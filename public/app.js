'use strict';

// ================= 상태 =================
const state = {
  locations: [],
  devices: [],
  templates: [],
  selectedId: null,
  device: null,       // devices <id> 결과
  status: null,       // devices:status 결과
  caps: {},           // capabilityId -> 정의
  tab: 'control',
  autoRefresh: false,
  autoTimer: null,
  draft: [],          // 시나리오 작성 중인 단계
};

const PROTOTYPES = [
  ['VIRTUAL_SWITCH', '스위치'], ['VIRTUAL_DIMMER_SWITCH', '디머 스위치'], ['VIRTUAL_BUTTON', '버튼'],
  ['VIRTUAL_CAMERA', '카메라'], ['VIRTUAL_COLOR_BULB', '컬러 전구'], ['VIRTUAL_CONTACT_SENSOR', '문열림 센서'],
  ['VIRTUAL_DIMMER', '디머(스위치 없음)'], ['VIRTUAL_GARAGE_DOOR_OPENER', '차고문'], ['VIRTUAL_LOCK', '도어락'],
  ['VIRTUAL_METERED_SWITCH', '전력측정 스위치'], ['VIRTUAL_MOTION_SENSOR', '모션 센서'], ['VIRTUAL_MULTI_SENSOR', '멀티 센서'],
  ['VIRTUAL_PRESENCE_SENSOR', '재실 센서'], ['VIRTUAL_REFRIGERATOR', '냉장고'], ['VIRTUAL_RGBW_BULB', 'RGBW 전구'],
  ['VIRTUAL_SIREN', '사이렌'], ['VIRTUAL_THERMOSTAT', '온도조절기'],
];

// ================= 유틸 =================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtVal = (v) => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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
    case 'integer': { const n = parseInt(raw, 10); if (Number.isNaN(n)) throw new Error('정수를 입력하세요'); return n; }
    case 'number': { const n = parseFloat(raw); if (Number.isNaN(n)) throw new Error('숫자를 입력하세요'); return n; }
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
  };
}

// ================= 상단 / 로그 =================
async function loadInfo() {
  const badge = $('#cliBadge');
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    $('#profileInput').value = info.profile;
    if (info.version) {
      badge.className = 'badge ok';
      badge.textContent = 'CLI ' + info.version.split(' ')[0].replace('@smartthings/cli/', '') + (info.tokenFromEnv ? ' · 토큰' : '');
      badge.title = info.version;
    } else {
      badge.className = 'badge err';
      badge.textContent = 'CLI 없음';
      badge.title = info.error || '';
      toast(info.error || 'SmartThings CLI를 실행할 수 없습니다', 'err');
    }
  } catch (e) {
    badge.className = 'badge err';
    badge.textContent = '서버 연결 실패';
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
        <span class="cmd" title="클릭하면 복사">${esc(e.command)}</span>
        <span class="muted">${e.ms}ms</span>
        ${e.input !== undefined ? `<details class="inp"><summary class="muted small">input.json</summary><pre class="json">${esc(JSON.stringify(e.input, null, 2))}</pre></details>` : ''}
        ${e.error ? `<span class="err">${esc(e.error)}</span>` : ''}
      </div>`).join('') || '<div class="muted pad">아직 실행한 명령이 없습니다.</div>';
  } catch { /* ignore */ }
}

$('#logBody').addEventListener('click', (e) => {
  const cmd = e.target.closest('.cmd');
  if (cmd) navigator.clipboard?.writeText(cmd.textContent).then(() => toast('명령을 복사했습니다'));
});
$('#logToggle').addEventListener('click', () => {
  const d = $('#logDrawer');
  d.classList.toggle('collapsed');
  $('#logToggle').firstChild.textContent = d.classList.contains('collapsed') ? '▲ CLI 명령 로그 ' : '▼ CLI 명령 로그 ';
});
$('#logClear').addEventListener('click', async () => { await fetch('/api/log', { method: 'DELETE' }); refreshLog(); });

$('#profileApply').addEventListener('click', async () => {
  try {
    await api('POST', '/api/profile', { profile: $('#profileInput').value.trim() });
    state.caps = {};
    toast(`프로필을 "${$('#profileInput').value.trim()}"(으)로 바꿨습니다`, 'ok');
    await Promise.all([loadLocations(), loadDevices()]);
  } catch (e) { toast(e.message, 'err'); }
});

// ================= 위치 / 기기 목록 =================
async function loadLocations() {
  try {
    state.locations = (await api('GET', '/api/locations')) || [];
  } catch (e) {
    state.locations = [];
    toast(`위치를 불러오지 못했습니다\n${e.message}`, 'err');
  }
  const sel = $('#locationFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">모든 위치</option>' +
    state.locations.map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)}</option>`).join('');
  sel.value = cur;
}

async function loadDevices() {
  const list = $('#deviceList');
  list.innerHTML = '<div class="muted pad"><span class="spinner"></span> 불러오는 중…</div>';
  const loc = $('#locationFilter').value;
  try {
    state.devices = (await api('GET', '/api/devices' + (loc ? `?location=${encodeURIComponent(loc)}` : ''))) || [];
  } catch (e) {
    state.devices = [];
    list.innerHTML = `<div class="muted pad">기기 목록을 불러오지 못했습니다.<br><span class="small">${esc(e.message)}</span></div>`;
    return;
  }
  renderDeviceList();
}

function renderDeviceList() {
  const list = $('#deviceList');
  if (!state.devices.length) {
    list.innerHTML = '<div class="muted pad">가상 기기가 없습니다. 위 버튼으로 만들어 보세요.</div>';
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

// ================= 기기 만들기 =================
let createState = { mode: 'template', templateId: null };

async function renderCreate() {
  if (!state.templates.length) {
    try { state.templates = await api('GET', '/api/templates'); } catch { state.templates = []; }
  }
  const main = $('#main');
  const locOpts = state.locations.map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)}</option>`).join('');
  main.innerHTML = `
    <div class="dev-head"><div><h2>가상 기기 만들기</h2><div class="muted small">결과는 SmartThings 앱의 선택한 위치에 실제로 추가됩니다.</div></div></div>
    <div class="tabs">
      <button class="tab ${createState.mode === 'template' ? 'active' : ''}" data-mode="template">삼성 가전 템플릿</button>
      <button class="tab ${createState.mode === 'standard' ? 'active' : ''}" data-mode="standard">표준 프로토타입</button>
      <button class="tab ${createState.mode === 'profileId' ? 'active' : ''}" data-mode="profileId">디바이스 프로필 ID</button>
      <button class="tab ${createState.mode === 'json' ? 'active' : ''}" data-mode="json">프로필 JSON 직접 입력</button>
    </div>
    <div class="panel">
      <div id="modeArea"></div>
      <div class="form" style="margin-top:14px">
        <label for="cName">기기 이름</label><input id="cName" placeholder="예: 테스트 세탁기 1" />
        <label for="cLoc">위치</label><select id="cLoc">${locOpts || '<option value="">(위치 없음 — CLI 로그인 확인)</option>'}</select>
        <label for="cRoom">방 (선택)</label><select id="cRoom"><option value="">선택 안 함</option></select>
        <label></label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="cSubmit" class="btn primary">만들기</button>
          <button id="cDry" class="btn">dry-run (요청 JSON 미리보기)</button>
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
    roomSel.innerHTML = '<option value="">선택 안 함</option>';
    if (!locSel.value) return;
    try {
      const rooms = (await api('GET', `/api/locations/${locSel.value}/rooms`)) || [];
      roomSel.innerHTML += rooms.map((r) => `<option value="${esc(r.roomId)}">${esc(r.name)}</option>`).join('');
    } catch { /* 방 없이도 생성 가능 */ }
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
    area.innerHTML = `
      <div class="tpl-grid">${state.templates.map((x) => `
        <button class="tpl ${x.id === createState.templateId ? 'active' : ''}" data-id="${esc(x.id)}">
          <span class="ic">${esc(x.icon || '▢')}</span><span class="nm">${esc(x.name)}</span><span class="ds">${esc(x.description)}</span>
        </button>`).join('')}</div>
      ${t?.deviceProfile ? `<details><summary class="muted small">프로필 정의 보기/수정 (capability 추가·삭제 가능)</summary>
        <textarea id="tplJson" rows="12" style="margin-top:8px">${esc(JSON.stringify(t.deviceProfile, null, 2))}</textarea></details>`
        : t ? `<div class="muted small">표준 프로토타입 <code>${esc(t.prototype)}</code> 로 생성합니다.</div>` : ''}`;
    area.querySelectorAll('.tpl').forEach((b) => b.addEventListener('click', () => {
      createState.templateId = b.dataset.id;
      renderModeArea();
      const tt = state.templates.find((x) => x.id === b.dataset.id);
      const nameEl = $('#cName');
      if (nameEl && (!nameEl.value || nameEl.dataset.auto)) { nameEl.value = `가상 ${tt.name.replace(/\s*\(.*\)/, '')}`; nameEl.dataset.auto = '1'; }
    }));
  } else if (m === 'standard') {
    area.innerHTML = `<div class="form"><label for="cProto">프로토타입</label>
      <select id="cProto">${PROTOTYPES.map(([id, nm]) => `<option value="${id}">${nm} — ${id}</option>`).join('')}</select></div>`;
  } else if (m === 'profileId') {
    area.innerHTML = `<div class="form"><label for="cProfile">디바이스 프로필</label>
      <div style="display:flex;gap:6px"><select id="cProfile"><option value="">불러오는 중…</option></select>
      <input id="cProfileId" placeholder="또는 UUID 직접 입력" /></div></div>`;
    api('GET', '/api/deviceprofiles').then((list) => {
      $('#cProfile').innerHTML = '<option value="">선택…</option>' +
        (list || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.status || '')})</option>`).join('');
    }).catch((e) => { $('#cProfile').innerHTML = `<option value="">목록 실패: ${esc(e.message)}</option>`; });
  } else {
    area.innerHTML = `<div class="muted small" style="margin-bottom:6px">virtualdevices:create 의 <code>deviceProfile</code> 필드에 들어갈 정의</div>
      <textarea id="cJson" rows="14">${esc(JSON.stringify({
        name: 'My Virtual Profile',
        components: [{ id: 'main', capabilities: [{ id: 'switch', version: 1 }, { id: 'temperatureMeasurement', version: 1 }], categories: [{ name: 'Switch' }] }],
      }, null, 2))}</textarea>`;
  }
}

async function submitCreate(dryRun) {
  const name = $('#cName').value.trim();
  const locationId = $('#cLoc').value;
  const roomId = $('#cRoom').value || undefined;
  if (!name) return toast('기기 이름을 입력하세요', 'err');
  if (!locationId) return toast('위치를 선택하세요', 'err');
  store('st.lastLocation', locationId);

  let url; let body;
  try {
    const m = createState.mode;
    if (m === 'template') {
      const t = state.templates.find((x) => x.id === createState.templateId);
      if (!t) throw new Error('템플릿을 선택하세요');
      if (t.prototype) { url = '/api/devices/standard'; body = { name, locationId, roomId, prototype: t.prototype }; }
      else {
        const txt = $('#tplJson')?.value;
        url = '/api/devices/profile';
        body = { name, locationId, roomId, deviceProfile: txt ? JSON.parse(txt) : t.deviceProfile };
      }
    } else if (m === 'standard') {
      url = '/api/devices/standard'; body = { name, locationId, roomId, prototype: $('#cProto').value };
    } else if (m === 'profileId') {
      const id = $('#cProfileId').value.trim() || $('#cProfile').value;
      if (!id) throw new Error('디바이스 프로필을 선택하거나 UUID를 입력하세요');
      url = '/api/devices/profile'; body = { name, locationId, roomId, deviceProfileId: id };
    } else {
      url = '/api/devices/profile'; body = { name, locationId, roomId, deviceProfile: JSON.parse($('#cJson').value) };
    }
  } catch (e) { return toast(e.message, 'err'); }

  body.dryRun = dryRun;
  const btn = dryRun ? $('#cDry') : $('#cSubmit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> 실행 중…';
  try {
    const out = await api('POST', url, body);
    const pre = $('#cResult');
    pre.style.display = 'block';
    pre.textContent = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    if (!dryRun) {
      toast(`"${name}" 을(를) 만들었습니다`, 'ok');
      await loadDevices();
      const id = out?.deviceId;
      if (id) selectDevice(id);
    }
  } catch (e) {
    toast(`생성 실패\n${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ================= 기기 상세 =================
async function selectDevice(id) {
  stopAuto();
  if (state.selectedId !== id) state.tab = 'control';
  state.selectedId = id;
  state.device = null;
  state.status = null;
  state.draft = store(`st.draft.${id}`) || [];
  renderDeviceList();
  $('#main').innerHTML = '<div class="muted"><span class="spinner"></span> 기기 정보를 불러오는 중…</div>';
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
    $('#main').innerHTML = `<div class="panel"><h3>기기를 불러오지 못했습니다</h3><pre class="json">${esc(e.message)}</pre></div>`;
  }
}

async function refreshStatus(flash = true) {
  if (!state.selectedId) return;
  const before = JSON.stringify(state.status);
  try {
    state.status = await api('GET', `/api/devices/${state.selectedId}/status`);
  } catch (e) { toast(`상태 조회 실패\n${e.message}`, 'err'); return; }
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
        <button class="btn small" id="copyId">ID 복사</button>
        <button class="btn small" id="renameBtn">이름 변경</button>
        <button class="btn small danger" id="deleteBtn">삭제</button>
      </div>
    </div>
    <div class="tabs">
      <button class="tab" data-tab="control">상태 &amp; 주입</button>
      <button class="tab" data-tab="scenario">프리셋 &amp; 시나리오</button>
      <button class="tab" data-tab="raw">원본 JSON</button>
    </div>
    <div id="tabBody"></div>`;

  $('#copyId').addEventListener('click', () => navigator.clipboard?.writeText(d.deviceId).then(() => toast('ID를 복사했습니다')));
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
  const label = prompt('새 기기 이름', state.device.label || state.device.name);
  if (!label) return;
  try {
    await api('PATCH', `/api/devices/${state.selectedId}`, { label });
    state.device.label = label;
    $('#devLabel').textContent = label;
    toast('이름을 바꿨습니다', 'ok');
    loadDevices();
  } catch (e) { toast(`이름 변경 실패\n${e.message}`, 'err'); }
}

async function deleteDevice() {
  const nm = state.device.label || state.device.name;
  if (!confirm(`"${nm}" 가상 기기를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await api('DELETE', `/api/devices/${state.selectedId}`);
    toast(`"${nm}" 을(를) 삭제했습니다`, 'ok');
    state.selectedId = null;
    $('#main').innerHTML = '';
    $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
    loadDevices();
  } catch (e) { toast(`삭제 실패\n${e.message}`, 'err'); }
}

// ---------- 상태 & 주입 ----------
function currentAttr(comp, cap, attr) {
  return state.status?.components?.[comp]?.[cap]?.[attr];
}

function renderControl(body) {
  const d = state.device;
  const comps = d.components || [];
  body.innerHTML = `
    <div class="toolbar">
      <button class="btn small" id="reloadStatus">↻ 상태 새로고침</button>
      <label class="small"><input type="checkbox" id="autoChk" ${state.autoRefresh ? 'checked' : ''}/> 5초마다 자동 새로고침</label>
      <span class="muted small">값을 고르면 바로 주입하거나(칩), 입력 후 <b>주입</b>을 누르세요. <b>＋</b>는 시나리오에 단계로 추가합니다.</span>
    </div>
    <div class="cap-grid">
      ${comps.flatMap((c) => (c.capabilities || []).map((cap) => capCard(c.id, cap.id))).join('')}
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>직접 입력</h3>
      <div class="attr-ctrl">
        <input id="mComp" value="main" style="width:90px" placeholder="component" />
        <input id="mCap" placeholder="capability" style="width:180px" />
        <input id="mAttr" placeholder="attribute" style="width:150px" />
        <input id="mVal" placeholder="value (JSON 가능)" type="text" />
        <input id="mUnit" placeholder="unit" style="width:70px" />
        <button class="btn primary small" id="mSend">주입</button>
      </div>
      <div class="muted small" style="margin-top:6px">값은 JSON으로 해석을 시도하고(숫자, true, {...}), 실패하면 문자열로 보냅니다.</div>
    </div>`;

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
    if (!ev.capability || !ev.attribute) return toast('capability 와 attribute 를 입력하세요', 'err');
    sendEvents([ev]);
  });

  body.querySelectorAll('.attr[data-attr]').forEach(wireAttr);
}

function capCard(comp, capId) {
  const cap = state.caps[capId] || {};
  const attrs = Object.keys(cap.attributes || {});
  return `
    <div class="cap">
      <div class="cap-head"><b>${esc(capId)}</b><span class="comp">${esc(comp)}${cap.name && cap.name !== capId ? ' · ' + esc(cap.name) : ''}</span></div>
      ${attrs.length ? attrs.map((a) => attrRow(comp, capId, a)).join('') : '<div class="attr-empty muted small">속성이 없는 capability (명령 전용)</div>'}
    </div>`;
}

function attrRow(comp, capId, attrName) {
  const s = valueSchema(capId, attrName);
  const cur = currentAttr(comp, capId, attrName);
  const curVal = cur?.value;
  const curUnit = cur?.unit;
  let ctrl = '';
  if (s.enum) {
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
      <button class="btn primary small send">주입</button>`;
  } else if (s.type === 'array' || s.type === 'object') {
    ctrl = `<textarea class="inp" rows="2">${esc(curVal !== undefined ? JSON.stringify(curVal) : (s.type === 'array' ? '[]' : '{}'))}</textarea>
      <button class="btn primary small send">주입</button>`;
  } else {
    ctrl = `<input type="text" class="inp" value="${esc(curVal ?? '')}" />
      ${s.units ? `<select class="unit">${s.units.map((u) => `<option>${esc(u)}</option>`).join('')}</select>` : ''}
      <button class="btn primary small send">주입</button>`;
  }
  const hint = [s.type, s.min !== undefined ? `min ${s.min}` : '', s.max !== undefined ? `max ${s.max}` : ''].filter(Boolean).join(' · ');
  return `
    <div class="attr" data-comp="${esc(comp)}" data-cap="${esc(capId)}" data-attr="${esc(attrName)}" data-type="${esc(s.type)}">
      <div class="attr-top">
        <span class="attr-name">${esc(attrName)} <span class="range-hint">${esc(hint)}</span></span>
        <span class="attr-cur"><span class="muted">현재</span> <span class="val">${esc(fmtVal(curVal))}${curUnit ? ' ' + esc(curUnit) : ''}</span></span>
      </div>
      <div class="attr-ctrl">${ctrl}<button class="btn small addStep" title="시나리오에 추가">＋</button></div>
    </div>`;
}

function readAttrEvent(row, chipValue) {
  const { comp, cap, attr, type } = row.dataset;
  const raw = chipValue !== undefined ? chipValue : row.querySelector('.inp')?.value;
  if (raw === undefined || raw === '') throw new Error(`${attr}: 값을 입력하세요`);
  const ev = { component: comp, capability: cap, attribute: attr, value: convertValue(raw, type) };
  const unit = row.querySelector('select.unit')?.value;
  if (unit) ev.unit = unit;
  return ev;
}

function wireAttr(row) {
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
  row.querySelector('.addStep').addEventListener('click', () => {
    let ev;
    if (row.querySelector('.chip')) {
      const v = prompt(`시나리오에 추가할 ${row.dataset.attr} 값`, row.querySelector('.chip.current')?.dataset.v || row.querySelector('.chip').dataset.v);
      if (v === null) return;
      try { ev = readAttrEvent(row, v); } catch (e) { return toast(e.message, 'err'); }
    } else {
      try { ev = readAttrEvent(row); } catch (e) { return toast(e.message, 'err'); }
    }
    state.draft.push({ events: [ev], delayMs: 1000 });
    store(`st.draft.${state.selectedId}`, state.draft);
    toast(`시나리오에 단계 추가: ${ev.capability}.${ev.attribute} = ${fmtVal(ev.value)} (총 ${state.draft.length}단계)`, 'ok');
  });
}

function updateCurrentValues(flash) {
  document.querySelectorAll('#tabBody .attr[data-attr]').forEach((row) => {
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
      toast(`주입 완료${changes ? ` (상태변경: ${changes.join(', ')})` : ''}\n${summary}`, 'ok');
    }
    if (state.selectedId === id) await refreshStatus();
    return true;
  } catch (e) {
    toast(`주입 실패\n${e.message}`, 'err');
    return false;
  }
}

// ---------- 프리셋 & 시나리오 ----------
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
  const presets = state.templates.flatMap((t) => (t.presets || []).map((p) => ({ ...p, from: t.name }))).filter((p) => applicable(p.events));
  const saved = savedScenarios().map((s, i) => ({ ...s, idx: i })).filter((s) => s.steps.every((st) => applicable(st.events)));

  body.innerHTML = `
    <div class="panel">
      <h3>빠른 프리셋 <span class="muted small">이 기기의 capability와 맞는 템플릿 프리셋</span></h3>
      ${presets.length ? `<div class="preset-row">${presets.map((p, i) => `<button class="btn small preset" data-i="${i}" title="${esc(p.from + '\n' + p.events.map(evText).join('\n'))}">${esc(p.label)}</button>`).join('')}</div>`
        : '<div class="muted small">맞는 프리셋이 없습니다. 아래 시나리오를 직접 만들어 보세요.</div>'}
    </div>

    <div class="panel">
      <h3>시나리오 작성 <span class="muted small">상태 &amp; 주입 탭의 ＋ 버튼으로 단계를 추가합니다</span></h3>
      <div id="draftSteps">${renderSteps(state.draft, true)}</div>
      <div class="toolbar" style="margin:10px 0 0">
        <button class="btn primary small" id="runDraft" ${state.draft.length ? '' : 'disabled'}>▶ 실행</button>
        <label class="small"><input type="checkbox" id="loopChk" /> 반복</label>
        <button class="btn small" id="stopRun" disabled>■ 정지</button>
        <input id="scName" placeholder="시나리오 이름" style="width:180px" />
        <button class="btn small" id="saveDraft" ${state.draft.length ? '' : 'disabled'}>저장</button>
        <button class="btn small" id="clearDraft" ${state.draft.length ? '' : 'disabled'}>비우기</button>
        <button class="btn small" id="importBtn">JSON 가져오기/내보내기</button>
      </div>
    </div>

    <div class="panel">
      <h3>저장된 시나리오</h3>
      ${saved.length ? saved.map((s) => `
        <div class="scenario">
          <div class="scenario-head"><b>${esc(s.name)}</b>
            <span><button class="btn small runSaved" data-idx="${s.idx}">▶ 실행</button>
            <button class="btn small editSaved" data-idx="${s.idx}">편집</button>
            <button class="btn small danger delSaved" data-idx="${s.idx}">삭제</button></span></div>
          <div class="muted small">${s.steps.length}단계 · ${esc(s.steps.map((st) => st.events.map(evText).join(', ')).join(' → '))}</div>
        </div>`).join('') : '<div class="muted small">저장된 시나리오가 없습니다. (브라우저에 저장됩니다)</div>'}
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
    const name = $('#scName').value.trim() || `시나리오 ${new Date().toLocaleString()}`;
    const all = savedScenarios();
    all.push({ name, steps: JSON.parse(JSON.stringify(state.draft)) });
    store('st.scenarios', all);
    toast(`"${name}" 저장됨`, 'ok');
    renderTabBody();
  });
  $('#clearDraft').addEventListener('click', () => { state.draft = []; store(`st.draft.${state.selectedId}`, []); renderTabBody(); });
  $('#importBtn').addEventListener('click', () => {
    const txt = prompt('시나리오 단계 JSON (현재 작성 중인 내용이 들어 있습니다. 붙여넣고 확인하면 교체됩니다)', JSON.stringify(state.draft));
    if (txt === null) return;
    try {
      const steps = JSON.parse(txt);
      if (!Array.isArray(steps) || !steps.every((s) => Array.isArray(s.events))) throw new Error('[{ "events": [...], "delayMs": 1000 }] 형식이어야 합니다');
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
    if (!confirm(`"${all[b.dataset.idx].name}" 시나리오를 삭제할까요?`)) return;
    all.splice(b.dataset.idx, 1);
    store('st.scenarios', all);
    renderTabBody();
  }));
}

function renderSteps(steps, editable) {
  if (!steps.length) return '<div class="muted small">단계가 없습니다.</div>';
  return steps.map((s, i) => `
    <div class="step" data-i="${i}">
      <span class="muted">${i + 1}</span>
      <span class="ev">${esc(s.events.map(evText).join(', '))}</span>
      ${editable ? `<input type="number" class="delay" min="0" step="100" value="${s.delayMs ?? 1000}" title="이 단계 후 대기(ms)" />` : `<span class="muted small">${s.delayMs ?? 0}ms</span>`}
      ${editable ? '<button class="btn small ghost rm" title="삭제">✕</button>' : '<span></span>'}
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
  toast(flag.stop ? '시나리오를 멈췄습니다' : '시나리오 실행 완료', flag.stop ? '' : 'ok');
}

// ================= 시작 =================
(async function init() {
  $('#main').appendChild($('#welcomeTpl').content.cloneNode(true));
  await loadInfo();
  refreshLog();
  api('GET', '/api/templates').then((t) => { state.templates = t; }).catch(() => {});
  await loadLocations();
  await loadDevices();
})();
