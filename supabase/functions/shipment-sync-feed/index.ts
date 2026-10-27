// Read-only pull API for the client dashboard.
//
//   GET /shipment-sync-feed?after_seq=0&limit=500
//       -> events (same shape as the webhook body) after a cursor
//   GET /shipment-sync-feed/snapshot?status=PH%20Warehouse&after_id=0&limit=500
//       -> current shipments in a status (initial load)
//
// Auth: header `x-api-key: <SHIPMENT_SYNC_API_KEY>`. Deploy with --no-verify-jwt.
import { createClient } from "jsr:@supabase/supabase-js@2";

const API_KEY = Deno.env.get("SHIPMENT_SYNC_API_KEY") ?? "";
const SNAPSHOT_STATUSES = ["PH Warehouse", "Ready For Pickup", "Warehouse Overstaying", "Delivered"];

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function intParam(url: URL, name: string, fallback: number) {
  const v = Number(url.searchParams.get(name) ?? fallback);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (!API_KEY || !safeEqual(req.headers.get("x-api-key") ?? "", API_KEY)) {
    return json(401, { error: "unauthorized" });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(intParam(url, "limit", 500), 1), 1000);

  if (url.pathname.endsWith("/snapshot")) {
    const status = url.searchParams.get("status") ?? "PH Warehouse";
    if (!SNAPSHOT_STATUSES.includes(status)) {
      return json(400, { error: "invalid_status", allowed: SNAPSHOT_STATUSES });
    }
    const afterId = intParam(url, "after_id", 0);
    const { data, error } = await supabase.rpc("shipment_sync_snapshot", {
      p_status: status,
      p_after_id: afterId,
      p_limit: limit,
    });
    if (error) return json(500, { error: "query_failed" });
    const shipments = (data ?? []).map((r: { shipment: unknown }) => r.shipment);
    const last = shipments.at(-1) as { shipment_id?: number } | undefined;
    return json(200, {
      status,
      shipments,
      next_after_id: last?.shipment_id ?? afterId,
      has_more: shipments.length === limit,
    });
  }

  const afterSeq = intParam(url, "after_seq", 0);
  const { data, error } = await supabase.rpc("shipment_sync_feed", {
    p_after_seq: afterSeq,
    p_limit: limit,
  });
  if (error) return json(500, { error: "query_failed" });
  const events = data ?? [];
  return json(200, {
    events,
    next_after_seq: events.at(-1)?.seq ?? afterSeq,
    has_more: events.length === limit,
  });
});
