-- cellar27 — invariant: claimed_by must be set whenever status='picked_up'.
--
-- The watcher already sets claimed_by = hostname() inside the same atomic
-- update that flips status to 'picked_up' (see watcher/src/index.js, the
-- pickUp() function), and the stale-claim sweep clears claimed_by back to
-- NULL when it resets a row to 'pending'. So the invariant is honored in
-- practice; this constraint formalizes it so any future code path (or a
-- service-role hand-edit during debugging) can't leave a row in a half-
-- claimed state where status='picked_up' but claimed_by is NULL.
--
-- NOT VALID is intentional: if there's any pre-existing row that violates
-- the invariant (extremely unlikely given current code, but possible from
-- early dev sessions), we want the migration to apply without rejecting
-- it. The constraint is enforced for all subsequent inserts/updates.
-- After applying, the owner can run a one-shot VALIDATE to upgrade the
-- constraint to fully enforced once any legacy rows have been cleaned up.
--
-- Run via Supabase SQL Editor. Idempotent (DROP IF EXISTS first).

------------------------------------------------------------
-- pairing_requests
------------------------------------------------------------
alter table pairing_requests
  drop constraint if exists pairing_requests_claimed_by_when_picked_up;
alter table pairing_requests
  add constraint pairing_requests_claimed_by_when_picked_up
  check (status <> 'picked_up' or claimed_by is not null) not valid;

------------------------------------------------------------
-- scan_requests
------------------------------------------------------------
alter table scan_requests
  drop constraint if exists scan_requests_claimed_by_when_picked_up;
alter table scan_requests
  add constraint scan_requests_claimed_by_when_picked_up
  check (status <> 'picked_up' or claimed_by is not null) not valid;

-- After applying, optionally upgrade to fully validated once any legacy
-- offending rows are cleaned up:
--
--   alter table pairing_requests
--     validate constraint pairing_requests_claimed_by_when_picked_up;
--   alter table scan_requests
--     validate constraint scan_requests_claimed_by_when_picked_up;
--
-- VALIDATE will scan every row and raise if any violates the constraint;
-- safe to run with the watcher up since it only takes a SHARE UPDATE
-- EXCLUSIVE lock (allows concurrent reads/writes).
