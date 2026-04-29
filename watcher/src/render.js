// Render Supabase request rows into markdown files for Claude Code to read.

const ISO = (d) => new Date(d).toISOString();

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
  return type === 'pairing' ? '1-2' : type === 'flight' ? '3-5' : '1-3';
}

function taskFor(type, ctx = {}) {
  switch (type) {
    case 'pairing':
      return `Pick 1–2 bottles from the cellar that pair best with the dish/context above. Consider sweetness, acidity, weight, and tannin in relation to the food. Prefer bottles in or entering their drink window. Avoid past-peak unless the user asked specifically. If quantity is 1, weigh whether opening it now is worth it.`;
    case 'flight':
      return `Build a tasting flight of 3–5 bottles in a deliberate order. Theme: ${ctx.theme || 'unspecified'}. Length: ${ctx.length || 3}. Each pick should teach the palate something in relation to the others; explain the progression in the narrative.`;
    case 'drink_now':
      return `Pick 1–3 bottles to drink soon. Prioritize bottles entering or already in peak window over later vintages. Consider quantity (don't recommend the last bottle of a hard-to-replace wine unless asked).`;
    default:
      return `Unrecognized request_type: ${type}.`;
  }
}

export function renderPairingRequest(row, respondToPath) {
  const fm = `---
request_id: ${row.id}
type: ${row.request_type}
created: ${ISO(row.created_at)}
expected_count: "${expectedCount(row.request_type)}"
respond_to: ${respondToPath}
---`;

  const contextStr = JSON.stringify(row.context || {}, null, 2);

  return `${fm}

# cellar27 request

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

// images: array of { label: 'front'|'back'|..., path: '<absolute local path>' }
// existingBottle: only set for intent='enrich' (DB row, AI uses for context)
export function renderScanRequest(row, images, respondToPath, existingBottle = null) {
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
