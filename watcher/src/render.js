// Render Supabase request rows into markdown files for Claude Code to read.

const ISO = (d) => new Date(d).toISOString();

// "Friday, May 1, 2026 — 11:14 AM CDT (America/Chicago)"
// Spelled out so Claude can reason about day-of-week without parsing ISO.
// The watcher runs on the owner's machine so Date / Intl reflect the
// local timezone the user actually lives in.
function nowContext() {
  const d = new Date();
  const dayDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  let tzName = '';
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  return `${dayDate} — ${time}${tzName ? ` (${tzName})` : ''}`;
}

// Build the "## Today" body. Includes weather if the caller fetched any
// (null when LOCATION_LAT/LON aren't configured or the API call failed —
// graceful degradation, never blocks the recommendation).
function todaySection(weather) {
  const lines = [nowContext()];
  if (weather) lines.push(`Weather: ${weather}`);
  return lines.join('\n');
}

function bottleRow(b) {
  const bits = [
    b.id,
    b.producer || '',
    b.wine_name || '',
    b.varietal || '',
    b.vintage ?? '',
    b.style || '',
    b.quantity ?? '',
    (b.drink_window_start && b.drink_window_end) ? `${b.drink_window_start}–${b.drink_window_end}` : '',
  ];
  return `| ${bits.join(' | ')} |`;
}

function bottlesTable(snapshot, includeQty = true) {
  const head = includeQty
    ? '| id | producer | wine | varietal | vintage | style | qty | drink window |'
    : '| id | producer | wine | varietal | vintage | qty |';
  const sep = includeQty ? '|----|----------|------|----------|---------|-------|-----|--------------|' : '|----|----------|------|----------|---------|-----|';
  const rows = (snapshot || [])
    .map(includeQty ? bottleRow : (b) => `| ${b.id} | ${b.producer || ''} | ${b.wine_name || ''} | ${b.varietal || ''} | ${b.vintage ?? ''} | ${b.quantity ?? ''} |`)
    .join('\n');
  return `${head}\n${sep}\n${rows || '_(empty)_'}`;
}

function expectedCount(type) {
  if (type === 'pairing')     return '1-2';
  if (type === 'flight')      return '3-5';
  if (type === 'flight_plan') return '0';
  return '1-3';
}

// Shared instruction appended to every task. The model has a habit of
// inventing atmosphere about the user's evening — "warm spring Friday",
// "Tuesday-feeling Friday", "save it for a special occasion" — based on
// no actual signal. That invented mood then drives the framing of the
// recommendation, which is wrong: the user only gave us the data in
// ## Today and ## Context. Don't editorialize beyond it.
const NO_INVENTED_CONTEXT = `\n\nIMPORTANT — narrative discipline:
- Only describe today using the actual day, date, and weather from the ## Today section above. Don't use day-name colloquialisms (no "a Tuesday", "Tuesday-feeling Friday", "save it for a Saturday", etc.). If you mean "weeknight" say "weeknight"; if you mean "special occasion" say "special occasion."
- Don't invent the user's mood, vibe, or occasion. If the ## Context section doesn't say it's casual / special / a date / low-key / celebratory, don't project any of those onto their evening. Recommend the wine for the dish and the data given, not for an atmosphere you imagined.
- Don't invent weather, season, or location specifics beyond what ## Today literally states.`;

function taskFor(type, ctx = {}) {
  let body;
  switch (type) {
    case 'pairing':
      body = `Pick 1–2 bottles from the cellar that pair best with the dish/context above. Consider sweetness, acidity, weight, and tannin in relation to the food. Prefer bottles in or entering their drink window. Avoid past-peak unless the user asked specifically. If quantity is 1, weigh whether opening it now is worth it.

ALSO always end the Narrative with a short "buy suggestion" section recommending exactly 1 specific wine (producer + wine name + vintage range, NOT from the cellar above) that would pair well with this dish, with an approximate retail price range. Frame it three ways depending on how strong your in-cellar pick was:

  - Cellar pick is **high confidence** → start the section with a level-3 heading "### Optional buy" and one sentence framing it as "if you want to expand your range for dishes like this, also worth picking up…"
  - Cellar pick is **medium confidence** → "### Worth buying" with one sentence framing it as a meaningful upgrade for next time you cook this.
  - Cellar pick is **low confidence**, OR your best pick required a real stretch → "### Better option" and frame it as "the wine that would actually nail this dish, if you're shopping" — make it clear the cellar pick is a compromise.

Keep the buy suggestion to 2–3 sentences max plus the price range. Don't pad. The buy suggestion does NOT go in the Recommendations array — only the in-cellar picks do.`;
      break;
    case 'flight':
      if (ctx.kind === 'extras') {
        body = `Suggest 1–2 specific wines (producer + wine name + vintage range, NOT from the user's cellar above) that would meaningfully round out their flight-building potential. ${ctx.theme_hint ? `Constraint or theme they're aiming for: ${ctx.theme_hint}.` : 'Look at gaps in their current cellar — varietals, regions, vintages, styles missing.'} For each suggestion include: producer + wine + vintage range, what flight it would unlock (with which existing bottles), why it fills a gap, and an approximate retail price range. Recommendations array stays EMPTY (these aren't owned); put the picks in the Narrative as a clearly formatted list.`;
      } else {
        body = `Build a tasting flight of 3–5 bottles in a deliberate order. Theme: ${ctx.theme || 'unspecified'}. Length: ${ctx.length || 3}. Each pick should teach the palate something in relation to the others; explain the progression in the narrative.`;
      }
      break;
    case 'drink_now':
      body = `Pick 1–3 bottles to drink soon. Prioritize bottles entering or already in peak window over later vintages. Consider quantity (don't recommend the last bottle of a hard-to-replace wine unless asked).`;
      break;
    case 'flight_plan':
      body = `The user has saved a tasting flight (see ## Saved flight) and wants you to plan the evening around it. Produce two things:

1) **Food** — 2–4 specific suggestions that work across the flight. Mark each as either a "meal" (a real plated course) or a "snack" (something to nibble between pours, or while talking before pour 1). Aim for one snack and one or two meal options unless the bottles strongly suggest otherwise. For each item give a short name and a one-sentence description.

2) **Prep** — concrete serving instructions per bottle:
   - chill: minutes in the fridge before pour (0 if it's already at serving temp; omit the line entirely if no chill needed)
   - open_by: minutes ahead to pull the cork to let the bottle breathe (omit if no breathing needed)
   - decant: include the bottle if it should be decanted, with a one-line "why"
   - glassware: type per bottle (Burgundy, Bordeaux, white, flute, universal, etc.)
   Plus a "notes" field with anything else (order of service if non-obvious, palate-cleanser, when to pour the snack, etc.).

Use the picks from ## Saved flight — do NOT recommend other bottles. The Recommendations array in the response stays empty.`;
      break;
    default:
      return `Unrecognized request_type: ${type}.`;
  }
  return body + NO_INVENTED_CONTEXT;
}

export function renderPairingRequest(row, respondToPath, weather = null) {
  const fm = `---
request_id: ${row.id}
type: ${row.request_type}
created: ${ISO(row.created_at)}
expected_count: "${expectedCount(row.request_type)}"
respond_to: ${respondToPath}
---`;

  const contextStr = JSON.stringify(row.context || {}, null, 2);

  // flight_plan operates on bottles already chosen — render the saved
  // flight as its own section and skip the wider cellar (the user isn't
  // asking us to repick).
  if (row.request_type === 'flight_plan') {
    const savedFlightSection = renderSavedFlightSection(row.context || {});
    return `${fm}

# cellar27 request

## Today
${todaySection(weather)}

## Context
\`\`\`json
${contextStr}
\`\`\`

${savedFlightSection}

## Task
${taskFor(row.request_type, row.context)}

## Response format
Write the response file at the path in \`respond_to\` with this structure:

\`\`\`markdown
---
request_id: ${row.id}
completed: <ISO timestamp>
---

## Recommendations
_(empty for flight_plan — the picks were already saved)_

## Plan
\`\`\`json
{
  "food": [
    { "kind": "meal",  "name": "...", "description": "..." },
    { "kind": "snack", "name": "...", "description": "..." }
  ],
  "prep": {
    "chill":     [{ "bottle_id": "<uuid from Saved flight>", "minutes": 30 }],
    "open_by":   [{ "bottle_id": "<uuid>", "minutes": 60 }],
    "decanters": [{ "bottle_id": "<uuid>", "why": "young, tight tannins" }],
    "glassware": [{ "bottle_id": "<uuid>", "type": "Burgundy" }],
    "notes": "..."
  }
}
\`\`\`

## Narrative
_(optional — short paragraph framing the night, or omit entirely)_
\`\`\`
`;
  }

  return `${fm}

# cellar27 request

## Today
${todaySection(weather)}

## Context
\`\`\`json
${contextStr}
\`\`\`

## Available cellar
${bottlesTable(row.cellar_snapshot, true)}

## Task
${taskFor(row.request_type, row.context)}

## Response format
Write the response file at the path in \`respond_to\` with this structure:

\`\`\`markdown
---
request_id: ${row.id}
completed: <ISO timestamp>
---

## Recommendations
- bottle_id: <uuid from cellar table above>
  confidence: high | medium | low
  reasoning: <1–2 sentences>
  alternatives: [<bottle_id>, ...]   # optional

## Narrative
<markdown — 2-4 paragraphs, the thoughtful take. This is what the user actually reads.>
\`\`\`
`;
}

// Render the picks + narrative from a saved planned flight as a markdown
// section the agent can reason about. The id column is critical — the
// food/prep response must reference the same bottle_ids.
function renderSavedFlightSection(ctx) {
  const picks = Array.isArray(ctx.picks) ? ctx.picks : [];
  const head = '| bottle_id | confidence | reasoning |';
  const sep  = '|-----------|------------|-----------|';
  const rows = picks.map((p) => {
    const reasoning = (p.reasoning || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    return `| ${p.bottle_id} | ${p.confidence || ''} | ${reasoning} |`;
  }).join('\n') || '_(no picks)_';
  const meta = [
    ctx.title         ? `**Title:** ${ctx.title}` : null,
    ctx.occasion_date ? `**Occasion date:** ${ctx.occasion_date}` : null,
    ctx.theme         ? `**Theme:** ${ctx.theme}` : null,
    ctx.guests        ? `**Guests:** ${ctx.guests}` : null,
  ].filter(Boolean).join(' · ');
  const narrative = ctx.narrative
    ? `\n### Original sommelier narrative\n${ctx.narrative}\n`
    : '';
  return `## Saved flight
${meta || '_(no metadata)_'}

### Picks
${head}
${sep}
${rows}
${narrative}`;
}

// images: array of { label: 'front'|'back'|..., path: '<absolute local path>' }
// existingBottle: only set for intent='enrich' (DB row, AI uses for context)
export function renderScanRequest(row, images, respondToPath, existingBottle = null, weather = null) {
  const fm = `---
request_id: ${row.id}
type: scan
intent: ${row.intent}
created: ${ISO(row.created_at)}
respond_to: ${respondToPath}
---`;

  const imagesSection = (images || []).length
    ? '## Images\n' + images.map((img) => `- **${img.label}**: \`${img.path}\``).join('\n')
    : '## Images\n_(none — enrichment-only)_';

  const contextStr = row.context ? JSON.stringify(row.context, null, 2) : null;
  const contextSection = contextStr
    ? `## Context\n\`\`\`json\n${contextStr}\n\`\`\``
    : '## Context\n_(none)_';

  const cellarSection = row.intent === 'pour'
    ? `## Cellar\n${bottlesTable(row.cellar_snapshot, false)}\n`
    : '';

  const bottleSection = (row.intent === 'enrich' && existingBottle)
    ? `## Bottle to enrich\n\`\`\`json\n${JSON.stringify(existingBottle, null, 2)}\n\`\`\`\n`
    : '';

  let task;
  if (row.intent === 'add') {
    task = `Extract structured wine metadata from the label image(s) AND produce rich enrichment (tasting notes, food pairings, producer background, drinking window rationale, serving recommendations). Use the back label if provided — it usually has tech sheet info (alcohol, blend %, winemaker notes). Be honest about extraction confidence: if a field isn't visible, return null. Enrichment may draw on your knowledge of the producer/region but should align with what the labels actually show.`;
  } else if (row.intent === 'pour') {
    task = `Identify the bottle in the image(s) and match it to a row in the cellar table above. If multiple cellar rows could match, return all candidates with confidences. Use both front and back labels if provided.`;
  } else if (row.intent === 'enrich') {
    task = `Produce rich enrichment for the bottle described in "Bottle to enrich". Include tasting notes, food pairings, producer background, drinking window rationale, and serving recommendations. Use your knowledge of the producer/region/varietal.`;
  } else {
    task = `Unknown intent: ${row.intent}`;
  }

  return `${fm}

# cellar27 scan request

## Today
${todaySection(weather)}

${imagesSection}

${contextSection}

${cellarSection}${bottleSection}## Task
${task}

## Response format

Write the response file at the path in \`respond_to\` with the following structure. Each block is JSON inside a fenced code block; use \`null\` for sections that don't apply to this intent.

\`\`\`markdown
---
request_id: ${row.id}
completed: <ISO timestamp>
---

## Extracted
(intent=add only — null otherwise)
\`\`\`json
{
  "producer": "...",
  "wine_name": "...",
  "varietal": "...",
  "blend_components": [{"varietal": "...", "pct": 60}],
  "vintage": 2018,
  "region": "...",
  "country": "...",
  "style": "light_red|medium_red|full_red|light_white|full_white|rose|sparkling|dessert|fortified",
  "sweetness": "bone_dry|dry|off_dry|sweet",
  "body": 4,
  "confidence": "high|medium|low"
}
\`\`\`

## Match
(intent=pour only — null otherwise)
\`\`\`json
{
  "matched_bottle_id": "<uuid or null>",
  "match_candidates": [
    { "bottle_id": "<uuid>", "confidence": "high|medium|low", "reasoning": "..." }
  ]
}
\`\`\`

## Details
(intent=add or enrich — null for pour)
\`\`\`json
{
  "tasting_notes": { "aroma": "...", "palate": "...", "finish": "..." },
  "food_pairings": ["...", "..."],
  "producer_background": "...",
  "region_context": "...",
  "drinking_window_rationale": "...",
  "serving": { "temp_celsius": 16, "decant_minutes": 30, "glass": "..." }
}
\`\`\`

## Narrative
<markdown — what you see on the label(s), what was hard to read, the thoughtful summary>
\`\`\`
`;
}
