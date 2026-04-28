-- cellar27 — initial schema + Storage bucket + RLS
--
-- Apply via Supabase dashboard SQL editor (Project → SQL → New query → paste → Run),
-- or via the Supabase CLI: `supabase db push`.
--
-- Idempotent within reason: uses `if not exists` where possible. Re-running will
-- error on the policies; drop them first if iterating.

------------------------------------------------------------
-- Tables
------------------------------------------------------------

create table if not exists bottles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  producer text not null,
  wine_name text,
  varietal text not null,
  blend_components jsonb,
  vintage int,
  region text,
  country text,
  style text not null check (style in (
    'light_red','medium_red','full_red',
    'light_white','full_white',
    'rose','sparkling','dessert','fortified'
  )),
  sweetness text check (sweetness in ('bone_dry','dry','off_dry','sweet')),
  body int check (body between 1 and 5),
  quantity int not null default 1 check (quantity >= 0),
  storage_location text,
  acquired_date date,
  acquired_price numeric(10,2),
  drink_window_start int,
  drink_window_end int,
  drink_window_overridden boolean not null default false,
  notes text,
  label_image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bottles_user_idx on bottles(user_id);
create index if not exists bottles_drink_window_idx on bottles(drink_window_start, drink_window_end);

create table if not exists pairing_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  request_type text not null check (request_type in ('pairing','flight','drink_now')),
  context jsonb not null,
  cellar_snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','picked_up','completed','error')),
  picked_up_at timestamptz,
  error_message text
);

create index if not exists pairing_requests_status_idx on pairing_requests(status, created_at);
create index if not exists pairing_requests_user_idx on pairing_requests(user_id);

create table if not exists pairing_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references pairing_requests(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  recommendations jsonb not null,
  narrative text
);

create unique index if not exists pairing_responses_request_idx on pairing_responses(request_id);

create table if not exists scan_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  intent text not null check (intent in ('add','pour')),
  image_path text not null,
  context jsonb,
  cellar_snapshot jsonb,
  status text not null default 'pending' check (status in ('pending','picked_up','completed','error')),
  picked_up_at timestamptz,
  error_message text
);

create index if not exists scan_requests_status_idx on scan_requests(status, created_at);
create index if not exists scan_requests_user_idx on scan_requests(user_id);

create table if not exists scan_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references scan_requests(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  extracted jsonb,
  matched_bottle_id uuid references bottles(id),
  match_candidates jsonb,
  narrative text
);

create unique index if not exists scan_responses_request_idx on scan_responses(request_id);

------------------------------------------------------------
-- updated_at trigger for bottles
------------------------------------------------------------

create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists bottles_updated_at on bottles;
create trigger bottles_updated_at before update on bottles
  for each row execute function set_updated_at();

------------------------------------------------------------
-- Row-level security
------------------------------------------------------------

alter table bottles enable row level security;
alter table pairing_requests enable row level security;
alter table pairing_responses enable row level security;
alter table scan_requests enable row level security;
alter table scan_responses enable row level security;

create policy "users see own bottles" on bottles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users see own pairing requests" on pairing_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users see responses to own pairing requests" on pairing_responses
  for select using (
    exists (select 1 from pairing_requests pr where pr.id = pairing_responses.request_id and pr.user_id = auth.uid())
  );

create policy "users see own scan requests" on scan_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users see responses to own scan requests" on scan_responses
  for select using (
    exists (select 1 from scan_requests sr where sr.id = scan_responses.request_id and sr.user_id = auth.uid())
  );

------------------------------------------------------------
-- Storage bucket for bottle label photos
------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('bottle-labels', 'bottle-labels', false)
on conflict (id) do nothing;

-- Authenticated users may upload only under their own {user_id}/ prefix
create policy "users upload own labels" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users may read only their own files
create policy "users read own labels" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users update own labels" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users delete own labels" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
