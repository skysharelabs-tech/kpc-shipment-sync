-- =====================================================================
-- KPC shipment sync: pushes PH Warehouse / Delivered events to an
-- external dashboard via signed webhooks, with an outbox for retries
-- and a pull feed for catch-up.
--
-- Prerequisites (run once per project, NOT in this file):
--   select vault.create_secret('<random 64-hex>', 'shipment_sync_webhook_secret');
--   insert into integrations.webhook_endpoints (name, url, secret_name)
--     values ('shipment_sync', 'https://<their-endpoint>', 'shipment_sync_webhook_secret');
--
-- Bulk maintenance (backfills, sync_from_old_api) without sending events:
--   set local integrations.skip_shipment_sync = 'on';
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. delivered_at: when a shipment was tagged Delivered
-- ---------------------------------------------------------------------
alter table public.shipments
  add column if not exists delivered_at timestamptz;

create or replace function public.set_delivered_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if NEW.delivery_status = 'Delivered'
     and NEW.delivered_at is null
     and (TG_OP = 'INSERT' or OLD.delivery_status is distinct from 'Delivered')
  then
    NEW.delivered_at := now();
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_shipments_set_delivered_at on public.shipments;
create trigger trg_shipments_set_delivered_at
  before insert or update of delivery_status on public.shipments
  for each row execute function public.set_delivered_at();

-- ---------------------------------------------------------------------
-- 2. Private schema (not exposed through PostgREST)
-- ---------------------------------------------------------------------
create schema if not exists integrations;
revoke all on schema integrations from public, anon, authenticated;

create table if not exists integrations.webhook_endpoints (
  name        text primary key,
  url         text not null,
  secret_name text not null,              -- vault.secrets name used for HMAC
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists integrations.shipment_sync_events (
  seq              bigint generated always as identity unique,  -- pull-feed cursor
  id               uuid primary key default gen_random_uuid(),  -- event_id sent to receiver
  event_type       text not null
                   check (event_type in ('shipment.ph_warehouse', 'shipment.delivered')),
  shipment_id      bigint not null,
  shipment_code    text,
  payload          jsonb not null,
  occurred_at      timestamptz not null default now(),
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_attempt_at  timestamptz,
  last_request_id  bigint,                 -- net.http_post request id
  last_status_code int,
  last_error       text,
  sent_at          timestamptz
);

create index if not exists shipment_sync_events_pending_idx
  on integrations.shipment_sync_events (next_attempt_at) where status = 'pending';
create index if not exists shipment_sync_events_shipment_idx
  on integrations.shipment_sync_events (shipment_id);

revoke all on all tables in schema integrations from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Payload: the shipment fields the dashboard receives
-- ---------------------------------------------------------------------
create or replace function integrations.build_shipment_payload(p_shipment_id bigint)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'shipment_id',            s.id,
    'shipment_code',          s.shipment_code,
    'tracking_number',        s.tracking_number,
    'waybill_number',         s.waybill_number,
    'container_van',          s.container_van,
    'delivery_status',        s.delivery_status,
    'payment_status',         s.payment_status,
    'client_code',            u.custom_id,
    'client_name',            u.full_name,
    'business_name',          u.business_name,
    'quantity',               s.quantity,
    'box_quantity',           s.box_quantity,
    'total_cbm',              s.total_cbm,
    'total_kgs',              s.total_kgs,
    'source_warehouse',       sw.name,
    'pickup_warehouse',       pw.name,
    'item_description',       to_jsonb(s.item_description),
    'created_at',             s.created_at,
    'date_received',          s.date_received,
    'ph_warehouse_tagged_at', s.ph_warehouse_tagged_at,
    'delivered_at',           s.delivered_at
  )
  from public.shipments s
  left join public.users u       on u.id  = s.client_id
  left join public.warehouses sw on sw.id = s.source_warehouse_id
  left join public.warehouses pw on pw.id = s.pickup_warehouse_id
  where s.id = p_shipment_id;
$$;

-- ---------------------------------------------------------------------
-- 4. Send one event (signed POST via pg_net)
--    Headers: X-KPC-Event, X-KPC-Event-Id, X-KPC-Timestamp,
--             X-KPC-Signature = sha256=hex(HMAC_SHA256(secret, timestamp + '.' + raw_body))
-- ---------------------------------------------------------------------
create or replace function integrations.send_shipment_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_ep     integrations.webhook_endpoints;
  v_ev     integrations.shipment_sync_events;
  v_secret text;
  v_body   jsonb;
  v_ts     text;
  v_sig    text;
  v_req    bigint;
begin
  select * into v_ep from integrations.webhook_endpoints
   where name = 'shipment_sync' and enabled;
  if not found then
    return;  -- no endpoint configured: events stay pending for the pull feed / later delivery
  end if;

  select * into v_ev from integrations.shipment_sync_events
   where id = p_event_id and status = 'pending'
   for update skip locked;
  if not found then
    return;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = v_ep.secret_name;
  if v_secret is null then
    update integrations.shipment_sync_events
       set last_error = 'webhook secret ' || v_ep.secret_name || ' not found in vault'
     where id = v_ev.id;
    return;
  end if;

  v_body := jsonb_build_object(
    'event_id',    v_ev.id,
    'event',       v_ev.event_type,
    'occurred_at', v_ev.occurred_at,
    'shipment',    v_ev.payload
  );
  v_ts  := extract(epoch from now())::bigint::text;
  -- pg_net sends body::text, so sign exactly that text
  v_sig := encode(extensions.hmac(v_ts || '.' || v_body::text, v_secret, 'sha256'), 'hex');

  v_req := net.http_post(
    url     := v_ep.url,
    body    := v_body,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'X-KPC-Event',     v_ev.event_type,
      'X-KPC-Event-Id',  v_ev.id::text,
      'X-KPC-Timestamp', v_ts,
      'X-KPC-Signature', 'sha256=' || v_sig
    ),
    timeout_milliseconds := 10000
  );

  -- backoff before the next retry: 2, 4, 8 ... capped at 60 minutes
  update integrations.shipment_sync_events
     set attempts        = attempts + 1,
         last_attempt_at = now(),
         last_request_id = v_req,
         next_attempt_at = now() + least(interval '1 minute' * power(2, attempts + 1), interval '60 minutes')
   where id = v_ev.id;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Trigger: record + send on entering PH Warehouse / Delivered
-- ---------------------------------------------------------------------
create or replace function integrations.enqueue_shipment_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_type text;
  v_id   uuid;
begin
  if coalesce(current_setting('integrations.skip_shipment_sync', true), '') = 'on' then
    return null;
  end if;
  if TG_OP = 'UPDATE' and NEW.delivery_status is not distinct from OLD.delivery_status then
    return null;
  end if;
  if coalesce(NEW.is_delete, false) then
    return null;
  end if;

  v_type := case NEW.delivery_status
              when 'PH Warehouse' then 'shipment.ph_warehouse'
              when 'Delivered'    then 'shipment.delivered'
            end;
  if v_type is null then
    return null;
  end if;

  insert into integrations.shipment_sync_events (event_type, shipment_id, shipment_code, payload)
  values (v_type, NEW.id, NEW.shipment_code, integrations.build_shipment_payload(NEW.id))
  returning id into v_id;

  perform integrations.send_shipment_event(v_id);
  return null;
end;
$$;

drop trigger if exists trg_shipments_sync_event on public.shipments;
create trigger trg_shipments_sync_event
  after insert or update of delivery_status on public.shipments
  for each row execute function integrations.enqueue_shipment_event();

-- ---------------------------------------------------------------------
-- 6. Worker (pg_cron, every minute): record results, retry, give up
-- ---------------------------------------------------------------------
create or replace function integrations.process_shipment_sync(p_max_attempts int default 12)
returns table (marked_sent int, marked_failed int, resent int)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_sent   int := 0;
  v_failed int := 0;
  v_resent int := 0;
  r        record;
begin
  -- results of the last attempt
  with res as (
    update integrations.shipment_sync_events e
       set last_status_code = rsp.status_code,
           last_error = case
                          when rsp.status_code between 200 and 299 then null
                          else left(coalesce(rsp.error_msg, rsp.content, 'no response'), 500)
                        end,
           status  = case when rsp.status_code between 200 and 299 then 'sent' else e.status end,
           sent_at = case when rsp.status_code between 200 and 299 then now() else e.sent_at end
      from net._http_response rsp
     where rsp.id = e.last_request_id
       and e.status = 'pending'
       and e.last_status_code is null
    returning e.status
  )
  select count(*) filter (where status = 'sent') into v_sent from res;

  -- give up after p_max_attempts
  update integrations.shipment_sync_events
     set status = 'failed'
   where status = 'pending'
     and attempts >= p_max_attempts
     and next_attempt_at <= now();
  get diagnostics v_failed = row_count;

  -- retry anything still pending that is due
  for r in
    select id from integrations.shipment_sync_events
     where status = 'pending' and next_attempt_at <= now()
     order by seq
     limit 200
  loop
    update integrations.shipment_sync_events set last_status_code = null where id = r.id;
    perform integrations.send_shipment_event(r.id);
    v_resent := v_resent + 1;
  end loop;

  return query select v_sent, v_failed, v_resent;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Pull feed for the edge function (service_role only)
-- ---------------------------------------------------------------------
create or replace function public.shipment_sync_feed(p_after_seq bigint default 0, p_limit int default 500)
returns table (seq bigint, event_id uuid, event text, occurred_at timestamptz, shipment jsonb)
language sql
stable
security definer
set search_path to ''
as $$
  select e.seq, e.id, e.event_type, e.occurred_at, e.payload
    from integrations.shipment_sync_events e
   where e.seq > coalesce(p_after_seq, 0)
   order by e.seq
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

create or replace function public.shipment_sync_snapshot(
  p_status text default 'PH Warehouse',
  p_after_id bigint default 0,
  p_limit int default 500
)
returns table (shipment jsonb)
language sql
stable
security definer
set search_path to ''
as $$
  select integrations.build_shipment_payload(s.id)
    from public.shipments s
   where s.delivery_status = p_status
     and not coalesce(s.is_delete, false)
     and s.id > coalesce(p_after_id, 0)
   order by s.id
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

revoke execute on function public.shipment_sync_feed(bigint, int) from public, anon, authenticated;
revoke execute on function public.shipment_sync_snapshot(text, bigint, int) from public, anon, authenticated;
grant execute on function public.shipment_sync_feed(bigint, int) to service_role;
grant execute on function public.shipment_sync_snapshot(text, bigint, int) to service_role;

revoke execute on all functions in schema integrations from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------
-- 8. Schedule the worker (outside the transaction; idempotent by name)
-- ---------------------------------------------------------------------
select cron.schedule('shipment-sync-worker', '* * * * *',
                     $$select integrations.process_shipment_sync()$$);
