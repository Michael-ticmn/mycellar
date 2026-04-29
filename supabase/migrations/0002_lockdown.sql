-- cellar27 — defense-in-depth lockdown
-- Run via Supabase SQL Editor. Idempotent (uses do-blocks where needed).

------------------------------------------------------------
-- Size CHECK constraints on user-supplied jsonb
-- Prevents someone inserting a multi-MB blob to crash the watcher.
------------------------------------------------------------

alter table pairing_requests
  drop constraint if exists pairing_requests_context_size,
  drop constraint if exists pairing_requests_snapshot_size;

alter table pairing_requests
  add constraint pairing_requests_context_size
    check (octet_length(context::text) <= 4096),
  add constraint pairing_requests_snapshot_size
    check (octet_length(cellar_snapshot::text) <= 65536);

alter table scan_requests
  drop constraint if exists scan_requests_context_size,
  drop constraint if exists scan_requests_snapshot_size,
  drop constraint if exists scan_requests_image_path_len;

alter table scan_requests
  add constraint scan_requests_context_size
    check (context is null or octet_length(context::text) <= 4096),
  add constraint scan_requests_snapshot_size
    check (cellar_snapshot is null or octet_length(cellar_snapshot::text) <= 65536),
  add constraint scan_requests_image_path_len
    check (length(image_path) <= 1024);

------------------------------------------------------------
-- Per-user pending-request cap (5 max in flight)
-- Caps blast radius at the DB layer regardless of what the
-- watcher / app does.
------------------------------------------------------------

create or replace function enforce_pending_request_cap() returns trigger
language plpgsql as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from pairing_requests
  where user_id = new.user_id
    and status in ('pending', 'picked_up');
  if pending_count >= cap then
    raise exception 'Too many pending requests (%): wait for the bridge to finish before submitting more.', pending_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists pairing_requests_cap on pairing_requests;
create trigger pairing_requests_cap
  before insert on pairing_requests
  for each row execute function enforce_pending_request_cap();

create or replace function enforce_pending_scan_cap() returns trigger
language plpgsql as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from scan_requests
  where user_id = new.user_id
    and status in ('pending', 'picked_up');
  if pending_count >= cap then
    raise exception 'Too many pending scans (%): wait for processing to finish.', pending_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists scan_requests_cap on scan_requests;
create trigger scan_requests_cap
  before insert on scan_requests
  for each row execute function enforce_pending_scan_cap();

------------------------------------------------------------
-- Bottle row size soft caps (defensive)
------------------------------------------------------------

alter table bottles
  drop constraint if exists bottles_producer_len,
  drop constraint if exists bottles_notes_len,
  drop constraint if exists bottles_storage_loc_len;

alter table bottles
  add constraint bottles_producer_len    check (length(producer) <= 200),
  add constraint bottles_notes_len       check (notes is null or length(notes) <= 4000),
  add constraint bottles_storage_loc_len check (storage_location is null or length(storage_location) <= 200);
