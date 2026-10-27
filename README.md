# KPC shipment sync (internal)

Pushes `shipment.ph_warehouse` / `shipment.delivered` events from KPC to the client's dashboard.
Client-facing guide: `docs/KPC-Shipment-Sync-Integration-Guide.pdf` (source: `docs/shipment-sync-guide.html`).

| Piece | Where |
|---|---|
| Migration (column `shipments.delivered_at`, schema `integrations`, triggers, worker, feed RPCs, cron `shipment-sync-worker`) | `migrations/001_shipment_sync.sql` |
| Pull API (`x-api-key`) | `supabase/functions/shipment-sync-feed` (deploy `--no-verify-jwt`) |
| Dev-only stand-in receiver | `supabase/functions/webhook-test-receiver` |
| Dev secrets (gitignored, never share by chat) | `.secrets/dev.env` |

Status: applied + tested on **KPC Dev** (`gtkchanspfuqdllnqzbn`) 2026-10-20. **Not on prod** (`iicntryczfdhvpgmmxhp`).

## Prod rollout
1. Apply `migrations/001_shipment_sync.sql`.
2. `select vault.create_secret('<openssl rand -hex 32>', 'shipment_sync_webhook_secret');`
3. `insert into integrations.webhook_endpoints (name, url, secret_name) values ('shipment_sync', '<client URL>', 'shipment_sync_webhook_secret');`
4. `supabase secrets set --project-ref iicntryczfdhvpgmmxhp SHIPMENT_SYNC_API_KEY=<openssl rand -hex 32>`
5. `supabase functions deploy shipment-sync-feed --project-ref iicntryczfdhvpgmmxhp --no-verify-jwt`
6. Send the client the secret + API key + `https://iicntryczfdhvpgmmxhp.supabase.co/functions/v1/shipment-sync-feed` through a secure channel.
7. Optional: backfill `delivered_at` for old shipments from `audit.record_version` / `old_api_shipments_order_audit` **with `set local integrations.skip_shipment_sync = 'on'`**.

## Ops
```sql
-- health
select status, count(*) from integrations.shipment_sync_events group by 1;
select seq, shipment_code, attempts, last_status_code, last_error from integrations.shipment_sync_events where status <> 'sent' order by seq;

-- resend one event (or all failed)
update integrations.shipment_sync_events set status='pending', attempts=0, next_attempt_at=now(), last_status_code=null where id = '<event_id>';

-- pause pushes (events still recorded and available in the pull feed)
update integrations.webhook_endpoints set enabled = false where name = 'shipment_sync';

-- bulk maintenance without emitting events
begin; set local integrations.skip_shipment_sync = 'on'; /* updates */ commit;
```
