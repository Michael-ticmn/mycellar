-- cellar27 — real rate limit for the guest-label Edge Function
--
-- 0016-0018 shipped with an in-memory throttle inside the Edge Function. It
-- does not work. Measured against the deployed function: 80 sequential and then
-- 100 concurrent requests with a single token produced zero 429s, because
-- Supabase hands each request a fresh isolate and the module-level Map never
-- accumulates. An in-process counter cannot rate limit a process that doesn't
-- persist.
--
-- So the counter has to live somewhere shared. This is the same shape as
-- cellar27_try_record_spawn (0004): a row per bucket, incremented atomically,
-- returning false once it's over the cap.
--
-- Cost is one round-trip per photo request, on an endpoint that already makes
-- two. Worth it — without it there is no limit at all.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Counter table. One row per (token, minute-bucket); old rows are pruned
-- opportunistically so this can't grow without bound.
------------------------------------------------------------

create table if not exists cellar27_guest_label_hits (
  token       text        not null,
  bucket      timestamptz not null,
  hits        int         not null default 0,
  primary key (token, bucket)
);

alter table cellar27_guest_label_hits enable row level security;
-- No policies: only service_role (i.e. the Edge Function) touches this.

create index if not exists cellar27_guest_label_hits_bucket_idx
  on cellar27_guest_label_hits(bucket);

------------------------------------------------------------
-- Atomic check-and-increment. Returns true if the request may proceed.
--
-- date_trunc gives a fixed one-minute window rather than a sliding one. A
-- sliding window would need per-request timestamps; for "stop a loop pulling
-- every photo" a fixed minute is plenty, and it keeps this to a single upsert.
------------------------------------------------------------

create or replace function cellar27_guest_label_allow(
  p_token text,
  p_max   int default 60
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_hits   int;
begin
  insert into public.cellar27_guest_label_hits (token, bucket, hits)
       values (p_token, v_bucket, 1)
  on conflict (token, bucket)
    do update set hits = public.cellar27_guest_label_hits.hits + 1
  returning hits into v_hits;

  -- Opportunistic cleanup: ~1 request in 100 clears anything older than an
  -- hour. Cheap, self-maintaining, and no scheduled job to forget about.
  if v_hits % 100 = 0 then
    delete from public.cellar27_guest_label_hits where bucket < now() - interval '1 hour';
  end if;

  return v_hits <= p_max;
end;
$$;

revoke all on function cellar27_guest_label_allow(text, int) from public;
-- The Edge Function calls this with the service key, which bypasses grants;
-- no role needs EXECUTE, and anon explicitly must not have it.
