"use client";
// The dashboard screen. Opens one EventSource to /api/live and re-renders when the server
// pushes a change. The browser never polls.
import { useEffect, useMemo, useState } from "react";
import type { LogEntry, Shipment } from "@/lib/kpc";

const fmt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-PH", {
        timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "–";
const show = (v: unknown) => (v === null || v === undefined ? "–" : String(v));

export default function Dashboard() {
  const [shipments, setShipments] = useState<Map<number, Shipment>>(new Map());
  const [log, setLog] = useState<(LogEntry & { key: string; isNew: boolean })[]>([]);
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  const [live, setLive] = useState<"connecting…" | "Live" | "reconnecting…">("connecting…");

  useEffect(() => {
    let n = 0;
    const withKey = (e: LogEntry, isNew: boolean) => ({ ...e, key: `${e.at}-${n++}`, isNew });
    const es = new EventSource("/api/live");
    es.onopen = () => setLive("Live");
    es.onerror = () => setLive("reconnecting…");
    es.addEventListener("init", (m) => {
      const d = JSON.parse(m.data) as { shipments: Shipment[]; log: LogEntry[] };
      setShipments(new Map(d.shipments.map((s) => [s.shipment_id, s])));
      setLog(d.log.map((e) => withKey(e, false)));
    });
    es.addEventListener("shipment", (m) => {
      const s = JSON.parse(m.data) as Shipment;
      setShipments((prev) => new Map(prev).set(s.shipment_id, s));
      setFlash({ id: s.shipment_id, n: n++ });
    });
    es.addEventListener("log", (m) => {
      setLog((prev) => [withKey(JSON.parse(m.data) as LogEntry, true), ...prev].slice(0, 50));
    });
    return () => es.close();
  }, []);

  const list = useMemo(
    () =>
      [...shipments.values()].sort(
        (a, b) =>
          Date.parse(b.delivered_at ?? b.ph_warehouse_tagged_at ?? "0") -
          Date.parse(a.delivered_at ?? a.ph_warehouse_tagged_at ?? "0"),
      ),
    [shipments],
  );

  const ph = list.filter((s) => s.delivery_status === "PH Warehouse").length;
  const delivered = list.filter((s) => s.delivered_at);
  const arrived = list.filter((s) => s.ph_warehouse_tagged_at).length;
  const rate = arrived ? Math.round((delivered.length / arrived) * 100) + "%" : "–";
  const spans = delivered
    .filter((s) => s.ph_warehouse_tagged_at)
    .map((s) => (Date.parse(s.delivered_at!) - Date.parse(s.ph_warehouse_tagged_at!)) / 3_600_000);
  const avgH = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  const avg = avgH === null ? "–" : avgH < 48 ? avgH.toFixed(1) + " h" : (avgH / 24).toFixed(1) + " d";

  return (
    <>
      <header>
        <div>
          <h1>
            Fulfillment Dashboard <span className="muted" style={{ fontWeight: 400 }}>— example client system</span>
          </h1>
          <div className="sub">Receives KPC shipment updates by webhook · live screen updates via Server-Sent Events</div>
        </div>
        <div className="live">
          <span className={`dot ${live === "Live" ? "on" : ""}`} />
          <span>{live}</span>
        </div>
      </header>

      <main>
        <div className="kpis">
          <div className="kpi"><div className="l">In PH Warehouse</div><div className="v">{ph}</div></div>
          <div className="kpi"><div className="l">Delivered</div><div className="v">{delivered.length}</div></div>
          <div className="kpi"><div className="l">Fulfillment rate</div><div className="v">{rate}</div></div>
          <div className="kpi"><div className="l">Avg PH Warehouse → Delivered</div><div className="v">{avg}</div></div>
        </div>

        <div className="grid">
          <div className="card">
            <h2>Shipments</h2>
            <table>
              <thead>
                <tr>
                  <th>Shipment code</th><th>Client</th><th>Status</th><th>Boxes</th><th>CBM</th>
                  <th>Pickup</th><th>PH Warehouse</th><th>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const flashed = flash?.id === s.shipment_id;
                  return (
                    // a new key on the flashed row remounts it, so the highlight animation replays
                    <tr key={flashed ? `${s.shipment_id}-${flash!.n}` : s.shipment_id} className={flashed ? "flash" : ""}>
                      <td><b>{show(s.shipment_code)}</b></td>
                      <td>{show(s.client_name)}</td>
                      <td>
                        <span className={`pill ${s.delivery_status === "Delivered" ? "del" : "ph"}`}>
                          {show(s.delivery_status)}
                        </span>
                      </td>
                      <td>{show(s.box_quantity ?? s.quantity)}</td>
                      <td>{show(s.total_cbm)}</td>
                      <td>{show(s.pickup_warehouse)}</td>
                      <td>{fmt(s.ph_warehouse_tagged_at)}</td>
                      <td>{fmt(s.delivered_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.length === 0 && (
              <div className="empty">No shipments yet. Tag one as PH Warehouse on the KPC website.</div>
            )}
          </div>

          <div className="card">
            <h2>Incoming updates</h2>
            <div className="log">
              {log.map((e) => {
                const src = e.source === "first load" ? "first" : e.source;
                return (
                  <div key={e.key} className={`row ${e.isNew ? "new" : ""}`}>
                    <span className={`src ${src}`}>{e.source}</span> · {e.type} · <b>{e.code}</b>
                    <br />
                    <span className="meta">
                      {new Date(e.at).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })} · {e.result}
                    </span>
                    {e.latency_ms != null && (
                      <>
                        {" · "}
                        <span className="lat">
                          arrived {(Math.max(0, e.latency_ms) / 1000).toFixed(2)} s after the tag
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
