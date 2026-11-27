// State & inject view: capability master list, pinned panels, attribute controls, and live updates.

import { state, actions, store, fmtVal, getCapDef, currentCapStatus, currentAttr } from '../state.js';
import { LIST_PREFIX, convertValue, valueSchema, valueOptions, listOptions, listHint } from '../schema.js';
import { $, esc, api, toast, sendEvents } from '../api.js';

const capKey = (comp, capId) => `${comp}/${capId}`;
const capName = (comp, capId) => (comp === 'main' ? '' : `${comp}: `) + capId;
const capMaster = { entries: [], sel: null, pins: [], hidden: [] };

export function renderControl(body) {
  const d = state.device;
  const comps = d.components || [];
  body.innerHTML = `
    <div class="toolbar">
      <button class="btn small" id="reloadStatus"><span class="ico">↻</span> Refresh state</button>
      <span class="muted small refresh-note" id="refreshNote" aria-live="polite"></span>
      <label class="small"><input type="checkbox" id="autoChk" ${state.autoRefresh ? 'checked' : ''}/> Auto-refresh every 5 s</label>
      <span class="muted small">Click a value chip to inject it right away, or type a value and press <b>Inject</b>. <b>＋</b> adds it as a scenario step.</span>
    </div>
    <div class="state-summary" id="stateSummary" title="Current state at a glance"></div>
    <div class="panel custom-event">
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
    </div>
    <div id="pinnedPane" class="pinned-pane"></div>
    <div class="md">
      <aside class="cap-list" aria-label="Capabilities">
        <input id="capSearch" placeholder="Filter capabilities…" />
        <div id="capItems"></div>
      </aside>
      <section id="capPane" class="cap-pane"></section>
    </div>
    <div class="panel activity">
      <div class="activity-head"><h3>Recent activity</h3><button class="btn small" id="loadActivity">Load</button></div>
      <div class="muted small">The last 20 state changes SmartThings recorded for this device: values injected here and changes made by commands from other apps (for example Homey turning it on). SmartThings records the resulting state, not the command itself.</div>
      <div id="activityList"></div>
    </div>`;

  initCapMaster(comps);
  $('#loadActivity').addEventListener('click', loadActivity);
  $('#reloadStatus').addEventListener('click', manualRefresh);
  $('#autoChk').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    clearInterval(state.autoTimer);
    if (state.autoRefresh) state.autoTimer = setInterval(() => actions.refreshStatus(), 5000);
  });
  $('#mSend').addEventListener('click', () => {
    const raw = $('#mVal').value;
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    const ev = { component: $('#mComp').value.trim() || 'main', capability: $('#mCap').value.trim(), attribute: $('#mAttr').value.trim(), value };
    const unit = $('#mUnit').value.trim();
    if (unit) ev.unit = unit;
    if (!ev.capability || !ev.attribute) return toast('Enter a capability and an attribute', 'err');
    sendEvents(state.selectedId, [ev]);
  });
}

// Refresh state button: spin while reading, then say when it was read and whether anything changed
// (changed values also flash in the list).
async function manualRefresh() {
  const btn = $('#reloadStatus');
  const note = $('#refreshNote');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  if (note) { note.textContent = 'Reading state from SmartThings…'; note.classList.remove('done'); }
  const started = Date.now();
  const r = await actions.refreshStatus(true);
  await new Promise((res) => setTimeout(res, Math.max(0, 400 - (Date.now() - started)))); // keep the spin visible
  const b = $('#reloadStatus');
  if (b) { b.disabled = false; b.classList.remove('busy'); }
  const n = $('#refreshNote');
  if (!n) return;
  n.textContent = r ? `Updated ${new Date().toLocaleTimeString()} · ${r.changed ? 'values changed (highlighted)' : 'no changes'}` : '';
  n.classList.remove('done'); void n.offsetWidth; n.classList.add('done');
}

// Device history (devices:history): the latest recorded attribute changes, newest first.
async function loadActivity() {
  const box = $('#activityList');
  const id = state.selectedId;
  if (!box || !id) return;
  box.innerHTML = '<div class="muted small pad"><span class="spinner"></span> Loading…</div>';
  try {
    const items = (await api('GET', `/api/devices/${id}/history`)) || [];
    if (state.selectedId !== id || !$('#activityList')) return;
    box.innerHTML = items.length
      ? `<table class="map-table"><thead><tr><th>Time</th><th>Capability</th><th>Value</th></tr></thead><tbody>${items.map((h) => `
          <tr><td class="muted">${esc(h.time ? new Date(h.time).toLocaleString() : '')}</td>
          <td><code>${esc((h.component && h.component !== 'main' ? h.component + ': ' : '') + h.capability + '.' + h.attribute)}</code></td>
          <td><b>${esc(typeof h.value === 'object' ? JSON.stringify(h.value) : String(h.value))}</b>${h.unit ? ' ' + esc(h.unit) : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted small pad">No activity recorded yet.</div>';
  } catch (e) {
    box.innerHTML = `<div class="muted small pad">Could not load the history: ${esc(e.message)}</div>`;
  }
}

// One short value for a capability: its first scalar attribute (supported*/available* lists last).
function briefOf(comp, capId, version) {
  const names = Object.keys(getCapDef(capId, version)?.attributes || {});
  const ordered = [...names.filter((a) => !LIST_PREFIX.test(a)), ...names.filter((a) => LIST_PREFIX.test(a))];
  for (const pass of [0, 1]) {
    for (const a of ordered) {
      const v = currentAttr(comp, capId, a);
      if (!v || v.value === null || v.value === undefined) continue;
      const isObj = typeof v.value === 'object';
      if (pass === 0 && isObj) continue;
      const text = Array.isArray(v.value) ? `${v.value.length} items` : isObj ? '{…}' : String(v.value) + (v.unit ? ' ' + v.unit : '');
      return { attr: a, text };
    }
  }
  return null;
}

function capItemHtml(e) {
  const b = briefOf(e.comp, e.id, e.version);
  const pinned = capMaster.pins.includes(e.key);
  return `<div class="cap-item ${e.key === capMaster.sel ? 'sel' : ''}" data-key="${esc(e.key)}" role="button" tabindex="0" data-search="${esc(capName(e.comp, e.id).toLowerCase())}">
      <span class="ci-name">${esc(capName(e.comp, e.id))}</span>
      <span class="ci-val" title="${esc(b ? b.attr : '')}">${esc(b ? b.text : '')}</span>
      <button type="button" class="pin ${pinned ? 'on' : ''}" title="${pinned ? 'Unpin' : 'Pin: keep this capability open on the right'}" aria-label="Pin">${pinned ? '★' : '☆'}</button>
    </div>`;
}

function updateCapList() {
  const box = $('#capItems');
  if (!box) return;
  capMaster.entries.forEach((e) => {
    const item = box.querySelector(`.cap-item[data-key="${CSS.escape(e.key)}"]`);
    if (!item) return;
    const b = briefOf(e.comp, e.id, e.version);
    const val = item.querySelector('.ci-val');
    if (val.textContent !== (b ? b.text : '')) { val.textContent = b ? b.text : ''; val.title = b ? b.attr : ''; }
  });
  const sum = $('#stateSummary');
  if (sum) {
    const parts = capMaster.entries.map((e) => ({ e, b: briefOf(e.comp, e.id, e.version) })).filter((x) => x.b && !/^(refresh)$/.test(x.e.id)).slice(0, 6);
    sum.innerHTML = parts.length
      ? parts.map(({ e, b }) => `<span class="sum-item" data-key="${esc(e.key)}" title="Open ${esc(e.id)}"><span class="muted">${esc(b.attr)}</span> <b>${esc(b.text)}</b></span>`).join('')
      : '<span class="muted small">No state reported yet.</span>';
  }
}

function renderCapPane() {
  const pane = $('#capPane');
  if (!pane) return;
  // Starred (frequently used) capabilities are always open right under the Custom event panel, in pin order.
  const pp = $('#pinnedPane');
  const card = (k) => { const e = capMaster.entries.find((x) => x.key === k); return e ? capCard(e.comp, e.id, e.version) : ''; };
  pp.innerHTML = capMaster.pins.length
    ? `<div class="pinned-title">★ Pinned</div>${capMaster.pins.map(card).join('')}`
    : '';
  pp.hidden = !capMaster.pins.length;
  const sel = capMaster.sel;
  pane.innerHTML = sel && capMaster.pins.includes(sel)
    ? '<div class="muted pad">This capability is pinned and shown above. Select another one to see it here.</div>'
    : sel ? card(sel) : '<div class="muted pad">Select a capability on the left.</div>';
  pp.querySelectorAll('.attr[data-attr]').forEach(wireAttr);
  pane.querySelectorAll('.attr[data-attr]').forEach(wireAttr);
}

// Command-only capabilities (refresh, tone, audioNotification …) have no state to inject, so the list hides
// them. They stay in the device profile, so other apps still see the same device as a real one.
// A definition that failed to load has no `commands` field and is kept.
const isCommandOnly = (id, version) => {
  const def = getCapDef(id, version);
  return !!def && !!def.commands && !Object.keys(def.attributes || {}).length;
};

function initCapMaster(comps) {
  const all = comps.flatMap((c) => (c.capabilities || []).map((cap) => ({ comp: c.id, id: cap.id, version: cap.version || 1, key: capKey(c.id, cap.id) })));
  const entries = all.filter((e) => !isCommandOnly(e.id, e.version));
  capMaster.hidden = [...new Set(all.filter((e) => isCommandOnly(e.id, e.version)).map((e) => e.id))];
  const id = state.selectedId;
  capMaster.entries = entries;
  capMaster.pins = (store(`st.pin.${id}`) || []).filter((k) => entries.some((e) => e.key === k));
  const saved = store(`st.sel.${id}`);
  capMaster.sel = entries.some((e) => e.key === saved) ? saved
    : (entries.find((e) => Object.keys(getCapDef(e.id, e.version)?.attributes || {}).length && e.id !== 'refresh') || entries[0] || {}).key || null;

  const box = $('#capItems');
  // Pinned capabilities go to the top (in pin order) under a "Pinned" heading; the rest keep their normal order.
  const paint = () => {
    const pinned = capMaster.pins.map((k) => entries.find((e) => e.key === k)).filter(Boolean);
    const rest = entries.filter((e) => !capMaster.pins.includes(e.key));
    box.innerHTML = (pinned.length ? `<div class="cap-group">Pinned</div>${pinned.map(capItemHtml).join('')}<div class="cap-group">All capabilities</div>` : '')
      + rest.map(capItemHtml).join('')
      + (capMaster.hidden.length ? `<div class="muted small pad" title="These capabilities only accept commands (for example from SmartThings or Homey) and have no state to inject. They are still part of the device.">Command-only, not listed: ${capMaster.hidden.map(esc).join(', ')}</div>` : '');
    applySearch();
  };
  const applySearch = () => {
    const q = ($('#capSearch').value || '').trim().toLowerCase();
    box.querySelectorAll('.cap-item').forEach((it) => { it.hidden = !!q && !it.dataset.search.includes(q); });
    box.querySelectorAll('.cap-group').forEach((g) => { g.hidden = !!q; }); // hide headings while searching
  };
  const select = (key) => {
    capMaster.sel = key;
    store(`st.sel.${id}`, key);
    box.querySelectorAll('.cap-item').forEach((it) => it.classList.toggle('sel', it.dataset.key === key));
    renderCapPane();
  };
  paint();
  updateCapList();
  renderCapPane();

  $('#capSearch').addEventListener('input', applySearch);
  box.addEventListener('click', (ev) => {
    const item = ev.target.closest('.cap-item');
    if (!item) return;
    if (ev.target.closest('.pin')) {
      const k = item.dataset.key;
      capMaster.pins = capMaster.pins.includes(k) ? capMaster.pins.filter((x) => x !== k) : [...capMaster.pins, k];
      store(`st.pin.${id}`, capMaster.pins);
      paint();
      updateCapList();
      renderCapPane();
      return;
    }
    select(item.dataset.key);
  });
  box.addEventListener('keydown', (ev) => {
    const item = ev.target.closest('.cap-item');
    if (!item || ev.target.closest('.pin')) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(item.dataset.key); }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const vis = [...box.querySelectorAll('.cap-item:not([hidden])')];
      const next = vis[vis.indexOf(item) + (ev.key === 'ArrowDown' ? 1 : -1)];
      if (next) { next.focus(); select(next.dataset.key); }
    }
  });
  // clicking an entry of the summary line opens that capability
  $('#stateSummary').addEventListener('click', (ev) => {
    const it = ev.target.closest('.sum-item');
    if (it) { select(it.dataset.key); box.querySelector(`.cap-item[data-key="${CSS.escape(it.dataset.key)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  });
}

function capCard(comp, capId, version = 1) {
  const cap = getCapDef(capId, version) || {};
  const attrs = Object.keys(cap.attributes || {});
  return `
    <div class="cap" data-key="${esc(capKey(comp, capId))}">
      <div class="cap-head"><b>${esc(capId)}</b><span class="comp">${esc(comp)}${cap.name && cap.name !== capId ? ' · ' + esc(cap.name) : ''}</span></div>
      ${attrs.length ? attrs.map((a) => attrRow(comp, capId, version, a)).join('') : '<div class="attr-empty muted small">Capability without attributes (commands only)</div>'}
    </div>`;
}

function computeAttrOptsKey(comp, capId, version, attrName) {
  const capDef = getCapDef(capId, version);
  const capStatus = currentCapStatus(comp, capId);
  const s = valueSchema(capDef, attrName);
  const vOpts = s.type === 'string' ? valueOptions(capDef, capStatus, attrName) : null;
  if (vOpts) return JSON.stringify(vOpts);
  const lOpts = s.type === 'array' ? listOptions(capDef, capStatus, attrName) : null;
  if (lOpts) return JSON.stringify(lOpts);
  return '';
}

function attrRow(comp, capId, version, attrName) {
  const capDef = getCapDef(capId, version);
  const capStatus = currentCapStatus(comp, capId);
  const s = valueSchema(capDef, attrName);
  const cur = currentAttr(comp, capId, attrName);
  const curVal = cur?.value;
  const curUnit = cur?.unit;
  let ctrl = '';
  const vOpts = s.type === 'string' ? valueOptions(capDef, capStatus, attrName) : null;
  const lOpts = s.type === 'array' ? listOptions(capDef, capStatus, attrName) : null;
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
    const curArr = Array.isArray(curVal) ? curVal : [];
    ctrl = `<div class="checks">
        ${lOpts.map((v) => `<label class="check ${curArr.some((c) => c === v) ? 'on' : ''}"><input type="checkbox" data-j="${esc(JSON.stringify(v))}" ${curArr.some((c) => c === v) ? 'checked' : ''}/>${esc(v)}</label>`).join('')}
        <span class="add-item"><input type="text" class="newItem" placeholder="new value…" title="Type a value, then press Enter or click Add" /><button class="btn small addNew" title="Add this value to the list">Add</button></span>
      </div>
      <div class="check-actions">
        <button class="btn small selAll">All</button><button class="btn small selNone">None</button>
        <details class="json-edit"><summary class="muted small">Edit as JSON</summary><textarea class="inp" rows="2">${esc(JSON.stringify(curArr))}</textarea></details>
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
  const infoHtml = listHint(attrName);
  return `
    <div class="attr" data-comp="${esc(comp)}" data-cap="${esc(capId)}" data-ver="${esc(version)}" data-attr="${esc(attrName)}" data-type="${esc(s.type)}" data-opts="${esc(optsKey)}"${s.type === 'integer' || s.type === 'number' ? ` data-numeric-value="${esc(curVal ?? '')}"` : ''}>
      <div class="attr-top">
        <span class="attr-name">${esc(attrName)} <span class="range-hint">${esc(hint)}</span>${infoHtml ? ' <button type="button" class="info" title="What is this?" aria-label="What is this?">ⓘ</button>' : ''}</span>
        <span class="attr-cur"><span class="muted">current</span> <span class="val">${esc(fmtVal(curVal))}${curUnit ? ' ' + esc(curUnit) : ''}</span></span>
      </div>
      ${infoHtml ? `<div class="attr-hint" hidden>${infoHtml}</div>` : ''}
      <div class="attr-ctrl">${ctrl}<button class="btn small addStep" title="Add to scenario">＋</button></div>
    </div>`;
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
    try { sendEvents(state.selectedId, [readAttrEvent(row, chip.dataset.v)]); } catch (e) { toast(e.message, 'err'); }
  }));
  row.querySelector('.send')?.addEventListener('click', () => {
    try { sendEvents(state.selectedId, [readAttrEvent(row)]); } catch (e) { toast(e.message, 'err'); }
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

export function updateCurrentValues(flash) {
  document.querySelectorAll('#tabBody .attr[data-attr]').forEach((row) => {
    // Only rebuild a row when its computed option list actually changed (avoids reparsing HTML every 5s).
    const { comp, cap, ver, attr } = row.dataset;
    const version = Number(ver || 1);
    const nextOptsKey = computeAttrOptsKey(comp, cap, version, attr);
    if (nextOptsKey !== row.dataset.opts) {
      const fresh = document.createElement('div');
      fresh.innerHTML = attrRow(comp, cap, version, attr).trim();
      const next = fresh.firstElementChild;
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
    if (row.dataset.type === 'integer' || row.dataset.type === 'number') {
      const input = row.querySelector('input.inp');
      const range = row.querySelector('input.rng');
      const nextValue = cur?.value == null ? '' : String(cur.value);
      if (input && input.value === row.dataset.numericValue &&
          document.activeElement !== input && document.activeElement !== range) {
        input.value = nextValue;
        if (range && nextValue !== '') range.value = nextValue;
      }
      row.dataset.numericValue = nextValue;
    }
    row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('current', String(cur?.value) === c.dataset.v));
  });
  updateCapList();
}
