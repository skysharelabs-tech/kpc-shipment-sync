// Server-side core of the example client dashboard (what the client's IT team builds).
// Follows the integration guide:
//   webhook  -> verify signature, skip duplicates, save newer data only (app/api/webhooks/kpc)
//   live     -> push changes to open browsers over Server-Sent Events (app/api/live)
//   pull API -> first load (snapshot) + catch-up safety net (startSync, run from instrumentation.ts)
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type Shipment = {
  shipment_id: number;
  shipment_code: string;
  delivery_status: string;
  ph_warehouse_tagged_at: string | null;
  delivered_at: string | null;
  created_at?: string;
  [field: string]: unknown;
};
export type KpcEvent = { event_id: string; event: string; occurred_at: string; shipment: Shipment };
export type LogEntry = {
  at: string;
  source: "webhook" | "catch-up" | "first load";
  type: string;
  code: string;
  result: string;
  latency_ms?: number | null;
};
type Listener = (type: string, payload: unknown) => void;

const CATCHUP_EVERY_MS = 60_000;

// ---------------------------------------------------------------- state
// Kept on globalThis: Next.js may load this module more than once (route handlers,
// instrumentation, dev hot reload), but there must be one database and one set of listeners.
type State = {
  db: DatabaseSync;
  insertEvent: StatementSync;
  upsertShipment: StatementSync;
  getState: StatementSync;
  setState: StatementSync;
  listeners: Set<Listener>;
  log: LogEntry[];
  syncStarted: boolean;
};
const g = globalThis as typeof globalThis & { __kpcDashboard?: State };

function state(): State {
  if (g.__kpcDashboard) return g.__kpcDashboard;
  const db = new DatabaseSync(process.env.DB_PATH ?? path.join(process.cwd(), "dashboard.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS kpc_shipments (
      shipment_id            INTEGER PRIMARY KEY,
      shipment_code          TEXT,
      delivery_status        TEXT,
      ph_warehouse_tagged_at TEXT,
      delivered_at           TEXT,
      data                   TEXT NOT NULL,
      last_event_ms          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kpc_events (event_id TEXT PRIMARY KEY, received_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS kpc_state  (key TEXT PRIMARY KEY, value TEXT);
  `);
  g.__kpcDashboard = {
    db,
    insertEvent: db.prepare("INSERT OR IGNORE INTO kpc_events (event_id) VALUES (?)"),
    upsertShipment: db.prepare(`
      INSERT INTO kpc_shipments (shipment_id, shipment_code, delivery_status, ph_warehouse_tagged_at,
                                 delivered_at, data, last_event_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (shipment_id) DO UPDATE SET
        shipment_code = excluded.shipment_code, delivery_status = excluded.delivery_status,
        ph_warehouse_tagged_at = excluded.ph_warehouse_tagged_at, delivered_at = excluded.delivered_at,
        data = excluded.data, last_event_ms = excluded.last_event_ms
      WHERE kpc_shipments.last_event_ms < excluded.last_event_ms`),
    getState: db.prepare("SELECT value FROM kpc_state WHERE key = ?"),
    setState: db.prepare(
      "INSERT INTO kpc_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    listeners: new Set(),
    log: [],
    syncStarted: false,
  };
  return g.__kpcDashboard;
}

// ---------------------------------------------------------------- live updates
export function subscribe(listener: Listener): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

function broadcast(type: string, payload: unknown) {
  for (const listener of state().listeners) listener(type, payload);
}

function addLog(entry: Omit<LogEntry, "at">) {
  const s = state();
  s.log.unshift({ at: new Date().toISOString(), ...entry });
  s.log.length = Math.min(s.log.length, 50);
  broadcast("log", s.log[0]);
}

export function snapshotForBrowser() {
  const s = state();
  const shipments = (s.db.prepare("SELECT data FROM kpc_shipments ORDER BY last_event_ms DESC LIMIT 200").all() as {
    data: string;
  }[]).map((r) => JSON.parse(r.data) as Shipment);
  return { shipments, log: s.log };
}

// ---------------------------------------------------------------- core: apply one event
export function applyEvent(event: KpcEvent, source: "webhook" | "catch-up") {
  const s = state();
  const { event_id, event: type, occurred_at, shipment } = event;
  if (s.insertEvent.run(event_id).changes === 0) {
    addLog({ source, type, code: shipment.shipment_code, result: "duplicate, skipped" });
    return;
  }
  const occurredMs = Date.parse(occurred_at);
  const r = s.upsertShipment.run(shipment.shipment_id, shipment.shipment_code, shipment.delivery_status,
    shipment.ph_warehouse_tagged_at, shipment.delivered_at, JSON.stringify(shipment), occurredMs);
  addLog({
    source, type, code: shipment.shipment_code,
    result: r.changes ? "saved" : "older than saved data, ignored",
    latency_ms: source === "webhook" ? Date.now() - occurredMs : null,
  });
  if (r.changes) broadcast("shipment", shipment);
}

export function isFromKpc(raw: string, ts: string, sig: string): boolean {
  const secret = process.env.KPC_WEBHOOK_SECRET ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function logRejected() {
  addLog({ source: "webhook", type: "rejected", code: "-", result: "invalid signature" });
}

// ---------------------------------------------------------------- Pull API: first load + catch-up
async function pull<T>(query: string): Promise<T> {
  const res = await fetch((process.env.KPC_PULL_URL ?? "") + query, {
    headers: { "x-api-key": process.env.KPC_API_KEY ?? "" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Pull API ${res.status}`);
  return res.json() as Promise<T>;
}

async function firstLoad() {
  const s = state();
  if (s.getState.get("first_load_done")) return;
  let afterId = 0, total = 0;
  for (;;) {
    const page = await pull<{ shipments: Shipment[]; next_after_id: number; has_more: boolean }>(
      `/snapshot?status=${encodeURIComponent("PH Warehouse")}&after_id=${afterId}&limit=500`);
    for (const sh of page.shipments) {
      const ms = Date.parse(sh.delivered_at ?? sh.ph_warehouse_tagged_at ?? sh.created_at ?? "");
      s.upsertShipment.run(sh.shipment_id, sh.shipment_code, sh.delivery_status, sh.ph_warehouse_tagged_at,
        sh.delivered_at, JSON.stringify(sh), ms);
    }
    total += page.shipments.length;
    afterId = page.next_after_id;
    if (!page.has_more) break;
  }
  s.setState.run("first_load_done", "1");
  addLog({ source: "first load", type: "snapshot", code: `${total} shipment(s) in PH Warehouse`, result: "loaded" });
}

// Safety net only: picks up events a webhook missed (e.g. while this server was down).
async function catchUp(): Promise<number> {
  const s = state();
  let seq = Number((s.getState.get("last_seq") as { value: string } | undefined)?.value ?? 0), applied = 0;
  for (;;) {
    const page = await pull<{ events: KpcEvent[]; next_after_seq: number; has_more: boolean }>(
      `?after_seq=${seq}&limit=500`);
    for (const e of page.events) { applyEvent(e, "catch-up"); applied++; }
    seq = page.next_after_seq;
    s.setState.run("last_seq", String(seq));
    if (!page.has_more) break;
  }
  return applied;
}

export async function startSync() {
  const s = state();
  if (s.syncStarted) return;
  s.syncStarted = true;
  try {
    await firstLoad();
    const n = await catchUp();
    console.log(`[kpc] first load done; catch-up applied ${n} event(s)`);
  } catch (e) {
    console.error("[kpc] startup sync failed:", (e as Error).message);
  }
  setInterval(() => catchUp().catch((e) => console.error("[kpc] catch-up failed:", e.message)), CATCHUP_EVERY_MS);
}
