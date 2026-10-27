// GET /api/live: one long-lived Server-Sent Events stream per browser tab.
// Sends the current data once ("init"), then pushes each change as it is saved.
import { snapshotForBrowser, subscribe } from "@/lib/kpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (type: string, payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };
      send("init", snapshotForBrowser());
      const unsubscribe = subscribe(send);
      // comment line every 25 s so proxies (ngrok, load balancers) don't close an idle stream
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
      }, 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
