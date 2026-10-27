// Runs once when the Next.js server starts: first load from the KPC Pull API,
// then the catch-up safety net every 60 s. Live updates come from the webhook, not from this.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSync } = await import("./lib/kpc");
    void startSync();
  }
}
