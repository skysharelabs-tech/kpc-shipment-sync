// POST /api/webhooks/kpc: KPC pushes shipment.ph_warehouse / shipment.delivered here the moment
// a shipment is tagged. Verify the signature, save, reply 200 within 10 seconds.
import { applyEvent, isFromKpc, logRejected, type KpcEvent } from "@/lib/kpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text(); // raw body: the signature covers these exact bytes
  const ts = req.headers.get("x-kpc-timestamp") ?? "";
  const sig = req.headers.get("x-kpc-signature") ?? "";
  if (!isFromKpc(raw, ts, sig)) {
    logRejected();
    return new Response("invalid signature", { status: 401 });
  }
  applyEvent(JSON.parse(raw) as KpcEvent, "webhook");
  return Response.json({ ok: true });
}
