// Example client dashboard: what the client's IT team builds on THEIR side.
// Follows the integration guide exactly:
//   POST /webhooks/kpc  -> verify signature, skip duplicates, save newer data only, reply 200
//   live browser updates via Server-Sent Events (GET /live)
//   first load (snapshot) + catch-up feed from the KPC Pull API
//
// Run: node --env-file=.env server.mjs   (no npm install needed; Node 22+)
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT ?? 4545);
const SECRET = process.env.KPC_WEBHOOK_SECRET ?? "";
const API_KEY = process.env.KPC_API_KEY ?? "";
const PULL_URL = process.env.KPC_PULL_URL ?? "";
const CATCHUP_EVERY_MS = 60_000;

// ---------------------------------------------------------------- database
const db = new DatabaseSync(new URL("./dashboard.db", import.meta.url).pathname);
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
const insertEvent = db.prepare("INSERT OR IGNORE INTO kpc_events (event_id) VALUES (?)");
const upsertShipment = db.prepare(`
  INSERT INTO kpc_shipments (shipment_id, shipment_code, delivery_status, ph_warehouse_tagged_at,
                             delivered_at, data, last_event_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (shipment_id) DO UPDATE SET
    shipment_code = excluded.shipment_code, delivery_status = excluded.delivery_status,
    ph_warehouse_tagged_at = excluded.ph_warehouse_tagged_at, delivered_at = excluded.delivered_at,
    data = excluded.data, last_event_ms = excluded.last_event_ms
  WHERE kpc_shipments.last_event_ms < excluded.last_event_ms`);
const getState = db.prepare("SELECT value FROM kpc_state WHERE key = ?");
const setState = db.prepare("INSERT INTO kpc_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");

// ---------------------------------------------------------------- live updates (SSE)
const clients = new Set();
const log = [];
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
function addLog(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  log.length = Math.min(log.length, 50);
  broadcast("log", log[0]);
}

// ---------------------------------------------------------------- core: apply one event
function applyEvent(event, source) {
  const { event_id, event: type, occurred_at, shipment: s } = event;
  if (insertEvent.run(event_id).changes === 0) {
    addLog({ source, type, code: s.shipment_code, result: "duplicate, skipped" });
    return;
  }
  const occurredMs = Date.parse(occurred_at);
  const r = upsertShipment.run(s.shipment_id, s.shipment_code, s.delivery_status,
    s.ph_warehouse_tagged_at, s.delivered_at, JSON.stringify(s), occurredMs);
  const latencyMs = Date.now() - occurredMs;
  addLog({
    source, type, code: s.shipment_code,
    result: r.changes ? "saved" : "older than saved data, ignored",
    latency_ms: source === "webhook" ? latencyMs : null,
  });
  if (r.changes) broadcast("shipment", s);
}

function isFromKpc(raw, ts, sig) {
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------------------------------------------------------------- Pull API: first load + catch-up
async function pull(path) {
  const res = await fetch(PULL_URL + path, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) throw new Error(`Pull API ${res.status}`);
  return res.json();
}

async function firstLoad() {
  if (getState.get("first_load_done")) return;
  let afterId = 0, total = 0;
  for (;;) {
    const page = await pull(`/snapshot?status=${encodeURIComponent("PH Warehouse")}&after_id=${afterId}&limit=500`);
    for (const s of page.shipments) {
      const ms = Date.parse(s.delivered_at ?? s.ph_warehouse_tagged_at ?? s.created_at);
      upsertShipment.run(s.shipment_id, s.shipment_code, s.delivery_status, s.ph_warehouse_tagged_at,
        s.delivered_at, JSON.stringify(s), ms);
    }
    total += page.shipments.length;
    afterId = page.next_after_id;
    if (!page.has_more) break;
  }
  setState.run("first_load_done", "1");
  addLog({ source: "first load", type: "snapshot", code: `${total} shipment(s) in PH Warehouse`, result: "loaded" });
}

async function catchUp() {
  let seq = Number(getState.get("last_seq")?.value ?? 0), applied = 0;
  for (;;) {
    const page = await pull(`?after_seq=${seq}&limit=500`);
    for (const e of page.events) { applyEvent(e, "catch-up"); applied++; }
    seq = page.next_after_seq;
    setState.run("last_seq", String(seq));
    if (!page.has_more) break;
  }
  return applied;
}

// ---------------------------------------------------------------- HTTP server
function snapshotForBrowser() {
  const shipments = db.prepare("SELECT data FROM kpc_shipments ORDER BY last_event_ms DESC LIMIT 200").all()
    .map((r) => JSON.parse(r.data));
  return { shipments, log };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "POST" && url.pathname === "/webhooks/kpc") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!isFromKpc(raw, req.headers["x-kpc-timestamp"] ?? "", req.headers["x-kpc-signature"] ?? "")) {
      addLog({ source: "webhook", type: "rejected", code: "-", result: "invalid signature" });
      res.writeHead(401).end("invalid signature");
      return;
    }
    applyEvent(JSON.parse(raw), "webhook");
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  if (url.pathname === "/live") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: init\ndata: ${JSON.stringify(snapshotForBrowser())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(readFileSync(new URL("./index.html", import.meta.url)));
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, async () => {
  console.log(`Example dashboard on http://localhost:${PORT}  (webhook: POST /webhooks/kpc)`);
  try {
    await firstLoad();
    const n = await catchUp();
    console.log(`first load done; catch-up applied ${n} event(s)`);
  } catch (e) {
    console.error("startup sync failed:", e.message);
  }
  setInterval(() => catchUp().catch((e) => console.error("catch-up failed:", e.message)), CATCHUP_EVERY_MS);
});
