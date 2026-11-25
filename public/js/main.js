// Application entry point: top bar, CLI log drawer, device sidebar, device selection, and tab routing.

import {
  state, actions, store, capCacheKey, setCapDef, clearCapDefs, stopAuto, stopActiveRun,
} from './state.js';
import { $, esc, api, toast, refreshLog } from './api.js';
import { renderCreate, applySampleState } from './views/create.js';
import { renderControl, updateCurrentValues } from './views/control.js';
import { renderScenario } from './views/scenario.js';
import { initAccountMenu, loadAccount, signIn, isSigningIn } from './views/account.js';

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
  } catch {
    badge.className = 'badge err';
    badge.textContent = 'Cannot reach server';
  }
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
    const profile = $('#profileInput').value.trim();
    await api('POST', '/api/profile', { profile });
    stopAuto();
    stopActiveRun();
    clearCapDefs();
    toast(`Switched to profile "${profile}"`, 'ok');
    await loadAccountAndData();
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
  if (!state.account?.signedIn || isSigningIn()) return renderSignedOut();
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
$('#newDeviceBtn').addEventListener('click', () => {
  if (!state.account?.signedIn) { toast('Sign in to a SmartThings account first (account menu, top right).', 'err'); return; }
  stopAuto();
  stopActiveRun();
  state.selectedId = null;
  renderDeviceList();
  renderCreate();
});

async function loadTemplates() {
  try {
    const r = await api('GET', '/api/templates');
    state.templates = r.templates || [];
    state.templatesMeta = r.generatedFrom || null;
  } catch { state.templates = []; }
  try { state.presets = (await api('GET', '/api/presets')) || []; } catch { state.presets = []; }
}

// ================= Device detail =================
async function selectDevice(id) {
  stopAuto();
  stopActiveRun();
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
      const [cid, verStr] = k.split('|');
      const ver = Number(verStr || 1);
      if (state.caps[capCacheKey(cid, ver)]) return;
      try {
        setCapDef(cid, ver, await api('GET', `/api/capabilities/${cid}/${ver}`));
      } catch {
        setCapDef(cid, ver, { id: cid, version: ver, attributes: {} });
      }
    }));
    if (state.selectedId !== id) return;
    renderDevice();
  } catch (e) {
    if (state.selectedId !== id) return;
    $('#main').innerHTML = `<div class="panel"><h3>Could not load the device</h3><pre class="json">${esc(e.message)}</pre></div>`;
  }
}

async function refreshStatus(flash = true) {
  const id = state.selectedId;
  if (!id) return;
  const before = JSON.stringify(state.status);
  let nextStatus;
  try {
    nextStatus = await api('GET', `/api/devices/${id}/status`);
  } catch (e) { toast(`Could not read status\n${e.message}`, 'err'); return; }
  // Guard against stale responses after switching devices.
  if (state.selectedId !== id) return;
  state.status = nextStatus;
  if (state.tab === 'control') updateCurrentValues(flash && before !== JSON.stringify(state.status));
  if (state.tab === 'raw') renderTabBody();
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
  $('#sampleBtn')?.addEventListener('click', () => applySampleState(state.templates.find((x) => x.id === store(`st.tpl.${d.deviceId}`)), d.deviceId));
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
  const id = state.selectedId;
  const label = prompt('New device name', state.device.label || state.device.name);
  if (!label) return;
  try {
    await api('PATCH', `/api/devices/${id}`, { label });
    if (state.selectedId === id && state.device) {
      state.device.label = label;
      const el = $('#devLabel');
      if (el) el.textContent = label;
    }
    toast('Renamed', 'ok');
    loadDevices();
  } catch (e) { toast(`Rename failed\n${e.message}`, 'err'); }
}

async function deleteDevice() {
  const id = state.selectedId;
  const nm = state.device.label || state.device.name;
  if (!confirm(`Delete virtual device "${nm}"? This cannot be undone.`)) return;
  try {
    stopAuto();
    stopActiveRun();
    await api('DELETE', `/api/devices/${id}`);
    toast(`Deleted "${nm}"`, 'ok');
    state.selectedId = null;
    $('#main').innerHTML = '';
    $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
    loadDevices();
  } catch (e) { toast(`Delete failed\n${e.message}`, 'err'); }
}

// ================= Account changes =================
function clearAccountData() {
  stopAuto();
  stopActiveRun();
  clearCapDefs();
  state.selectedId = null;
  state.device = null;
  state.status = null;
  state.devices = [];
  state.locations = [];
  $('#locationFilter').innerHTML = '<option value="">All locations</option>';
  $('#main').innerHTML = '';
  $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
}

function renderSignedOut() {
  const list = $('#deviceList');
  if (isSigningIn()) {
    list.innerHTML = '<div class="signed-out muted"><span class="spinner"></span><p>Finish signing in in the browser window the CLI opened.</p></div>';
    return;
  }
  list.innerHTML = `<div class="signed-out">
      <b>Not signed in</b>
      <p class="muted small">Sign in to a SmartThings account to see and create virtual devices.</p>
      <button class="btn primary small" id="sideSignIn">Sign in</button>
    </div>`;
  $('#sideSignIn').addEventListener('click', () => signIn());
}

async function loadAccountAndData() {
  const acct = await loadAccount();
  if (acct?.signedIn) {
    await loadLocations();
    await loadDevices();
  } else {
    clearAccountData();
    renderSignedOut();
  }
}

actions.onSignedOut = () => { clearAccountData(); renderSignedOut(); };
actions.onSigningIn = () => { clearAccountData(); renderSignedOut(); };
actions.onSignedIn = async () => { clearAccountData(); await loadLocations(); await loadDevices(); };

// Wire shared view hooks
actions.loadDevices = loadDevices;
actions.loadTemplates = loadTemplates;
actions.selectDevice = selectDevice;
actions.refreshStatus = refreshStatus;
actions.renderTabBody = renderTabBody;

// ================= Start =================
(async function init() {
  $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
  initAccountMenu();
  await loadInfo();
  refreshLog();
  loadTemplates();
  await loadAccountAndData();
})();
