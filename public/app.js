'use strict';

// ================= State =================
const state = {
  locations: [],
  devices: [],
  templates: [],
  templatesMeta: null, // where the templates were derived from
  presets: [],
  selectedId: null,
  device: null,       // result of `devices <id>`
  status: null,       // result of `devices:status`
  caps: {},           // capabilityId -> definition
  tab: 'control',
  autoRefresh: false,
  autoTimer: null,
  draft: [],          // steps of the scenario being edited
};

const PROTOTYPES = [
  ['VIRTUAL_SWITCH', 'Switch'], ['VIRTUAL_DIMMER_SWITCH', 'Dimmer switch'], ['VIRTUAL_BUTTON', 'Button'],
  ['VIRTUAL_CAMERA', 'Camera'], ['VIRTUAL_COLOR_BULB', 'Color bulb'], ['VIRTUAL_CONTACT_SENSOR', 'Contact sensor'],
  ['VIRTUAL_DIMMER', 'Dimmer (no switch)'], ['VIRTUAL_GARAGE_DOOR_OPENER', 'Garage door opener'], ['VIRTUAL_LOCK', 'Lock'],
  ['VIRTUAL_METERED_SWITCH', 'Metered switch'], ['VIRTUAL_MOTION_SENSOR', 'Motion sensor'], ['VIRTUAL_MULTI_SENSOR', 'Multi-sensor'],
  ['VIRTUAL_PRESENCE_SENSOR', 'Presence sensor'], ['VIRTUAL_REFRIGERATOR', 'Refrigerator'], ['VIRTUAL_RGBW_BULB', 'RGBW bulb'],
  ['VIRTUAL_SIREN', 'Siren'], ['VIRTUAL_THERMOSTAT', 'Thermostat'],
];

// ================= Utilities =================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtVal = (v) => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only throws when the connection itself fails: the local server is not running (any more).
    throw new Error('Cannot reach the local server. Is the terminal that started it still open? Restart it, then reload this page.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  refreshLog();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.command = data.command;
    throw err;
  }
  return data.data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 3500);
}

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
}

function convertValue(raw, type) {
  switch (type) {
    case 'integer': { const n = parseInt(raw, 10); if (Number.isNaN(n)) throw new Error('Enter an integer'); return n; }
    case 'number': { const n = parseFloat(raw); if (Number.isNaN(n)) throw new Error('Enter a number'); return n; }
    case 'boolean': return raw === true || raw === 'true';
    case 'array': case 'object': return typeof raw === 'string' ? JSON.parse(raw) : raw;
    default: return raw;
  }
}

function valueSchema(capId, attrName) {
  const cap = state.caps[capId];
  const attr = cap?.attributes?.[attrName];
  const props = attr?.schema?.properties || {};
  const v = props.value || {};
  let type = v.type;
  if (!type && v.enum) type = 'string';
  if (!type && (v.oneOf || v.anyOf)) type = 'string';
  const unit = props.unit || {};
  return {
    type: type || 'string',
    enum: v.enum,
    min: v.minimum,
    max: v.maximum,
    units: unit.enum || (unit.default ? [unit.default] : null),
    unitDefault: unit.default,
    required: attr?.schema?.required,
    itemsEnum: v.items?.enum,
  };
}

// ---------- supported* / available* option lists ----------
// Many capabilities describe what a device can do with a list attribute next to the value attribute,
// e.g. airConditionerFanMode.fanMode <-> supportedAcFanModes / availableAcFanModes, or
// washerOperatingState.machineState <-> supportedMachineStates. The lists are device state, so options
// are always read from the latest device status (they change when you inject a new supported list).
const LIST_PREFIX = /^(supported|available)(?=[A-Z])/;
const camelWords = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
const listBase = (name) => name.replace(LIST_PREFIX, '').toLowerCase().replace(/s$/, '');

function pairScore(listName, attrName) {
  const base = listBase(listName);
  const a = attrName.toLowerCase();
  if (base === a || base === a.replace(/s$/, '')) return 3;
  if (base.endsWith(a) || a.endsWith(base)) return 2;
  const lw = camelWords(listName.replace(LIST_PREFIX, '')).pop().replace(/s$/, '');
  return camelWords(attrName).pop() === lw ? 1 : 0;
}

// capId -> { attrName: { supported, available } } and { listName: valueAttrName }
const pairCache = {};
function capPairs(capId) {
  if (pairCache[capId]) return pairCache[capId];
  const attrs = Object.keys(state.caps[capId]?.attributes || {});
  const lists = attrs.filter((a) => LIST_PREFIX.test(a) && valueSchema(capId, a).type === 'array');
  const values = attrs.filter((a) => !LIST_PREFIX.test(a) && valueSchema(capId, a).type === 'string');
  const byValue = {};
  const byList = {};
  for (const l of lists) {
    // Give each list to the value attribute that matches it best (ties are ambiguous -> no pairing).
    const scored = values.map((v) => [v, pairScore(l, v)]).filter(([, sc]) => sc > 0).sort((x, y) => y[1] - x[1]);
    if (!scored.length || (scored[1] && scored[1][1] === scored[0][1])) continue;
    const v = scored[0][0];
    const kind = l.startsWith('available') ? 'available' : 'supported';
    byValue[v] = byValue[v] || {};
    if (!byValue[v][kind]) byValue[v][kind] = l;
    byList[l] = v;
  }
  return (pairCache[capId] = { byValue, byList });
}

const listValue = (comp, capId, attr) => {
  const v = attr ? currentAttr(comp, capId, attr)?.value : undefined;
  return Array.isArray(v) ? v.filter((x) => x !== null && typeof x !== 'object') : [];
};
const uniq = (arr) => { const seen = new Set(); return arr.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

// Options for a single string value: groups of [label, values]. null = no device-provided list.
function valueOptions(comp, capId, attrName) {
  const pair = capPairs(capId).byValue[attrName];
  if (!pair) return null;
  const supported = listValue(comp, capId, pair.supported);
  const available = listValue(comp, capId, pair.available);
  const main = pair.available && available.length ? available : supported;
  if (!main.length) return null;
  const s = valueSchema(capId, attrName);
  const groups = [[pair.available && available.length ? pair.available : pair.supported, main]];
  const notAvail = supported.filter((v) => !main.includes(v));
  if (notAvail.length) groups.push([`in ${pair.supported}, not ${pair.available}`, notAvail]);
  const others = (s.enum || []).filter((v) => !main.includes(v) && !notAvail.includes(v));
  if (others.length) groups.push(['other values from the capability', others]);
  return groups;
}

// Options for a list attribute (supportedX / availableX / any array with items.enum). null = keep JSON box.
function listOptions(comp, capId, attrName) {
  const s = valueSchema(capId, attrName);
  const { byValue, byList } = capPairs(capId);
  const valueAttr = byList[attrName];
  const own = listValue(comp, capId, attrName);
  let opts = [...(s.itemsEnum || [])];
  if (valueAttr) {
    const pair = byValue[valueAttr] || {};
    if (attrName === pair.available) opts.push(...listValue(comp, capId, pair.supported));
    opts.push(...(valueSchema(capId, valueAttr).enum || []));
  }
  const cur = currentAttr(comp, capId, attrName)?.value;
  if (!valueAttr && !s.itemsEnum) return null;
  if (cur !== undefined && cur !== null && !Array.isArray(cur)) return null;
  if (Array.isArray(cur) && cur.some((x) => x !== null && typeof x === 'object')) return null; // lists of objects stay JSON
  return uniq([...opts, ...own]);
}

// ================= Top bar / log =================
async function loadInfo() {
  const badge = $('#cliBadge');
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    $('#profileInput').value = info.profile;
    if (info.version) {
      badge.className = 'badge ok';
      badge.textContent = 'CLI ' + info.version.split(' ')[0].replace('@smartthings/cli/', '') + (info.tokenFromEnv ? ' · token' : '');
      badge.title = info.version;
    } else {
      badge.className = 'badge err';
      badge.textContent = 'CLI not found';
      badge.title = info.error || '';
      toast(info.error || 'Cannot run the SmartThings CLI', 'err');
    }
  } catch (e) {
    badge.className = 'badge err';
    badge.textContent = 'Cannot reach server';
  }
}

async function refreshLog() {
  try {
    const res = await fetch('/api/log');
    const { data } = await res.json();
    $('#logCount').textContent = data.length;
    $('#logBody').innerHTML = data.map((e) => `
      <div class="log-entry">
        <span class="muted">${esc(new Date(e.at).toLocaleTimeString())}</span>
        <span class="${e.ok ? 'ok' : 'bad'}">${e.ok ? '✓' : '✕'}</span>
        <span class="cmd" title="Click to copy">${esc(e.command)}</span>
        <span class="muted">${e.ms}ms</span>
        ${e.input !== undefined ? `<details class="inp"><summary class="muted small">input.json</summary><pre class="json">${esc(JSON.stringify(e.input, null, 2))}</pre></details>` : ''}
        ${e.error ? `<span class="err">${esc(e.error)}</span>` : ''}
      </div>`).join('') || '<div class="muted pad">No commands have been run yet.</div>';
  } catch { /* ignore */ }
}

$('#logBody').addEventListener('click', (e) => {
  const cmd = e.target.closest('.cmd');
  if (cmd) navigator.clipboard?.writeText(cmd.textContent).then(() => toast('Command copied'));
});
$('#logToggle').addEventListener('click', () => {
  const d = $('#logDrawer');
  d.classList.toggle('collapsed');
  $('#logToggle').firstChild.textContent = d.classList.contains('collapsed') ? '▲ CLI command log ' : '▼ CLI command log ';
});
$('#logClear').addEventListener('click', async () => { await fetch('/api/log', { method: 'DELETE' }); refreshLog(); });

$('#profileApply').addEventListener('click', async () => {
  try {
    await api('POST', '/api/profile', { profile: $('#profileInput').value.trim() });
    state.caps = {};
    toast(`Switched to profile "${$('#profileInput').value.trim()}"`, 'ok');
    await Promise.all([loadLocations(), loadDevices()]);
  } catch (e) { toast(e.message, 'err'); }
});

// ================= Locations / device list =================
async function loadLocations() {
  try {
    state.locations = (await api('GET', '/api/locations')) || [];
  } catch (e) {
    state.locations = [];
    toast(`Could not load locations\n${e.message}`, 'err');
  }
  const sel = $('#locationFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All locations</option>' +
    state.locations.map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)}</option>`).join('');
  sel.value = cur;
}

async function loadDevices() {
  const list = $('#deviceList');
  list.innerHTML = '<div class="muted pad"><span class="spinner"></span> Loading…</div>';
  const loc = $('#locationFilter').value;
  try {
    state.devices = (await api('GET', '/api/devices' + (loc ? `?location=${encodeURIComponent(loc)}` : ''))) || [];
  } catch (e) {
    state.devices = [];
    list.innerHTML = `<div class="muted pad">Could not load the device list.<br><span class="small">${esc(e.message)}</span></div>`;
    return;
  }
  renderDeviceList();
}

function renderDeviceList() {
  const list = $('#deviceList');
  if (!state.devices.length) {
    list.innerHTML = '<div class="muted pad">No virtual devices yet. Create one with the button above.</div>';
    return;
  }
  const locName = (id) => state.locations.find((l) => l.locationId === id)?.name || '';
  list.innerHTML = state.devices
    .slice()
    .sort((a, b) => (a.label || a.name || '').localeCompare(b.label || b.name || ''))
    .map((d) => `
      <button class="device-item ${d.deviceId === state.selectedId ? 'active' : ''}" data-id="${esc(d.deviceId)}">
        <div class="name">${esc(d.label || d.name)}</div>
        <div class="meta">${esc(d.deviceId.slice(0, 8))}… ${esc(locName(d.locationId))}</div>
      </button>`).join('');
}

$('#deviceList').addEventListener('click', (e) => {
  const item = e.target.closest('.device-item');
  if (item) selectDevice(item.dataset.id);
});
$('#refreshDevices').addEventListener('click', loadDevices);
$('#locationFilter').addEventListener('change', loadDevices);
$('#newDeviceBtn').addEventListener('click', () => { stopAuto(); state.selectedId = null; renderDeviceList(); renderCreate(); });

async function loadTemplates() {
  try {
    const r = await api('GET', '/api/templates');
    state.templates = r.templates || [];
    state.templatesMeta = r.generatedFrom || null;
  } catch { state.templates = []; }
  try { state.presets = (await api('GET', '/api/presets')) || []; } catch { state.presets = []; }
}

// ================= Create device =================
let createState = { mode: 'template', templateId: null };

async function renderCreate() {
  if (!state.templates.length) {
    await loadTemplates();
  }
  const main = $('#main');
  const locOpts = state.locations.map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)}</option>`).join('');
  main.innerHTML = `
    <div class="dev-head"><div><h2>New virtual device</h2><div class="muted small">The device is created for real in the selected location of your SmartThings account.</div></div></div>
    <div class="tabs">
      <button class="tab ${createState.mode === 'template' ? 'active' : ''}" data-mode="template">Appliance templates</button>
      <button class="tab ${createState.mode === 'standard' ? 'active' : ''}" data-mode="standard">Standard prototype</button>
      <button class="tab ${createState.mode === 'profileId' ? 'active' : ''}" data-mode="profileId">Device profile ID</button>
      <button class="tab ${createState.mode === 'json' ? 'active' : ''}" data-mode="json">Profile JSON</button>
    </div>
    <div class="panel">
      <div id="modeArea"></div>
      <div class="form" style="margin-top:14px">
        <label for="cName">Device name</label><input id="cName" placeholder="e.g. Test Washer 1" />
        <label for="cLoc">Location</label><select id="cLoc">${locOpts || '<option value="">(no locations — check the CLI login)</option>'}</select>
        <label for="cRoom">Room (optional)</label><select id="cRoom"><option value="">None</option></select>
        <label></label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="cSubmit" class="btn primary">Create</button>
          <button id="cDry" class="btn">dry-run (preview request JSON)</button>
        </div>
      </div>
      <pre id="cResult" class="json" style="display:none;margin-top:14px"></pre>
    </div>`;

  main.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { createState.mode = t.dataset.mode; renderCreate(); }));
  renderModeArea();

  const locSel = $('#cLoc');
  const fav = store('st.lastLocation');
  if (fav && state.locations.some((l) => l.locationId === fav)) locSel.value = fav;
  const loadRooms = async () => {
    const roomSel = $('#cRoom');
    roomSel.innerHTML = '<option value="">None</option>';
    if (!locSel.value) return;
    try {
      const rooms = (await api('GET', `/api/locations/${locSel.value}/rooms`)) || [];
      roomSel.innerHTML += rooms.map((r) => `<option value="${esc(r.roomId)}">${esc(r.name)}</option>`).join('');
    } catch { /* creating without a room is fine */ }
  };
  locSel.addEventListener('change', loadRooms);
  loadRooms();

  $('#cSubmit').addEventListener('click', () => submitCreate(false));
  $('#cDry').addEventListener('click', () => submitCreate(true));
}

const MODE_INTROS = {
  template: '<b>Appliance templates</b> — pick a real appliance model (washer, oven, TV …) and get a virtual device with the same <em>standard</em> SmartThings capabilities. Best for trying an app or automation against Samsung-like devices. These are not official Samsung profiles: the capability lists and sample values were taken from real devices (Home Assistant test data), and Samsung-specific capabilities are left out.',
  standard: '<b>Standard prototype</b> — one of SmartThings\' built-in virtual device types (switch, dimmer, motion sensor, lock, thermostat …). The quickest way to get a simple generic device; the capabilities are fixed by SmartThings.',
  profileId: '<b>Device profile ID</b> — reuse a device profile that already exists in your SmartThings account (for example one you made earlier with <code>smartthings deviceprofiles:create</code>). The list only shows profiles from your own account, so it is empty if you have not created any. In that case use another tab, or paste a profile UUID.',
  json: '<b>Profile JSON</b> — write your own profile and choose exactly which components and capabilities the device has. Use it for custom combinations or devices with several components. Find capability IDs with <code>smartthings capabilities</code>.',
};

function renderModeArea() {
  const area = $('#modeArea');
  const m = createState.mode;
  if (m === 'template') {
    if (!createState.templateId && state.templates[0]) createState.templateId = state.templates[0].id;
    const t = state.templates.find((x) => x.id === createState.templateId);
    const profile = t ? t.deviceProfile : null;
    const src = state.templatesMeta;
    area.innerHTML = `
      <div class="muted small" style="margin-bottom:8px">Capability lists and sample values come from real Samsung appliances
        (<a href="${esc(src?.repository || '#')}" target="_blank" rel="noopener">Home Assistant SmartThings test fixtures</a>, ${esc(src?.license || '')}). Only standard SmartThings capabilities are used; Samsung-specific ones (<code>samsungce.*</code>, <code>custom.*</code> …) are left out.</div>
      <input id="tplFilter" placeholder="Filter templates (e.g. washer, oven, tv)" style="width:100%;margin-bottom:8px" />
      <div class="tpl-grid">${state.templates.map((x) => `
        <button class="tpl ${x.id === createState.templateId ? 'active' : ''}" data-id="${esc(x.id)}" data-search="${esc((x.name + ' ' + x.description).toLowerCase())}">
          <span class="ic">${esc(x.icon || '▢')}</span><span class="nm">${esc(x.name)}</span><span class="ds">${esc(x.description)}</span>
        </button>`).join('')}</div>
      <label class="small" style="display:block;margin:4px 0"><input type="checkbox" id="tplSample" ${createState.sample === false ? '' : 'checked'}/>
        Load the real device's sample state after creating</label>
      ${profile ? `<details><summary class="muted small">View / edit the profile definition (add or remove capabilities)</summary>
        <textarea id="tplJson" rows="12" style="margin-top:8px">${esc(JSON.stringify(profile, null, 2))}</textarea></details>`
        : t ? `<div class="muted small">Created from the standard prototype <code>${esc(t.prototype)}</code>.</div>` : ''}`;
    $('#tplFilter').value = createState.filter || '';
    const applyFilter = () => {
      const q = ($('#tplFilter').value || '').trim().toLowerCase();
      createState.filter = q;
      area.querySelectorAll('.tpl').forEach((b) => { b.hidden = !!q && !b.dataset.search.includes(q); });
    };
    $('#tplFilter').addEventListener('input', applyFilter);
    applyFilter();
    $('#tplSample').addEventListener('change', (e) => { createState.sample = e.target.checked; });
    area.querySelectorAll('.tpl').forEach((b) => b.addEventListener('click', () => {
      createState.templateId = b.dataset.id;
      renderModeArea();
      const tt = state.templates.find((x) => x.id === b.dataset.id);
      const nameEl = $('#cName');
      if (nameEl && (!nameEl.value || nameEl.dataset.auto)) { nameEl.value = `Virtual ${tt.name.replace(/\s*\(.*\)/, '')}`; nameEl.dataset.auto = '1'; }
    }));
  } else if (m === 'standard') {
    area.innerHTML = `<div class="form"><label for="cProto">Prototype</label>
      <select id="cProto">${PROTOTYPES.map(([id, nm]) => `<option value="${id}">${nm} — ${id}</option>`).join('')}</select></div>`;
  } else if (m === 'profileId') {
    area.innerHTML = `<div class="form"><label for="cProfile">Device profile</label>
      <div style="display:flex;gap:6px"><select id="cProfile"><option value="">Loading…</option></select>
      <input id="cProfileId" placeholder="or paste a UUID" /></div></div>`;
    api('GET', '/api/deviceprofiles').then((list) => {
      $('#cProfile').innerHTML = '<option value="">Select…</option>' +
        (list || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.status || '')})</option>`).join('');
    }).catch((e) => {
      $('#cProfile').innerHTML = '<option value="">Could not load the list (paste a UUID instead)</option>';
      toast(`Could not load device profiles\n${e.message}`, 'err');
    });
  } else {
    area.innerHTML = `<div class="muted small" style="margin-bottom:6px">Definition for the <code>deviceProfile</code> field of virtualdevices:create</div>
      <textarea id="cJson" rows="14">${esc(JSON.stringify({
        name: 'My Virtual Profile',
        components: [{ id: 'main', capabilities: [{ id: 'switch', version: 1 }, { id: 'temperatureMeasurement', version: 1 }], categories: [{ name: 'Switch' }] }],
      }, null, 2))}</textarea>`;
  }
  area.insertAdjacentHTML('afterbegin', `<div class="mode-intro">${MODE_INTROS[m] || ''}</div>`);
}

async function submitCreate(dryRun) {
  const name = $('#cName').value.trim();
  const locationId = $('#cLoc').value;
  const roomId = $('#cRoom').value || undefined;
  if (!name) return toast('Enter a device name', 'err');
  if (!locationId) return toast('Select a location', 'err');
  store('st.lastLocation', locationId);

  let url; let body; let tplUsed = null;
  try {
    const m = createState.mode;
    if (m === 'template') {
      const t = state.templates.find((x) => x.id === createState.templateId);
      if (!t) throw new Error('Select a template');
      if (t.prototype) { url = '/api/devices/standard'; body = { name, locationId, roomId, prototype: t.prototype }; }
      else {
        const txt = $('#tplJson')?.value;
        url = '/api/devices/profile';
        body = { name, locationId, roomId, deviceProfile: txt ? JSON.parse(txt) : t.deviceProfile };
        tplUsed = t;
      }
    } else if (m === 'standard') {
      url = '/api/devices/standard'; body = { name, locationId, roomId, prototype: $('#cProto').value };
    } else if (m === 'profileId') {
      const id = $('#cProfileId').value.trim() || $('#cProfile').value;
      if (!id) throw new Error('Select a device profile or enter a UUID');
      url = '/api/devices/profile'; body = { name, locationId, roomId, deviceProfileId: id };
    } else {
      url = '/api/devices/profile'; body = { name, locationId, roomId, deviceProfile: JSON.parse($('#cJson').value) };
    }
  } catch (e) { return toast(e.message, 'err'); }

  body.dryRun = dryRun;
  const btn = dryRun ? $('#cDry') : $('#cSubmit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Running…';
  try {
    const out = await api('POST', url, body);
    const pre = $('#cResult');
    pre.style.display = 'block';
    pre.textContent = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    if (!dryRun) {
      toast(`Created "${name}"`, 'ok');
      await loadDevices();
      const id = out?.deviceId;
      if (id) {
        if (tplUsed) store(`st.tpl.${id}`, tplUsed.id);
        await selectDevice(id);
        if (tplUsed && $('#tplSample')?.checked !== false && createState.sample !== false) await applySampleState(tplUsed);
      }
    }
  } catch (e) {
    toast(`Creation failed\n${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ================= Device detail =================
async function selectDevice(id) {
  stopAuto();
  if (state.selectedId !== id) state.tab = 'control';
  state.selectedId = id;
  state.device = null;
  state.status = null;
  state.draft = store(`st.draft.${id}`) || [];
  renderDeviceList();
  $('#main').innerHTML = '<div class="muted"><span class="spinner"></span> Loading device…</div>';
  try {
    const [device, status] = await Promise.all([api('GET', `/api/devices/${id}`), api('GET', `/api/devices/${id}/status`)]);
    if (state.selectedId !== id) return;
    state.device = device;
    state.status = status;
    const capIds = [...new Set((device.components || []).flatMap((c) => (c.capabilities || []).map((x) => `${x.id}|${x.version || 1}`)))];
    await Promise.all(capIds.map(async (k) => {
      const [cid, ver] = k.split('|');
      if (state.caps[cid]) return;
      try { state.caps[cid] = await api('GET', `/api/capabilities/${cid}/${ver}`); } catch { state.caps[cid] = { id: cid, attributes: {} }; }
    }));
    if (state.selectedId !== id) return;
    renderDevice();
  } catch (e) {
    $('#main').innerHTML = `<div class="panel"><h3>Could not load the device</h3><pre class="json">${esc(e.message)}</pre></div>`;
  }
}

async function refreshStatus(flash = true) {
  if (!state.selectedId) return;
  const before = JSON.stringify(state.status);
  try {
    state.status = await api('GET', `/api/devices/${state.selectedId}/status`);
  } catch (e) { toast(`Could not read status\n${e.message}`, 'err'); return; }
  if (state.tab === 'control') updateCurrentValues(flash && before !== JSON.stringify(state.status));
  if (state.tab === 'raw') renderTabBody();
}

function stopAuto() {
  state.autoRefresh = false;
  clearInterval(state.autoTimer);
  state.autoTimer = null;
}

function renderDevice() {
  const d = state.device;
  const locName = state.locations.find((l) => l.locationId === d.locationId)?.name || d.locationId;
  $('#main').innerHTML = `
    <div class="dev-head">
      <div>
        <h2 id="devLabel">${esc(d.label || d.name)}</h2>
        <div class="ids">${esc(d.deviceId)} · ${esc(locName)}${d.deviceTypeName ? ' · ' + esc(d.deviceTypeName) : ''}</div>
      </div>
      <div class="actions">
        ${store(`st.tpl.${d.deviceId}`) ? '<button class="btn small" id="sampleBtn" title="Inject the values recorded from the real appliance">Load sample state</button>' : ''}
        <button class="btn small" id="copyId">Copy ID</button>
        <button class="btn small" id="renameBtn">Rename</button>
        <button class="btn small danger" id="deleteBtn">Delete</button>
      </div>
    </div>
    <div class="tabs">
      <button class="tab" data-tab="control">State &amp; inject</button>
      <button class="tab" data-tab="scenario">Presets &amp; scenarios</button>
      <button class="tab" data-tab="raw">Raw JSON</button>
    </div>
    <div id="tabBody"></div>`;

  $('#copyId').addEventListener('click', () => navigator.clipboard?.writeText(d.deviceId).then(() => toast('ID copied')));
  $('#sampleBtn')?.addEventListener('click', () => applySampleState(state.templates.find((x) => x.id === store(`st.tpl.${d.deviceId}`))));
  $('#renameBtn').addEventListener('click', renameDevice);
  $('#deleteBtn').addEventListener('click', deleteDevice);
  document.querySelectorAll('#main .tabs .tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; renderTabBody(); }));
  renderTabBody();
}

function renderTabBody() {
  document.querySelectorAll('#main .tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const body = $('#tabBody');
  if (!body) return;
  if (state.tab === 'control') renderControl(body);
  else if (state.tab === 'scenario') renderScenario(body);
  else body.innerHTML = `<div class="panel"><h3>devices:status</h3><pre class="json">${esc(JSON.stringify(state.status, null, 2))}</pre></div>
    <div class="panel"><h3>devices</h3><pre class="json">${esc(JSON.stringify(state.device, null, 2))}</pre></div>`;
}

async function renameDevice() {
  const label = prompt('New device name', state.device.label || state.device.name);
  if (!label) return;
  try {
    await api('PATCH', `/api/devices/${state.selectedId}`, { label });
    state.device.label = label;
    $('#devLabel').textContent = label;
    toast('Renamed', 'ok');
    loadDevices();
  } catch (e) { toast(`Rename failed\n${e.message}`, 'err'); }
}

async function deleteDevice() {
  const nm = state.device.label || state.device.name;
  if (!confirm(`Delete virtual device "${nm}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/devices/${state.selectedId}`);
    toast(`Deleted "${nm}"`, 'ok');
    state.selectedId = null;
    $('#main').innerHTML = '';
    $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
    loadDevices();
  } catch (e) { toast(`Delete failed\n${e.message}`, 'err'); }
}

// ---------- State & inject ----------
function currentAttr(comp, cap, attr) {
  return state.status?.components?.[comp]?.[cap]?.[attr];
}

function renderControl(body) {
  const d = state.device;
  const comps = d.components || [];
  body.innerHTML = `
    <div class="toolbar">
      <button class="btn small" id="reloadStatus">↻ Refresh state</button>
      <label class="small"><input type="checkbox" id="autoChk" ${state.autoRefresh ? 'checked' : ''}/> Auto-refresh every 5 s</label>
      <span class="muted small">Click a value chip to inject it right away, or type a value and press <b>Inject</b>. <b>＋</b> adds it as a scenario step.</span>
    </div>
    ${capFilterPanel(comps)}
    <div class="cap-grid">
      ${comps.flatMap((c) => (c.capabilities || []).map((cap) => capCard(c.id, cap.id))).join('')}
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>Custom event</h3>
      <div class="attr-ctrl">
        <input id="mComp" value="main" style="width:90px" placeholder="component" />
        <input id="mCap" placeholder="capability" style="width:180px" />
        <input id="mAttr" placeholder="attribute" style="width:150px" />
        <input id="mVal" placeholder="value (JSON allowed)" type="text" />
        <input id="mUnit" placeholder="unit" style="width:70px" />
        <button class="btn primary small" id="mSend">Inject</button>
      </div>
      <div class="muted small" style="margin-top:6px">The value is parsed as JSON first (number, true, {...}); if that fails it is sent as a string.</div>
    </div>`;

  wireCapFilter(body, comps);
  $('#reloadStatus').addEventListener('click', () => refreshStatus());
  $('#autoChk').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    clearInterval(state.autoTimer);
    if (state.autoRefresh) state.autoTimer = setInterval(() => refreshStatus(), 5000);
  });
  $('#mSend').addEventListener('click', () => {
    const raw = $('#mVal').value;
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    const ev = { component: $('#mComp').value.trim() || 'main', capability: $('#mCap').value.trim(), attribute: $('#mAttr').value.trim(), value };
    const unit = $('#mUnit').value.trim();
    if (unit) ev.unit = unit;
    if (!ev.capability || !ev.attribute) return toast('Enter a capability and an attribute', 'err');
    sendEvents([ev]);
  });

  body.querySelectorAll('.attr[data-attr]').forEach(wireAttr);
}

// ---------- Capability filter (which cards to show) and collapsing ----------
const capKey = (comp, capId) => `${comp}/${capId}`;
function visibleSet() { const v = store(`st.visible.${state.selectedId}`); return Array.isArray(v) ? new Set(v) : null; } // null = show all
function collapsedSet() { return new Set(store(`st.collapsed.${state.selectedId}`) || []); }
const isCapVisible = (comp, capId) => { const v = visibleSet(); return !v || v.has(capKey(comp, capId)); };
const isCollapsed = (comp, capId) => collapsedSet().has(capKey(comp, capId));

function capFilterPanel(comps) {
  const all = comps.flatMap((c) => (c.capabilities || []).map((cap) => ({ comp: c.id, id: cap.id })));
  if (all.length < 2) return '';
  const v = visibleSet();
  const shown = all.filter((c) => !v || v.has(capKey(c.comp, c.id))).length;
  return `
    <details class="panel cap-filter" open>
      <summary><b>Capabilities</b> <span class="muted small" id="capCount">${shown} of ${all.length} shown</span></summary>
      <div class="muted small" style="margin:6px 0">Tick the capabilities you want to work with; the others are hidden. Your choice is remembered for this device.</div>
      <div class="cap-filter-actions">
        <button class="btn small" id="capAll">All</button><button class="btn small" id="capNone">None</button>
        <button class="btn small" id="capCollapse">Collapse shown</button><button class="btn small" id="capExpand">Expand shown</button>
      </div>
      <div class="checks cap-checks">${all.map((c) => {
        const on = !v || v.has(capKey(c.comp, c.id));
        return `<label class="check ${on ? 'on' : ''}"><input type="checkbox" data-key="${esc(capKey(c.comp, c.id))}" ${on ? 'checked' : ''}/>${c.comp === 'main' ? '' : `<span class="muted">${esc(c.comp)}:</span>`}${esc(c.id)}</label>`;
      }).join('')}</div>
    </details>`;
}

function wireCapFilter(body, comps) {
  const total = comps.reduce((n, c) => n + (c.capabilities || []).length, 0);
  const boxes = [...body.querySelectorAll('.cap-checks input[type=checkbox]')];
  const apply = () => {
    const on = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.key));
    body.querySelectorAll('.cap[data-key]').forEach((card) => { card.hidden = !on.has(card.dataset.key); });
    boxes.forEach((b) => b.closest('label').classList.toggle('on', b.checked));
    store(`st.visible.${state.selectedId}`, on.size === total ? null : [...on]);
    const cnt = $('#capCount'); if (cnt) cnt.textContent = `${on.size} of ${total} shown`;
  };
  body.querySelector('.cap-checks')?.addEventListener('change', apply);
  $('#capAll')?.addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); apply(); });
  $('#capNone')?.addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); apply(); });
  const setCollapsed = (collapse) => {
    body.querySelectorAll('.cap[data-key]:not([hidden])').forEach((card) => card.classList.toggle('collapsed', collapse));
    persistCollapsed(body);
  };
  $('#capCollapse')?.addEventListener('click', () => setCollapsed(true));
  $('#capExpand')?.addEventListener('click', () => setCollapsed(false));
  // clicking a card header collapses / expands that card
  body.querySelectorAll('.cap-head').forEach((head) => {
    const toggle = () => { head.parentElement.classList.toggle('collapsed'); persistCollapsed(body); };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

function persistCollapsed(body) {
  store(`st.collapsed.${state.selectedId}`, [...body.querySelectorAll('.cap.collapsed')].map((c) => c.dataset.key));
}

function capCard(comp, capId) {
  const cap = state.caps[capId] || {};
  const attrs = Object.keys(cap.attributes || {});
  return `
    <div class="cap ${isCollapsed(comp, capId) ? 'collapsed' : ''}" data-key="${esc(capKey(comp, capId))}" ${isCapVisible(comp, capId) ? '' : 'hidden'}>
      <div class="cap-head" role="button" tabindex="0" title="Click to collapse / expand"><span class="chev">▾</span><b>${esc(capId)}</b><span class="comp">${esc(comp)}${cap.name && cap.name !== capId ? ' · ' + esc(cap.name) : ''}</span></div>
      ${attrs.length ? attrs.map((a) => attrRow(comp, capId, a)).join('') : '<div class="attr-empty muted small">Capability without attributes (commands only)</div>'}
    </div>`;
}

function attrRow(comp, capId, attrName) {
  const s = valueSchema(capId, attrName);
  const cur = currentAttr(comp, capId, attrName);
  const curVal = cur?.value;
  const curUnit = cur?.unit;
  let ctrl = '';
  const vOpts = s.type === 'string' ? valueOptions(comp, capId, attrName) : null;
  const lOpts = s.type === 'array' ? listOptions(comp, capId, attrName) : null;
  let optsKey = '';
  if (vOpts) {
    optsKey = JSON.stringify(vOpts);
    const all = vOpts.flatMap(([, vs]) => vs);
    const isCustom = curVal !== undefined && curVal !== null && curVal !== '' && !all.includes(curVal);
    const hasMatch = all.some((v) => String(curVal) === String(v));
    ctrl = `<select class="pick" title="Options come from the device's current ${esc(vOpts[0][0])}">
        ${!hasMatch && !isCustom ? '<option value="" selected disabled>— choose a value —</option>' : ''}
        ${vOpts.map(([label, vs], i) => `<optgroup label="${esc(label)}">${vs.map((v) => `<option value="${esc(v)}" ${String(curVal) === String(v) ? 'selected' : ''}>${esc(v)}${i ? ' ⚠' : ''}</option>`).join('')}</optgroup>`).join('')}
        <option value="__custom__" ${isCustom ? 'selected' : ''}>Custom value…</option>
      </select>
      <input type="text" class="inp custom" placeholder="any string" value="${esc(isCustom ? curVal : '')}" ${isCustom ? '' : 'hidden'} />
      ${s.units ? `<select class="unit">${s.units.map((u) => `<option>${esc(u)}</option>`).join('')}</select>` : ''}
      <button class="btn primary small send">Inject</button>`;
  } else if (lOpts) {
    optsKey = JSON.stringify(lOpts);
    const cur = Array.isArray(curVal) ? curVal : [];
    ctrl = `<div class="checks">
        ${lOpts.map((v) => `<label class="check ${cur.some((c) => c === v) ? 'on' : ''}"><input type="checkbox" data-j="${esc(JSON.stringify(v))}" ${cur.some((c) => c === v) ? 'checked' : ''}/>${esc(v)}</label>`).join('')}
        <span class="add-item"><input type="text" class="newItem" placeholder="new value…" title="Type a value, then press Enter or click Add" /><button class="btn small addNew" title="Add this value to the list">Add</button></span>
      </div>
      <div class="check-actions">
        <button class="btn small selAll">All</button><button class="btn small selNone">None</button>
        <details class="json-edit"><summary class="muted small">Edit as JSON</summary><textarea class="inp" rows="2">${esc(JSON.stringify(cur))}</textarea></details>
        <button class="btn primary small send">Inject</button>
      </div>`;
  } else if (s.enum) {
    ctrl = `<div class="chips">${s.enum.map((v) => `<button class="chip ${String(curVal) === String(v) ? 'current' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>`;
  } else if (s.type === 'boolean') {
    ctrl = `<div class="chips">${['true', 'false'].map((v) => `<button class="chip ${String(curVal) === v ? 'current' : ''}" data-v="${v}">${v}</button>`).join('')}</div>`;
  } else if (s.type === 'integer' || s.type === 'number') {
    const step = s.type === 'integer' ? 1 : 'any';
    const useRange = s.min !== undefined && s.max !== undefined && s.max - s.min <= 1000;
    ctrl = `
      ${useRange ? `<input type="range" class="rng" min="${s.min}" max="${s.max}" step="${s.type === 'integer' ? 1 : (s.max - s.min) / 200}" value="${curVal ?? s.min}" style="flex:1;min-width:100px" />` : ''}
      <input type="number" class="inp" step="${step}" ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''} value="${esc(curVal ?? '')}" />
      ${s.units ? `<select class="unit">${s.units.map((u) => `<option ${u === (curUnit || s.unitDefault) ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}
      <button class="btn primary small send">Inject</button>`;
  } else if (s.type === 'array' || s.type === 'object') {
    ctrl = `<textarea class="inp" rows="2">${esc(curVal !== undefined ? JSON.stringify(curVal) : (s.type === 'array' ? '[]' : '{}'))}</textarea>
      <button class="btn primary small send">Inject</button>`;
  } else {
    ctrl = `<input type="text" class="inp" value="${esc(curVal ?? '')}" />
      ${s.units ? `<select class="unit">${s.units.map((u) => `<option>${esc(u)}</option>`).join('')}</select>` : ''}
      <button class="btn primary small send">Inject</button>`;
  }
  const hint = [s.type, s.min !== undefined ? `min ${s.min}` : '', s.max !== undefined ? `max ${s.max}` : ''].filter(Boolean).join(' · ');
  return `
    <div class="attr" data-comp="${esc(comp)}" data-cap="${esc(capId)}" data-attr="${esc(attrName)}" data-type="${esc(s.type)}" data-opts="${esc(optsKey)}">
      <div class="attr-top">
        <span class="attr-name">${esc(attrName)} <span class="range-hint">${esc(hint)}</span>${listHint(attrName) ? ' <button type="button" class="info" title="What is this?" aria-label="What is this?">ⓘ</button>' : ''}</span>
        <span class="attr-cur"><span class="muted">current</span> <span class="val">${esc(fmtVal(curVal))}${curUnit ? ' ' + esc(curUnit) : ''}</span></span>
      </div>
      ${listHint(attrName) ? `<div class="attr-hint" hidden>${listHint(attrName)}</div>` : ''}
      <div class="attr-ctrl">${ctrl}<button class="btn small addStep" title="Add to scenario">＋</button></div>
    </div>`;
}

// Short explanation shown (via the ⓘ button) for every supportedX / availableX attribute, whatever the capability.
function listHint(attrName) {
  const m = LIST_PREFIX.exec(attrName);
  if (!m) return '';
  return m[1] === 'supported'
    ? '<b>supported…</b> = everything this device can do at all. It rarely changes.'
    : '<b>available…</b> = what can be chosen <em>right now</em>: a subset of the matching <code>supported…</code> list that changes with the current mode (for example, in dry mode a high fan speed may be unavailable). <b>Test tip:</b> inject a shorter list here to check that your app hides or blocks the rest.';
}

function readAttrEvent(row, chipValue) {
  const { comp, cap, attr, type } = row.dataset;
  let raw = chipValue !== undefined ? chipValue : row.querySelector('.inp')?.value;
  const pick = row.querySelector('select.pick');
  if (chipValue === undefined && pick && pick.value !== '__custom__') raw = pick.value;
  const checks = row.querySelector('.checks');
  if (chipValue === undefined && checks) row._commitNew?.(); // a typed-but-not-added value counts too
  if (chipValue === undefined && checks && !row.querySelector('details.json-edit')?.open) {
    raw = [...checks.querySelectorAll('input[type=checkbox]:checked')].map((c) => JSON.parse(c.dataset.j));
  }
  if (raw === undefined || raw === '') throw new Error(`${attr}: enter a value`);
  const ev = { component: comp, capability: cap, attribute: attr, value: convertValue(raw, type) };
  const unit = row.querySelector('select.unit')?.value;
  if (unit) ev.unit = unit;
  return ev;
}

function wireAttr(row) {
  row.querySelector('.info')?.addEventListener('click', () => { const h = row.querySelector('.attr-hint'); if (h) h.hidden = !h.hidden; });
  const rng = row.querySelector('.rng');
  const inp = row.querySelector('.inp');
  if (rng && inp) {
    rng.addEventListener('input', () => { inp.value = rng.value; });
    inp.addEventListener('input', () => { rng.value = inp.value; });
  }
  row.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    try { sendEvents([readAttrEvent(row, chip.dataset.v)]); } catch (e) { toast(e.message, 'err'); }
  }));
  row.querySelector('.send')?.addEventListener('click', () => {
    try { sendEvents([readAttrEvent(row)]); } catch (e) { toast(e.message, 'err'); }
  });
  inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.tagName === 'INPUT') row.querySelector('.send')?.click(); });
  const pick = row.querySelector('select.pick');
  pick?.addEventListener('change', () => {
    inp.hidden = pick.value !== '__custom__';
    if (!inp.hidden) inp.focus();
  });
  const checks = row.querySelector('.checks');
  if (checks) {
    const json = row.querySelector('details.json-edit textarea');
    const sync = () => {
      checks.querySelectorAll('label.check').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      json.value = JSON.stringify([...checks.querySelectorAll('input[type=checkbox]:checked')].map((c) => JSON.parse(c.dataset.j)));
    };
    checks.addEventListener('change', sync);
    row.querySelector('.selAll').addEventListener('click', () => { checks.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = true; }); sync(); });
    row.querySelector('.selNone').addEventListener('click', () => { checks.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; }); sync(); });
    const add = row.querySelector('.newItem');
    // Add the typed value as a checked item. Returns true if something was added.
    const commitNew = () => {
      const v = add.value.trim();
      if (!v) return false;
      add.value = '';
      const exists = [...checks.querySelectorAll('input[type=checkbox]')].find((c) => JSON.parse(c.dataset.j) === v);
      if (exists) { exists.checked = true; sync(); return true; }
      const lbl = document.createElement('label');
      lbl.className = 'check on';
      lbl.innerHTML = `<input type="checkbox" data-j="${esc(JSON.stringify(v))}" checked/>${esc(v)}`;
      checks.insertBefore(lbl, add.parentElement);
      sync();
      return true;
    };
    row._commitNew = commitNew;
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNew(); } });
    add.addEventListener('blur', commitNew);
    row.querySelector('.addNew').addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so blur does not double-fire
    row.querySelector('.addNew').addEventListener('click', () => { if (!commitNew()) add.focus(); });
  }
  row.querySelector('.addStep').addEventListener('click', () => {
    let ev;
    if (row.querySelector('.chip')) {
      const v = prompt(`Value of ${row.dataset.attr} to add to the scenario`, row.querySelector('.chip.current')?.dataset.v || row.querySelector('.chip').dataset.v);
      if (v === null) return;
      try { ev = readAttrEvent(row, v); } catch (e) { return toast(e.message, 'err'); }
    } else {
      try { ev = readAttrEvent(row); } catch (e) { return toast(e.message, 'err'); }
    }
    state.draft.push({ events: [ev], delayMs: 1000 });
    store(`st.draft.${state.selectedId}`, state.draft);
    toast(`Added step: ${ev.capability}.${ev.attribute} = ${fmtVal(ev.value)} (${state.draft.length} steps total)`, 'ok');
  });
}

function updateCurrentValues(flash) {
  document.querySelectorAll('#tabBody .attr[data-attr]').forEach((row) => {
    // Rebuild a row whose option list changed (e.g. a new supported* list was just injected).
    const { comp, cap, attr } = row.dataset;
    const fresh = document.createElement('div');
    fresh.innerHTML = attrRow(comp, cap, attr).trim();
    const next = fresh.firstElementChild;
    if (next.dataset.opts !== row.dataset.opts) {
      row.replaceWith(next);
      wireAttr(next);
      row = next;
    }
    const cur = currentAttr(row.dataset.comp, row.dataset.cap, row.dataset.attr);
    const el = row.querySelector('.attr-cur .val');
    if (!el) return;
    const text = fmtVal(cur?.value) + (cur?.unit ? ' ' + cur.unit : '');
    if (el.textContent !== text) {
      el.textContent = text;
      if (flash) {
        el.parentElement.classList.add('flash');
        setTimeout(() => el.parentElement.classList.remove('flash'), 1500);
      }
    }
    row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('current', String(cur?.value) === c.dataset.v));
  });
}

async function sendEvents(events, { quiet = false } = {}) {
  const id = state.selectedId;
  try {
    const out = await api('POST', `/api/devices/${id}/events`, { events });
    if (!quiet) {
      const changes = out?.output?.stateChanges;
      const summary = events.map((e) => `${e.capability}.${e.attribute} = ${fmtVal(e.value)}${e.unit ? ' ' + e.unit : ''}`).join('\n');
      toast(`Injected${changes ? ` (state changed: ${changes.join(', ')})` : ''}\n${summary}`, 'ok');
    }
    if (state.selectedId === id) await refreshStatus();
    return true;
  } catch (e) {
    toast(`Injection failed\n${e.message}`, 'err');
    return false;
  }
}

// Inject the sample attribute values recorded from the real appliance (only for capabilities this device has).
async function applySampleState(t) {
  if (!t?.sampleState || !state.device) return;
  const have = deviceCapSet();
  const events = [];
  for (const [comp, caps] of Object.entries(t.sampleState)) {
    for (const [cap, attrs] of Object.entries(caps)) {
      if (!have.has(`${comp}/${cap}`)) continue;
      for (const [attr, v] of Object.entries(attrs)) {
        events.push({ component: comp, capability: cap, attribute: attr, value: v.value, ...(v.unit ? { unit: v.unit } : {}) });
      }
    }
  }
  if (!events.length) return toast('No sample state for this device');
  let ok = 0;
  for (let i = 0; i < events.length; i += 25) {
    if (await sendEvents(events.slice(i, i + 25), { quiet: true })) ok += Math.min(25, events.length - i); else break;
  }
  toast(ok === events.length ? `Loaded sample state (${ok} attributes)` : `Loaded ${ok} of ${events.length} attributes`, ok === events.length ? 'ok' : 'err');
}

// ---------- Presets & scenarios ----------
function deviceCapSet() {
  const set = new Set();
  (state.device?.components || []).forEach((c) => (c.capabilities || []).forEach((x) => set.add(`${c.id}/${x.id}`)));
  return set;
}

function applicable(events) {
  const set = deviceCapSet();
  return events.every((e) => set.has(`${e.component || 'main'}/${e.capability}`));
}

function evText(e) {
  return `${e.component && e.component !== 'main' ? e.component + ':' : ''}${e.capability}.${e.attribute} = ${fmtVal(e.value)}${e.unit ? ' ' + e.unit : ''}`;
}

function savedScenarios() { return store('st.scenarios') || []; }

function renderScenario(body) {
  const presets = state.presets.map((p) => ({ ...p, from: 'built-in preset' })).filter((p) => applicable(p.events));
  const saved = savedScenarios().map((s, i) => ({ ...s, idx: i })).filter((s) => s.steps.every((st) => applicable(st.events)));

  body.innerHTML = `
    <div class="panel">
      <h3>Quick presets <span class="muted small">built-in presets that match this device's capabilities</span></h3>
      ${presets.length ? `<div class="preset-row">${presets.map((p, i) => `<button class="btn small preset" data-i="${i}" title="${esc(p.from + '\n' + p.events.map(evText).join('\n'))}">${esc(p.label)}</button>`).join('')}</div>`
        : '<div class="muted small">No matching presets. Build a scenario below.</div>'}
    </div>

    <div class="panel">
      <h3>Scenario builder <span class="muted small">add steps with the ＋ buttons on the State &amp; inject tab</span></h3>
      <div id="draftSteps">${renderSteps(state.draft, true)}</div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn primary small" id="runDraft" ${state.draft.length ? '' : 'disabled'}>▶ Run</button>
        <label class="small"><input type="checkbox" id="loopChk" /> Loop</label>
        <button class="btn small" id="stopRun" disabled>■ Stop</button>
        <input id="scName" placeholder="Scenario name" style="width:180px" />
        <button class="btn small" id="saveDraft" ${state.draft.length ? '' : 'disabled'}>Save</button>
        <button class="btn small" id="clearDraft" ${state.draft.length ? '' : 'disabled'}>Clear</button>
        <button class="btn small" id="importBtn">Import / export JSON</button>
      </div>
    </div>

    <div class="panel">
      <h3>Saved scenarios</h3>
      ${saved.length ? saved.map((s) => `
        <div class="scenario">
          <div class="scenario-head"><b>${esc(s.name)}</b>
            <span><button class="btn small runSaved" data-idx="${s.idx}">▶ Run</button>
            <button class="btn small editSaved" data-idx="${s.idx}">Edit</button>
            <button class="btn small danger delSaved" data-idx="${s.idx}">Delete</button></span></div>
          <div class="muted small">${s.steps.length} steps · ${esc(s.steps.map((st) => st.events.map(evText).join(', ')).join(' → '))}</div>
        </div>`).join('') : '<div class="muted small">No saved scenarios. (They are stored in your browser.)</div>'}
    </div>`;

  body.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => sendEvents(presets[b.dataset.i].events)));
  wireSteps($('#draftSteps'));

  let stopFlag = { stop: false };
  $('#runDraft').addEventListener('click', async () => {
    stopFlag = { stop: false };
    $('#runDraft').disabled = true; $('#stopRun').disabled = false;
    do {
      await runSteps(state.draft, $('#draftSteps'), stopFlag);
    } while ($('#loopChk')?.checked && !stopFlag.stop && state.tab === 'scenario');
    if ($('#runDraft')) { $('#runDraft').disabled = false; $('#stopRun').disabled = true; }
  });
  $('#stopRun').addEventListener('click', () => { stopFlag.stop = true; });
  $('#saveDraft').addEventListener('click', () => {
    const name = $('#scName').value.trim() || `Scenario ${new Date().toLocaleString()}`;
    const all = savedScenarios();
    all.push({ name, steps: JSON.parse(JSON.stringify(state.draft)) });
    store('st.scenarios', all);
    toast(`Saved "${name}"`, 'ok');
    renderTabBody();
  });
  $('#clearDraft').addEventListener('click', () => { state.draft = []; store(`st.draft.${state.selectedId}`, []); renderTabBody(); });
  $('#importBtn').addEventListener('click', () => {
    const txt = prompt('Scenario steps JSON (the current draft is pre-filled; paste and confirm to replace it)', JSON.stringify(state.draft));
    if (txt === null) return;
    try {
      const steps = JSON.parse(txt);
      if (!Array.isArray(steps) || !steps.every((s) => Array.isArray(s.events))) throw new Error('Expected the format [{ "events": [...], "delayMs": 1000 }]');
      state.draft = steps; store(`st.draft.${state.selectedId}`, steps); renderTabBody();
    } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('.runSaved').forEach((b) => b.addEventListener('click', async () => {
    const s = savedScenarios()[b.dataset.idx];
    b.disabled = true;
    await runSteps(s.steps, null, { stop: false });
    b.disabled = false;
  }));
  body.querySelectorAll('.editSaved').forEach((b) => b.addEventListener('click', () => {
    const s = savedScenarios()[b.dataset.idx];
    state.draft = JSON.parse(JSON.stringify(s.steps));
    store(`st.draft.${state.selectedId}`, state.draft);
    renderTabBody();
    $('#scName').value = s.name;
  }));
  body.querySelectorAll('.delSaved').forEach((b) => b.addEventListener('click', () => {
    const all = savedScenarios();
    if (!confirm(`Delete scenario "${all[b.dataset.idx].name}"?`)) return;
    all.splice(b.dataset.idx, 1);
    store('st.scenarios', all);
    renderTabBody();
  }));
}

function renderSteps(steps, editable) {
  if (!steps.length) return '<div class="muted small">No steps.</div>';
  return steps.map((s, i) => `
    <div class="step" data-i="${i}">
      <span class="muted">${i + 1}</span>
      <span class="ev">${esc(s.events.map(evText).join(', '))}</span>
      ${editable ? `<input type="number" class="delay" min="0" step="100" value="${s.delayMs ?? 1000}" title="Wait after this step (ms)" />` : `<span class="muted small">${s.delayMs ?? 0}ms</span>`}
      ${editable ? '<button class="btn small ghost rm" title="Remove">✕</button>' : '<span></span>'}
    </div>`).join('');
}

function wireSteps(container) {
  container.querySelectorAll('.step').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.delay')?.addEventListener('change', (e) => {
      state.draft[i].delayMs = Math.max(0, Number(e.target.value) || 0);
      store(`st.draft.${state.selectedId}`, state.draft);
    });
    row.querySelector('.rm')?.addEventListener('click', () => {
      state.draft.splice(i, 1);
      store(`st.draft.${state.selectedId}`, state.draft);
      renderTabBody();
    });
  });
}

async function runSteps(steps, container, flag) {
  const rows = container ? container.querySelectorAll('.step') : [];
  rows.forEach((r) => r.classList.remove('running', 'done', 'fail'));
  for (let i = 0; i < steps.length; i++) {
    if (flag.stop) break;
    rows[i]?.classList.add('running');
    const ok = await sendEvents(steps[i].events, { quiet: true });
    rows[i]?.classList.remove('running');
    rows[i]?.classList.add(ok ? 'done' : 'fail');
    if (!ok) { flag.stop = true; break; }
    const delay = steps[i].delayMs ?? 0;
    if (delay && i < steps.length - 1) await sleep(delay);
  }
  toast(flag.stop ? 'Scenario stopped' : 'Scenario finished', flag.stop ? '' : 'ok');
}

// ================= Start =================
(async function init() {
  $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
  await loadInfo();
  refreshLog();
  loadTemplates();
  await loadLocations();
  await loadDevices();
})();
