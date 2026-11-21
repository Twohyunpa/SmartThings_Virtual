// Presets & scenarios view with device-pinned, globally stoppable scenario execution.

import { state, actions, store, applicable, evText, stopActiveRun } from '../state.js';
import { $, esc, sleep, toast, sendEvents } from '../api.js';

function savedScenarios() {
  return store('st.scenarios') || [];
}

function syncRunButtons() {
  const running = !!state.activeRun && !state.activeRun.stop;
  const runBtn = $('#runDraft');
  const stopBtn = $('#stopRun');
  if (runBtn) runBtn.disabled = running || !state.draft.length;
  if (stopBtn) stopBtn.disabled = !running;
}

export function renderScenario(body) {
  const presets = state.presets.map((p) => ({ ...p, from: 'built-in preset' })).filter((p) => applicable(p.events));
  const saved = savedScenarios().map((s, i) => ({ ...s, idx: i })).filter((s) => s.steps.every((st) => applicable(st.events)));
  const running = !!state.activeRun && !state.activeRun.stop;

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
        <button class="btn primary small" id="runDraft" ${!running && state.draft.length ? '' : 'disabled'}>▶ Run</button>
        <label class="small"><input type="checkbox" id="loopChk" /> Loop</label>
        <button class="btn small" id="stopRun" ${running ? '' : 'disabled'}>■ Stop</button>
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

  const targetDeviceId = state.selectedId;
  body.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => sendEvents(targetDeviceId, presets[b.dataset.i].events)));
  wireSteps($('#draftSteps'));

  $('#runDraft').addEventListener('click', async () => {
    stopActiveRun();
    const run = { deviceId: targetDeviceId, stop: false };
    state.activeRun = run;
    syncRunButtons();
    try {
      do {
        await runSteps(targetDeviceId, state.draft, $('#draftSteps'), run);
      } while ($('#loopChk')?.checked && !run.stop && state.selectedId === targetDeviceId && state.tab === 'scenario');
    } finally {
      if (state.activeRun === run) state.activeRun = null;
      syncRunButtons();
    }
  });

  $('#stopRun').addEventListener('click', () => {
    stopActiveRun();
    syncRunButtons();
  });

  $('#saveDraft').addEventListener('click', () => {
    const name = $('#scName').value.trim() || `Scenario ${new Date().toLocaleString()}`;
    const all = savedScenarios();
    all.push({ name, steps: JSON.parse(JSON.stringify(state.draft)) });
    store('st.scenarios', all);
    toast(`Saved "${name}"`, 'ok');
    actions.renderTabBody();
  });

  $('#clearDraft').addEventListener('click', () => {
    state.draft = [];
    store(`st.draft.${state.selectedId}`, []);
    actions.renderTabBody();
  });

  $('#importBtn').addEventListener('click', () => {
    const txt = prompt('Scenario steps JSON (the current draft is pre-filled; paste and confirm to replace it)', JSON.stringify(state.draft));
    if (txt === null) return;
    try {
      const steps = JSON.parse(txt);
      if (!Array.isArray(steps) || !steps.every((s) => Array.isArray(s.events))) throw new Error('Expected the format [{ "events": [...], "delayMs": 1000 }]');
      state.draft = steps;
      store(`st.draft.${state.selectedId}`, steps);
      actions.renderTabBody();
    } catch (e) { toast(e.message, 'err'); }
  });

  body.querySelectorAll('.runSaved').forEach((b) => b.addEventListener('click', async () => {
    const s = savedScenarios()[b.dataset.idx];
    if (!s) return;
    stopActiveRun();
    const run = { deviceId: targetDeviceId, stop: false };
    state.activeRun = run;
    b.disabled = true;
    syncRunButtons();
    try {
      await runSteps(targetDeviceId, s.steps, null, run);
    } finally {
      if (state.activeRun === run) state.activeRun = null;
      b.disabled = false;
      syncRunButtons();
    }
  }));

  body.querySelectorAll('.editSaved').forEach((b) => b.addEventListener('click', () => {
    const s = savedScenarios()[b.dataset.idx];
    state.draft = JSON.parse(JSON.stringify(s.steps));
    store(`st.draft.${state.selectedId}`, state.draft);
    actions.renderTabBody();
    const nameEl = $('#scName');
    if (nameEl) nameEl.value = s.name;
  }));

  body.querySelectorAll('.delSaved').forEach((b) => b.addEventListener('click', () => {
    const all = savedScenarios();
    if (!confirm(`Delete scenario "${all[b.dataset.idx].name}"?`)) return;
    all.splice(b.dataset.idx, 1);
    store('st.scenarios', all);
    actions.renderTabBody();
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
      actions.renderTabBody();
    });
  });
}

async function runSteps(deviceId, steps, container, run) {
  const rows = container ? container.querySelectorAll('.step') : [];
  rows.forEach((r) => r.classList.remove('running', 'done', 'fail'));
  for (let i = 0; i < steps.length; i++) {
    if (run.stop || state.selectedId !== deviceId) { run.stop = true; break; }
    rows[i]?.classList.add('running');
    const ok = await sendEvents(deviceId, steps[i].events, { quiet: true });
    rows[i]?.classList.remove('running');
    rows[i]?.classList.add(ok ? 'done' : 'fail');
    if (!ok) { run.stop = true; break; }
    const delay = steps[i].delayMs ?? 0;
    if (delay && i < steps.length - 1) await sleep(delay);
  }
  toast(run.stop ? 'Scenario stopped' : 'Scenario finished', run.stop ? '' : 'ok');
}
