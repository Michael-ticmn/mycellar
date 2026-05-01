// Parse Claude Code's response files. Tolerant of formatting drift.

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const fmRaw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const frontmatter = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter, body };
}

// Extract a section by ## heading. Returns text between this heading
// and the next ## (or end of body), trimmed.
//
// (Earlier version used a regex with `\Z` for end-of-string — that's a
// PCRE thing; in JavaScript regex `\Z` is literal "Z", which made the
// last section in a response fail to close.)
function section(body, heading) {
  const lines = body.split('\n');
  const startRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

// Pull the first ```json ... ``` fenced block out of a section. Returns
// parsed object, or null if missing / empty / "null" literal / unparseable.
function extractJson(sectionText) {
  if (!sectionText) return null;
  const fenceMatch = sectionText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const raw = fenceMatch ? fenceMatch[1].trim() : sectionText.trim();
  if (!raw || /^null$/i.test(raw)) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

// ─────────────── pairing response (unchanged shape) ───────────────

function parseRecommendations(text) {
  if (!text) return [];
  const recs = [];
  const blocks = text.split(/^-\s+bottle_id\s*:/m).slice(1);
  for (const block of blocks) {
    const rec = {};
    const idMatch = block.match(/^\s*([0-9a-f-]{36}|<[^>]+>)/i);
    if (idMatch) rec.bottle_id = idMatch[1];
    const conf = block.match(/^\s*confidence\s*:\s*(\w+)/im);
    if (conf) rec.confidence = conf[1].toLowerCase();
    const reason = block.match(/^\s*reasoning\s*:\s*(.+?)(?=\n\s*\w+\s*:|\n\s*$|$)/ims);
    if (reason) rec.reasoning = reason[1].trim();
    const alts = block.match(/^\s*alternatives\s*:\s*\[([^\]]*)\]/im);
    if (alts) {
      rec.alternatives = alts[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    if (rec.bottle_id) recs.push(rec);
  }
  return recs;
}

export function parsePairingResponse(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  // ## Plan section is only emitted by flight_plan responses; for every
  // other request_type it'll be missing and payload stays null.
  const plan = extractJson(section(body, 'Plan'));
  return {
    frontmatter,
    recommendations: parseRecommendations(section(body, 'Recommendations')),
    narrative: section(body, 'Narrative') || null,
    payload: plan || null,
  };
}

// ─────────────── scan response (JSON blocks) ───────────────

export function parseScanResponse(text) {
  const { frontmatter, body } = splitFrontmatter(text);

  const extracted = extractJson(section(body, 'Extracted'));
  const match = extractJson(section(body, 'Match'));
  const details = extractJson(section(body, 'Details'));
  const narrative = section(body, 'Narrative') || null;

  return {
    frontmatter,
    extracted,
    matched_bottle_id: match?.matched_bottle_id ?? null,
    match_candidates: match?.match_candidates ?? null,
    details,
    narrative,
  };
}
