// Device creation view (Appliance templates, Standard prototype, Device profile ID, Profile JSON)
// and sample state injection.

import { state, actions, PROTOTYPES, store, deviceCapSet } from '../state.js';
import { $, esc, api, toast, sendEvents } from '../api.js';

const createState = { mode: 'template', templateId: null };

const MODE_INTROS = {
  template: '<b>Appliance templates</b> — pick a real appliance model (washer, oven, TV …) and get a virtual device with the same <em>standard</em> SmartThings capabilities. Best for trying an app or automation against Samsung-like devices. These are not official Samsung profiles: the capability lists and sample values were taken from real devices (Home Assistant test data), and Samsung-specific capabilities are left out.',
  standard: '<b>Standard prototype</b> — one of SmartThings\' built-in virtual device types (switch, dimmer, motion sensor, lock, thermostat …). The quickest way to get a simple generic device; the capabilities are fixed by SmartThings.',
  profileId: '<b>Device profile ID</b> — reuse a device profile that already exists in your SmartThings account (for example one you made earlier with <code>smartthings deviceprofiles:create</code>). The list only shows profiles from your own account, so it is empty if you have not created any. In that case use another tab, or paste a profile UUID.',
  json: '<b>Profile JSON</b> — write your own profile and choose exactly which components and capabilities the device has. Use it for custom combinations or devices with several components. Find capability IDs with <code>smartthings capabilities</code>.',
};

export async function renderCreate() {
  if (!state.templates.length) {
    await actions.loadTemplates();
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
      const sel = $('#cProfile');
      if (!sel) return;
      sel.innerHTML = '<option value="">Select…</option>' +
        (list || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.status || '')})</option>`).join('');
    }).catch((e) => {
      const sel = $('#cProfile');
      if (sel) sel.innerHTML = '<option value="">Could not load the list (paste a UUID instead)</option>';
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
    if (pre) {
      pre.style.display = 'block';
      pre.textContent = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    }
    if (!dryRun) {
      toast(`Created "${name}"`, 'ok');
      await actions.loadDevices();
      const id = out?.deviceId;
      if (id) {
        if (tplUsed) store(`st.tpl.${id}`, tplUsed.id);
        const wantSample = tplUsed && $('#tplSample')?.checked !== false && createState.sample !== false;
        await actions.selectDevice(id);
        if (wantSample) await applySampleState(tplUsed, id);
      }
    }
  } catch (e) {
    toast(`Creation failed\n${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Inject the sample attribute values recorded from the real appliance (only for capabilities this device has).
export async function applySampleState(t, targetDeviceId = state.selectedId) {
  if (!t?.sampleState || !state.device || !targetDeviceId) return;
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
    if (state.selectedId !== targetDeviceId) break;
    if (await sendEvents(targetDeviceId, events.slice(i, i + 25), { quiet: true })) ok += Math.min(25, events.length - i);
    else break;
  }
  toast(ok === events.length ? `Loaded sample state (${ok} attributes)` : `Loaded ${ok} of ${events.length} attributes`, ok === events.length ? 'ok' : 'err');
}
