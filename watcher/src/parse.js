// Parse Claude Code's response files. Tolerant — Claude may format
// recommendations as a YAML-ish list or a bulleted list; we accept both.

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

// Extract a section by ## heading. Returns the text between this heading
// and the next ## (or EOF), trimmed.
function section(body, heading) {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

function parseRecommendations(text) {
  if (!text) return [];
  const recs = [];
  // Split on lines starting with "- bottle_id:" — each block is one rec.
  const blocks = text.split(/^-\s+bottle_id\s*:/m).slice(1);
  for (const block of blocks) {
    const rec = {};
    // The bottle_id is the first thing in the split residue.
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
  const recsText = section(body, 'Recommendations');
  const narrative = section(body, 'Narrative');
  return {
    frontmatter,
    recommendations: parseRecommendations(recsText),
    narrative: narrative || null,
  };
}

function parseYamlScalars(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\w_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v === '' || /^null$/i.test(v)) v = null;
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    else if (/^-?\d+\.\d+$/.test(v)) v = parseFloat(v);
    else v = v.replace(/^["']|["']$/g, '');
    out[m[1]] = v;
  }
  return out;
}

export function parseScanResponse(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  const extractedTxt = section(body, 'Extracted') || section(body, 'Extracted \\(intent=add only\\)');
  const matchTxt = section(body, 'Match') || section(body, 'Match \\(intent=pour only\\)');
  const narrative = section(body, 'Narrative');

  const extracted = extractedTxt ? parseYamlScalars(extractedTxt) : null;
  let matched_bottle_id = null;
  let match_candidates = null;
  if (matchTxt) {
    const m = matchTxt.match(/^\s*matched_bottle_id\s*:\s*(.+)$/im);
    if (m) {
      const v = m[1].trim();
      matched_bottle_id = (v === '' || /^null$/i.test(v)) ? null : v.replace(/^["']|["']$/g, '');
    }
    const candBlocks = matchTxt.split(/^\s*-\s+bottle_id\s*:/m).slice(1);
    if (candBlocks.length) {
      match_candidates = candBlocks.map((blk) => {
        const id = (blk.match(/^\s*([0-9a-f-]{36})/i) || [])[1] || null;
        const conf = (blk.match(/^\s*confidence\s*:\s*(\w+)/im) || [])[1] || null;
        const reason = (blk.match(/^\s*reasoning\s*:\s*(.+)/im) || [])[1] || null;
        return { bottle_id: id, confidence: conf?.toLowerCase() || null, reasoning: reason?.trim() || null };
      });
    }
  }

  return {
    frontmatter,
    extracted,
    matched_bottle_id,
    match_candidates,
    narrative: narrative || null,
  };
}
