-- cellar27 — Phase 3: scan flow with multi-image capture + bottle enrichment.
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Bottles: optional back-label image + flexible AI-generated details bag.
------------------------------------------------------------

alter table bottles
  add column if not exists back_image_path text,
  add column if not exists details jsonb;

-- Soft size cap on details so a runaway response can't bloat the row.
alter table bottles
  drop constraint if exists bottles_details_size;
alter table bottles
  add constraint bottles_details_size
    check (details is null or octet_length(details::text) <= 8192);

------------------------------------------------------------
-- Scan requests: multi-image (front + back) + new 'enrich' intent.
------------------------------------------------------------

-- Add 'enrich' as a valid intent. Drop and recreate the check.
alter table scan_requests
  drop constraint if exists scan_requests_intent_check;
alter table scan_requests
  add constraint scan_requests_intent_check
    check (intent in ('add', 'pour', 'enrich'));

-- Drop the old singular-path size constraint.
alter table scan_requests
  drop constraint if exists scan_requests_image_path_len;

-- Add the array column and backfill from any existing singular path.
alter table scan_requests
  add column if not exists image_paths jsonb;

update scan_requests
set image_paths = jsonb_build_array(image_path)
where image_paths is null and image_path is not null;

alter table scan_requests
  alter column image_paths set default '[]'::jsonb;

update scan_requests
set image_paths = '[]'::jsonb
where image_paths is null;

alter table scan_requests
  alter column image_paths set not null;

alter table scan_requests
  drop column if exists image_path;

-- Size + per-intent count rules.
alter table scan_requests
  drop constraint if exists scan_requests_image_paths_size,
  drop constraint if exists scan_requests_image_paths_count;

alter table scan_requests
  add constraint scan_requests_image_paths_size
    check (octet_length(image_paths::text) <= 4096),
  add constraint scan_requests_image_paths_count
    check (
      (intent = 'enrich' and jsonb_array_length(image_paths) = 0)
      or (intent in ('add', 'pour') and jsonb_array_length(image_paths) between 1 and 4)
    );
