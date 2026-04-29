import { getSession, signIn, signUp, signOut, onAuthChange } from './auth.js';
import { listBottles, createBottle, deleteBottle, pourBottle, undoPour, getBottle } from './bottles.js';
import { VARIETAL_NAMES, suggestDrinkWindow } from './varietal-windows.js';
import { requestPairing, requestFlight, requestDrinkNow } from './pairings.js';

const STYLES = [
  'light_red','medium_red','full_red',
  'light_white','full_white',
  'rose','sparkling','dessert','fortified',
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Routing (hash-based) ──────────────────────────────────────────
const ROUTES = ['cellar', 'add', 'pairing', 'flight', 'drink-now', 'scan'];
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(h) ? h : 'cellar';
}
async function loadView(name) {
  const res = await fetch(`views/${name}.html`);
  return res.ok ? res.text() : `<p>View not found: ${name}</p>`;
}

async function render(providedSession) {
  // Use session passed by auth listener if available (avoids a Supabase v2 lock
  // deadlock when called from inside onAuthStateChange); otherwise fetch it.
  const session = providedSession !== undefined ? providedSession : await getSession();
  if (!session) {
    renderAuth();
    return;
  }
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#user-email').textContent = session.user.email;

  const route = currentRoute();
  $$('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });

  $('#main').innerHTML = await loadView(route);
  await mountView(route);
}

async function mountView(route) {
  switch (route) {
    case 'cellar':     return mountCellar();
    case 'add':        return mountAddBottle();
    case 'drink-now':  return mountDrinkNow();
    case 'pairing':    return mountPairing();
    case 'flight':     return mountFlight();
    case 'scan':       return; // placeholder — Phase 3
  }
}

// ── Cellar grid ───────────────────────────────────────────────────
async function mountCellar() {
  const grid = $('#cellar-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="muted">Loading…</p>';
  let bottles;
  try { bottles = await listBottles(); }
  catch (e) { grid.innerHTML = `<p class="error">${e.message}</p>`; return; }
  if (!bottles.length) {
    grid.innerHTML = '<p class="muted">Empty cellar. <a href="#/add">Add your first bottle →</a></p>';
    return;
  }
  grid.innerHTML = bottles.map(bottleCardHTML).join('');
  $$('[data-pour]', grid).forEach((btn) => btn.addEventListener('click', onPour));
  $$('[data-delete]', grid).forEach((btn) => btn.addEventListener('click', onDelete));
}

function bottleCardHTML(b) {
  const window = (b.drink_window_start && b.drink_window_end)
    ? `${b.drink_window_start}–${b.drink_window_end}`
    : '—';
  return `
    <article class="bottle-card">
      <div class="bottle-photo placeholder">${escapeHtml(b.producer[0] || '?')}</div>
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

// ── Add bottle (manual) ───────────────────────────────────────────
function mountAddBottle() {
  const form = $('#add-bottle-form');
  if (!form) return;

  // Populate varietal datalist + style select
  const dl = $('#varietal-options');
  if (dl) dl.innerHTML = VARIETAL_NAMES.map((v) => `<option value="${v}">`).join('');
  const styleSel = form.style;
  if (styleSel) styleSel.innerHTML = STYLES.map((s) => `<option value="${s}">${s}</option>`).join('');

  // Live drink-window suggestion
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
    const input = {
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
    try {
      await createBottle(input);
      location.hash = '#/cellar';
    } catch (err) { alert(err.message); }
  });
}

// ── Bridge requests (pairing / flight / drink-now suggestions) ────
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
    return `<article class="bottle-card">
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

// Minimal markdown — paragraphs + bold/italic. Avoid pulling in a parser.
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
    setBusy(result, 'Asking the bridge… (Claude on the VM picks this up; up to a couple of minutes)');
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
  if (!form) return;
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

// ── Drink-now ─────────────────────────────────────────────────────
async function mountDrinkNow() {
  const dnForm = $('#drink-now-form');
  const dnResult = $('#drink-now-result');
  if (dnForm) {
    dnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(dnForm);
      setBusy(dnResult, 'Asking the bridge…');
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
      // If account already exists, transparently fall through to sign in.
      if (/already registered|already exists|user_already_exists/i.test(err.message)) {
        try { await signIn(email, pw); await render(); }
        catch (signInErr) { $('#auth-error').textContent = signInErr.message; }
      } else {
        $('#auth-error').textContent = err.message;
      }
    }
  });
  $('#signout-btn').addEventListener('click', () => signOut());
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

// ── Bootstrap ─────────────────────────────────────────────────────
window.addEventListener('hashchange', () => render());
// Defer to next tick — Supabase v2 listener must not call SDK methods synchronously.
onAuthChange((session) => setTimeout(() => render(session), 0));
wireAuth();
render();

// PWA service worker registration + auto-update.
//
// Mechanism: bumping docs/version.js changes sw.js bytes (via importScripts),
// so the browser treats sw.js as a new SW → install (skipWaiting) → activate
// (claim) → controllerchange fires here → reload page so the new shell takes
// effect. Visibility change triggers an update check so reopening the PWA
// from background catches new versions promptly.
//
// No-op on http://192.168.x.x (SW requires HTTPS or localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');

      // First-time install also fires controllerchange. Only auto-reload on
      // subsequent changes (i.e. when there was already a controller).
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
