// Account menu in the top bar: shows which SmartThings account the CLI is signed in to,
// and lets you log out, sign in, or switch to another account (log out + fresh browser login).

import { state, actions } from '../state.js';
import { $, esc, api, toast } from '../api.js';

const AUTH_TEXT = {
  login: 'Browser login (stored by the CLI)',
  'env-token': 'Personal access token (SMARTTHINGS_TOKEN)',
  'profile-token': 'Token in the CLI config.yaml',
  none: 'Not signed in',
};

let busy = false; // a sign-in is waiting on the browser

function accountName(a) {
  if (!a) return '';
  return a.organization?.name || a.locations?.[0]?.name || 'Signed in';
}

function renderButton() {
  const a = state.account;
  const dot = $('#accountDot');
  const label = $('#accountLabel');
  if (busy) {
    dot.className = 'dot busy';
    label.textContent = 'Waiting for browser sign-in…';
  } else if (!a) {
    dot.className = 'dot err';
    label.textContent = 'Account unknown';
  } else if (!a.signedIn) {
    dot.className = 'dot err';
    label.textContent = 'Not signed in';
  } else {
    dot.className = 'dot ok';
    label.textContent = accountName(a) + (a.auth === 'login' ? '' : ' · token');
  }
  $('#accountBtn').title = a?.signedIn ? `Signed in: ${accountName(a)} (profile "${a.profile}")` : 'SmartThings account';
}

function renderMenu() {
  const a = state.account;
  const menu = $('#accountMenu');
  if (busy) {
    menu.innerHTML = `
      <h4>Signing in…</h4>
      <p class="note">The CLI opened a SmartThings sign-in page in your default browser. Finish signing in there; this menu updates when it is done (the CLI waits up to 10 minutes).</p>
      <p class="note">If no page opened, check the terminal that runs this app.</p>`;
    return;
  }
  if (!a) {
    menu.innerHTML = '<p class="note">Could not read the account state. Is the local server running?</p>';
    return;
  }
  const locs = (a.locations || []).map((l) => esc(l.name)).join(', ') || '—';
  const rows = a.signedIn ? `
      <dt>Account</dt><dd>${esc(a.organization?.name || '—')}</dd>
      <dt>Locations</dt><dd>${locs}</dd>` : '';
  let actionsHtml = '';
  let note = '';
  if (a.auth === 'login') {
    actionsHtml = `
      <button class="btn small primary" id="acctSwitch">Switch account</button>
      <button class="btn small danger" id="acctLogout">Log out</button>`;
  } else if (a.auth === 'none') {
    actionsHtml = '<button class="btn small primary" id="acctLogin">Sign in</button>';
    note = '<p class="note">Sign in opens the SmartThings login page in your browser.</p>';
  } else if (a.auth === 'env-token') {
    note = '<p class="note">This app was started with the <code>SMARTTHINGS_TOKEN</code> environment variable, so the token decides the account. To use another account, restart the app with a different token, or without one to use browser login.</p>';
  } else if (a.auth === 'profile-token') {
    note = `<p class="note">Profile "${esc(a.profile)}" has a token in the CLI <code>config.yaml</code>, so the token decides the account. Pick another profile or remove the token from config.yaml to use browser login.</p>`;
  }
  menu.innerHTML = `
    <h4>SmartThings account</h4>
    <dl>
      <dt>Status</dt><dd>${a.signedIn ? 'Signed in' : 'Not signed in'}</dd>
      ${rows}
      ${a.signedIn ? `<dt>Sign-in</dt><dd>${esc(AUTH_TEXT[a.auth] || a.auth)}</dd>` : ''}
      <dt>CLI profile</dt><dd>${esc(a.profile)}</dd>
    </dl>
    <div class="acct-actions">${actionsHtml}</div>
    ${note}
    ${a.error ? `<p class="note warn">${esc(a.error)}</p>` : ''}`;
  $('#acctSwitch')?.addEventListener('click', switchAccount);
  $('#acctLogout')?.addEventListener('click', logout);
  $('#acctLogin')?.addEventListener('click', () => signIn());
}

function render() {
  renderButton();
  renderMenu();
}

export async function loadAccount() {
  try {
    state.account = await api('GET', '/api/account');
  } catch (e) {
    state.account = null;
    toast(`Could not read the account\n${e.message}`, 'err');
  }
  render();
  return state.account;
}

async function doLogout() {
  await api('POST', '/api/account/logout');
  state.account = { ...state.account, signedIn: false, auth: 'none', organization: null, locations: [] };
  render();
  actions.onSignedOut();
}

async function logout() {
  if (!confirm('Log out of SmartThings?\n\nThe CLI forgets its stored login for this profile. Your virtual devices are not changed.')) return;
  try {
    await doLogout();
    toast('Logged out', 'ok');
  } catch (e) { toast(`Log out failed\n${e.message}`, 'err'); }
}

export async function signIn() {
  if (busy) return;
  busy = true;
  render();
  actions.onSigningIn();
  try {
    state.account = await api('POST', '/api/account/login');
    busy = false;
    render();
    toast(`Signed in: ${accountName(state.account)}`, 'ok');
    actions.onSignedIn();
  } catch (e) {
    busy = false;
    await loadAccount();
    toast(e.message, 'err');
    if (!state.account?.signedIn) actions.onSignedOut();
    else actions.onSignedIn();
  }
}

async function switchAccount() {
  const ok = confirm('Switch to another SmartThings account?\n\n'
    + 'This logs out, then opens the SmartThings sign-in page in your browser.\n\n'
    + 'Tip: if the browser signs you straight back in to the same account, sign out of your Samsung account on that page (or at account.samsung.com) and try again.');
  if (!ok) return;
  try {
    await doLogout();
  } catch (e) {
    toast(`Switch failed\n${e.message}`, 'err');
    return;
  }
  await signIn();
}

export function initAccountMenu() {
  const btn = $('#accountBtn');
  const menu = $('#accountMenu');
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.account')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  render();
}

export const isSigningIn = () => busy;
