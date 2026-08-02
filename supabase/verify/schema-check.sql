-- cellar27 — "is it actually applied?" check, for the things PostgREST can't see.
--
-- Paste into the Supabase SQL Editor and run. Read-only: it only queries system
-- catalogs. Every row comes back with PASS or a FAIL that names the migration
-- to run.
--
-- WHY THIS EXISTS, alongside scripts/verify-migrations.mjs
--
-- There is no migration ledger — migrations are applied by hand, so the only
-- record of what ran is the filename. The Node verifier answers "does this
-- function exist and behave", because that is what PostgREST exposes. It cannot
-- answer:
--
--   * does a function have search_path locked down?   (pg_proc.proconfig)
--   * does a CHECK constraint exist?                  (pg_constraint)
--   * does an RLS policy have a WITH CHECK clause?    (pg_policies)
--   * is a function SECURITY DEFINER or INVOKER?      (pg_proc.prosecdef)
--
-- Those are catalog questions, and only a direct SQL connection can ask them.
-- That gap cost real time: whether 0006 and 0007 had ever been applied sat
-- unanswered on the handoff queue from 2026-05-02 to 2026-08-02, because the
-- Node verifier structurally could not tell, and re-running the files blind
-- would have left it just as unanswered. This query settled it in one run.
--
-- Add a row here whenever a migration changes something invisible to PostgREST.

with checks as (

  -- 0006 / 0011 / 0017 — search_path lockdown on SECURITY DEFINER functions.
  -- A SECURITY DEFINER function without a pinned search_path will resolve
  -- unqualified names against whatever is on the caller's path.
  select
    'search_path'                                        as area,
    'function ' || p.proname                             as object,
    case when array_to_string(p.proconfig, ',') like '%pg_catalog%'
         then 'PASS' else 'FAIL — run 0006 / 0011 / 0017' end as status,
    coalesce(array_to_string(p.proconfig, ', '), '(none set)') as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'cellar27\_%'
    and p.prosecdef                       -- SECURITY DEFINER only

  union all

  -- 0007 — claimed_by invariant. NOT VALID by design: enforced going forward,
  -- tolerant of any legacy row. `validated=false` is expected, not a failure.
  select
    '0007 constraint',
    c.conname,
    'PASS',
    pg_get_constraintdef(c.oid)
      || case when c.convalidated then '  [validated]' else '  [not valid — expected]' end
  from pg_constraint c
  join pg_class r     on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public'
    and c.conname in ('pairing_requests_claimed_by_when_picked_up',
                      'scan_requests_claimed_by_when_picked_up')

  union all

  -- 0016 (S4) — the Storage UPDATE policy needs WITH CHECK as well as USING.
  -- USING decides which rows you may target; WITH CHECK decides what the row is
  -- allowed to become. With only the first, an object could be renamed into
  -- another user's folder prefix.
  select
    '0016 storage policy',
    pol.policyname,
    case when pol.with_check is not null then 'PASS' else 'FAIL — run 0016' end,
    coalesce(pol.with_check, '(no WITH CHECK clause)')
  from pg_policies pol
  where pol.schemaname = 'storage'
    and pol.policyname = 'users update own labels'

  union all

  -- 0018 — atomic pour. Must be SECURITY INVOKER so RLS still scopes it to the
  -- caller's own bottles; DEFINER here would let anyone decrement any bottle.
  select
    '0018 atomic pour',
    'function ' || p.proname,
    case when p.prosecdef then 'FAIL — must be SECURITY INVOKER' else 'PASS' end,
    case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('cellar27_pour_bottle', 'cellar27_unpour_bottle')

  union all

  -- 0019 — guest-label rate limit. The counter has to be a table, not memory:
  -- an in-process counter cannot rate limit Edge Function isolates that are
  -- discarded between invocations. Measured doing nothing before this landed.
  select
    '0019 rate limit',
    'table cellar27_guest_label_hits',
    case when to_regclass('public.cellar27_guest_label_hits') is not null
         then 'PASS' else 'FAIL — run 0019' end,
    coalesce(to_regclass('public.cellar27_guest_label_hits')::text, '(missing)')
)
select * from checks
order by
  case when status like 'FAIL%' then 0 else 1 end,   -- failures first
  area, object;
