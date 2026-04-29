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
// and the next ## (or EOF), trimmed.
function section(body, heading) {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = body.match(re);
  return m ? m[1].trim() : '';
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
  return {
    frontmatter,
    recommendations: parseRecommendations(section(body, 'Recommendations')),
    narrative: section(body, 'Narrative') || null,
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
