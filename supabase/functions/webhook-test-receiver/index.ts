// DEV ONLY: stand-in for the client's webhook endpoint.
// Verifies the X-KPC-Signature exactly as the client should, and echoes the
// result so it lands in net._http_response. `?fail=1` returns 500 to exercise retries.
const SECRET = Deno.env.get("SHIPMENT_SYNC_WEBHOOK_SECRET") ?? "";

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const raw = await req.text();
  const ts = req.headers.get("x-kpc-timestamp") ?? "";
  const got = req.headers.get("x-kpc-signature") ?? "";
  const expected = "sha256=" + (await hmacHex(SECRET, `${ts}.${raw}`));
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
  const result = {
    signature_valid: got === expected,
    timestamp_fresh: ageSeconds < 300,
    event: req.headers.get("x-kpc-event"),
    event_id: req.headers.get("x-kpc-event-id"),
  };
  const fail = new URL(req.url).searchParams.get("fail") === "1";
  return new Response(JSON.stringify(result), {
    status: fail ? 500 : result.signature_valid ? 200 : 401,
    headers: { "Content-Type": "application/json" },
  });
});
