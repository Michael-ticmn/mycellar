-- cellar27 — let hosts delete guest activity
--
-- 0014 deliberately shipped no delete policy on guest_messages, on the
-- assumption that cascade-on-link-delete was enough cleanup. In practice
-- hosts want to prune individual guest activity items (a stray sommelier
-- query, a duplicate note) from the Share page without nuking the whole
-- tasting session. Add an owner-scoped DELETE policy mirroring the
-- existing SELECT policy — a host may delete a guest message iff it hangs
-- off one of their own share links. Guests (anon) still have no delete
-- path.
--
-- Run via Supabase SQL Editor. Idempotent.

drop policy if exists "owners delete guest messages on their links" on guest_messages;
create policy "owners delete guest messages on their links" on guest_messages
  for delete to authenticated using (
    exists (select 1 from share_links sl
            where sl.id = guest_messages.share_link_id
              and sl.owner_user_id = auth.uid())
  );
