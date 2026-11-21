// DOM utilities, HTTP API wrapper, debounced CLI log refresh, and event injection.

import { state, actions, fmtVal } from './state.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  const box = $('#toasts');
  if (!box) return;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 3500);
}

let logRefreshTimer = null;
export function scheduleRefreshLog() {
  if (logRefreshTimer) return;
  logRefreshTimer = setTimeout(() => {
    logRefreshTimer = null;
    refreshLog();
  }, 150);
}

export async function refreshLog() {
  try {
    const res = await fetch('/api/log');
    const { data } = await res.json();
    const countEl = $('#logCount');
    const bodyEl = $('#logBody');
    if (!countEl || !bodyEl) return;
    countEl.textContent = data.length;
    bodyEl.innerHTML = data.map((e) => `
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

export async function api(method, url, body) {
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
  scheduleRefreshLog();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.command = data.command;
    throw err;
  }
  return data.data;
}

// Explicit deviceId prevents injecting into a newly selected device if the user switches mid-operation.
export async function sendEvents(deviceId, events, { quiet = false } = {}) {
  if (!deviceId) return false;
  try {
    const out = await api('POST', `/api/devices/${deviceId}/events`, { events });
    if (!quiet) {
      const changes = out?.output?.stateChanges;
      const summary = events.map((e) => `${e.capability}.${e.attribute} = ${fmtVal(e.value)}${e.unit ? ' ' + e.unit : ''}`).join('\n');
      toast(`Injected${changes ? ` (state changed: ${changes.join(', ')})` : ''}\n${summary}`, 'ok');
    }
    if (state.selectedId === deviceId) await actions.refreshStatus();
    return true;
  } catch (e) {
    toast(`Injection failed\n${e.message}`, 'err');
    return false;
  }
}
