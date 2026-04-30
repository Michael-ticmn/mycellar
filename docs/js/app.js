import { getSession, signIn, signUp, onAuthChange } from './auth.js';
import { listBottles, createBottle, deleteBottle, pourBottle, undoPour, getBottle, updateBottle, findDuplicate } from './bottles.js';
import { VARIETAL_NAMES, suggestDrinkWindow } from './varietal-windows.js';
import { requestPairing, requestFlight, requestFlightExtras, requestDrinkNow } from './pairings.js';
import {
  startCamera, stopCamera, captureFrame,
  uploadCapture, submitScanRequest, waitForScanResponse,
  subscribeForResponse, signedUrlForImage, requestEnrichment,
} from './scan.js';

const STYLES = [
  'light_red','medium_red','full_red',
  'light_white','full_white',
  'rose','sparkling','dessert','fortified',
];
const SWEETNESS_OPTS = ['bone_dry','dry','off_dry','sweet'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Routing (hash-based, supports `bottle/<id>`) ──────────────────
const ROUTES = ['cellar', 'add', 'edit', 'pairing', 'flight', 'drink-now', 'scan', 'bottle'];
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [route, ...params] = h.split('/');
  return { route: ROUTES.includes(route) ? route : 'cellar', params };
}
async function loadView(name) {
  // Edit reuses the add view (form is identical; submit handler differs).
  const file = name === 'edit' ? 'add' : name;
  const res = await fetch(`views/${file}.html`);
  return res.ok ? res.text() : `<p>View not found: ${name}</p>`;
}

async function render(providedSession) {
  const session = providedSession !== undefined ? providedSession : await getSession();
  if (!session) { renderAuth(); return; }
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#user-email').textContent = session.user.email;

  const { route, params } = parseHash();
  $$('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });

  $('#main').innerHTML = await loadView(route);
  await mountView(route, params);
}

async function mountView(route, params = []) {
  switch (route) {
    case 'cellar':     return mountCellar();
    case 'add':        return mountAddBottle();
    case 'edit':       return mountAddBottle(params[0]);
    case 'drink-now':  return mountDrinkNow();
    case 'pairing':    return mountPairing();
    case 'flight':     return mountFlight();
    case 'scan':       return mountScan();
    case 'bottle':     return mountBottleDetail(params[0]);
  }
}

// ── Cellar grid (with search / filter / sort) ─────────────────────
const STYLE_GROUPS = {
  red:       ['light_red', 'medium_red', 'full_red'],
  white:     ['light_white', 'full_white'],
  rose:      ['rose'],
  sparkling: ['sparkling'],
  sweet:     ['dessert', 'fortified'],
};

async function mountCellar() {
  const grid = $('#cellar-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="muted">Loading…</p>';
  let bottles;
  try { bottles = await listBottles(); }
  catch (e) { grid.innerHTML = `<p class="error">${e.message}</p>`; return; }
  if (!bottles.length) {
    grid.innerHTML = '<p class="muted">Empty cellar. <a href="#/scan">Scan a bottle →</a> or <a href="#/add">add manually</a>.</p>';
    return;
  }

  // Filter / sort / search state
  let activeFilter = 'all';
  let sortMode = $('#cellar-sort')?.value || 'recent';
  let searchTerm = '';

  const repaint = () => {
    let view = bottles.slice();

    // Filter by style group
    if (activeFilter !== 'all') {
      const allowed = new Set(STYLE_GROUPS[activeFilter] || []);
      view = view.filter((b) => allowed.has(b.style));
    }

    // Search across producer, wine_name, varietal, region, country
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      view = view.filter((b) => [b.producer, b.wine_name, b.varietal, b.region, b.country]
        .some((s) => (s || '').toLowerCase().includes(q)));
    }

    // Sort
    const cmp = {
      recent:         (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
      producer:       (a, b) => (a.producer || '').localeCompare(b.producer || ''),
      vintage:        (a, b) => (b.vintage || 0) - (a.vintage || 0),
      vintage_oldest: (a, b) => (a.vintage || 9999) - (b.vintage || 9999),
      drink_end:      (a, b) => (a.drink_window_end || 9999) - (b.drink_window_end || 9999),
    }[sortMode] || (() => 0);
    view.sort(cmp);

    const count = $('#cellar-count');
    if (count) {
      count.hidden = view.length === bottles.length && !searchTerm && activeFilter === 'all';
      count.textContent = `${view.length} of ${bottles.length} bottles`;
    }

    if (!view.length) {
      grid.innerHTML = '<p class="muted">No bottles match.</p>';
      return;
    }
    grid.innerHTML = view.map(bottleCardHTML).join('');
    $$('.bottle-card', grid).forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = card.dataset.bottleId;
        if (id) location.hash = `#/bottle/${id}`;
      });
    });
    $$('[data-pour]',   grid).forEach((btn) => btn.addEventListener('click', onPour));
    $$('[data-delete]', grid).forEach((btn) => btn.addEventListener('click', onDelete));
  };

  // Wire toolbar
  const search = $('#cellar-search');
  if (search) search.addEventListener('input', (e) => { searchTerm = e.target.value.trim(); repaint(); });
  const sort = $('#cellar-sort');
  if (sort) sort.addEventListener('change', (e) => { sortMode = e.target.value; repaint(); });
  $$('#cellar-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#cellar-filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.styleFilter;
      repaint();
    });
  });

  repaint();
}

function bottleCardHTML(b) {
  const window = (b.drink_window_start && b.drink_window_end)
    ? `${b.drink_window_start}–${b.drink_window_end}`
    : '—';
  return `
    <article class="bottle-card" data-bottle-id="${b.id}" data-style="${escapeAttr(b.style || '')}" tabindex="0">
      <div class="bottle-photo placeholder">${escapeHtml((b.producer || '?')[0])}</div>
      <div class="bottle-meta">
        <h3>${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h3>
        <p class="muted">
          ${escapeHtml(b.varietal)}${b.vintage ? ` · ${b.vintage}` : ''}
          ${b.region ? ` · ${escapeHtml(b.region)}` : ''}
        </p>
        <p class="meta-row">
          <span class="qty">×${b.quantity}</span>
          <span class="window">drink ${window}</span>
        </p>
        <div class="actions">
          <button data-pour="${b.id}" ${b.quantity <= 0 ? 'disabled' : ''}>Pour</button>
          <button data-delete="${b.id}" class="ghost">Delete</button>
        </div>
      </div>
    </article>`;
}

async function onPour(e) {
  const id = e.currentTarget.dataset.pour;
  try {
    await pourBottle(id);
    showToast('Poured. Undo?', { actionLabel: 'Undo', onAction: () => undoPour(id).then(() => render()) });
    render();
  } catch (err) { alert(err.message); }
}
async function onDelete(e) {
  const id = e.currentTarget.dataset.delete;
  if (!confirm('Delete this bottle?')) return;
  try { await deleteBottle(id); render(); }
  catch (err) { alert(err.message); }
}

// ── Add / Edit bottle (manual) ────────────────────────────────────
async function mountAddBottle(bottleId) {
  const form = $('#add-bottle-form');
  if (!form) return;

  const dl = $('#varietal-options');
  if (dl) dl.innerHTML = VARIETAL_NAMES.map((v) => `<option value="${v}">`).join('');
  const styleSel = form.style;
  if (styleSel) styleSel.innerHTML = STYLES.map((s) => `<option value="${s}">${s}</option>`).join('');

  // Edit mode: prefill from existing row + change page heading.
  let existing = null;
  if (bottleId) {
    try { existing = await getBottle(bottleId); }
    catch (err) {
      $('#main').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const heading = $('#main h1');
    if (heading) heading.textContent = 'Edit bottle';
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Save changes';
    for (const f of ['producer','wine_name','varietal','vintage','region','country','style','sweetness','body','quantity','storage_location','acquired_date','acquired_price','drink_window_start','drink_window_end','notes']) {
      const el = form.elements[f];
      if (el && existing[f] != null) el.value = existing[f];
    }
  }

  const updateWindowHint = () => {
    const v = form.varietal.value;
    const s = form.style.value;
    const yr = parseInt(form.vintage.value, 10);
    if (!yr) { $('#window-hint').textContent = ''; return; }
    const { start, end } = suggestDrinkWindow({ varietal: v, style: s, vintage: yr });
    $('#window-hint').textContent = (start && end)
      ? `Auto: ${start}–${end} (override below if you disagree)`
      : 'No window suggestion for this varietal/style';
    if (start && !form.drink_window_start.value) form.drink_window_start.placeholder = start;
    if (end && !form.drink_window_end.value) form.drink_window_end.placeholder = end;
  };
  ['varietal','style','vintage'].forEach((n) => form[n].addEventListener('input', updateWindowHint));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = collectBottleFields(fd);
    try {
      if (bottleId) {
        await updateBottle(bottleId, input);
        location.hash = `#/bottle/${bottleId}`;
      } else {
        const created = await createBottle(input);
        location.hash = `#/bottle/${created.id}`;
        // Background: ask the sommelier for enrichment so the detail page
        // fills in tasting notes etc without the user clicking anything.
        autoEnrich(created.id);
      }
    } catch (err) { alert(err.message); }
  });
}

// Tracks bottles currently being enriched so the detail view can show a
// "Fetching sommelier notes…" banner instead of the Get-details button.
const enrichingBottles = new Set();
async function autoEnrich(bottleId) {
  if (enrichingBottles.has(bottleId)) return;
  enrichingBottles.add(bottleId);
  try {
    const response = await requestEnrichment(bottleId);
    const details = response.extracted?.details || response.extracted || null;
    if (details) {
      await updateBottle(bottleId, { details });
      // If the user is still on this bottle's detail page, re-render with details.
      if (location.hash === `#/bottle/${bottleId}`) render();
    }
  } catch (err) {
    console.warn('[cellar27] autoEnrich failed:', err);
  } finally {
    enrichingBottles.delete(bottleId);
  }
}

function collectBottleFields(fd) {
  return {
    producer: fd.get('producer').trim(),
    wine_name: fd.get('wine_name')?.trim() || null,
    varietal: fd.get('varietal').trim(),
    vintage: numOrNull(fd.get('vintage')),
    region: fd.get('region')?.trim() || null,
    country: fd.get('country')?.trim() || null,
    style: fd.get('style'),
    sweetness: fd.get('sweetness') || null,
    body: numOrNull(fd.get('body')),
    quantity: numOrNull(fd.get('quantity')) ?? 1,
    storage_location: fd.get('storage_location')?.trim() || null,
    acquired_date: fd.get('acquired_date') || null,
    acquired_price: numOrNull(fd.get('acquired_price')),
    drink_window_start: numOrNull(fd.get('drink_window_start')),
    drink_window_end: numOrNull(fd.get('drink_window_end')),
    notes: fd.get('notes')?.trim() || null,
  };
}

// ── Sommelier requests (pairing / flight / drink-now suggestions) ────
function setBusy(resultEl, msg) {
  resultEl.innerHTML = `<p class="muted">${escapeHtml(msg)}</p>`;
}
async function renderRecommendations(resultEl, response) {
  const recs = Array.isArray(response.recommendations) ? response.recommendations : [];
  const cards = await Promise.all(recs.map(async (r) => {
    let bottle = null;
    try { bottle = await getBottle(r.bottle_id); } catch { /* unknown id */ }
    if (!bottle) {
      return `<article class="bottle-card"><div class="bottle-meta">
        <h3 class="muted">Unknown bottle</h3>
        <p class="muted">id: ${escapeHtml(r.bottle_id)}</p>
        <p>${escapeHtml(r.reasoning || '')}</p>
      </div></article>`;
    }
    return `<article class="bottle-card" data-style="${escapeAttr(bottle.style || '')}">
      <div class="bottle-photo placeholder">${escapeHtml((bottle.producer || '?')[0])}</div>
      <div class="bottle-meta">
        <h3>${escapeHtml(bottle.producer)}${bottle.wine_name ? ` <span class="muted">· ${escapeHtml(bottle.wine_name)}</span>` : ''}</h3>
        <p class="muted">${escapeHtml(bottle.varietal)}${bottle.vintage ? ` · ${bottle.vintage}` : ''}</p>
        <p><span class="qty">${escapeHtml(r.confidence || 'medium')}</span> · ${escapeHtml(r.reasoning || '')}</p>
      </div>
    </article>`;
  }));
  const narrative = response.narrative
    ? `<section><h2>Narrative</h2><div class="narrative">${markdownLite(response.narrative)}</div></section>`
    : '';
  resultEl.innerHTML = `
    <section>
      <h2>Picks</h2>
      <div class="grid">${cards.join('') || '<p class="muted">(no recommendations)</p>'}</div>
    </section>
    ${narrative}`;
}

function markdownLite(md) {
  const escaped = escapeHtml(md);
  const inline = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*(.+?)\*(?=\W|$)/g, '$1<em>$2</em>');
  return inline.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function mountPairing() {
  const form = $('#pairing-form');
  const result = $('#pairing-result');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    setBusy(result, 'Asking your sommelier… (up to a couple of minutes)');
    try {
      const { response } = await requestPairing({
        dish: fd.get('dish').trim(),
        guests: numOrNull(fd.get('guests')) ?? 2,
        occasion: fd.get('occasion'),
        constraints: fd.get('constraints')?.trim() || null,
      });
      await renderRecommendations(result, response);
    } catch (err) { result.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; }
  });
}

function mountFlight() {
  const form = $('#flight-form');
  const result = $('#flight-result');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      setBusy(result, 'Building the flight… (this may take a couple of minutes)');
      try {
        const { response } = await requestFlight({
          theme: fd.get('theme'),
          guests: numOrNull(fd.get('guests')) ?? 4,
          length: numOrNull(fd.get('length')) ?? 3,
        });
        await renderRecommendations(result, response);
      } catch (err) { result.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; }
    });
  }
  const extrasForm = $('#flight-extras-form');
  const extrasResult = $('#flight-extras-result');
  if (extrasForm) {
    extrasForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(extrasForm);
      setBusy(extrasResult, 'Asking your sommelier what to add…');
      try {
        const { response } = await requestFlightExtras({
          themeHint: fd.get('theme_hint')?.trim() || null,
        });
        // No structured cellar picks — render narrative only.
        extrasResult.innerHTML = response.narrative
          ? `<section><h3>Suggestions</h3><div class="narrative">${markdownLite(response.narrative)}</div></section>`
          : '<p class="muted">(no suggestions)</p>';
      } catch (err) { extrasResult.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; }
    });
  }
}

// ── Drink-now ─────────────────────────────────────────────────────
async function mountDrinkNow() {
  const dnForm = $('#drink-now-form');
  const dnResult = $('#drink-now-result');
  if (dnForm) {
    dnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(dnForm);
      setBusy(dnResult, 'Asking your sommelier…');
      try {
        const { response } = await requestDrinkNow({ notes: fd.get('notes')?.trim() || null });
        await renderRecommendations(dnResult, response);
      } catch (err) { dnResult.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`; }
    });
  }
  const root = $('#drink-now-list');
  if (!root) return;
  const yr = new Date().getFullYear();
  let bottles;
  try { bottles = await listBottles(); }
  catch (e) { root.innerHTML = `<p class="error">${e.message}</p>`; return; }
  const buckets = { past: [], peak: [], entering: [] };
  for (const b of bottles) {
    if (b.drink_window_start == null || b.drink_window_end == null) continue;
    if (yr > b.drink_window_end) buckets.past.push(b);
    else if (yr >= b.drink_window_start) buckets.peak.push(b);
    else if (yr === b.drink_window_start - 1) buckets.entering.push(b);
  }
  const section = (title, list) => list.length
    ? `<section><h2>${title}</h2><div class="grid">${list.map(bottleCardHTML).join('')}</div></section>` : '';
  root.innerHTML = [
    section('Past peak — drink soon', buckets.past),
    section('In peak window', buckets.peak),
    section('Entering peak this year', buckets.entering),
  ].join('') || '<p class="muted">Nothing to flag right now.</p>';
}

// ── Scan queue (background, in-memory) ────────────────────────────
//
// Multi-bottle add: submit a scan, immediately go back to the intent
// stage, scan the next one. Each in-flight scan is one entry in
// scanQueue. The realtime subscription survives navigation because
// the queue lives at module scope, not inside mountScan's closure.
//
// status flow:  pending → ready → reviewing → (removed on Save)
//                                 ↘ ready (if user navigates back without saving)
//                       ↘ error
const MAX_IN_FLIGHT = 5; // matches enforce_pending_scan_cap trigger
const scanQueue = [];
const queueListeners = new Set();
let _scanCounter = 0;

function scanQueueSnapshot() { return scanQueue.slice(); }
function notifyQueue() { for (const fn of queueListeners) { try { fn(); } catch (e) { console.error(e); } } }

function enqueueAddScan({ imagePaths, request }) {
  const entry = {
    requestId: request.id,
    imagePaths,
    label: `Bottle ${++_scanCounter}`,
    status: 'pending',
    response: null,
    error: null,
    unsubscribe: null,
  };
  entry.unsubscribe = subscribeForResponse(request.id, {
    onResponse: (row) => { entry.status = 'ready'; entry.response = row; entry.unsubscribe = null; notifyQueue(); },
    onError:    (err) => { entry.status = 'error'; entry.error = err.message; entry.unsubscribe = null; notifyQueue(); },
  });
  scanQueue.push(entry);
  notifyQueue();
  return entry;
}

function removeScanEntry(requestId) {
  const i = scanQueue.findIndex((e) => e.requestId === requestId);
  if (i < 0) return;
  const [entry] = scanQueue.splice(i, 1);
  try { entry.unsubscribe?.(); } catch { /* idempotent */ }
  notifyQueue();
}

// ── Scan view (orchestrator state machine) ────────────────────────
function mountScan() {
  const root = $('#scan-view');
  if (!root) return;

  let intent = null;          // 'add' | 'pour'
  let scanId = null;           // groups uploads of the same scan
  let stream = null;
  let currentLabel = 'front';  // 'front' | 'back'
  let captures = [];           // [{ label, blob }]
  let lastBlob = null;         // pending review
  let reviewingEntry = null;   // queue entry whose review form is showing

  const setStage = (stage) => {
    root.dataset.stage = stage;
    $$('.scan-stage-pane', root).forEach((p) => { p.hidden = p.dataset.pane !== stage; });
    renderTray();
  };
  const cleanup = () => { if (stream) { stopCamera(stream); stream = null; } };
  const showError = (msg) => { setStage('error'); $('#scan-error', root).textContent = msg; };

  const startCaptureFor = async (label) => {
    currentLabel = label;
    setStage('capture');
    const promptEl = root.querySelector('[data-pane="capture"] .scan-prompt');
    promptEl.textContent = label === 'front'
      ? (intent === 'pour' ? 'Snap the front label to identify the bottle' : 'Snap the front label')
      : 'Snap the back label (optional — alcohol, blend %, winemaker notes)';
    try { stream = await startCamera($('#scan-video', root)); }
    catch (e) { showError(e.message); }
  };

  // Tray lives in the intent pane; only visible when there's something
  // pending or ready, and only on the intent stage so it doesn't compete
  // with the camera/review UIs.
  function renderTray() {
    const tray = $('#scan-queue-tray', root);
    const startBtn = root.querySelector('[data-action="start-add"]');
    if (!tray) return;
    const items = scanQueueSnapshot();
    const showTray = items.length && root.dataset.stage === 'intent';
    tray.hidden = !showTray;
    if (startBtn) {
      const atCap = items.length >= MAX_IN_FLIGHT;
      startBtn.disabled = atCap;
      startBtn.title = atCap ? `${MAX_IN_FLIGHT} scans in flight — review one before scanning more.` : '';
    }
    if (!showTray) return;
    tray.innerHTML = items.map((e) => {
      if (e.status === 'pending') {
        return `<li class="scan-queue-item is-pending">
          <span class="scan-queue-spinner" aria-hidden="true"></span>
          <span class="scan-queue-text">${escapeHtml(e.label)}: identifying…</span>
        </li>`;
      }
      if (e.status === 'ready') {
        return `<li class="scan-queue-item is-ready">
          <button class="scan-queue-btn" data-action="review-queued" data-request-id="${escapeAttr(e.requestId)}">
            ${escapeHtml(e.label)}: ready — tap to review
          </button>
        </li>`;
      }
      if (e.status === 'error') {
        return `<li class="scan-queue-item is-error">
          <span class="scan-queue-text">${escapeHtml(e.label)}: ${escapeHtml(e.error || 'failed')}</span>
          <button class="ghost scan-queue-dismiss" data-action="dismiss-queued" data-request-id="${escapeAttr(e.requestId)}">Dismiss</button>
        </li>`;
      }
      return ''; // 'reviewing' is hidden from the tray; it's the foreground form
    }).join('');
  }

  queueListeners.add(renderTray);
  // Initial paint: if we're returning to #/scan after a save (or any
  // navigation), the queue may already hold ready/pending entries whose
  // status won't change again on its own. Without this, those entries
  // stay invisible until the next state transition.
  renderTray();
  // Drop this mount's listener when the user navigates away. Also restore
  // any entry stuck in 'reviewing' (user navigated away without saving)
  // back to 'ready' so it stays visible in the tray on return.
  const onHashChange = () => {
    if (parseHash().route !== 'scan') {
      if (reviewingEntry && reviewingEntry.status === 'reviewing') {
        reviewingEntry.status = 'ready';
        notifyQueue();
      }
      reviewingEntry = null;
      queueListeners.delete(renderTray);
      window.removeEventListener('hashchange', onHashChange);
    }
  };
  window.addEventListener('hashchange', onHashChange);

  root.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    if (action === 'start-add' || action === 'start-pour') {
      if (action === 'start-add' && scanQueue.length >= MAX_IN_FLIGHT) {
        showToast(`${MAX_IN_FLIGHT} scans in flight — review one first.`);
        return;
      }
      // If user was mid-review and started a new scan instead of saving,
      // bounce that entry back to 'ready' so the tray keeps it visible.
      if (reviewingEntry && reviewingEntry.status === 'reviewing') {
        reviewingEntry.status = 'ready';
        notifyQueue();
      }
      reviewingEntry = null;
      intent = action === 'start-add' ? 'add' : 'pour';
      scanId = crypto.randomUUID();
      captures = []; lastBlob = null;
      await startCaptureFor('front');
      return;
    }
    if (action === 'capture') {
      try {
        lastBlob = await captureFrame($('#scan-video', root));
        const preview = $('#scan-preview', root);
        const url = URL.createObjectURL(lastBlob);
        preview.onload = () => URL.revokeObjectURL(url);
        preview.src = url;

        const actionsRow = $('#scan-review-actions', root);
        if (intent === 'add' && currentLabel === 'front') {
          actionsRow.innerHTML = `
            <button data-action="use-then-back">Use this, also do back</button>
            <button data-action="use-and-submit" class="ghost">Use this, send now</button>
            <button data-action="retake" class="ghost">Retake</button>`;
        } else {
          actionsRow.innerHTML = `
            <button data-action="use-and-submit">Use this, send</button>
            <button data-action="retake" class="ghost">Retake</button>`;
        }
        cleanup();
        setStage('review');
      } catch (err) { showError(err.message); }
      return;
    }
    if (action === 'cancel') { cleanup(); setStage('intent'); return; }
    if (action === 'retake') { lastBlob = null; await startCaptureFor(currentLabel); return; }
    if (action === 'use-then-back') {
      captures.push({ label: 'front', blob: lastBlob });
      lastBlob = null;
      await startCaptureFor('back');
      return;
    }
    if (action === 'use-and-submit') {
      if (lastBlob) captures.push({ label: currentLabel, blob: lastBlob });
      lastBlob = null;
      await uploadAndSubmit();
      return;
    }
    if (action === 'restart') {
      intent = null; captures = []; lastBlob = null;
      setStage('intent');
      return;
    }
    if (action === 'review-queued') {
      const requestId = e.target.closest('[data-action]').dataset.requestId;
      const entry = scanQueue.find((x) => x.requestId === requestId);
      if (!entry || entry.status !== 'ready') return;
      reviewingEntry = entry;
      entry.status = 'reviewing';
      notifyQueue();
      await renderQueuedReview(entry);
      return;
    }
    if (action === 'dismiss-queued') {
      const requestId = e.target.closest('[data-action]').dataset.requestId;
      removeScanEntry(requestId);
      return;
    }
    if (action === 'confirm-pour') {
      const bottleId = e.target.closest('[data-action]').dataset.bottleId;
      try {
        await pourBottle(bottleId);
        showToast('Poured. Undo?', { actionLabel: 'Undo', onAction: () => undoPour(bottleId).catch(() => {}) });
        location.hash = '#/cellar';
      } catch (err) { alert(err.message); }
    }
  });

  async function uploadAndSubmit() {
    setStage('uploading');
    try {
      const imagePaths = [];
      for (const cap of captures) {
        const path = await uploadCapture(cap.blob, { scanId, label: cap.label });
        imagePaths.push(path);
      }
      if (intent === 'pour') {
        // Pour stays single-shot: user wants the answer right now.
        const bottles = await listBottles();
        const cellarSnapshot = bottles.map((b) => ({
          id: b.id, producer: b.producer, wine_name: b.wine_name,
          varietal: b.varietal, vintage: b.vintage, quantity: b.quantity,
        }));
        const req = await submitScanRequest({ intent, imagePaths, cellarSnapshot });
        setStage('waiting');
        const response = await waitForScanResponse(req.id);
        await renderPourResult(response);
      } else {
        // Add intent: enqueue and immediately bounce back to intent so
        // the user can scan another bottle while this one cooks.
        const req = await submitScanRequest({ intent, imagePaths });
        const entry = enqueueAddScan({ imagePaths, request: req });
        showToast(`${entry.label} sent — scan another or wait for review.`);
        // Reset transient capture state so the next "Add new bottle" tap is clean.
        intent = null; captures = []; lastBlob = null;
        setStage('intent');
      }
    } catch (err) { showError(err.message); }
  }

  async function renderQueuedReview(entry) {
    setStage('result');
    const result = $('#scan-result', root);
    const ext = entry.response?.extracted || {};
    const details = ext.details || null;
    result.innerHTML = renderAddReviewHTML(ext, details, entry.imagePaths, entry.response?.narrative);
    // Wrap the form's submit so we can splice the entry out on success
    // (whether the user merged into an existing bottle or created new).
    wireAddReviewForm(result, entry.imagePaths, details, () => {
      removeScanEntry(entry.requestId);
      reviewingEntry = null;
    });
  }

  async function renderPourResult(response) {
    setStage('result');
    const result = $('#scan-result', root);
    result.innerHTML = await renderPourResultHTML(response);
  }
}

function renderAddReviewHTML(ext, details, imagePaths, narrative) {
  const sel = (val, opts) => opts.map((o) => `<option value="${o}" ${ext[o] === val || val === o ? 'selected' : ''}>${o}</option>`).join('');
  return `
    <h2>Review extracted details</h2>
    <p class="muted">Confidence: <strong>${escapeHtml(ext.confidence || 'unknown')}</strong>. Edit any field before saving.</p>
    <form id="scan-add-form">
      <label>Producer<input name="producer" required value="${escapeAttr(ext.producer || '')}" /></label>
      <label>Wine name<input name="wine_name" value="${escapeAttr(ext.wine_name || '')}" /></label>
      <label>Varietal
        <input name="varietal" required value="${escapeAttr(ext.varietal || '')}" list="varietal-options-scan" />
        <datalist id="varietal-options-scan">${VARIETAL_NAMES.map((v) => `<option value="${v}">`).join('')}</datalist>
      </label>
      <label>Vintage<input name="vintage" type="number" min="1900" max="2100" value="${ext.vintage ?? ''}" /></label>
      <div class="row">
        <label style="flex:1">Region<input name="region" value="${escapeAttr(ext.region || '')}" /></label>
        <label style="flex:1">Country<input name="country" value="${escapeAttr(ext.country || '')}" /></label>
      </div>
      <div class="row">
        <label style="flex:1">Style
          <select name="style" required>${STYLES.map((s) => `<option ${ext.style === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </label>
        <label style="flex:1">Sweetness
          <select name="sweetness">
            <option value="">—</option>
            ${SWEETNESS_OPTS.map((s) => `<option ${ext.sweetness === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label style="flex:1">Body 1-5<input name="body" type="number" min="1" max="5" value="${ext.body ?? ''}" /></label>
      </div>
      <div class="row">
        <label style="flex:1">Quantity<input name="quantity" type="number" min="0" value="1" /></label>
        <label style="flex:1">Storage location<input name="storage_location" /></label>
      </div>
      <label>Notes<textarea name="notes" rows="2"></textarea></label>
      <div class="row">
        <button type="submit">Save bottle</button>
        <a href="#/cellar" class="btn ghost" style="display:inline-block; padding:0.5rem 1rem; border:1px solid var(--surface-2); border-radius:var(--radius);">Cancel</a>
      </div>
    </form>
    ${details ? `<section style="margin-top:2rem"><h3>Enrichment</h3><div class="narrative">${renderDetailsHTML(details)}</div></section>` : ''}
    ${narrative ? `<section style="margin-top:1.5rem"><h3>Narrative</h3><div class="narrative">${markdownLite(narrative)}</div></section>` : ''}
  `;
}

function wireAddReviewForm(rootEl, imagePaths, details, onSaved = null) {
  const form = $('#scan-add-form', rootEl);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = collectBottleFields(fd);
    input.label_image_path = imagePaths.find((p) => /-front\.jpg$/i.test(p)) || imagePaths[0] || null;
    input.back_image_path = imagePaths.find((p) => /-back\.jpg$/i.test(p)) || null;
    input.details = details || null;

    try {
      // Different vintage is treated as a different bottle (per spec).
      const dupe = await findDuplicate({
        producer: input.producer, wine_name: input.wine_name,
        vintage: input.vintage, varietal: input.varietal,
      });

      if (dupe) {
        const desc = `${dupe.producer}${dupe.wine_name ? ' · ' + dupe.wine_name : ''}${dupe.vintage ? ' ' + dupe.vintage : ''}`;
        const merge = confirm(
          `You already have ${dupe.quantity}× of "${desc}".\n\nOK = add to existing (${dupe.quantity + 1} total).\nCancel = save as a separate bottle.`
        );
        if (merge) {
          // Increment, and opportunistically fill in missing photos / details.
          const patch = { quantity: dupe.quantity + 1 };
          if (!dupe.label_image_path && input.label_image_path) patch.label_image_path = input.label_image_path;
          if (!dupe.back_image_path  && input.back_image_path)  patch.back_image_path  = input.back_image_path;
          if (!dupe.details          && input.details)          patch.details          = input.details;
          await updateBottle(dupe.id, patch);
          showToast(`Added 1 — ${desc} now ×${dupe.quantity + 1}`);
          onSaved?.();
          location.hash = `#/bottle/${dupe.id}`;
          return;
        }
      }

      const created = await createBottle(input);
      onSaved?.();
      location.hash = `#/bottle/${created.id}`;
    } catch (err) { alert(err.message); }
  });
}

async function renderPourResultHTML(response) {
  if (response.matched_bottle_id) {
    let b = null;
    try { b = await getBottle(response.matched_bottle_id); } catch { /* missing */ }
    if (b) {
      return `
        <h2>Found a match</h2>
        <article class="bottle-card" data-style="${escapeAttr(b.style || '')}">
          <div class="bottle-photo placeholder">${escapeHtml((b.producer || '?')[0])}</div>
          <div class="bottle-meta">
            <h3>${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h3>
            <p class="muted">${escapeHtml(b.varietal)}${b.vintage ? ` · ${b.vintage}` : ''} · ×${b.quantity}</p>
            <div class="actions">
              <button data-action="confirm-pour" data-bottle-id="${b.id}" ${b.quantity <= 0 ? 'disabled' : ''}>Pour this</button>
              <a href="#/cellar" class="btn ghost" style="display:inline-block; padding:0.4rem 0.8rem; border:1px solid var(--surface-2); border-radius:var(--radius);">Cancel</a>
            </div>
          </div>
        </article>
        ${response.narrative ? `<section style="margin-top:1rem"><div class="narrative">${markdownLite(response.narrative)}</div></section>` : ''}
      `;
    }
  }
  if (Array.isArray(response.match_candidates) && response.match_candidates.length) {
    const cards = await Promise.all(response.match_candidates.map(async (c) => {
      let b = null;
      try { b = await getBottle(c.bottle_id); } catch {}
      const head = b
        ? `<h3>${escapeHtml(b.producer)}${b.wine_name ? ` · ${escapeHtml(b.wine_name)}` : ''}${b.vintage ? ` · ${b.vintage}` : ''}</h3>`
        : `<h3 class="muted">Unknown bottle (${escapeHtml(c.bottle_id)})</h3>`;
      return `<article class="bottle-card">
        <div class="bottle-meta">
          ${head}
          <p class="muted">Confidence: ${escapeHtml(c.confidence || '?')}. ${escapeHtml(c.reasoning || '')}</p>
          <button data-action="confirm-pour" data-bottle-id="${c.bottle_id}">Pour this</button>
        </div>
      </article>`;
    }));
    return `<h2>Possible matches</h2><div class="grid">${cards.join('')}</div>`;
  }
  return `<h2>No match in your cellar</h2>
    ${response.narrative ? `<div class="narrative">${markdownLite(response.narrative)}</div>` : ''}
    <p><a href="#/scan">Scan again</a> or <a href="#/cellar">back to cellar</a>.</p>`;
}

// ── Bottle detail view ────────────────────────────────────────────
async function mountBottleDetail(id) {
  const root = $('#bottle-detail-content');
  if (!root) return;
  if (!id) { root.innerHTML = '<p class="error">No bottle id in URL.</p>'; return; }

  let bottle;
  try { bottle = await getBottle(id); }
  catch (e) { root.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }

  const [frontUrl, backUrl] = await Promise.all([
    bottle.label_image_path ? signedUrlForImage(bottle.label_image_path).catch(() => null) : null,
    bottle.back_image_path  ? signedUrlForImage(bottle.back_image_path).catch(() => null)  : null,
  ]);

  root.innerHTML = renderBottleDetailHTML(bottle, frontUrl, backUrl);
  wireBottleDetail(root, bottle);
}

function renderBottleDetailHTML(b, frontUrl, backUrl) {
  const w = (b.drink_window_start && b.drink_window_end) ? `${b.drink_window_start}–${b.drink_window_end}` : '—';
  const photos = (frontUrl || backUrl) ? `
    <div class="bottle-detail-photos">
      ${frontUrl ? `<img src="${frontUrl}" alt="Front label" data-zoom="${escapeAttr(frontUrl)}" />` : ''}
      ${backUrl  ? `<img src="${backUrl}"  alt="Back label"  data-zoom="${escapeAttr(backUrl)}"  />` : ''}
    </div>` : '';

  const isEnriching = enrichingBottles.has(b.id);
  const detailsBtn = isEnriching
    ? `<span class="muted" style="align-self:center; padding: 0.5rem 0;">Fetching sommelier notes…</span>`
    : (b.details
        ? `<button data-action="refresh-details" class="ghost">Refresh details</button>`
        : `<button data-action="fetch-details" class="ghost">Get details</button>`);

  return `
    <article class="bottle-detail-card" data-style="${escapeAttr(b.style || '')}">
      ${photos}
      <header>
        <h1>${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h1>
        <p class="muted">
          ${escapeHtml(b.varietal)}${b.vintage ? ` · ${b.vintage}` : ''}
          ${b.region ? ` · ${escapeHtml(b.region)}` : ''}${b.country ? ` · ${escapeHtml(b.country)}` : ''}
        </p>
      </header>
      <dl class="bottle-stats">
        <dt>Quantity</dt><dd><span class="qty">×${b.quantity}</span></dd>
        <dt>Style</dt><dd>${escapeHtml(b.style)}</dd>
        ${b.sweetness ? `<dt>Sweetness</dt><dd>${escapeHtml(b.sweetness)}</dd>` : ''}
        ${b.body ? `<dt>Body</dt><dd>${b.body}/5</dd>` : ''}
        <dt>Drink window</dt><dd>${w}${b.drink_window_overridden ? ' <span class="muted">(custom)</span>' : ''}</dd>
        ${b.storage_location ? `<dt>Storage</dt><dd>${escapeHtml(b.storage_location)}</dd>` : ''}
        ${b.acquired_date ? `<dt>Acquired</dt><dd>${escapeHtml(b.acquired_date)}</dd>` : ''}
        ${b.notes ? `<dt>Notes</dt><dd>${escapeHtml(b.notes)}</dd>` : ''}
      </dl>
      <div class="row">
        <button data-action="pour" ${b.quantity <= 0 ? 'disabled' : ''}>Pour</button>
        <button data-action="edit" class="ghost">Edit</button>
        <button data-action="delete" class="ghost">Delete</button>
        ${detailsBtn}
      </div>
      ${b.details ? `<section class="bottle-details-section">
        <h2>More info</h2>
        <div class="narrative">${renderDetailsHTML(b.details)}</div>
      </section>` : ''}
    </article>
  `;
}

function wireBottleDetail(root, bottle) {
  // Tap a label photo → fullscreen lightbox.
  $$('img[data-zoom]', root).forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.zoom));
  });

  root.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'pour') {
      try {
        await pourBottle(bottle.id);
        showToast('Poured. Undo?', { actionLabel: 'Undo', onAction: () => undoPour(bottle.id).then(() => render()) });
        render();
      } catch (err) { alert(err.message); }
      return;
    }
    if (action === 'edit') {
      location.hash = `#/edit/${bottle.id}`;
      return;
    }
    if (action === 'delete') {
      if (!confirm('Delete this bottle?')) return;
      try { await deleteBottle(bottle.id); location.hash = '#/cellar'; }
      catch (err) { alert(err.message); }
      return;
    }
    if (action === 'fetch-details' || action === 'refresh-details') {
      const btn = e.target.closest('button');
      const wasLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Asking your sommelier…';
      try {
        const response = await requestEnrichment(bottle.id);
        const details = response.extracted?.details || response.extracted || null;
        if (details) {
          await updateBottle(bottle.id, { details });
          render();
        } else {
          alert('No details returned.');
          btn.disabled = false; btn.textContent = wasLabel;
        }
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = wasLabel; }
    }
  });
}

function renderDetailsHTML(d) {
  if (!d || typeof d !== 'object') return '<p class="muted">(no details)</p>';
  const out = [];
  if (d.tasting_notes && typeof d.tasting_notes === 'object') {
    const tn = d.tasting_notes;
    out.push(`<h3>Tasting notes</h3><dl>
      ${tn.aroma  ? `<dt>Aroma</dt><dd>${escapeHtml(tn.aroma)}</dd>`   : ''}
      ${tn.palate ? `<dt>Palate</dt><dd>${escapeHtml(tn.palate)}</dd>` : ''}
      ${tn.finish ? `<dt>Finish</dt><dd>${escapeHtml(tn.finish)}</dd>` : ''}
    </dl>`);
  }
  if (Array.isArray(d.food_pairings) && d.food_pairings.length) {
    out.push(`<h3>Food pairings</h3><ul>${d.food_pairings.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`);
  }
  if (d.producer_background) out.push(`<h3>Producer</h3><p>${escapeHtml(d.producer_background)}</p>`);
  if (d.region_context)      out.push(`<h3>Region</h3><p>${escapeHtml(d.region_context)}</p>`);
  if (d.drinking_window_rationale) out.push(`<h3>When to drink</h3><p>${escapeHtml(d.drinking_window_rationale)}</p>`);
  if (d.serving && typeof d.serving === 'object') {
    const bits = [];
    if (d.serving.temp_celsius != null) bits.push(`Temp: ${d.serving.temp_celsius}°C`);
    if (d.serving.decant_minutes != null) bits.push(`Decant: ${d.serving.decant_minutes} min`);
    if (d.serving.glass) bits.push(`Glass: ${d.serving.glass}`);
    if (bits.length) out.push(`<h3>Serving</h3><p>${bits.map((s) => escapeHtml(s)).join(' · ')}</p>`);
  }
  return out.join('') || '<p class="muted">(no details)</p>';
}

// ── Auth view ─────────────────────────────────────────────────────
function renderAuth() {
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
}
function wireAuth() {
  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await signIn(fd.get('email'), fd.get('password'));
      await render();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });
  $('#signup-btn').addEventListener('click', async () => {
    const email = $('#signin-form').email.value;
    const pw    = $('#signin-form').password.value;
    if (!email || !pw) { $('#auth-error').textContent = 'Email + password required.'; return; }
    $('#auth-error').textContent = '';
    try {
      await signUp(email, pw);
    } catch (err) {
      if (/already registered|already exists|user_already_exists/i.test(err.message)) {
        try { await signIn(email, pw); await render(); }
        catch (signInErr) { $('#auth-error').textContent = signInErr.message; }
      } else {
        $('#auth-error').textContent = err.message;
      }
    }
  });
}

// ── Lightbox (tap photo → fullscreen) ─────────────────────────────
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `<img src="${src}" alt="" />`;
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, { actionLabel, onAction } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${escapeHtml(msg)}</span>${actionLabel ? `<button id="toast-action">${actionLabel}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) $('#toast-action').addEventListener('click', () => { onAction?.(); t.hidden = true; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ── Helpers ───────────────────────────────────────────────────────
function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Bootstrap ─────────────────────────────────────────────────────
{
  // Expose version in the topbar so we can eyeball whether the SW has
  // swapped to a new build yet.
  const versionEl = document.getElementById('app-version');
  if (versionEl && self.CELLAR_VERSION) versionEl.textContent = `v${self.CELLAR_VERSION}`;
}
window.addEventListener('hashchange', () => render());
onAuthChange((session) => setTimeout(() => render(session), 0));
wireAuth();
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' makes the browser bypass HTTP cache for sw.js
      // AND its importScripts (i.e. version.js) on every update check.
      // Without it (default 'imports'), version.js is read from HTTP cache
      // and the SW update check sees no change — users were having to clear
      // browsing data to pick up new builds.
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }
        console.log('[cellar27] SW updated, reloading');
        window.location.reload();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    } catch (e) {
      console.warn('[cellar27] SW register failed:', e);
    }
  });
}
