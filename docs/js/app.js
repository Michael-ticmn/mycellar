import { getSession, signIn, signUp, onAuthChange } from './auth.js';
import { listBottles, createBottle, deleteBottle, pourBottle, undoPour, getBottle, updateBottle, findDuplicate } from './bottles.js';
import { VARIETAL_NAMES, suggestDrinkWindow } from './varietal-windows.js';
import { requestPairing, requestFlight, requestFlightExtras, requestDrinkNow } from './pairings.js';
import {
  listPlannedFlights, getPlannedFlight, createPlannedFlight,
  updatePlannedFlight, deletePlannedFlight, requestFlightPlanEnrichment,
  attachPlannedFlightToShare, detachPlannedFlightFromShare,
  requestGuestWalkthrough,
} from './planned-flights.js';
import {
  startCamera, stopCamera, captureFrame,
  uploadCapture, submitScanRequest, waitForScanResponse,
  subscribeForResponse, signedUrlForImage, requestEnrichment,
} from './scan.js';
import {
  resolveShare, listBottlesForShare,
  requestPairingForShare, requestFlightForShare,
  requestFlightExtrasForShare, requestDrinkNowForShare,
  getSharedPlannedFlight, sendGuestMessage,
} from './guest.js';
import { getActiveShareLink, createShareLink, revokeShareLink, shareUrlFor, listGuestMessages, countGuestMessagesSince } from './share.js';

const STYLES = [
  'light_red','medium_red','full_red',
  'light_white','full_white',
  'rose','sparkling','dessert','fortified',
];
const SWEETNESS_OPTS = ['bone_dry','dry','off_dry','sweet'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Routing (hash-based, supports `bottle/<id>`) ──────────────────
const ROUTES = ['cellar', 'add', 'edit', 'pairing', 'flight', 'planned', 'drink-now', 'manage', 'scan', 'bottle', 'guest', 'share'];
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [route, ...params] = h.split('/');
  return { route: ROUTES.includes(route) ? route : 'cellar', params };
}
// Cancel any in-flight view fetch when a new one starts so a slow load
// can't overwrite the view the user has since navigated to.
let _viewAbort = null;
async function loadView(name) {
  // Aliases: edit → add (same form, different submit), scan → manage
  // (kept so old PWA shortcuts / bookmarks don't 404).
  const file = name === 'edit' ? 'add' : name === 'scan' ? 'manage' : name;
  if (_viewAbort) _viewAbort.abort();
  _viewAbort = new AbortController();
  try {
    const res = await fetch(`views/${file}.html`, { signal: _viewAbort.signal });
    return res.ok ? res.text() : `<p>View not found: ${name}</p>`;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}

async function render(providedSession) {
  const { route, params } = parseHash();

  // Guest share route: anonymous, token-gated, no auth required.
  if (route === 'guest') {
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#user-email').textContent = '';
    document.body.classList.add('guest-mode');
    const html = await loadView('guest');
    if (html === null) return;
    $('#main').innerHTML = html;
    await mountGuest(params[0]);
    return;
  }
  document.body.classList.remove('guest-mode');

  const session = providedSession !== undefined ? providedSession : await getSession();
  if (!session) { renderAuth(); return; }
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#user-email').textContent = session.user.email;

  $$('nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });

  // Best-effort: refresh the Share nav badge so the unread-guest pip
  // stays accurate as the user moves around. Cheap (one head/count
  // query against guest_messages) and tolerant of failures.
  refreshShareNavBadge().catch(() => {});

  const html = await loadView(route);
  if (html === null) return; // superseded by a newer navigation
  $('#main').innerHTML = html;
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
    case 'planned':    return mountPlanned(params[0]);
    case 'manage':     return mountManage();
    case 'scan':       return mountManage(); // legacy alias
    case 'bottle':     return mountBottleDetail(params[0]);
    case 'share':      return mountShare();
  }
}

// ── Share (owner-side: generate / revoke a guest link) ────────────
async function mountShare() {
  const form = $('#share-create-form');
  const errEl = $('#share-create-error');
  if (!form) return;

  const renderActive = (link) => {
    const panel = $('#share-active');
    if (!panel) return;
    if (!link) { panel.hidden = true; return; }
    panel.hidden = false;
    const url = shareUrlFor(link.token);
    $('#share-url').value = url;

    // QRCode is loaded as a global script tag in index.html.
    const qrEl = $('#share-qr');
    if (qrEl && window.QRCode) {
      qrEl.innerHTML = '';
      // eslint-disable-next-line no-new
      new window.QRCode(qrEl, {
        text: url,
        width: 220,
        height: 220,
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    }

    const expiresAt = new Date(link.expires_at);
    const hoursLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 36e5));
    const aiLeft = Math.max(0, (link.ai_quota || 0) - (link.ai_used || 0));
    $('#share-meta').textContent = `${aiLeft} of ${link.ai_quota} AI requests left · expires in ~${hoursLeft}h`;

    $('#share-revoke').onclick = async () => {
      if (!confirm('Revoke this share link? Anyone using it will lose access immediately.')) return;
      try {
        await revokeShareLink(link.id);
        renderActive(null);
      } catch (e) { alert(e.message); }
    };
    $('#share-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
      catch { $('#share-url').select(); }
    };
  };

  let activeLink = null;
  try {
    activeLink = await getActiveShareLink();
    renderActive(activeLink);
  } catch (e) { errEl.textContent = e.message; }

  // Guest activity feed — load + render below the share-link card.
  // Updates the unread-since timestamp once visible so the nav badge
  // clears after the host eyeballs the page.
  await renderGuestActivity(activeLink);
  if (activeLink) markGuestActivitySeen(activeLink.id);
  refreshShareNavBadge();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const fd = new FormData(form);
    const ttlHours = parseInt(fd.get('ttl_hours'), 10);
    const aiQuota  = parseInt(fd.get('ai_quota'),  10);
    const btn = $('#share-create-btn');
    btn.disabled = true;
    try {
      const link = await createShareLink({ ttlHours, aiQuota });
      activeLink = link;
      renderActive(link);
      await renderGuestActivity(link);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Guest activity (owner-side feed of guest_messages) ────────────

const LAST_SEEN_GUEST_ACTIVITY_KEY = 'cellar27.lastSeenGuestActivity';
function getLastSeenGuestActivity(linkId) {
  try { return localStorage.getItem(`${LAST_SEEN_GUEST_ACTIVITY_KEY}.${linkId}`) || null; }
  catch { return null; }
}
function markGuestActivitySeen(linkId) {
  try { localStorage.setItem(`${LAST_SEEN_GUEST_ACTIVITY_KEY}.${linkId}`, new Date().toISOString()); }
  catch { /* private mode */ }
}

async function renderGuestActivity(link) {
  const section = $('#share-guest-activity');
  const list    = $('#share-guest-activity-list');
  if (!section || !list) return;

  if (!link) {
    // Could still show historical messages from a prior link, but the
    // UI is keyed off the active link to keep the page coherent.
    section.hidden = true;
    return;
  }

  let messages;
  try { messages = await listGuestMessages(link.id); }
  catch (e) {
    section.hidden = false;
    list.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    return;
  }

  section.hidden = false;
  if (!messages.length) {
    list.innerHTML = '<p class="muted">No guest activity yet. When guests use the share link to ask the sommelier or leave a note on Tonight, it shows up here.</p>';
    return;
  }
  list.innerHTML = messages.map((m) => guestActivityCardHTML(m)).join('');
}

function guestActivityCardHTML(m) {
  const when = new Date(m.created_at);
  const ts = when.toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const who = m.guest_name ? escapeHtml(m.guest_name) : '<span class="muted">(unnamed guest)</span>';
  if (m.kind === 'pour_note') {
    const p   = m.payload || {};
    const link = p.planned_flight_id ? `#/planned/${p.planned_flight_id}` : '#';
    return `<article class="guest-activity-card" data-kind="pour_note">
      <header class="guest-activity-head">
        <span class="guest-activity-kind">Pour note</span>
        <span class="guest-activity-who">${who}</span>
        <span class="guest-activity-ts muted">${escapeHtml(ts)}</span>
      </header>
      <p class="guest-activity-note">${escapeHtml(p.note || '')}</p>
      <p class="muted"><a href="${escapeAttr(link)}">Open the planned flight ↗</a></p>
    </article>`;
  }
  // ai_result
  const p = m.payload || {};
  const reqType = (p.request_type || 'ai_result').replace('_', ' ');
  const ctxBits = ctxSummary(p.context, p.request_type);
  const recs    = Array.isArray(p.recommendations) ? p.recommendations : [];
  const recList = recs.length
    ? `<ul class="guest-activity-recs">${recs.map((r) => `<li>
        <span class="qty">${escapeHtml(r.confidence || 'medium')}</span>
        <code>${escapeHtml(r.bottle_id)}</code>
        ${r.reasoning ? `<span class="muted"> — ${escapeHtml(r.reasoning)}</span>` : ''}
      </li>`).join('')}</ul>`
    : '';
  const narrative = p.narrative
    ? narrativeBlockHTML(p.narrative, { heading: 'Narrative', headingTag: 'h4' })
    : '';
  return `<article class="guest-activity-card" data-kind="ai_result">
    <header class="guest-activity-head">
      <span class="guest-activity-kind">${escapeHtml(reqType)}</span>
      <span class="guest-activity-who">${who}</span>
      <span class="guest-activity-ts muted">${escapeHtml(ts)}</span>
    </header>
    ${ctxBits ? `<p class="muted">${ctxBits}</p>` : ''}
    ${narrative}
    ${recList}
  </article>`;
}

// Compact one-line summary of the request context — what the guest
// actually asked for. Kept escaped/short so the card stays scannable.
function ctxSummary(ctx, requestType) {
  if (!ctx || typeof ctx !== 'object') return '';
  const bits = [];
  if (requestType === 'pairing') {
    if (ctx.dish)        bits.push(`Dish: ${escapeHtml(ctx.dish)}`);
    if (ctx.occasion)    bits.push(`Occasion: ${escapeHtml(ctx.occasion)}`);
    if (ctx.constraints) bits.push(`Constraints: ${escapeHtml(ctx.constraints)}`);
  } else if (requestType === 'flight') {
    if (ctx.theme)  bits.push(`Theme: ${escapeHtml(ctx.theme.replace(/_/g, ' '))}`);
    if (ctx.length) bits.push(`${ctx.length} bottles`);
    if (ctx.food)   bits.push(`Food: ${escapeHtml(ctx.food)}`);
    if (ctx.notes)  bits.push(`Notes: ${escapeHtml(ctx.notes)}`);
  } else if (requestType === 'drink_now') {
    if (ctx.notes) bits.push(`Notes: ${escapeHtml(ctx.notes)}`);
  }
  return bits.join(' · ');
}

// Refresh the unread-pip on the Share nav icon. Called on app boot,
// after route changes, and after any owner-side action that might
// affect the count.
async function refreshShareNavBadge() {
  const navEl = $('nav a[data-route="share"]');
  if (!navEl) return;
  navEl.querySelector('.share-nav-badge')?.remove();
  let link;
  try { link = await getActiveShareLink(); } catch { return; }
  if (!link) return;
  const since = getLastSeenGuestActivity(link.id);
  let count;
  try { count = await countGuestMessagesSince(link.id, since); } catch { return; }
  if (count <= 0) return;
  const pip = document.createElement('span');
  pip.className = 'share-nav-badge';
  pip.textContent = count > 9 ? '9+' : String(count);
  pip.setAttribute('aria-label', `${count} new guest message${count === 1 ? '' : 's'}`);
  navEl.appendChild(pip);
}

// ── Guest share view (anonymous, token-gated, read-only) ──────────
async function mountGuest(token) {
  const banner = $('#guest-banner');
  const grid = $('#guest-grid');
  const toolbar = $('#guest-toolbar');
  const tabs = $('#guest-tabs');
  if (!banner || !grid) return;

  if (!token) {
    banner.innerHTML = '<p class="error">Missing share token.</p>';
    return;
  }

  let meta;
  try { meta = await resolveShare(token); }
  catch (e) {
    banner.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!meta) {
    banner.innerHTML = '<p class="error">This share link is invalid, revoked, or has expired.</p>';
    return;
  }

  const renderBanner = (m) => {
    const left = Math.max(0, (m.ai_quota || 0) - (m.ai_used || 0));
    banner.innerHTML = `<p class="muted">Shared cellar · ${left} request${left === 1 ? '' : 's'} left</p>`;
  };
  renderBanner(meta);

  let bottles;
  try { bottles = await listBottlesForShare(token); }
  catch (e) {
    grid.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!bottles.length) {
    grid.innerHTML = '<p class="muted">This cellar is empty.</p>';
    return;
  }

  if (toolbar) toolbar.hidden = false;
  if (tabs) tabs.hidden = false;

  // In-memory bottle map for guest-side recommendation rendering. The
  // anon client cannot read `bottles` directly (RLS), so getBottle()
  // would fail — recommendations look up by id from this map instead.
  const bottleById = new Map(bottles.map((b) => [b.id, b]));

  // Tonight tab — only surfaces when the host has attached a planned
  // flight to this share link. If a plan is attached we make Tonight
  // the default tab so guests land directly on the evening's guide.
  let tonightPlan = null;
  try { tonightPlan = await getSharedPlannedFlight(token); }
  catch { /* RPC failed — silently skip the Tonight tab */ }
  if (tonightPlan) {
    const tonightTab  = $('.guest-tab[data-tab="tonight"]', tabs);
    const tonightPane = $('.guest-pane[data-pane="tonight"]');
    const cellarTab   = $('.guest-tab[data-tab="cellar"]', tabs);
    if (tonightTab)  tonightTab.hidden = false;
    if (tonightPane) tonightPane.hidden = false;
    if (cellarTab)   cellarTab.classList.remove('active');
    if (tonightTab)  tonightTab.classList.add('active');
    // Hide non-Tonight panes by default until the user clicks another tab.
    $$('.guest-pane').forEach((p) => { p.hidden = p.dataset.pane !== 'tonight'; });
    renderTonightPane($('#guest-tonight-root'), tonightPlan, token);
  }

  // Modal close (backdrop or ✕)
  $$('#guest-bottle-modal [data-close]').forEach((el) => {
    el.addEventListener('click', () => { $('#guest-bottle-modal').hidden = true; });
  });

  // Tabs
  $$('.guest-tab', tabs).forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      $$('.guest-tab', tabs).forEach((b) => b.classList.toggle('active', b === btn));
      $$('.guest-pane').forEach((p) => { p.hidden = p.dataset.pane !== target; });
    });
  });

  // After every successful AI request: re-fetch quota and update the banner.
  const refreshQuota = async () => {
    try {
      const m = await resolveShare(token);
      if (m) renderBanner(m);
    } catch { /* non-fatal */ }
  };

  // Pair
  $('#guest-pair-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const out = $('#guest-pair-result');
    await withBusySubmit(e.currentTarget, out, 'Asking the sommelier… (up to a couple of minutes)', async () => {
      const ctx = {
        dish: fd.get('dish').trim(),
        guests: numOrNull(fd.get('guests')) ?? 2,
        occasion: fd.get('occasion'),
        constraints: fd.get('constraints')?.trim() || null,
      };
      const { response } = await requestPairingForShare(token, ctx);
      await renderGuestRecommendations(out, response, bottleById, {
        token, requestType: 'pairing', context: ctx,
      });
    });
    refreshQuota();
  });

  // Flight
  $('#guest-flight-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const out = $('#guest-flight-result');
    await withBusySubmit(e.currentTarget, out, 'Building the flight…', async () => {
      const ctx = {
        theme: fd.get('theme'),
        guests: numOrNull(fd.get('guests')) ?? 4,
        length: numOrNull(fd.get('length')) ?? 3,
        food:  fd.get('food')?.trim()  || null,
        notes: fd.get('notes')?.trim() || null,
      };
      const { response } = await requestFlightForShare(token, ctx);
      await renderGuestRecommendations(out, response, bottleById, {
        token, requestType: 'flight', context: ctx,
      });
    });
    refreshQuota();
  });

  // Drink now / sommelier
  $('#guest-drinknow-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const out = $('#guest-drinknow-result');
    await withBusySubmit(e.currentTarget, out, 'Asking the sommelier…', async () => {
      const ctx = { notes: fd.get('notes')?.trim() || null };
      const { response } = await requestDrinkNowForShare(token, ctx);
      await renderGuestRecommendations(out, response, bottleById, {
        token, requestType: 'drink_now', context: ctx,
      });
    });
    refreshQuota();
  });

  let activeFilter = 'all';
  let sortMode = 'producer';
  let searchTerm = '';

  const repaint = () => {
    let view = bottles.slice();
    if (activeFilter !== 'all') {
      const allowed = new Set(STYLE_GROUPS[activeFilter] || []);
      view = view.filter((b) => allowed.has(b.style));
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      view = view.filter((b) => [b.producer, b.wine_name, b.varietal, b.region, b.country]
        .some((s) => (s || '').toLowerCase().includes(q)));
    }
    const cmp = {
      producer:       (a, b) => (a.producer || '').localeCompare(b.producer || ''),
      vintage:        (a, b) => (b.vintage || 0) - (a.vintage || 0),
      vintage_oldest: (a, b) => (a.vintage || 9999) - (b.vintage || 9999),
      drink_end:      (a, b) => (a.drink_window_end || 9999) - (b.drink_window_end || 9999),
    }[sortMode] || (() => 0);
    view.sort(cmp);

    const count = $('#guest-count');
    if (count) {
      count.hidden = view.length === bottles.length && !searchTerm && activeFilter === 'all';
      count.textContent = `${view.length} of ${bottles.length} bottles`;
    }
    if (!view.length) { grid.innerHTML = '<p class="muted">No bottles match.</p>'; return; }
    grid.innerHTML = view.map(guestBottleRowHTML).join('');
    wireGuestBottleClicks(grid, bottleById);
  };

  $('#guest-search')?.addEventListener('input', (e) => { searchTerm = e.target.value.trim(); repaint(); });
  $('#guest-sort')?.addEventListener('change', (e) => { sortMode = e.target.value; repaint(); });
  $$('#guest-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#guest-filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.styleFilter;
      repaint();
    });
  });

  repaint();
}

async function renderGuestRecommendations(resultEl, response, bottleById, opts = {}) {
  const recs = Array.isArray(response.recommendations) ? response.recommendations : [];
  const cards = recs.map((r) => {
    const bottle = bottleById.get(r.bottle_id);
    if (!bottle) {
      return `<article class="bottle-card"><div class="bottle-meta">
        <h3 class="muted">Unknown bottle</h3>
        <p class="muted">id: ${escapeHtml(r.bottle_id)}</p>
        <p>${escapeHtml(r.reasoning || '')}</p>
      </div></article>`;
    }
    return `<article class="bottle-card" data-bottle-id="${escapeAttr(bottle.id)}" data-style="${escapeAttr(bottle.style || '')}" tabindex="0">
      <div class="bottle-photo placeholder">${escapeHtml((bottle.producer || '?')[0])}</div>
      <div class="bottle-meta">
        <h3>${escapeHtml(bottle.producer)}${bottle.wine_name ? ` <span class="muted">· ${escapeHtml(bottle.wine_name)}</span>` : ''}</h3>
        <p class="muted">${escapeHtml(bottle.varietal)}${bottle.vintage ? ` · ${bottle.vintage}` : ''}</p>
        <p><span class="qty">${escapeHtml(r.confidence || 'medium')}</span> · ${escapeHtml(r.reasoning || '')}</p>
      </div>
    </article>`;
  });
  const narrative = narrativeBlockHTML(response.narrative, { heading: 'Narrative' });
  const sendBlock = (opts.token && opts.requestType) ? sendToHostBlockHTML() : '';
  resultEl.innerHTML = `
    ${narrative}
    <section>
      <h2>Picks</h2>
      <div class="grid">${cards.join('') || '<p class="muted">(no recommendations)</p>'}</div>
    </section>
    ${sendBlock}`;
  wireGuestBottleClicks(resultEl, bottleById);
  if (opts.token && opts.requestType) {
    wireSendToHost(resultEl, opts.token, {
      kind: 'ai_result',
      payload: {
        request_type:    opts.requestType,
        context:         opts.context || {},
        recommendations: recs,
        narrative:       response.narrative || null,
      },
    });
  }
}

// Inline "Send to host" affordance + first-time name prompt. Renders
// inside any guest result panel (Pair / Flight / Sommelier). Once sent,
// the button collapses to "Sent ✓" so the same result can't be double-
// posted from the same render. Guest's display name persists in
// localStorage so subsequent sends auto-fill.
const GUEST_NAME_KEY = 'cellar27.guestName';
function getGuestName() {
  try { return localStorage.getItem(GUEST_NAME_KEY) || ''; }
  catch { return ''; }
}
function setGuestName(name) {
  try { localStorage.setItem(GUEST_NAME_KEY, name); } catch { /* private mode */ }
}

function sendToHostBlockHTML() {
  return `<section class="send-to-host">
    <button type="button" data-send-host>Send this to the host</button>
    <form class="send-to-host-form" data-send-host-form hidden>
      <label>Your name (so the host knows who sent this)
        <input type="text" name="guest_name" placeholder="e.g. Mike" />
      </label>
      <div class="row">
        <button type="submit">Send</button>
        <button type="button" class="ghost" data-send-host-cancel>Cancel</button>
      </div>
      <p class="error send-to-host-error" hidden></p>
    </form>
  </section>`;
}

function wireSendToHost(root, token, message) {
  const btn    = $('[data-send-host]', root);
  const form   = $('[data-send-host-form]', root);
  const cancel = $('[data-send-host-cancel]', root);
  if (!btn || !form) return;
  const errEl  = $('.send-to-host-error', form);
  const showErr = (msg) => { if (!errEl) return; errEl.hidden = !msg; errEl.textContent = msg || ''; };
  const nameInput = form.querySelector('input[name="guest_name"]');
  if (nameInput) nameInput.value = getGuestName();

  const send = async (guestName) => {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await sendGuestMessage(token, { ...message, guestName });
      if (guestName) setGuestName(guestName);
      btn.textContent = 'Sent ✓';
      btn.classList.add('sent');
      form.hidden = true;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Send this to the host';
      showErr(err.message);
    }
  };

  btn.addEventListener('click', () => {
    const saved = getGuestName();
    if (saved) {
      // Skip the prompt — name already known. One-tap send.
      send(saved);
    } else {
      form.hidden = false;
      btn.hidden  = true;
      nameInput?.focus();
    }
  });
  cancel?.addEventListener('click', () => {
    form.hidden = true;
    btn.hidden  = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (nameInput?.value || '').trim();
    send(name || null);
  });
}

function wireGuestBottleClicks(root, bottleById) {
  $$('[data-bottle-id]', root).forEach((node) => {
    node.addEventListener('click', () => {
      const b = bottleById.get(node.dataset.bottleId);
      if (b) showGuestBottleDetail(b);
    });
  });
}

// Render the Tonight tab — read-only walkthrough for guests of a saved
// planned flight. Falls back to plan.narrative when guest_view hasn't
// been generated yet so the page still works pre-walkthrough.
function renderTonightPane(root, plan, token) {
  if (!root || !plan) return;
  const bottles  = Array.isArray(plan.bottles) ? plan.bottles : [];
  const bottleById = new Map(bottles.map((b) => [b.id, b]));
  const picks    = Array.isArray(plan.picks)   ? plan.picks   : [];
  const food     = Array.isArray(plan.food)    ? plan.food    : [];
  const gv       = plan.guest_view || null;
  const intro    = (gv && gv.guest_intro) || plan.narrative || '';
  const walk     = (gv && Array.isArray(gv.pour_walkthrough)) ? gv.pour_walkthrough : [];
  const walkById = new Map(walk.filter((w) => w?.bottle_id).map((w) => [w.bottle_id, w]));

  const date = plan.occasion_date
    ? new Date(plan.occasion_date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  const headerHTML = `<header class="guest-tonight-head">
    <h1>${escapeHtml(plan.title || "Tonight's flight")}</h1>
    ${date ? `<p class="muted">${escapeHtml(date)}</p>` : ''}
  </header>`;

  const introHTML = intro
    ? narrativeBlockHTML(intro, { heading: 'Welcome', headingTag: 'h2' })
    : '';

  const foodHTML = food.length ? `<section class="guest-tonight-food">
    <h2>On the table</h2>
    <ul class="guest-food-list">
      ${food.map((f) => `<li>
        <span class="guest-food-kind">${escapeHtml(f.kind || 'meal')}</span>
        <strong>${escapeHtml(f.name || '')}</strong>
        ${f.description ? `<span class="muted"> — ${escapeHtml(f.description)}</span>` : ''}
      </li>`).join('')}
    </ul>
  </section>` : '';

  const whenLabel = (when) => {
    const w = (when || '').toLowerCase();
    if (w === 'before') return 'Before this pour';
    if (w === 'after')  return 'After this pour';
    return 'During this pour';
  };

  const poursHTML = picks.length ? `<section class="guest-tonight-pours">
    <h2>The pours</h2>
    ${picks.map((pick, i) => {
      const bottle = bottleById.get(pick.bottle_id);
      const w      = walkById.get(pick.bottle_id);
      const num    = i + 1;
      const sub    = bottle ? [bottle.varietal, bottle.vintage, bottle.region, bottle.country].filter(Boolean).map(escapeHtml).join(' · ') : '';
      const title  = bottle ? `${escapeHtml(bottle.producer)}${bottle.wine_name ? ` <span class="muted">· ${escapeHtml(bottle.wine_name)}</span>` : ''}` : `<span class="muted">Unknown bottle</span>`;
      const lookFor = w?.what_to_look_for
        ? `<p class="pour-look">${escapeHtml(w.what_to_look_for)}</p>`
        : (pick.reasoning ? `<p class="pour-look muted">${escapeHtml(pick.reasoning)}</p>` : '');
      const cue = (w?.food_cue && w.food_cue.toLowerCase() !== 'none')
        ? `<p class="food-cue-chip"><span class="food-cue-when">${escapeHtml(whenLabel(w.food_when))}</span> · ${escapeHtml(w.food_cue)}</p>`
        : '';
      const transition = w?.transition
        ? `<p class="pour-transition">${escapeHtml(w.transition)}</p>`
        : '';
      const noteWidget = token ? pourNoteWidgetHTML() : '';
      return `<article class="pour-block" data-style="${escapeAttr(bottle?.style || '')}" data-pour-bottle-id="${escapeAttr(pick.bottle_id)}">
        <div class="pour-num">Pour ${num}</div>
        <h3>${title}</h3>
        ${sub ? `<p class="muted">${sub}</p>` : ''}
        ${lookFor}
        ${cue}
        ${transition}
        ${noteWidget}
      </article>`;
    }).join('')}
  </section>` : '';

  root.innerHTML = `<div class="guest-plan-tonight">
    ${headerHTML}
    ${introHTML}
    ${foodHTML}
    ${poursHTML}
  </div>`;

  if (token) wirePourNoteWidgets(root, token, plan.id);
}

// Per-pour "Send a note to the host" affordance. Multiple notes per
// pour allowed — each submission posts a separate guest_message and
// resets the form so the guest can keep adding (e.g. one note before
// a sip, another after).
function pourNoteWidgetHTML() {
  return `<div class="pour-note">
    <button type="button" class="ghost" data-pour-note-toggle>Send a note to the host</button>
    <form class="pour-note-form" data-pour-note-form hidden>
      <textarea name="note" rows="2" placeholder="What did you notice? What would you tell the host?" required></textarea>
      <div class="row">
        <button type="submit">Send</button>
        <button type="button" class="ghost" data-pour-note-cancel>Cancel</button>
      </div>
      <p class="muted pour-note-status" hidden></p>
      <p class="error pour-note-error" hidden></p>
    </form>
  </div>`;
}

function wirePourNoteWidgets(root, token, plannedFlightId) {
  $$('.pour-block', root).forEach((block) => {
    const bottleId = block.dataset.pourBottleId;
    const toggle   = $('[data-pour-note-toggle]', block);
    const form     = $('[data-pour-note-form]', block);
    const cancel   = $('[data-pour-note-cancel]', block);
    if (!toggle || !form) return;
    const errEl    = $('.pour-note-error', form);
    const statusEl = $('.pour-note-status', form);
    const showErr = (msg) => { if (!errEl) return; errEl.hidden = !msg; errEl.textContent = msg || ''; };
    const showOk  = (msg) => { if (!statusEl) return; statusEl.hidden = !msg; statusEl.textContent = msg || ''; };

    toggle.addEventListener('click', () => {
      form.hidden = false;
      toggle.hidden = true;
      form.querySelector('textarea')?.focus();
    });
    cancel?.addEventListener('click', () => {
      form.hidden = true;
      toggle.hidden = false;
      showErr(''); showOk('');
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = form.querySelector('textarea');
      const note = (ta?.value || '').trim();
      if (!note) return;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      showErr(''); showOk('');
      try {
        await sendGuestMessage(token, {
          kind: 'pour_note',
          payload: { planned_flight_id: plannedFlightId, bottle_id: bottleId, note },
          guestName: getGuestName(),
        });
        if (ta) ta.value = '';
        showOk('Sent ✓');
      } catch (err) {
        showErr(err.message);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  });
}

function showGuestBottleDetail(b) {
  const modal = $('#guest-bottle-modal');
  if (!modal) return;
  const sub = [b.varietal, b.vintage, b.region, b.country].filter(Boolean).map(escapeHtml).join(' · ');
  const window = (b.drink_window_start && b.drink_window_end)
    ? `${b.drink_window_start}–${b.drink_window_end}` : '—';
  // The share RPC now returns `b.details` (sommelier enrichment jsonb —
  // tasting notes, food pairings, producer/region/serving). Render it
  // through the same helper the owner detail page uses so guests see
  // the same depth of info.
  const detailsBlock = b.details
    ? `<section class="narrative-block guest-bottle-details">
        <div class="narrative-head"><h3>More info</h3>${speakBtnHTML()}</div>
        <div class="narrative">${renderDetailsHTML(b.details)}</div>
      </section>`
    : '';
  $('#guest-bottle-detail').innerHTML = `
    <h2>${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h2>
    <p class="muted">${sub}</p>
    <dl class="bottle-meta-grid">
      <dt>Style</dt><dd>${escapeHtml(b.style || '—')}</dd>
      ${b.sweetness ? `<dt>Sweetness</dt><dd>${escapeHtml(b.sweetness)}</dd>` : ''}
      ${b.body ? `<dt>Body</dt><dd>${b.body} / 5</dd>` : ''}
      <dt>Quantity</dt><dd>×${b.quantity}</dd>
      <dt>Drink window</dt><dd>${window}</dd>
    </dl>
    ${detailsBlock}`;
  modal.hidden = false;
}

function guestBottleRowHTML(b) {
  const window = (b.drink_window_start && b.drink_window_end)
    ? `${b.drink_window_start}–${b.drink_window_end}`
    : '';
  const subParts = [
    escapeHtml(b.varietal),
    b.vintage ? String(b.vintage) : '',
    b.region ? escapeHtml(b.region) : '',
  ].filter(Boolean).join(' · ');
  return `
    <article class="bottle-row" data-bottle-id="${escapeAttr(b.id)}" data-style="${escapeAttr(b.style || '')}" tabindex="0">
      <div class="bottle-row-main">
        <h3 class="bottle-row-title">${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h3>
        <p class="bottle-row-sub muted">${subParts}</p>
      </div>
      <div class="bottle-row-aside">
        <span class="qty">×${b.quantity}</span>
        ${window ? `<span class="window muted">${window}</span>` : ''}
      </div>
    </article>`;
}

// ── Cellar grid (with search / filter / sort) ─────────────────────
const STYLE_GROUPS = {
  red:       ['light_red', 'medium_red', 'full_red'],
  white:     ['light_white', 'full_white'],
  rose:      ['rose'],
  sparkling: ['sparkling'],
  sweet:     ['dessert', 'fortified'],
};

const CELLAR_VIEW_KEY = 'cellar27.cellarView';
const getCellarView = () => localStorage.getItem(CELLAR_VIEW_KEY) === 'card' ? 'card' : 'list';
const setCellarView = (v) => { try { localStorage.setItem(CELLAR_VIEW_KEY, v); } catch { /* private mode */ } };

async function mountCellar() {
  const grid = $('#cellar-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="muted">Loading…</p>';
  let bottles;
  try { bottles = await listBottles(); }
  catch (e) { grid.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
  if (!bottles.length) {
    grid.innerHTML = '<p class="muted">Empty cellar. <a href="#/scan">Scan a bottle →</a> or <a href="#/add">add manually</a>.</p>';
    return;
  }

  // Filter / sort / search / view state
  let activeFilter = 'all';
  let sortMode = $('#cellar-sort')?.value || 'recent';
  let searchTerm = '';
  let viewMode = getCellarView();

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
    const builder = viewMode === 'list' ? bottleListRowHTML : bottleCardHTML;
    grid.innerHTML = view.map(builder).join('');
    grid.classList.toggle('grid', viewMode === 'card');
    grid.classList.toggle('cellar-list', viewMode === 'list');
    $$('[data-bottle-id]', grid).forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = node.dataset.bottleId;
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
  // View toggle: persist + repaint.
  const refreshToggleActive = () => {
    $$('#cellar-view-toggle .view-toggle-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === viewMode));
  };
  refreshToggleActive();
  $$('#cellar-view-toggle .view-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view;
      if (next === viewMode) return;
      viewMode = next;
      setCellarView(next);
      refreshToggleActive();
      repaint();
    });
  });

  repaint();
}

function bottleListRowHTML(b) {
  const window = (b.drink_window_start && b.drink_window_end)
    ? `${b.drink_window_start}–${b.drink_window_end}`
    : '';
  const subParts = [
    escapeHtml(b.varietal),
    b.vintage ? String(b.vintage) : '',
    b.region ? escapeHtml(b.region) : '',
  ].filter(Boolean).join(' · ');
  return `
    <article class="bottle-row" data-bottle-id="${b.id}" data-style="${escapeAttr(b.style || '')}" tabindex="0">
      <div class="bottle-row-main">
        <h3 class="bottle-row-title">${escapeHtml(b.producer)}${b.wine_name ? ` <span class="muted">· ${escapeHtml(b.wine_name)}</span>` : ''}</h3>
        <p class="bottle-row-sub muted">${subParts}</p>
      </div>
      <div class="bottle-row-aside">
        <span class="qty">×${b.quantity}</span>
        ${window ? `<span class="window muted">${window}</span>` : ''}
      </div>
      <button class="bottle-row-pour" data-pour="${b.id}" ${b.quantity <= 0 ? 'disabled' : ''}>Pour</button>
    </article>`;
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
// Records the most recent enrichment failure per bottle so the detail page
// can offer a Retry instead of the spinner-forever bug from before.
const enrichFailures = new Map(); // bottleId → error message
async function autoEnrich(bottleId) {
  if (enrichingBottles.has(bottleId)) return;
  enrichingBottles.add(bottleId);
  enrichFailures.delete(bottleId);
  if (location.hash === `#/bottle/${bottleId}`) render();
  try {
    const response = await requestEnrichment(bottleId);
    const details = response.extracted?.details || response.extracted || null;
    if (details) {
      await updateBottle(bottleId, { details });
    } else {
      enrichFailures.set(bottleId, 'No details returned by sommelier.');
    }
  } catch (err) {
    console.warn('[cellar27] autoEnrich failed:', err);
    enrichFailures.set(bottleId, err?.message || 'Sommelier request failed.');
    if (location.hash === `#/bottle/${bottleId}`) {
      showToast(`Couldn't fetch sommelier notes — tap Retry on the bottle.`);
    }
  } finally {
    enrichingBottles.delete(bottleId);
    if (location.hash === `#/bottle/${bottleId}`) render();
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
// Animated SVG loader: tilted bottle pouring into a wine glass that
// fills, holds, then drains. Inline SVG with SMIL animation so we
// don't need any extra JS lifecycle.
function pourLoaderHTML(msg = '') {
  const svg = `
    <svg class="pour-loader-svg" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="pour-bowl-clip"><path d="M16 21 h11 l-1.3 5.5 a5.2 5.2 0 0 1 -8.4 0 z" /></clipPath>
      </defs>
      <g transform="rotate(-50 14 14)" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
        <path d="M11 3 h6 v3 c1 0.4 1.4 1.5 1.4 3 v8 a1.4 1.4 0 0 1 -1.4 1.4 h-6 a1.4 1.4 0 0 1 -1.4 -1.4 v-8 c0 -1.5 0.4 -2.6 1.4 -3 z" />
      </g>
      <circle cx="18" cy="17" r="0.9" fill="currentColor" opacity="0">
        <animate attributeName="cy" values="16;22" dur="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;0" dur="0.9s" repeatCount="indefinite" />
      </circle>
      <circle cx="19" cy="17" r="0.7" fill="currentColor" opacity="0">
        <animate attributeName="cy" values="16;23" dur="0.9s" begin="0.3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;0" dur="0.9s" begin="0.3s" repeatCount="indefinite" />
      </circle>
      <rect clip-path="url(#pour-bowl-clip)" fill="currentColor" opacity="0.85" x="15" width="13" y="27" height="0">
        <animate attributeName="y" values="27;21.5;21.5;27" dur="2.4s" keyTimes="0;0.6;0.8;1" repeatCount="indefinite" />
        <animate attributeName="height" values="0;5.5;5.5;0" dur="2.4s" keyTimes="0;0.6;0.8;1" repeatCount="indefinite" />
      </rect>
      <path d="M16 21 h11 l-1.3 5.5 a5.2 5.2 0 0 1 -8.4 0 z M21.5 30.4 V34 M19 34 h6"
            fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
  return `<div class="pour-loader" role="status" aria-live="polite">${svg}${msg ? `<p class="muted pour-loader-msg">${escapeHtml(msg)}</p>` : ''}</div>`;
}

function setBusy(resultEl, msg) {
  resultEl.innerHTML = pourLoaderHTML(msg);
}

// Wraps an async submit handler so the form's submit button is disabled
// for the duration of the request — prevents button-mashing during the
// 30–90s Claude wait that would otherwise fire parallel requests, blow
// past the in-flight cap, and burn the daily Claude budget. Also owns
// the standard error-rendering pattern so the call sites stay tight.
async function withBusySubmit(form, resultEl, msg, fn) {
  const submitBtn = form.querySelector('button[type="submit"], button:not([type])');
  if (submitBtn) submitBtn.disabled = true;
  setBusy(resultEl, msg);
  try {
    await fn();
  } catch (err) {
    resultEl.innerHTML = `<p class="error">${escapeHtml(err?.message || String(err))}</p>`;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// In-memory cache of the most recent rendered AI result panel per view,
// keyed by a short string. Lets us restore the recommendations + narrative
// when the user clicks into a bottle and then navigates back — otherwise
// the result panel would be empty and they'd lose the context they were
// reading. Cleared only by a fresh submit (which overwrites) or page
// reload (in-memory only — intentional; we don't want stale results
// surviving days of inactivity).
const _aiResultCache = new Map();
function cacheResult(key, resultEl) {
  if (resultEl?.innerHTML?.trim()) _aiResultCache.set(key, resultEl.innerHTML);
}
function restoreResult(key, resultEl) {
  const html = _aiResultCache.get(key);
  if (!html || !resultEl) return false;
  resultEl.innerHTML = html;
  // Re-wire bottle-card click handlers — they're lost when innerHTML is
  // replaced (raw innerHTML doesn't carry attached listeners).
  $$('[data-bottle-id]', resultEl).forEach((node) => {
    node.addEventListener('click', () => {
      const id = node.dataset.bottleId;
      if (id) location.hash = `#/bottle/${id}`;
    });
  });
  // The Save-flight form needs the original response object to function
  // and we don't keep that across navigations — strip it so the user
  // doesn't click an inert button. Resubmitting the form yields a fresh
  // savable result.
  $$('.save-flight', resultEl).forEach((n) => n.remove());
  return true;
}
async function renderRecommendations(resultEl, response, opts = {}) {
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
    return `<article class="bottle-card" data-bottle-id="${escapeAttr(bottle.id)}" data-style="${escapeAttr(bottle.style || '')}" tabindex="0">
      <div class="bottle-photo placeholder">${escapeHtml((bottle.producer || '?')[0])}</div>
      <div class="bottle-meta">
        <h3>${escapeHtml(bottle.producer)}${bottle.wine_name ? ` <span class="muted">· ${escapeHtml(bottle.wine_name)}</span>` : ''}</h3>
        <p class="muted">${escapeHtml(bottle.varietal)}${bottle.vintage ? ` · ${bottle.vintage}` : ''}</p>
        <p><span class="qty">${escapeHtml(r.confidence || 'medium')}</span> · ${escapeHtml(r.reasoning || '')}</p>
      </div>
    </article>`;
  }));
  const narrative = narrativeBlockHTML(response.narrative, { heading: 'Narrative' });
  const saveSection = opts.savable ? saveFlightFormHTML() : '';
  resultEl.innerHTML = `
    ${narrative}
    <section>
      <h2>Picks</h2>
      <div class="grid">${cards.join('') || '<p class="muted">(no recommendations)</p>'}</div>
    </section>
    ${saveSection}`;
  $$('[data-bottle-id]', resultEl).forEach((node) => {
    node.addEventListener('click', () => {
      const id = node.dataset.bottleId;
      if (id) location.hash = `#/bottle/${id}`;
    });
  });
  if (opts.savable) wireSaveFlight(resultEl, response, opts.context || {});
}

// Inline form rendered below a flight builder result so the user can
// promote it to a planned flight. Hidden until the user clicks "Save".
function saveFlightFormHTML() {
  return `<section class="save-flight">
    <button type="button" class="save-flight-toggle" data-save-flight-toggle>Save this flight</button>
    <form class="save-flight-form" data-save-flight-form hidden>
      <label>Title (optional)
        <input name="title" placeholder="e.g. Saturday with Mike" />
      </label>
      <label>Occasion date (optional)
        <input name="occasion_date" type="date" />
      </label>
      <div class="row">
        <button type="submit">Save flight &amp; plan</button>
        <button type="button" class="ghost" data-save-flight-cancel>Cancel</button>
      </div>
      <p class="muted save-flight-hint">After saving we'll ask the sommelier to suggest food and prep — you can edit anything.</p>
    </form>
  </section>`;
}

function wireSaveFlight(resultEl, response, context) {
  const toggle = $('[data-save-flight-toggle]', resultEl);
  const form   = $('[data-save-flight-form]', resultEl);
  const cancel = $('[data-save-flight-cancel]', resultEl);
  if (!toggle || !form) return;
  toggle.addEventListener('click', () => {
    form.hidden = false;
    toggle.hidden = true;
    form.querySelector('input[name="title"]')?.focus();
  });
  cancel?.addEventListener('click', () => {
    form.hidden = true;
    toggle.hidden = false;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const picks = (response.recommendations || []).map((r) => ({
        bottle_id:  r.bottle_id,
        confidence: r.confidence || null,
        reasoning:  r.reasoning  || null,
      }));
      const saved = await createPlannedFlight({
        title:             fd.get('title')?.toString().trim() || null,
        occasion_date:     fd.get('occasion_date')?.toString() || null,
        source_request_id: response.request_id || null,
        theme:             context.theme  ?? null,
        guests:            context.guests ?? null,
        narrative:         response.narrative || '',
        picks,
      });
      // Fire-and-forget the AI enrichment — the detail page subscribes
      // to the response itself, so we don't have to await it here.
      requestFlightPlanEnrichment(saved).catch((err) => {
        console.error('flight_plan enrichment failed:', err);
      });
      location.hash = `#/planned/${saved.id}`;
    } catch (err) {
      const errEl = form.querySelector('.error') || (() => {
        const p = document.createElement('p');
        p.className = 'error';
        form.appendChild(p);
        return p;
      })();
      errEl.textContent = err?.message || String(err);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// Wrap a narrative blob with a Read-aloud button. Heading is optional;
// when set, the button sits inline with the heading. The button is
// wired by a global click delegate that calls window.speechSynthesis
// on the sibling .narrative's textContent.
function narrativeBlockHTML(text, opts = {}) {
  if (!text) return '';
  const heading = opts.heading || '';
  const headingTag = opts.headingTag || 'h2';
  const wrapStyle = opts.wrapStyle || '';
  const headHTML = heading
    ? `<div class="narrative-head"><${headingTag}>${escapeHtml(heading)}</${headingTag}>${speakBtnHTML()}</div>`
    : `<div class="narrative-head narrative-head-bare">${speakBtnHTML()}</div>`;
  return `<section class="narrative-block"${wrapStyle ? ` style="${wrapStyle}"` : ''}>${headHTML}<div class="narrative">${markdownLite(text)}</div></section>`;
}
function speakBtnHTML() {
  return `<span class="speak-control">
    <button type="button" class="narrative-speak" data-speak-target aria-label="Read aloud" title="Read aloud">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"
              d="M5 9 h3 l5 -4 v14 l-5 -4 h-3 z M16 9 a3 3 0 0 1 0 6 M18 7 a6 6 0 0 1 0 10" />
      </svg>
    </button>
    <button type="button" class="narrative-voice-toggle" data-voice-toggle aria-label="Voice settings" title="Voice settings">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9 l6 6 l6 -6" />
      </svg>
    </button>
  </span>`;
}

// Voice + rate persistence + cache.
const VOICE_KEY = 'cellar27.voiceURI';
const RATE_KEY  = 'cellar27.voiceRate';
let _voices = [];
function loadVoices() { _voices = window.speechSynthesis?.getVoices() || []; }
loadVoices();
window.speechSynthesis?.addEventListener?.('voiceschanged', () => {
  loadVoices();
  // If the picker is open, refresh its list so newly-loaded voices appear.
  if (!$('#voice-picker')?.hidden) renderVoiceList();
});
function getSavedRate() {
  const r = parseFloat(localStorage.getItem(RATE_KEY));
  return (r >= 0.5 && r <= 2) ? r : 0.95;
}

let _speakingBtn = null;
function toggleSpeak(text, btn) {
  const synth = window.speechSynthesis;
  if (!synth) { alert('Read-aloud not supported on this browser.'); return; }
  const wasThis = _speakingBtn === btn;
  if (synth.speaking || synth.pending) {
    synth.cancel();
    if (_speakingBtn) { _speakingBtn.classList.remove('speaking'); _speakingBtn = null; }
    if (wasThis) return; // just stop
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = getSavedRate();
  const wantedURI = localStorage.getItem(VOICE_KEY);
  if (wantedURI) {
    const v = _voices.find((x) => x.voiceURI === wantedURI);
    if (v) utter.voice = v;
  }
  const clear = () => {
    btn.classList.remove('speaking');
    if (_speakingBtn === btn) _speakingBtn = null;
  };
  utter.onend = clear;
  utter.onerror = clear;
  _speakingBtn = btn;
  btn.classList.add('speaking');
  synth.speak(utter);
}
// Delegate: any tap on a Read-aloud button finds the nearest .narrative
// element in the same .narrative-block and reads its plain text.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-speak-target]');
  if (!btn) return;
  const block = btn.closest('.narrative-block, .bottle-details-section, section, article');
  const narrEl = block?.querySelector('.narrative');
  const text = narrEl?.textContent?.trim();
  if (text) toggleSpeak(text, btn);
});
// Stop on navigation so a half-read narrative doesn't keep talking;
// also close the voice picker.
window.addEventListener('hashchange', () => {
  if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
  if (_speakingBtn) { _speakingBtn.classList.remove('speaking'); _speakingBtn = null; }
  closeVoicePicker();
});

// ── Voice picker ──────────────────────────────────────────────────
function renderVoiceList() {
  const list = $('#voice-list');
  if (!list) return;
  const enOnly = $('#voice-en-only')?.checked ?? true;
  const saved = localStorage.getItem(VOICE_KEY);
  const filtered = (enOnly ? _voices.filter((v) => /^en/i.test(v.lang)) : _voices.slice());
  // Sort: enhanced/local-service first, then by name.
  filtered.sort((a, b) => (Number(b.localService) - Number(a.localService)) || a.name.localeCompare(b.name));
  if (!filtered.length) {
    list.innerHTML = `<li class="muted" style="padding:.4rem .5rem;">No voices available.</li>`;
    return;
  }
  const savedAvailable = saved && _voices.some((v) => v.voiceURI === saved);
  const note = saved && !savedAvailable
    ? `<li class="muted" style="padding:.4rem .5rem; font-size:.8rem;">(Saved voice not available on this device — using default.)</li>`
    : '';
  list.innerHTML = note + filtered.map((v) => {
    const checked = (saved && v.voiceURI === saved) ? 'checked' : '';
    return `<li><label class="voice-row">
      <input type="radio" name="voice" value="${escapeAttr(v.voiceURI)}" ${checked} />
      <span class="voice-name">${escapeHtml(v.name)}</span>
      <span class="muted voice-lang">${escapeHtml(v.lang)}${v.default ? ' · default' : ''}</span>
    </label></li>`;
  }).join('');
}
function openVoicePicker(anchorBtn) {
  const picker = $('#voice-picker');
  if (!picker) return;
  // Position relative to the anchor; clamp to viewport.
  const r = anchorBtn.getBoundingClientRect();
  picker.hidden = false;
  // Force-render so we can measure dimensions.
  const pickerW = Math.min(320, window.innerWidth - 16);
  picker.style.width = pickerW + 'px';
  let left = r.right + window.scrollX - pickerW;
  left = Math.max(8 + window.scrollX, Math.min(left, window.scrollX + window.innerWidth - pickerW - 8));
  picker.style.left = left + 'px';
  picker.style.top = (r.bottom + window.scrollY + 6) + 'px';
  // Hydrate fields from saved state.
  const enOnly = $('#voice-en-only');
  if (enOnly) enOnly.checked = true;
  const rateInput = $('#voice-rate');
  const rateDisplay = $('#voice-rate-display');
  if (rateInput && rateDisplay) {
    const r0 = getSavedRate();
    rateInput.value = String(r0);
    rateDisplay.textContent = `${r0.toFixed(2)}×`;
  }
  renderVoiceList();
}
function closeVoicePicker() {
  const picker = $('#voice-picker');
  if (picker && !picker.hidden) picker.hidden = true;
}
function mountVoicePicker() {
  const picker = $('#voice-picker');
  if (!picker || picker.dataset.wired) return;
  picker.dataset.wired = '1';
  $('#voice-picker-close')?.addEventListener('click', closeVoicePicker);
  $('#voice-en-only')?.addEventListener('change', renderVoiceList);
  $('#voice-list')?.addEventListener('change', (e) => {
    const radio = e.target.closest('input[type="radio"][name="voice"]');
    if (radio?.value) localStorage.setItem(VOICE_KEY, radio.value);
  });
  $('#voice-rate')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    localStorage.setItem(RATE_KEY, String(v));
    const display = $('#voice-rate-display');
    if (display) display.textContent = `${v.toFixed(2)}×`;
  });
  $('#voice-test')?.addEventListener('click', () => {
    const fakeBtn = $('#voice-test'); // its .speaking class is harmless here
    toggleSpeak('This is the cellar27 sommelier voice.', fakeBtn);
  });
  // Click-outside dismiss.
  document.addEventListener('click', (e) => {
    if (picker.hidden) return;
    if (e.target.closest('#voice-picker')) return;
    if (e.target.closest('[data-voice-toggle]')) return;
    closeVoicePicker();
  });
  // Caret-button delegate.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-voice-toggle]');
    if (!btn) return;
    if (!picker.hidden) { closeVoicePicker(); return; }
    openVoicePicker(btn);
  });
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
  restoreResult('pairing', result);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await withBusySubmit(form, result, 'Asking your sommelier… (up to a couple of minutes)', async () => {
      const { response } = await requestPairing({
        dish: fd.get('dish').trim(),
        guests: numOrNull(fd.get('guests')) ?? 2,
        occasion: fd.get('occasion'),
        constraints: fd.get('constraints')?.trim() || null,
      });
      await renderRecommendations(result, response);
      cacheResult('pairing', result);
    });
  });
}

function mountFlight() {
  const form = $('#flight-form');
  const result = $('#flight-result');
  if (form) {
    restoreResult('flight', result);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      await withBusySubmit(form, result, 'Building the flight… (this may take a couple of minutes)', async () => {
        const theme  = fd.get('theme');
        const guests = numOrNull(fd.get('guests')) ?? 4;
        const length = numOrNull(fd.get('length')) ?? 3;
        const food   = fd.get('food')?.trim()  || null;
        const notes  = fd.get('notes')?.trim() || null;
        const { request, response } = await requestFlight({ theme, guests, length, food, notes });
        // Stamp the request id onto the response so the Save handler can
        // record source_request_id without having to refetch.
        response.request_id = request.id;
        await renderRecommendations(result, response, {
          savable: true,
          context: { theme, guests, length, food, notes },
        });
        cacheResult('flight', result);
      });
    });
  }
  const extrasForm = $('#flight-extras-form');
  const extrasResult = $('#flight-extras-result');
  if (extrasForm) {
    restoreResult('flight-extras', extrasResult);
    extrasForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(extrasForm);
      await withBusySubmit(extrasForm, extrasResult, 'Asking your sommelier what to add…', async () => {
        const { response } = await requestFlightExtras({
          themeHint: fd.get('theme_hint')?.trim() || null,
        });
        // No structured cellar picks — render narrative only.
        extrasResult.innerHTML = response.narrative
          ? narrativeBlockHTML(response.narrative, { heading: 'Suggestions', headingTag: 'h3' })
          : '<p class="muted">(no suggestions)</p>';
        cacheResult('flight-extras', extrasResult);
      });
    });
  }
}

// ── Planned flights ───────────────────────────────────────────────

async function mountPlanned(id) {
  const root = $('#planned-root');
  if (!root) return;
  if (id) await mountPlannedDetail(root, id);
  else    await mountPlannedList(root);
}

async function mountPlannedList(root) {
  root.innerHTML = `<h1>Planned flights</h1>
    <p class="muted">Flights you've saved from the Flight builder, with food and prep notes for the night.</p>
    <div id="planned-list" class="planned-list">Loading…</div>`;
  let plans;
  try { plans = await listPlannedFlights(); }
  catch (e) {
    $('#planned-list', root).innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!plans.length) {
    $('#planned-list', root).innerHTML = `<p class="muted">No planned flights yet. Build one in the
      <a href="#/flight">Flight builder</a> and click <em>Save this flight</em> to plan the evening.</p>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = [], undated = [], past = [];
  for (const p of plans) {
    if (!p.occasion_date) undated.push(p);
    else if (p.occasion_date >= today) upcoming.push(p);
    else past.push(p);
  }
  const section = (title, list) => list.length
    ? `<section><h2>${title}</h2><div class="planned-cards">${list.map(plannedCardHTML).join('')}</div></section>`
    : '';
  $('#planned-list', root).innerHTML = [
    section('Upcoming', upcoming),
    section('Undated',  undated),
    section('Past',     past),
  ].filter(Boolean).join('') || '<p class="muted">(nothing here yet)</p>';
  $$('[data-planned-id]', root).forEach((node) => {
    node.addEventListener('click', () => {
      location.hash = `#/planned/${node.dataset.plannedId}`;
    });
  });
}

function plannedCardHTML(p) {
  const date = p.occasion_date
    ? new Date(p.occasion_date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  const picksCount = Array.isArray(p.picks) ? p.picks.length : 0;
  const themeLabel = p.theme ? p.theme.replace(/_/g, ' ') : '';
  const enrichmentState = (p.food == null && p.prep == null)
    ? '<span class="planned-card-pending">plan pending</span>'
    : '';
  return `<article class="planned-card" data-planned-id="${escapeAttr(p.id)}" tabindex="0">
    <h3>${escapeHtml(p.title || 'Untitled flight')}</h3>
    <p class="muted">${escapeHtml(date)}${date && themeLabel ? ' · ' : ''}${escapeHtml(themeLabel)}</p>
    <p class="muted">${picksCount} bottle${picksCount === 1 ? '' : 's'} ${enrichmentState}</p>
  </article>`;
}

async function mountPlannedDetail(root, id) {
  root.innerHTML = '<p class="muted">Loading…</p>';
  let plan;
  try { plan = await getPlannedFlight(id); }
  catch (e) { root.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
  if (!plan) { root.innerHTML = '<p class="muted">Planned flight not found.</p>'; return; }

  await renderPlannedDetail(root, plan);

  // If enrichment hasn't landed yet, poll for it. The save flow fires the
  // request in the background; we just watch the row for food/prep
  // appearing. Bounded so a watcher outage doesn't poll forever.
  if (plan.food == null && plan.prep == null) pollForEnrichment(root, plan.id);
}

async function pollForEnrichment(root, id) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    // Stop if the user navigated away.
    if (!document.body.contains(root) || location.hash !== `#/planned/${id}`) return;
    let fresh;
    try { fresh = await getPlannedFlight(id); }
    catch { continue; }
    if (!fresh) return;
    if (fresh.food != null || fresh.prep != null) {
      await renderPlannedDetail(root, fresh);
      return;
    }
  }
}

async function renderPlannedDetail(root, plan) {
  // Pre-fetch each pick's bottle so we can show producer/varietal next to
  // its prep row. Tolerant of deleted bottles (unknown id renders muted).
  const picks = Array.isArray(plan.picks) ? plan.picks : [];
  const bottles = await Promise.all(picks.map(async (p) => {
    try { return { pick: p, bottle: await getBottle(p.bottle_id) }; }
    catch { return { pick: p, bottle: null }; }
  }));

  const headerHTML = `
    <header class="planned-header">
      <label>Title <input type="text" data-field="title" value="${escapeAttr(plan.title || '')}" placeholder="Untitled flight" /></label>
      <label>Occasion date <input type="date" data-field="occasion_date" value="${escapeAttr(plan.occasion_date || '')}" /></label>
      <p class="muted planned-meta">
        ${plan.theme ? `Theme: ${escapeHtml(plan.theme.replace(/_/g, ' '))}` : ''}
        ${plan.guests ? ` · ${plan.guests} guests` : ''}
      </p>
    </header>`;

  const narrativeHTML = plan.narrative
    ? narrativeBlockHTML(plan.narrative, { heading: 'Narrative' })
    : '';

  const picksHTML = `<section><h2>Picks</h2>
    <div class="grid">${bottles.map(({ pick, bottle }) => bottle ? `
      <article class="bottle-card" data-bottle-id="${escapeAttr(bottle.id)}" data-style="${escapeAttr(bottle.style || '')}" tabindex="0">
        <div class="bottle-photo placeholder">${escapeHtml((bottle.producer || '?')[0])}</div>
        <div class="bottle-meta">
          <h3>${escapeHtml(bottle.producer)}${bottle.wine_name ? ` <span class="muted">· ${escapeHtml(bottle.wine_name)}</span>` : ''}</h3>
          <p class="muted">${escapeHtml(bottle.varietal)}${bottle.vintage ? ` · ${bottle.vintage}` : ''}</p>
          ${pick.reasoning ? `<p>${escapeHtml(pick.reasoning)}</p>` : ''}
        </div>
      </article>` : `<article class="bottle-card"><div class="bottle-meta">
        <h3 class="muted">Unknown bottle</h3>
        <p class="muted">id: ${escapeHtml(pick.bottle_id)}</p>
      </div></article>`).join('')}</div>
  </section>`;

  const enrichmentPending = (plan.food == null && plan.prep == null);

  const foodHTML = `<section class="planned-food"><h2>Food</h2>
    ${enrichmentPending
      ? '<p class="muted">Sommelier is preparing food suggestions…</p>'
      : `<p class="muted food-hint">Options to choose from — keep what you'll serve, edit or delete the rest.</p>${renderFoodEditor(plan.food || [])}`}
  </section>`;

  const prepHTML = `<section class="planned-prep"><h2>Preparation</h2>
    ${enrichmentPending
      ? '<p class="muted">Sommelier is preparing serving notes…</p>'
      : renderPrepEditor(plan.prep || {}, bottles)}
  </section>`;

  const notesHTML = `<section class="planned-notes"><h2>Your notes</h2>
    <textarea data-field="user_notes" rows="3" placeholder="Anything else for the night…">${escapeHtml(plan.user_notes || '')}</textarea>
  </section>`;

  const guestSectionHTML = `<section class="planned-guest" data-guest-section>
    <h2>Guest view</h2>
    <div data-guest-body><p class="muted">Loading guest-link status…</p></div>
  </section>`;

  const actionsHTML = `<section class="planned-actions">
    <button type="button" class="ghost" data-action="reask"${enrichmentPending ? ' disabled' : ''}>Re-ask the sommelier</button>
    <button type="button" class="ghost" data-action="delete">Delete this plan</button>
    <p class="error planned-error" hidden></p>
  </section>`;

  root.innerHTML = headerHTML + narrativeHTML + picksHTML + foodHTML + prepHTML + notesHTML + guestSectionHTML + actionsHTML;

  wirePlannedDetail(root, plan);
  renderPlannedGuestSection(root, plan);
}

// Owner-side guest-link controls inside the planned flight detail page.
// Three states: no active share link (nudge to /share), link exists but
// nothing attached (offer to attach), already attached (offer to detach,
// generate/re-generate the walkthrough, or copy the URL).
async function renderPlannedGuestSection(root, plan) {
  const body = $('[data-guest-body]', root);
  if (!body) return;

  let link;
  try { link = await getActiveShareLink(); }
  catch (e) {
    body.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    return;
  }

  if (!link) {
    body.innerHTML = `<p class="muted">Create a guest link in the
      <a href="#/share">Share view</a> first, then come back here to show
      this plan to your guests.</p>`;
    return;
  }

  const expiresAt = new Date(link.expires_at);
  const expiresLabel = expiresAt.toLocaleString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const attached = plan.shared_via_link_id === link.id;
  const wrongLink = !attached && plan.shared_via_link_id != null;
  const shareUrl = shareUrlFor(link.token);
  const hasWalkthrough = plan.guest_view && (plan.guest_view.guest_intro || plan.guest_view.pour_walkthrough);

  if (wrongLink) {
    // The plan is attached to a different (revoked/expired) link. Treat
    // as detached; offer a clean re-attach to the current active link.
    body.innerHTML = `<p class="muted">This plan was attached to a previous share link that's no longer active.</p>
      <button type="button" data-guest-action="attach">Show on current guest link</button>
      <p class="error planned-guest-error" hidden></p>`;
  } else if (!attached) {
    body.innerHTML = `<p class="muted">Show this plan to anyone with your active guest link (<code>${escapeHtml(shareUrl)}</code> · expires ${escapeHtml(expiresLabel)}).</p>
      <button type="button" data-guest-action="attach">Show this plan to guests</button>
      <p class="error planned-guest-error" hidden></p>`;
  } else {
    const walkthroughBtn = hasWalkthrough
      ? `<button type="button" class="ghost" data-guest-action="walkthrough">Re-generate walkthrough</button>`
      : `<button type="button" data-guest-action="walkthrough">Generate guest walkthrough</button>`;
    const status = hasWalkthrough
      ? `<p class="muted">Visible to guests until ${escapeHtml(expiresLabel)} — walkthrough ready.</p>`
      : `<p class="muted">Visible to guests until ${escapeHtml(expiresLabel)} — guests will see the original narrative until you generate the walkthrough.</p>`;
    body.innerHTML = `${status}
      <p class="planned-guest-url"><a href="${escapeAttr(shareUrl)}" target="_blank" rel="noopener">Open guest view ↗</a></p>
      <div class="planned-guest-actions">
        ${walkthroughBtn}
        <button type="button" class="ghost" data-guest-action="detach">Hide from guests</button>
      </div>
      <p class="error planned-guest-error" hidden></p>`;
  }

  wirePlannedGuestSection(root, plan, link);
}

function wirePlannedGuestSection(root, plan, link) {
  const body = $('[data-guest-body]', root);
  if (!body) return;
  const errEl = $('.planned-guest-error', body);
  const showErr = (msg) => {
    if (!errEl) return;
    errEl.hidden = !msg;
    errEl.textContent = msg || '';
  };
  const refresh = async () => {
    const fresh = await getPlannedFlight(plan.id);
    if (fresh) await renderPlannedGuestSection(root, fresh);
  };

  $('[data-guest-action="attach"]', body)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await attachPlannedFlightToShare(plan.id, link.id); await refresh(); }
    catch (err) {
      e.currentTarget.disabled = false;
      const msg = /unique/i.test(err.message)
        ? 'Another planned flight is already attached to your active share link — detach it first.'
        : err.message;
      showErr(msg);
    }
  });

  $('[data-guest-action="detach"]', body)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await detachPlannedFlightFromShare(plan.id); await refresh(); }
    catch (err) { e.currentTarget.disabled = false; showErr(err.message); }
  });

  $('[data-guest-action="walkthrough"]', body)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sommelier is writing the walkthrough…';
    showErr('');
    try {
      const fresh = await getPlannedFlight(plan.id);
      await requestGuestWalkthrough(fresh);
      await refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showErr(err.message);
    }
  });
}

function renderFoodEditor(food) {
  const items = Array.isArray(food) ? food : [];
  const rows = items.map((item, i) => `
    <li class="food-row" data-food-idx="${i}">
      <div class="food-row-head">
        <select data-food-field="kind">
          <option value="meal"  ${item.kind === 'meal'  ? 'selected' : ''}>Meal</option>
          <option value="snack" ${item.kind === 'snack' ? 'selected' : ''}>Snack</option>
        </select>
        <input type="text" data-food-field="name" value="${escapeAttr(item.name || '')}" placeholder="Dish or snack" />
        <button type="button" class="ghost" data-food-remove aria-label="Remove">×</button>
      </div>
      <textarea data-food-field="description" rows="3" placeholder="Notes (optional)">${escapeHtml(item.description || '')}</textarea>
    </li>`).join('');
  return `<ul class="food-list">${rows || '<li class="muted">No food yet. Add one below.</li>'}</ul>
    <div class="row food-add-row">
      <button type="button" data-food-add="meal">+ Meal</button>
      <button type="button" data-food-add="snack">+ Snack</button>
    </div>`;
}

function renderPrepEditor(prep, bottles) {
  const chillBy   = (id) => (prep.chill    || []).find((x) => x.bottle_id === id) || {};
  const openByOf  = (id) => (prep.open_by  || []).find((x) => x.bottle_id === id) || {};
  const decantOf  = (id) => (prep.decanters || []).find((x) => x.bottle_id === id);
  const glassOf   = (id) => (prep.glassware || []).find((x) => x.bottle_id === id) || {};
  const rows = bottles.map(({ pick, bottle }) => {
    const id = pick.bottle_id;
    const name = bottle ? `${bottle.producer}${bottle.wine_name ? ' · ' + bottle.wine_name : ''}` : 'Unknown bottle';
    const decant = decantOf(id);
    const decantBadge = decant
      ? `<div class="prep-decant-badge">Decant${decant.why ? ` — ${escapeHtml(decant.why)}` : ''}</div>`
      : '';
    return `<tr data-prep-bottle="${escapeAttr(id)}">
      <th scope="row">
        <div class="prep-bottle-name">${escapeHtml(name)}</div>
        ${decantBadge}
      </th>
      <td data-prep-label="Chill in fridge (minutes before pour)"><input type="number" min="0" max="600" step="5" data-prep-field="chill"   value="${escapeAttr(chillBy(id).minutes ?? '')}"  placeholder="min" /></td>
      <td data-prep-label="Breathe — pull cork (minutes before pour)"><input type="number" min="0" max="600" step="5" data-prep-field="open_by" value="${escapeAttr(openByOf(id).minutes ?? '')}" placeholder="min" /></td>
      <td data-prep-label="Glass"><input type="text" data-prep-field="glassware" value="${escapeAttr(glassOf(id).type || '')}" placeholder="e.g. Burgundy" /></td>
    </tr>`;
  }).join('');
  return `<p class="muted prep-hint">Sommelier suggestions — adjust the minutes if you'd rather pour differently. <em>Chill</em> = how long in the fridge before serving. <em>Breathe</em> = how long ahead to pull the cork so the wine can aerate (a heavier intervention than this is in the Decant note under the bottle).</p>
  <table class="prep-table">
    <thead><tr><th></th><th>Chill (min)</th><th>Breathe (min)</th><th>Glass</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">No bottles to prep.</td></tr>'}</tbody>
  </table>
  <h3 class="prep-notes-heading">Other notes</h3>
  <div class="prep-notes-body" contenteditable="true" data-prep-field="notes" data-placeholder="Anything else — order of pours, palate cleansers, when to serve the snack, …">${escapeHtml(prep.notes || '')}</div>`;
}

function wirePlannedDetail(root, plan) {
  const id = plan.id;
  const errEl = $('.planned-error', root);
  const showErr = (msg) => {
    if (!errEl) return;
    errEl.hidden = !msg;
    errEl.textContent = msg || '';
  };

  // Bottle-card click → bottle detail
  $$('[data-bottle-id]', root).forEach((node) => {
    node.addEventListener('click', () => {
      location.hash = `#/bottle/${node.dataset.bottleId}`;
    });
  });

  // Header field commits on blur (or change for date input)
  for (const field of ['title', 'occasion_date', 'user_notes']) {
    const el = $(`[data-field="${field}"]`, root);
    if (!el) continue;
    el.addEventListener('change', async () => {
      const v = el.value.trim();
      try { await updatePlannedFlight(id, { [field]: v || null }); showErr(''); }
      catch (e) { showErr(e.message); }
    });
  }

  // Food add/edit/remove — recompute the full food array on every change
  // and PATCH it. Cheap, correct, and avoids per-row state.
  const collectFood = () => {
    return $$('.food-row', root).map((li) => ({
      kind:        li.querySelector('[data-food-field="kind"]')?.value || 'meal',
      name:        li.querySelector('[data-food-field="name"]')?.value || '',
      description: li.querySelector('[data-food-field="description"]')?.value || '',
    }));
  };
  const persistFood = async () => {
    try { await updatePlannedFlight(id, { food: collectFood() }); showErr(''); }
    catch (e) { showErr(e.message); }
  };

  $$('[data-food-add]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const food = collectFood();
      food.push({ kind: btn.dataset.foodAdd, name: '', description: '' });
      try { await updatePlannedFlight(id, { food }); showErr(''); }
      catch (e) { showErr(e.message); return; }
      const fresh = await getPlannedFlight(id);
      if (fresh) await renderPlannedDetail(root, fresh);
    });
  });
  $$('.food-row', root).forEach((li) => {
    li.querySelector('[data-food-remove]')?.addEventListener('click', async () => {
      li.remove();
      await persistFood();
    });
    li.querySelectorAll('[data-food-field]').forEach((el) => {
      el.addEventListener('change', persistFood);
    });
  });

  // Prep — same recompute-and-patch pattern. Decanters are not editable
  // in the UI (they're sommelier advice, not a user toggle), so we just
  // pass through whatever was in the loaded plan.
  const originalDecanters = Array.isArray(plan.prep?.decanters) ? plan.prep.decanters : [];
  const collectPrep = () => {
    const chill = [], open_by = [], glassware = [];
    $$('[data-prep-bottle]', root).forEach((tr) => {
      const bottleId = tr.dataset.prepBottle;
      const chillVal   = numOrNull(tr.querySelector('[data-prep-field="chill"]')?.value);
      const openByVal  = numOrNull(tr.querySelector('[data-prep-field="open_by"]')?.value);
      const glassVal   = tr.querySelector('[data-prep-field="glassware"]')?.value.trim();
      if (chillVal != null)  chill.push({ bottle_id: bottleId, minutes: chillVal });
      if (openByVal != null) open_by.push({ bottle_id: bottleId, minutes: openByVal });
      if (glassVal)          glassware.push({ bottle_id: bottleId, type: glassVal });
    });
    const notesEl = $('[data-prep-field="notes"]', root);
    const notesRaw = notesEl?.value ?? notesEl?.textContent ?? '';
    const notes = notesRaw.trim() || null;
    return { chill, open_by, decanters: originalDecanters, glassware, notes };
  };
  const persistPrep = async () => {
    try { await updatePlannedFlight(id, { prep: collectPrep() }); showErr(''); }
    catch (e) { showErr(e.message); }
  };
  $$('[data-prep-field]', root).forEach((el) => {
    // contenteditable elements don't fire 'change' — listen on 'blur' instead.
    const evt = el.isContentEditable ? 'blur' : 'change';
    el.addEventListener(evt, persistPrep);
  });

  // Re-ask
  $('[data-action="reask"]', root)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Asking…';
    try {
      const fresh = await getPlannedFlight(id);
      await requestFlightPlanEnrichment(fresh);
      const updated = await getPlannedFlight(id);
      if (updated) await renderPlannedDetail(root, updated);
    } catch (err) {
      showErr(err.message);
      btn.disabled = false;
      btn.textContent = 'Re-ask the sommelier';
    }
  });

  // Delete
  $('[data-action="delete"]', root)?.addEventListener('click', async () => {
    if (!confirm('Delete this planned flight?')) return;
    try {
      await deletePlannedFlight(id);
      location.hash = '#/planned';
    } catch (e) { showErr(e.message); }
  });
}

// ── Drink-now ─────────────────────────────────────────────────────
async function mountDrinkNow() {
  const dnForm = $('#drink-now-form');
  const dnResult = $('#drink-now-result');
  if (dnForm) {
    restoreResult('drink-now', dnResult);
    dnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(dnForm);
      await withBusySubmit(dnForm, dnResult, 'Asking your sommelier…', async () => {
        const { response } = await requestDrinkNow({ notes: fd.get('notes')?.trim() || null });
        await renderRecommendations(dnResult, response);
        cacheResult('drink-now', dnResult);
      });
    });
  }
  const root = $('#drink-now-list');
  if (!root) return;
  const yr = new Date().getFullYear();
  let bottles;
  try { bottles = await listBottles(); }
  catch (e) { root.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
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
// the queue lives at module scope, not inside mountManage's closure.
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

// ── Manage view (orchestrator state machine) ──────────────────────
function mountManage() {
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
    const r = parseHash().route;
    if (r !== 'manage' && r !== 'scan') {
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
    ${narrativeBlockHTML(narrative, { heading: 'Narrative', headingTag: 'h3', wrapStyle: 'margin-top:1.5rem' })}
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
        ${narrativeBlockHTML(response.narrative, { wrapStyle: 'margin-top:1rem' })}
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
    ${narrativeBlockHTML(response.narrative)}
    <p><a href="#/manage">Scan again</a> or <a href="#/cellar">back to cellar</a>.</p>`;
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
      ${frontUrl ? `<img src="${escapeAttr(frontUrl)}" alt="Front label" data-zoom="${escapeAttr(frontUrl)}" />` : ''}
      ${backUrl  ? `<img src="${escapeAttr(backUrl)}"  alt="Back label"  data-zoom="${escapeAttr(backUrl)}"  />` : ''}
    </div>` : '';

  const isEnriching = enrichingBottles.has(b.id);
  const enrichErr = enrichFailures.get(b.id);
  const detailsBtn = isEnriching
    ? `<span class="muted" style="align-self:center; padding: 0.5rem 0;">Fetching sommelier notes…</span>`
    : enrichErr
      ? `<button data-action="retry-enrich" class="ghost" title="${escapeAttr(enrichErr)}">Retry sommelier notes</button>`
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
      ${b.details ? `<section class="bottle-details-section narrative-block">
        <div class="narrative-head"><h2>More info</h2>${speakBtnHTML()}</div>
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
    if (action === 'retry-enrich') {
      autoEnrich(bottle.id);
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
// XSS rule for this file: any string interpolated into an innerHTML
// template that originates from the DB, an Error message, an upstream
// API, or user input MUST go through escapeHtml (text content) or
// escapeAttr (attribute value). Internal constants and verified-safe
// values (UUIDs, integers, fixed enum strings) can be interpolated
// directly. Markdown-shaped narrative fields go through markdownLite,
// which escapes first and then applies a small allowlist of inline tags.
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
mountVoicePicker();
window.addEventListener('hashchange', () => render());
onAuthChange((session) => setTimeout(() => render(session), 0));
wireAuth();

// Optional local-dev config override. config.local.js is gitignored and
// 404s in production — we load it via a script tag injected from JS so
// the index.html stays free of inline event handlers (CSP-friendly).
function loadOptionalLocalConfig() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'config.local.js';
    s.onload = () => resolve();
    s.onerror = () => resolve(); // 404 is the expected case in prod
    document.head.appendChild(s);
  });
}
await loadOptionalLocalConfig();
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' makes the browser bypass HTTP cache for sw.js
      // AND its importScripts (i.e. version.js) on every update check.
      // Without it (default 'imports'), version.js is read from HTTP cache
      // and the SW update check sees no change — users had to clear
      // browsing data to pick up new builds.
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });

      // Reload as soon as the new SW takes control (after the user taps
      // "Reload" in the banner, which posts skipWaiting). hadController
      // guards against firing on the very first SW install when there
      // was no prior controller.
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }
        window.location.reload();
      });

      // If a SW was already waiting when this page loaded (e.g. page was
      // closed before user tapped Reload last time), show the banner now.
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg.waiting);
      }
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // 'installed' + an existing controller = a new build is ready
          // and waiting. (Without an existing controller, this is the
          // very first install; nothing to update.)
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(sw);
          }
        });
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

function showUpdateBanner(waitingWorker) {
  if (document.getElementById('update-banner')) return; // already visible
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.innerHTML = `
    <span>New version ready</span>
    <button type="button" id="update-banner-reload">Reload</button>
    <button type="button" id="update-banner-dismiss" class="ghost" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(bar);
  bar.querySelector('#update-banner-reload').addEventListener('click', () => {
    bar.querySelector('#update-banner-reload').textContent = 'Updating…';
    waitingWorker.postMessage('skipWaiting');
    // controllerchange handler above triggers the reload once SW activates
  });
  bar.querySelector('#update-banner-dismiss').addEventListener('click', () => bar.remove());
}
