(() => {
'use strict';

/* ---------- constants ---------- */
const KIND = {
  camp:   { label: 'Campsite',  color: '#2f8f55' },
  leanto: { label: 'Lean-to',   color: '#e08a2e' },
  tent:   { label: 'Tent site', color: '#3b82d6' },
};
const GROUPS = {
  core:   { label: 'Designated sites in Adirondack Forest Preserve units', note: 'The main list.' },
  review: { label: 'Needs review', note: 'No land unit listed (or an unusual one). Many look genuine; confirm before relying on them.' },
  other:  { label: 'State forests & conservation easements', note: 'Mostly outside the park boundary. Rules differ.' },
};
const ACCESS = {
  car:  { label: 'Drive-up', note: 'Within about 100 m of a road or track on OpenStreetMap.' },
  near: { label: 'Short walk', note: 'About 100 to 400 m from the nearest road or track.' },
  hike: { label: 'Hike or paddle in', note: 'No road or track within 400 m on OpenStreetMap.' },
};
const DEFAULT_ACCESS = ['car', 'near'];   // hike-in sites hidden unless the user turns them on
function roadLine(r) {
  if (r.d == null) return 'No road or track found within 500 m on OpenStreetMap.';
  const m = r.d < 10 ? 'at the roadside' : `about ${r.d} m from`;
  const what = [r.rt, r.rn].filter(Boolean).join(': ');
  return r.d < 10 ? `${what || 'Road'} runs right by this site.` : `${what || 'Road'}, ${m} the site.`;
}
const DEC_URL = 'https://dec.ny.gov/things-to-do/camping';
const LIST_PAGE = 120;

/* ---------- tiny helpers ---------- */
const $ = (s, root = document) => root.querySelector(s);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('adk.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('adk.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { readonly: true });
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/* ---------- geo math ---------- */
const rad = (d) => (d * Math.PI) / 180;
function distKm(a, b) {
  const R = 6371.0088;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (b) => DIRS[Math.round(b / 45) % 8];
function fmtDist(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  const mi = km * 0.621371;
  const f = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  return `${f(km)} km (${f(mi)} mi)`;
}
const dd = (p) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
function dm(v, pos, neg) {
  const h = v >= 0 ? pos : neg;
  v = Math.abs(v);
  const d = Math.floor(v);
  const m = (v - d) * 60;
  return `${d}° ${m.toFixed(3).padStart(6, '0')}′ ${h}`;
}
const dmLine = (p) => `${dm(p.lat, 'N', 'S')}  ${dm(p.lon, 'E', 'W')}`;

/* ---------- state ---------- */
const stars = new Set(store.get('stars', []));
const state = {
  data: [],
  vis: [],
  kinds: new Set(store.get('kinds', Object.keys(KIND))),
  groups: new Set(store.get('groups', ['core'])),
  access: new Set(store.get('access3', DEFAULT_ACCESS)),
  unit: '',
  q: '',
  starOnly: false,
  me: null,
  sel: null,
  tab: 'map',
  base: store.get('base', 'topo'),
  listLimit: LIST_PAGE,
};

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 6, maxZoom: 17 })
  .setView([44.0, -74.4], 8);

const tileOpts = { crossOrigin: true };
const bases = {
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { ...tileOpts, subdomains: 'abc', maxZoom: 17, attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>' }),
  street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { ...tileOpts, maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
};
if (!bases[state.base]) state.base = 'topo';
bases[state.base].addTo(map);
L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

let tileErrs = 0, tileErrTimer;
for (const b of Object.values(bases)) {
  b.on('tileerror', () => {
    tileErrs++;
    clearTimeout(tileErrTimer);
    tileErrTimer = setTimeout(() => {
      if (tileErrs > 3) showStatus(navigator.onLine ? 'Some map tiles failed to load' : 'Offline: map pictures only where saved. Pins and coordinates still work.');
      tileErrs = 0;
    }, 800);
  });
}

const renderer = L.canvas({ padding: 0.5, tolerance: 12 });
const layer = L.layerGroup().addTo(map);
const radiusFor = (z) => (z <= 8 ? 4 : z <= 10 ? 5 : z <= 12 ? 7 : 9);
function styleFor(r) {
  const core = r.g === 'core';
  return {
    renderer,
    radius: radiusFor(map.getZoom()),
    color: core ? '#ffffff' : '#444',
    weight: core ? 1.2 : 1.5,
    dashArray: core ? null : '2 2',
    fillColor: KIND[r.k].color,
    fillOpacity: core ? 0.95 : 0.5,
  };
}
let ring = null;
map.on('zoomend', () => {
  const rad_ = radiusFor(map.getZoom());
  for (const r of state.data) r._m.setRadius(rad_);
  if (ring && state.sel) ring.setRadius(rad_ + 6);
});
map.on('click', () => closeSheet());

/* ---------- data ---------- */
async function load() {
  let data;
  try {
    const res = await fetch('data/campsites.json');
    data = await res.json();
  } catch (e) {
    toast('Could not load campsite data. Open the app once while online.', 6000);
    return;
  }
  state.data = data;
  for (const r of data) {
    r._s = `${r.n} ${r.u} ${r.t} ${r.c} ${KIND[r.k].label}`.toLowerCase();
    r._m = L.circleMarker([r.lat, r.lon], styleFor(r));
    r._m.on('click', (e) => { L.DomEvent.stopPropagation(e); select(r); });
  }
  buildFilterUI();
  fillAbout();
  applyFilters();
  fitAll();
}

function fitAll() {
  const pts = state.vis.length ? state.vis : state.data.filter((r) => r.g === 'core');
  if (pts.length) map.fitBounds(L.latLngBounds(pts.map((r) => [r.lat, r.lon])).pad(0.04));
}

/* ---------- filtering ---------- */
function applyFilters() {
  const q = state.q.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  state.vis = state.data.filter((r) =>
    state.kinds.has(r.k) &&
    state.groups.has(r.g) &&
    state.access.has(r.a) &&
    (!state.unit || r.u === state.unit) &&
    (!state.starOnly || stars.has(r.id)) &&
    words.every((w) => r._s.includes(w)));
  layer.clearLayers();
  for (const r of state.vis) layer.addLayer(r._m);
  if (ring) ring.bringToFront();
  $('#count').textContent = `${state.vis.length.toLocaleString()} site${state.vis.length === 1 ? '' : 's'} shown`;
  updateBadge();
  state.listLimit = LIST_PAGE;
  if (state.tab === 'list') renderList();
}
function updateBadge() {
  let n = 0;
  if (state.kinds.size < Object.keys(KIND).length) n++;
  if (!(state.groups.size === 1 && state.groups.has('core'))) n++;
  if (state.access.size !== DEFAULT_ACCESS.length || DEFAULT_ACCESS.some((a) => !state.access.has(a))) n++;
  if (state.unit) n++;
  if (state.starOnly) n++;
  const b = $('#filter-badge');
  b.hidden = n === 0;
  b.textContent = String(n);
}

/* ---------- detail sheet ---------- */
const sheet = $('#sheet');
function closeSheet() {
  state.sel = null;
  sheet.hidden = true;
  if (ring) { map.removeLayer(ring); ring = null; }
}
function select(r, { pan = true } = {}) {
  state.sel = r;
  if (ring) map.removeLayer(ring);
  ring = L.circleMarker([r.lat, r.lon], {
    renderer, radius: radiusFor(map.getZoom()) + 6, color: '#ffffff', weight: 3, fillOpacity: 0, interactive: false,
  }).addTo(map);
  renderSheet();
  sheet.hidden = false;
  if (pan) focusOn(r);
}
function focusOn(r) {
  const z = Math.max(map.getZoom(), 12);
  const h = sheet.offsetHeight || 280;
  const p = map.project([r.lat, r.lon], z).add([0, h / 2]);
  map.setView(map.unproject(p, z), z, { animate: true });
}
function distanceLine(r) {
  if (!state.me) return null;
  const km = distKm(state.me, r);
  return `${fmtDist(km)} ${compass(bearing(state.me, r))} of you (straight line)`;
}
function renderSheet() {
  const r = state.sel;
  if (!r) return;
  const k = KIND[r.k];
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}`;
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}&travelmode=driving`;
  const saved = stars.has(r.id);
  sheet.textContent = '';
  const parts = [
    el('div', { class: 'grab' }),
    el('button', { class: 'close', 'aria-label': 'Close', text: '×', onclick: closeSheet }),
    el('h2', { text: r.n }),
    el('div', { class: 'tags' },
      el('span', { class: 'tag' }, el('i', { class: 'dot', style: `background:${k.color}` }), k.label),
      el('span', { class: 'tag', text: ACCESS[r.a].label }),
      el('span', { class: 'tag', text: r.u }),
      el('span', { class: 'tag', text: [r.t, r.c && `${r.c} Co.`].filter(Boolean).join(', ') })),
    el('div', { class: 'coords' },
      el('div', { class: 'dd', text: dd(r) }),
      el('div', { class: 'dm', text: dmLine(r) })),
    state.me ? el('div', { class: 'dist', text: distanceLine(r) }) : null,
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn primary', text: 'Copy coordinates', onclick: async () => toast((await copyText(dd(r))) ? 'Coordinates copied' : 'Press and hold the numbers to copy') }),
      el('button', { class: 'btn', text: saved ? '★ Saved' : '☆ Save', onclick: () => toggleStar(r) })),
    el('div', { class: 'btnrow' },
      el('a', { class: 'btn', href: mapsUrl, target: '_blank', rel: 'noopener', text: 'Open in Google Maps' }),
      el('a', { class: 'btn', href: dirUrl, target: '_blank', rel: 'noopener', text: 'Directions' }),
      navigator.share ? el('button', { class: 'btn', text: 'Share', onclick: () => navigator.share({ title: r.n, text: `${r.n} (${r.u}): ${dd(r)}`, url: mapsUrl }).catch(() => {}) }) : null),
    el('div', { class: r.a === 'hike' ? 'note' : 'fine' }, roadLine(r)),
    r.rs ? el('div', { class: 'note', text: 'That road is tagged as seasonal or restricted on the map. It may be closed or gated.' }) : null,
    el('p', { class: 'fine', text: 'Measured from OpenStreetMap, not checked on the ground. Dirt tracks can be rough for motorcycles and low cars, and many roads close for the season.' }),
    r.g !== 'core' ? el('div', { class: 'note', text: GROUPS[r.g].note }) : null,
    el('p', { class: 'fine' }, 'Check ', el('a', { href: DEC_URL, target: '_blank', rel: 'noopener', text: 'current DEC rules' }),
      ' and look for the yellow “Camp Here” disc. Source data can be incomplete or outdated.'),
  ];
  sheet.append(...parts.filter(Boolean));
}
function toggleStar(r) {
  if (stars.has(r.id)) stars.delete(r.id); else stars.add(r.id);
  store.set('stars', [...stars]);
  toast(stars.has(r.id) ? 'Saved ★' : 'Removed from saved');
  renderSheet();
  if (state.starOnly) applyFilters();
}

/* ---------- list ---------- */
function renderList() {
  const arr = state.vis.slice();
  if (state.me) { for (const r of arr) r._d = distKm(state.me, r); arr.sort((a, b) => a._d - b._d); }
  else arr.sort((a, b) => a.u.localeCompare(b.u) || a.n.localeCompare(b.n, undefined, { numeric: true }));
  $('#list-title').textContent = `${arr.length.toLocaleString()} site${arr.length === 1 ? '' : 's'}`;
  $('#list-sub').textContent = state.me ? 'nearest first' : 'by area (turn on location for nearest)';
  const box = $('#rows');
  box.textContent = '';
  for (const r of arr.slice(0, state.listLimit)) {
    const li = el('li', { onclick: () => { setTab('map'); select(r); } },
      el('i', { class: 'dot', style: `background:${KIND[r.k].color}${r.g === 'core' ? '' : ';opacity:.5'}` }),
      el('div', { class: 'mid' },
        el('div', { class: 'nm' }, stars.has(r.id) ? el('span', { class: 'star', text: '★ ' }) : null, r.n),
        el('div', { class: 'sub', text: `${r.u} · ${r.t}` })),
      el('div', { class: 'd', text: state.me ? fmtDist(r._d).replace(/ \(.*\)/, '') : '' }));
    box.append(li);
  }
  const more = $('#more');
  more.hidden = arr.length <= state.listLimit;
  more.textContent = `Show more (${(arr.length - state.listLimit).toLocaleString()} left)`;
}
$('#more').addEventListener('click', () => { state.listLimit += LIST_PAGE; renderList(); });

/* ---------- tabs ---------- */
function setTab(t) {
  state.tab = t;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const v of ['map', 'list', 'info']) $(`#view-${v}`).hidden = v !== t;
  if (t !== 'map') closeSheet();
  if (t === 'map') setTimeout(() => map.invalidateSize(), 50);
  if (t === 'list') renderList();
}
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

/* ---------- search ---------- */
let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; applyFilters(); }, 160);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.target.blur();
  state.q = e.target.value;
  applyFilters();
  if (state.tab === 'map' && state.vis.length) {
    map.fitBounds(L.latLngBounds(state.vis.map((r) => [r.lat, r.lon])).pad(0.15), { maxZoom: 14 });
  }
});

/* ---------- filters UI ---------- */
function buildFilterUI() {
  const ac = $('#f-access'); ac.textContent = '';
  for (const [key, a] of Object.entries(ACCESS)) {
    const n = state.data.filter((r) => r.a === key && r.g === 'core').length;
    const cb = el('input', { type: 'checkbox', 'data-access': key });
    cb.checked = state.access.has(key);
    cb.addEventListener('change', () => { cb.checked ? state.access.add(key) : state.access.delete(key); persistFilters(); applyFilters(); });
    ac.append(el('label', { class: 'check' }, cb, el('span', {}, `${a.label} (${n.toLocaleString()})`, el('small', { text: a.note }))));
  }
  const kc = $('#f-kinds'); kc.textContent = '';
  for (const [key, k] of Object.entries(KIND)) {
    const n = state.data.filter((r) => r.k === key && r.g === 'core').length;
    const cb = el('input', { type: 'checkbox', 'data-kind': key });
    cb.checked = state.kinds.has(key);
    cb.addEventListener('change', () => { cb.checked ? state.kinds.add(key) : state.kinds.delete(key); persistFilters(); applyFilters(); });
    kc.append(el('label', { class: 'check' }, cb, el('span', {}, el('i', { class: 'dot', style: `background:${k.color}` }), `${k.label}s`, el('small', { text: `${n.toLocaleString()} in the main list` }))));
  }
  const gc = $('#f-groups'); gc.textContent = '';
  for (const [key, g] of Object.entries(GROUPS)) {
    const n = state.data.filter((r) => r.g === key).length;
    const cb = el('input', { type: 'checkbox', 'data-group': key });
    cb.checked = state.groups.has(key);
    cb.addEventListener('change', () => { cb.checked ? state.groups.add(key) : state.groups.delete(key); persistFilters(); applyFilters(); });
    gc.append(el('label', { class: 'check' }, cb, el('span', {}, `${g.label} (${n.toLocaleString()})`, el('small', { text: g.note }))));
  }
  const sel = $('#f-unit'); sel.textContent = '';
  sel.append(el('option', { value: '', text: 'All areas' }));
  const units = [...new Set(state.data.map((r) => r.u))].sort((a, b) => a.localeCompare(b));
  for (const u of units) sel.append(el('option', { value: u, text: u }));
  sel.addEventListener('change', () => { state.unit = sel.value; applyFilters(); });
  $('#f-stars').addEventListener('change', (e) => { state.starOnly = e.target.checked; applyFilters(); });
}
function persistFilters() { store.set('kinds', [...state.kinds]); store.set('groups', [...state.groups]); store.set('access3', [...state.access]); }
$('#btn-filters').addEventListener('click', () => { $('#filters').hidden = false; });
$('#filters-done').addEventListener('click', () => { $('#filters').hidden = true; });
$('#filters').addEventListener('click', (e) => { if (e.target.id === 'filters') $('#filters').hidden = true; });
$('#filters-reset').addEventListener('click', () => {
  state.kinds = new Set(Object.keys(KIND));
  state.groups = new Set(['core']);
  state.access = new Set(DEFAULT_ACCESS);
  state.unit = ''; state.starOnly = false;
  persistFilters();
  for (const cb of document.querySelectorAll('#f-kinds input')) cb.checked = true;
  for (const cb of document.querySelectorAll('#f-groups input')) cb.checked = cb.dataset.group === 'core';
  for (const cb of document.querySelectorAll('#f-access input')) cb.checked = DEFAULT_ACCESS.includes(cb.dataset.access);
  $('#f-unit').value = ''; $('#f-stars').checked = false;
  applyFilters();
});

/* ---------- about text ---------- */
function fillAbout() {
  const c = (g) => state.data.filter((r) => r.g === g);
  const core = c('core');
  const by = (k) => core.filter((r) => r.k === k).length;
  const units = new Set(core.map((r) => r.u)).size;
  const acc = (a) => core.filter((r) => r.a === a).length;
  $('#about-data').textContent =
    `${core.length.toLocaleString()} designated sites in ${units} Forest Preserve areas ` +
    `(${by('camp').toLocaleString()} campsites, ${by('leanto').toLocaleString()} lean-tos, ${by('tent').toLocaleString()} tent sites), ` +
    `plus ${c('review').length} to review and ${c('other').length} in state forests and easements. ` +
    `By access: ${acc('car').toLocaleString()} drive-up, ${acc('near').toLocaleString()} short walk, ${acc('hike').toLocaleString()} hike or paddle in.`;
}

/* ---------- location ---------- */
let watchId = null, meDot = null, meAcc = null, firstFix = true, lastListRender = 0;
function showStatus(msg) {
  const s = $('#status');
  s.textContent = msg; s.hidden = false;
  clearTimeout(showStatus.t);
  showStatus.t = setTimeout(() => { s.hidden = true; }, 6000);
}
function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  state.me = { lat, lon, acc: accuracy };
  const ll = [lat, lon];
  if (!meDot) {
    meAcc = L.circle(ll, { radius: accuracy, renderer, color: '#2b7fff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    meDot = L.circleMarker(ll, { renderer, radius: 8, color: '#fff', weight: 3, fillColor: '#2b7fff', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    meDot.setLatLng(ll); meAcc.setLatLng(ll).setRadius(accuracy);
  }
  const m = $('#me');
  m.hidden = false;
  m.textContent = `You: ${dd(state.me)} ±${Math.round(accuracy)} m`;
  $('#btn-locate').classList.add('on');
  if (firstFix) {
    firstFix = false;
    map.setView(ll, Math.max(map.getZoom(), 11));
    if (state.tab === 'map') toast('Location found');
  }
  if (state.sel) renderSheet();
  const now = Date.now();
  if (state.tab === 'list' && now - lastListRender > 5000) { lastListRender = now; renderList(); }
}
function onGeoErr(err) {
  const msg = err.code === 1 ? 'Location is off. Allow it in iPhone Settings › Privacy › Location Services › Safari Websites (or this app).'
    : err.code === 3 ? 'Still looking for a GPS fix… try going outside.' : 'Could not get your location.';
  showStatus(msg);
  if (err.code === 1) stopWatch();
}
function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; firstFix = true;
  $('#btn-locate').classList.remove('on');
}
$('#btn-locate').addEventListener('click', () => {
  if (!('geolocation' in navigator)) return toast('Location is not available on this device');
  if (watchId != null && state.me) {
    map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 13), { animate: true });
    return;
  }
  toast('Finding you…');
  watchId = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
});
$('#me').addEventListener('click', async () => {
  if (state.me) toast((await copyText(dd(state.me))) ? 'Your coordinates copied' : 'Could not copy');
});

/* ---------- map buttons ---------- */
$('#btn-base').addEventListener('click', () => {
  const next = state.base === 'topo' ? 'street' : 'topo';
  map.removeLayer(bases[state.base]);
  bases[next].addTo(map);
  state.base = next;
  store.set('base', next);
  toast(next === 'topo' ? 'Topographic map' : 'Street map');
});
$('#btn-fit').addEventListener('click', fitAll);

/* ---------- connectivity + service worker ---------- */
window.addEventListener('offline', () => showStatus('Offline: saved data still works'));
window.addEventListener('online', () => { $('#status').hidden = true; });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

load();
})();
