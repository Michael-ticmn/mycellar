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

export function renderScanRequest(row, imagePath, respondToPath) {
  const fm = `---
request_id: ${row.id}
type: scan
intent: ${row.intent}
created: ${ISO(row.created_at)}
image_path: ${imagePath}
respond_to: ${respondToPath}
---`;

  const contextStr = row.context ? JSON.stringify(row.context, null, 2) : 'none';
  const cellarSection = row.intent === 'pour'
    ? `\n## Cellar\n${bottlesTable(row.cellar_snapshot, false)}\n`
    : '';

  const taskAdd = `For intent=add: extract structured wine metadata from the label image. Be honest about confidence — if a field isn't visible or you can't read it, return null and explain in narrative.`;
  const taskPour = `For intent=pour: identify the bottle in the image and match it to a row in the cellar table above. If multiple cellar rows could match, return all candidates with confidences.`;
  const task = row.intent === 'add' ? taskAdd : taskPour;

  return `${fm}

# cellar27 scan request

## Image
View the file at \`image_path\` above. It's a photo of a wine bottle label.

## Context
${typeof contextStr === 'string' && contextStr !== 'none' ? '```json\n' + contextStr + '\n```' : contextStr}
${cellarSection}
## Task
${task}

## Response format

\`\`\`markdown
---
request_id: ${row.id}
completed: <ISO timestamp>
---

## Extracted (intent=add only)
producer: <text or null>
wine_name: <text or null>
varietal: <text or null>           # single varietal name; for blends use "Red Blend" / "White Blend"
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
`;
}
