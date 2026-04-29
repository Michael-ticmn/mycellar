# cellar27 — BUILD_SPEC.md

This is the technical plan. Code executes against this. Strategy decisions live in STRATEGY.md — read that first.

---

## Repos to create

1. **`cellar27`** (public) — GitHub Pages frontend. Static HTML/CSS/JS.
2. **`cellar27-watcher`** (private) — Node service running on the win11 VM. Subscribes to Supabase Realtime, manages the file-drop bridge.

---

## Phase 1 — Foundation (Code starts here)

### 1.1 Supabase project setup
- New Supabase project named `cellar27`
- Enable email/password auth (single-user for now; row-level security on `user_id`)
- Generate anon key for frontend, service role key for the watcher (watcher only — never in frontend)
- **Create Storage bucket `bottle-labels`** (private). Policy: authenticated users can upload to a `{user_id}/` prefix and read their own files. Watcher reads via service role.

### 1.2 Schema migration

```sql
-- bottles: the cellar
create table bottles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  producer text not null,
  wine_name text,
  varietal text not null,
  blend_components jsonb,           -- null unless blend; e.g. [{"varietal":"Cabernet Sauvignon","pct":60}]
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
  label_image_path text,            -- path in Supabase Storage; null until first scan
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bottles_user_idx on bottles(user_id);
create index bottles_drink_window_idx on bottles(drink_window_start, drink_window_end);

-- pairing_requests: outbound to the bridge
create table pairing_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  request_type text not null check (request_type in ('pairing','flight','drink_now')),
  context jsonb not null,           -- dish, cuisine, guest_count, occasion, constraints, etc.
  cellar_snapshot jsonb not null,   -- bottles array at request time
  status text not null default 'pending' check (status in ('pending','picked_up','completed','error')),
  picked_up_at timestamptz,
  error_message text
);

create index pairing_requests_status_idx on pairing_requests(status, created_at);
create index pairing_requests_user_idx on pairing_requests(user_id);

-- pairing_responses: inbound from the bridge
create table pairing_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references pairing_requests(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  recommendations jsonb not null,   -- [{bottle_id, reasoning, confidence, alternatives}]
  narrative text                    -- markdown, the thoughtful take
);

create unique index pairing_responses_request_idx on pairing_responses(request_id);

-- scan_requests: outbound vision requests (add OR pour)
create table scan_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  intent text not null check (intent in ('add','pour')),
  image_path text not null,         -- Supabase Storage path
  context jsonb,                    -- optional hints from user (e.g. "I think this is the 2018 Napa cab")
  cellar_snapshot jsonb,            -- only populated for intent='pour' so Code can match
  status text not null default 'pending' check (status in ('pending','picked_up','completed','error')),
  picked_up_at timestamptz,
  error_message text
);

create index scan_requests_status_idx on scan_requests(status, created_at);
create index scan_requests_user_idx on scan_requests(user_id);

-- scan_responses: vision results
create table scan_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references scan_requests(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  -- For intent='add': extracted fields user will review/edit before saving
  extracted jsonb,                  -- {producer, wine_name, varietal, vintage, region, country, style, sweetness, body, confidence}
  -- For intent='pour': matched cellar bottle(s)
  matched_bottle_id uuid references bottles(id),
  match_candidates jsonb,           -- [{bottle_id, confidence, reasoning}] when ambiguous
  narrative text                    -- markdown explanation; helpful when extraction is uncertain
);

create unique index scan_responses_request_idx on scan_responses(request_id);

-- RLS: every table scoped to user_id
alter table bottles enable row level security;
alter table pairing_requests enable row level security;
alter table pairing_responses enable row level security;
alter table scan_requests enable row level security;
alter table scan_responses enable row level security;

create policy "users see own bottles" on bottles
  for all using (auth.uid() = user_id);

create policy "users see own requests" on pairing_requests
  for all using (auth.uid() = user_id);

create policy "users see responses to own requests" on pairing_responses
  for select using (
    exists (select 1 from pairing_requests pr where pr.id = pairing_responses.request_id and pr.user_id = auth.uid())
  );

create policy "users see own scan requests" on scan_requests
  for all using (auth.uid() = user_id);

create policy "users see own scan responses" on scan_responses
  for select using (
    exists (select 1 from scan_requests sr where sr.id = scan_responses.request_id and sr.user_id = auth.uid())
  );

-- updated_at trigger for bottles
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger bottles_updated_at before update on bottles
  for each row execute function set_updated_at();
```

### 1.3 Frontend skeleton (cellar27 repo)

Single-page static app. File layout:

```
cellar27/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── supabase-client.js   -- init, exported singleton
│   ├── auth.js              -- login/logout, session handling
│   ├── bottles.js           -- CRUD on bottles table
│   ├── pairings.js          -- request creation + response polling/subscribe
│   ├── scan.js              -- camera capture, upload, scan_requests + response handling
│   ├── varietal-windows.js  -- lookup table for drink-by auto-suggest
│   └── app.js               -- main controller, view routing
├── views/
│   ├── cellar.html          -- visual grid of bottles (label photos)
│   ├── add-bottle.html      -- form (post-scan review OR manual entry)
│   ├── scan.html            -- camera capture UI (add or pour)
│   ├── pairing.html         -- "what to drink with X" UI
│   ├── flight.html          -- "build a tasting flight" UI
│   └── drink-now.html       -- bottles in/entering peak
└── README.md
```

Use Supabase JS v2 from CDN. No build step. No framework.

**Color palette proposal** (Code: post in BUILD_LOG before applying):
- Background: `#1a0f0f` (very dark oxblood)
- Surface: `#2d1818`
- Accent: `#8b1a1a` (burgundy)
- Highlight: `#d4a574` (warm sand, for tasting notes / drink-now badges)
- Text: `#f5e6d3` (cream)

Fonts: system stack, but use a serif (Cormorant or similar) for bottle producer/name display to lean into the wine-list aesthetic.

### 1.4 Varietal → drink-window lookup

Build `js/varietal-windows.js` as a const map. Format:
```js
export const VARIETAL_WINDOWS = {
  'Cabernet Sauvignon': { years_after_vintage: [3, 15], peak: [5, 12] },
  'Pinot Noir':         { years_after_vintage: [2, 8],  peak: [3, 6] },
  'Chardonnay':         { years_after_vintage: [1, 5],  peak: [2, 4] },
  // ... etc
};
```

Code: source defaults from standard wine references, flag any you're unsure about so Chat can confirm.

When user adds a bottle:
- If varietal matches the table and `drink_window_overridden` is false, auto-fill `drink_window_start = vintage + years_after_vintage[0]`, `drink_window_end = vintage + years_after_vintage[1]`
- User can override either field; setting either flips `drink_window_overridden = true`

---

## Phase 2 — The bridge

### 2.1 Watcher (cellar27-watcher repo)

Node 20+. Runs on win11 VM. Single process.

**Dependencies:** `@supabase/supabase-js`, `chokidar`, `dotenv`.

**Behavior:**

```
on startup:
  - read .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_DIR)
  - ensure ~/cellar27-bridge/{requests,responses,processed,images}/ exist
  - subscribe to pairing_requests Realtime channel filtered on status='pending'
  - subscribe to scan_requests    Realtime channel filtered on status='pending'
  - start chokidar watching ~/cellar27-bridge/responses/

on new pending pairing_request row:
  - update row status='picked_up', picked_up_at=now()
  - render request file from template (see Bridge Contract below)
  - write to ~/cellar27-bridge/requests/req-{uuid}.md

on new pending scan_request row:
  - update row status='picked_up', picked_up_at=now()
  - download image from Supabase Storage (image_path) to ~/cellar27-bridge/images/{uuid}.{ext}
  - render scan request file referencing the local image path
  - write to ~/cellar27-bridge/requests/scan-{uuid}.md

on new file in ~/cellar27-bridge/responses/req-{uuid}.md (pairing) or scan-{uuid}.md (scan):
  - parse frontmatter + sections
  - insert into pairing_responses OR scan_responses (based on filename prefix)
  - update parent request status='completed'
  - move request + response to ~/cellar27-bridge/processed/
  - delete corresponding image from ~/cellar27-bridge/images/ (Storage copy is the durable record)

on parse error or timeout (>10 min in picked_up):
  - update request status='error' with error_message
  - log
```

**Process management:** PM2 with auto-restart and log rotation. Document setup in watcher README. Tailscale unattended mode is already running so the VM stays reachable for debugging.

### 2.2 Bridge contract — request file format

`~/cellar27-bridge/requests/req-{uuid}.md`:

```markdown
---
request_id: <uuid>
type: pairing | flight | drink_now
created: 2026-04-28T19:42:00Z
expected_count: "1-2" | "3-5" | "1-3"
respond_to: ~/cellar27-bridge/responses/req-<uuid>.md
---

# cellar27 request

## Context
{{context as readable markdown — dish, cuisine, guests, occasion, constraints}}

## Available cellar
| id | producer | wine | varietal | vintage | style | qty | drink window |
|----|----------|------|----------|---------|-------|-----|--------------|
{{rows from cellar_snapshot}}

## Task
{{task instructions specific to request_type}}

## Response format
Write the response file at the path in `respond_to` with this structure:

\`\`\`markdown
---
request_id: <uuid>
completed: <ISO timestamp>
---

## Recommendations
- bottle_id: <uuid from cellar table above>
  confidence: high | medium | low
  reasoning: <1-2 sentences>
  alternatives: [<bottle_id>, ...]   # optional, other cellar bottles that would also work

## Narrative
<markdown — 2-4 paragraphs, the thoughtful take. This is what the user actually reads.>
\`\`\`
```

### 2.2b Bridge contract — scan request file format

`~/cellar27-bridge/requests/scan-{uuid}.md`:

```markdown
---
request_id: <uuid>
type: scan
intent: add | pour
created: 2026-04-28T19:42:00Z
image_path: ~/cellar27-bridge/images/<uuid>.jpg
respond_to: ~/cellar27-bridge/responses/scan-<uuid>.md
---

# cellar27 scan request

## Image
View the file at `image_path` above. It's a photo of a wine bottle label.

## Context
{{any user-provided hints, or "none"}}

## Cellar (only present for intent=pour)
| id | producer | wine | varietal | vintage | qty |
|----|----------|------|----------|---------|-----|
{{cellar rows}}

## Task

For intent=add:
Extract structured wine metadata from the label image. Be honest about confidence —
if a field isn't visible or you can't read it, return null and explain in narrative.

For intent=pour:
Identify the bottle in the image and match it to a row in the cellar table above.
If multiple cellar rows could match, return all candidates with confidences.

## Response format

\`\`\`markdown
---
request_id: <uuid>
completed: <ISO timestamp>
---

## Extracted (intent=add only)
producer: <text or null>
wine_name: <text or null>
varietal: <text or null>           # single varietal name; for blends, use "Red Blend" / "White Blend"
blend_components: <yaml list or null>
vintage: <int or null>
region: <text or null>
country: <text or null>
style: <one of light_red|medium_red|full_red|light_white|full_white|rose|sparkling|dessert|fortified or null>
sweetness: <bone_dry|dry|off_dry|sweet or null>
body: <1-5 or null>
confidence: high | medium | low

## Match (intent=pour only)
matched_bottle_id: <uuid or null>
match_candidates:
  - bottle_id: <uuid>
    confidence: high | medium | low
    reasoning: <1 sentence>

## Narrative
<markdown — what you see on the label, what was hard to read, why you chose what you chose>
\`\`\`
```

### 2.3 Claude Code monitoring

Code on the VM auto-monitors `~/cellar27-bridge/requests/`. When a new request file appears:
- Read it
- Reason about pairings using the cellar snapshot
- Write the response file to the path in `respond_to`
- Don't move or delete the request file — the watcher handles cleanup

This is a long-running Claude Code session. Document the launch command in the watcher README ("To accept cellar27 requests: in the bridge directory, run `claude code` with this prompt: ...").

---

## Phase 3 — UX details

### 3.1 Scan to add (default add flow)
1. User taps "Add Bottle" → camera opens (`getUserMedia`, rear camera preferred)
2. User snaps the label, sees preview, taps "Use this" or "Retake"
3. On confirm: image uploads to Supabase Storage at `bottle-labels/{user_id}/{timestamp}-{uuid}.jpg`
4. Insert `scan_request` with `intent='add'` and `image_path`
5. Show "identifying..." with the request id; subscribe to `scan_responses` for this request
6. On response: pre-fill the add-bottle form with extracted fields. Confidence shown per field. User reviews, edits, fills any nulls, taps "Save"
7. Save creates the `bottles` row with `label_image_path` set to the Storage path
8. If extraction returns mostly nulls or `confidence: low`, the form opens in manual-entry mode with the photo attached but no pre-fill — user enters by hand. The photo is still preserved.

### 3.1b Manual add fallback
- "Add manually" link in the scan view → form opens with no photo, all fields empty
- Same form Code uses for the post-scan review step
- Form: producer, wine name, varietal (autocomplete from VARIETAL_WINDOWS keys, free-text fallback), vintage, region, style (dropdown), sweetness, body slider, quantity, storage location, acquired date/price (optional), notes
- On varietal+vintage entered, drink window auto-populates with a "✏️ override" affordance

### 3.1c Scan to pour
1. User taps "Pour" in nav → camera opens
2. Snap label → preview → confirm
3. Insert `scan_request` with `intent='pour'`, `image_path`, and `cellar_snapshot` (so Code can match against owned bottles)
4. On response:
   - If `matched_bottle_id` is set: show "Pouring [Producer Wine Vintage] — quantity X → X-1" with confirm/cancel
   - If `match_candidates` has multiple: show a picker
   - If no match: offer "Add as new bottle" (pivots into the add flow with the photo already captured)
5. On confirm: decrement quantity, show toast with undo

### 3.2 Cellar view
- Default: visual grid of cards, label photo as the card face
- Bottles without photos (manual entries) show a placeholder with producer/wine in serif
- Filters: style, region, drink-now, search
- Sort: producer, vintage, drink_window_end, recently added
- Quantity badge on each card
- Tap a card → detail view with the larger label photo, all fields, and a "Pour" button (decrement -1 with undo toast). This is the no-camera tap-to-pour path.

### 3.3 Pairing flow
1. User clicks "What should I open?"
2. Form: dish description (free text), guest count, occasion (dropdown: weeknight / dinner party / celebration / casual), any constraints (free text)
3. Submit → insert pairing_request with cellar_snapshot, show "thinking..." with the request id
4. Subscribe to pairing_responses where request_id = this
5. On response arrival, render: recommendations (bottle cards highlighted in the user's cellar) + narrative below

### 3.4 Flight builder flow
- Same shape as pairing but the form asks: theme (vertical / horizontal / varietal comparison / regional tour / surprise me), guest count, length (3 / 5 bottles)
- Response renders as an ordered flight with notes on what each bottle is teaching the palate

### 3.5 Drink-now view
- Auto-populated from `drink_window_start <= current_year <= drink_window_end`
- Sub-sections: "Past peak — drink soon", "In peak window", "Entering peak this year"
- Each card has a "Get pairing for this bottle" shortcut that pre-fills the pairing form with the bottle locked in

---

## Phase 4 — Polish (post-launch)

Do not start until Phase 1–3 are functional and the owner has used it once for a real meal.

- Tasting log: after drinking, capture impressions; feeds back into future pairing context
- Photo upload for bottles (Supabase Storage)
- Export / share a flight as a printable card for guests
- Mobile-specific layout pass

---

## Things Code should NOT do without checking with Chat

- Change the bridge architecture (file drop is decided)
- Add a build step / framework (vanilla JS is decided)
- Add dependencies to the frontend beyond Supabase JS (keep the dependency surface small)
- Push anything to GitHub Pages until the owner confirms the palette and layout
- Send `acquired_price` into the bridge (price is private metadata, not pairing-relevant)
- Add barcode scanning, an external wine API, or any local cache of scanned wines (explicitly out of scope for v1 — every scan goes fresh through the bridge)
- Compress label images aggressively. Code may resize to a max dimension (e.g. 1600px long edge) for upload speed, but should preserve enough resolution for vision to read fine print on the label.

---

## Definition of done for v1

- [ ] User can sign in, see an empty cellar
- [ ] **Scan to add**: snap a label, vision returns extracted fields, user reviews and saves with the photo attached
- [ ] **Manual add fallback**: works when scan fails or for bottles without bringing the camera
- [ ] **Tap to pour**: bottle card → Pour button → decrement with undo
- [ ] **Scan to pour**: snap a label, vision matches against cellar, user confirms decrement
- [ ] Cellar view shows label photos in a grid
- [ ] Drink-by auto-fills from varietal lookup, override works
- [ ] Pairing request round-trips through the bridge and renders a response
- [ ] Flight request round-trips and renders an ordered flight
- [ ] Drink-now view shows correctly-windowed bottles
- [ ] Watcher runs unattended on the VM with PM2, handles both pairing and scan request types
- [ ] README in each repo with setup steps
