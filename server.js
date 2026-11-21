#!/usr/bin/env node
// SmartThings Virtual Device GUI - local server
// Wraps the SmartThings CLI (`smartthings`) so you can create virtual devices and inject states (events) from a browser UI.
// No external dependencies. Node 18+.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3700);
const HOST = process.env.HOST || '127.0.0.1';
const NO_OPEN = process.argv.includes('--no-open') || !!process.env.ST_NO_OPEN;
const USE_MOCK = process.argv.includes('--mock'); // select the mock CLI with an argument (works on Windows too)
const CLI = USE_MOCK ? path.join(__dirname, 'mock', 'smartthings-mock.js') : (process.env.ST_CLI || 'smartthings');
const CLI_TIMEOUT_MS = Number(process.env.ST_CLI_TIMEOUT_MS || 120000);
const CLI_CONCURRENCY = Math.max(1, Number(process.env.ST_CLI_CONCURRENCY || 5));
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const TEMPLATES_FILE = path.join(__dirname, 'templates', 'samsung-appliances.json');
const PRESETS_FILE = path.join(__dirname, 'templates', 'presets.json');

let currentProfile = process.env.ST_PROFILE || 'default';
let profileEpoch = 0; // incremented on profile switch so in-flight calls don't pollute new profile caches
let cliMajor = null; // detected CLI major version (1.x is oclif-based; 2.x+ is yargs-based and some arguments differ)
const commandLog = []; // recently executed CLI commands
const capabilityCache = new Map();
const capabilityInflight = new Map();
const staticJsonCache = new Map();

// Concurrency limiter for spawning SmartThings CLI subprocesses
let activeCliCount = 0;
const cliWaitQueue = [];
function acquireCliSlot() {
  if (activeCliCount < CLI_CONCURRENCY) {
    activeCliCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => cliWaitQueue.push(resolve));
}
function releaseCliSlot() {
  const next = cliWaitQueue.shift();
  if (next) next();
  else activeCliCount = Math.max(0, activeCliCount - 1);
}

// ---------- CLI execution ----------

function quoteForDisplay(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function quoteForWindowsShell(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

async function runCli(args, { json = true, api = true, input, inputFile } = {}) {
  const fullArgs = [...args];
  if (json) fullArgs.push('--json');
  if (api && currentProfile && currentProfile !== 'default') fullArgs.push('--profile', currentProfile);
  // The token is never shown in the UI or the log.
  // CLI 2.x+ reads SMARTTHINGS_TOKEN itself, so only pass --token to 1.x.
  const tokenArgs = api && process.env.SMARTTHINGS_TOKEN && cliMajor === 1 ? ['--token', process.env.SMARTTHINGS_TOKEN] : [];

  let cmd = CLI;
  let cmdArgs = [...fullArgs, ...tokenArgs];
  let shell = false;
  if (CLI.endsWith('.js')) {
    cmd = process.execPath;
    cmdArgs = [CLI, ...cmdArgs];
  } else if (process.platform === 'win32') {
    shell = true;
    cmdArgs = cmdArgs.map(quoteForWindowsShell);
  }

  const display = ['smartthings', ...fullArgs].map((a) => (a === inputFile ? 'input.json' : a)).map(quoteForDisplay).join(' ');

  await acquireCliSlot();
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      releaseCliSlot();
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, cmdArgs, { shell, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      const entry = { command: display, input, ok: false, ms: 0, error: err.message, at: new Date().toISOString() };
      pushLog(entry);
      return finish({ ok: false, error: err.message, command: display });
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      const msg = err.code === 'ENOENT'
        ? `SmartThings CLI not found ("${CLI}"). Install it with npm i -g @smartthings/cli or set the ST_CLI environment variable to its path.`
        : err.message;
      pushLog({ command: display, input, ok: false, ms: Date.now() - started, error: msg, at: new Date().toISOString() });
      finish({ ok: false, error: msg, command: display });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        const msg = cleanError(stderr || stdout) || `exit code ${code}`;
        pushLog({ command: display, input, ok: false, ms, error: msg, at: new Date().toISOString() });
        return finish({ ok: false, error: msg, command: display });
      }
      let data = stdout;
      if (json) {
        const trimmed = stdout.trim();
        try {
          data = trimmed ? JSON.parse(trimmed) : null;
        } catch {
          // in case a warning is printed before the JSON
          const i = trimmed.search(/[[{]/);
          try { data = i >= 0 ? JSON.parse(trimmed.slice(i)) : trimmed; } catch { data = trimmed; }
        }
      }
      pushLog({ command: display, input, ok: true, ms, at: new Date().toISOString() });
      finish({ ok: true, data, command: display, stderr: stderr.trim() || undefined });
    });
  });
}

function cleanError(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('at ') && !/^›?\s*$/.test(l))
    .slice(0, 8)
    .join('\n');
}

function pushLog(entry) {
  if (entry.ok === false) console.error(`[cli failed] ${entry.command}\n  ${String(entry.error || '').split('\n').join('\n  ')}`);
  commandLog.unshift(entry);
  if (commandLog.length > 200) commandLog.length = 200;
}

// Write the input JSON to a temp file and pass it as `--input <file>`. The log shows it as input.json with its contents.
async function runWithInput(args, obj, opts = {}) {
  const file = path.join(os.tmpdir(), `st-gui-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  try {
    return await runCli(args.map((a) => (a === '@INPUT' ? file : a)), { ...opts, input: obj, inputFile: file });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

function loadJsonCached(filePath) {
  if (!staticJsonCache.has(filePath)) {
    staticJsonCache.set(filePath, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return staticJsonCache.get(filePath);
}

// ---------- HTTP helpers ----------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function sendCli(res, result) {
  if (result.ok) send(res, 200, { data: result.data, command: result.command });
  else send(res, 502, { error: result.error, command: result.command });
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        req.destroy();
        reject(httpError(413, 'Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (!total) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

const UUID = /^[0-9a-fA-F-]{8,64}$/;
const SAFE_ID = /^[\w.\-]{1,128}$/;
function assertId(v, name = 'id') {
  if (!v || !UUID.test(v)) throw httpError(400, `Invalid ${name}`);
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (decoded.includes('\0')) return send(res, 400, { error: 'bad request' });
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- API ----------

let cliInfo = null;
async function detectCli(force = false) {
  if (cliInfo && !force) return cliInfo;
  const r = await runCli(['--version'], { json: false, api: false });
  const version = r.ok ? String(r.data).trim() : null;
  const m = version && version.match(/(?:^|\/)(\d+)\.\d+\.\d+/);
  cliMajor = m ? Number(m[1]) : null;
  cliInfo = { version, error: r.ok ? undefined : r.error };
  return cliInfo;
}

async function getCapability(id, version = 1) {
  const key = `${id}@${version}`;
  if (capabilityCache.has(key)) return { ok: true, data: capabilityCache.get(key) };
  if (capabilityInflight.has(key)) return capabilityInflight.get(key);

  const epoch = profileEpoch;
  const task = (async () => {
    await detectCli();
    const args = cliMajor === 1 ? ['capabilities', id, String(version)] : ['capabilities', id, '--capability-version', String(version)];
    const r = await runCli(args);
    if (r.ok && epoch === profileEpoch) capabilityCache.set(key, r.data);
    return r;
  })();

  capabilityInflight.set(key, task);
  try {
    return await task;
  } finally {
    if (capabilityInflight.get(key) === task) capabilityInflight.delete(key);
  }
}

// Safety guard: write operations (inject events / update / delete) are only allowed on virtual devices. Verified ids are cached.
const verifiedVirtual = new Set();
async function assertVirtual(id) {
  if (verifiedVirtual.has(id)) return;
  const epoch = profileEpoch;
  const r = await runCli(['devices', id]);
  if (!r.ok) throw httpError(502, r.error);
  const d = r.data || {};
  if (!(d.type === 'VIRTUAL' || d.virtual)) throw httpError(403, 'Not a virtual device; refusing to modify it');
  if (epoch === profileEpoch) verifiedVirtual.add(id);
}

const routes = [
  ['GET', /^\/api\/info$/, async () => {
    const info = await detectCli(true);
    return { status: 200, body: { cli: CLI, profile: currentProfile, version: info.version, major: cliMajor, error: info.error, tokenFromEnv: !!process.env.SMARTTHINGS_TOKEN } };
  }],
  ['POST', /^\/api\/profile$/, async (req) => {
    const { profile } = await readBody(req);
    if (!profile || !SAFE_ID.test(profile)) throw httpError(400, 'Invalid profile name');
    currentProfile = profile;
    profileEpoch++;
    capabilityCache.clear();
    capabilityInflight.clear();
    verifiedVirtual.clear();
    return { status: 200, body: { profile } };
  }],
  ['GET', /^\/api\/log$/, async () => ({ status: 200, body: { data: commandLog } })],
  ['DELETE', /^\/api\/log$/, async () => { commandLog.length = 0; return { status: 200, body: { ok: true } }; }],
  ['GET', /^\/api\/templates$/, async () => ({ status: 200, body: { data: loadJsonCached(TEMPLATES_FILE) } })],
  ['GET', /^\/api\/presets$/, async () => ({ status: 200, body: { data: loadJsonCached(PRESETS_FILE) } })],

  ['GET', /^\/api\/locations$/, async () => runCli(['locations'])],
  ['GET', /^\/api\/locations\/([^/]+)\/rooms$/, async (req, m) => { assertId(m[1], 'locationId'); return runCli(['locations:rooms', '--location', m[1]]); }],
  ['GET', /^\/api\/deviceprofiles$/, async () => runCli(['deviceprofiles'])],

  ['GET', /^\/api\/devices$/, async (req, m, url) => {
    const args = ['virtualdevices'];
    const loc = url.searchParams.get('location');
    if (loc) { assertId(loc, 'location'); args.push('--location', loc); }
    return runCli(args);
  }],
  ['GET', /^\/api\/devices\/([^/]+)$/, async (req, m) => { assertId(m[1]); return runCli(['devices', m[1]]); }],
  ['GET', /^\/api\/devices\/([^/]+)\/status$/, async (req, m) => { assertId(m[1]); return runCli(['devices:status', m[1]]); }],
  ['DELETE', /^\/api\/devices\/([^/]+)$/, async (req, m) => {
    assertId(m[1]);
    await assertVirtual(m[1]);
    return runCli(['virtualdevices:delete', m[1]], { json: false });
  }],
  ['PATCH', /^\/api\/devices\/([^/]+)$/, async (req, m) => {
    assertId(m[1]);
    await assertVirtual(m[1]);
    const body = await readBody(req);
    const update = {};
    if (body.label) update.label = String(body.label);
    if (body.roomId) { assertId(body.roomId, 'roomId'); update.roomId = body.roomId; }
    return runWithInput(['virtualdevices:update', m[1], '--input', '@INPUT'], update);
  }],

  // create from a standard prototype
  ['POST', /^\/api\/devices\/standard$/, async (req) => {
    const b = await readBody(req);
    if (!b.name || !b.prototype || !b.locationId) throw httpError(400, 'name, prototype and locationId are required');
    assertId(b.locationId, 'locationId');
    if (!SAFE_ID.test(b.prototype)) throw httpError(400, 'Invalid prototype');
    const input = {
      name: String(b.name),
      prototype: b.prototype,
      owner: { ownerType: 'LOCATION', ownerId: b.locationId },
      executionTarget: 'CLOUD',
    };
    if (b.roomId) { assertId(b.roomId, 'roomId'); input.roomId = b.roomId; }
    const extra = b.dryRun ? ['--dry-run'] : [];
    return runWithInput(['virtualdevices:create-standard', '--input', '@INPUT', ...extra], input);
  }],

  // create from a device profile ID or an inline profile definition
  ['POST', /^\/api\/devices\/profile$/, async (req) => {
    const b = await readBody(req);
    if (!b.name || !b.locationId || !(b.deviceProfileId || b.deviceProfile)) {
      throw httpError(400, 'name, locationId and either deviceProfileId or deviceProfile are required');
    }
    assertId(b.locationId, 'locationId');
    const input = {
      name: String(b.name),
      owner: { ownerType: 'LOCATION', ownerId: b.locationId },
      executionTarget: 'CLOUD',
    };
    if (b.deviceProfileId) { assertId(b.deviceProfileId, 'deviceProfileId'); input.deviceProfileId = b.deviceProfileId; }
    else input.deviceProfile = b.deviceProfile;
    if (b.roomId) { assertId(b.roomId, 'roomId'); input.roomId = b.roomId; }
    const extra = b.dryRun ? ['--dry-run'] : [];
    return runWithInput(['virtualdevices:create', '--input', '@INPUT', ...extra], input);
  }],

  // inject events (state): body = { events: [{component, capability, attribute, value, unit?}] }
  ['POST', /^\/api\/devices\/([^/]+)\/events$/, async (req, m) => {
    assertId(m[1]);
    await assertVirtual(m[1]);
    const { events } = await readBody(req);
    if (!Array.isArray(events) || events.length === 0) throw httpError(400, 'An events array is required');
    const clean = events.map((e) => {
      if (!e.capability || !e.attribute || e.value === undefined) throw httpError(400, 'Each event needs capability, attribute and value');
      const ev = { component: e.component || 'main', capability: e.capability, attribute: e.attribute, value: e.value };
      if (e.unit) ev.unit = e.unit;
      if (e.data) ev.data = e.data;
      return ev;
    });
    return runWithInput(['virtualdevices:events', m[1], '--input', '@INPUT'], clean);
  }],

  ['GET', /^\/api\/capabilities\/([^/]+)(?:\/(\d+))?$/, async (req, m) => {
    if (!SAFE_ID.test(m[1])) throw httpError(400, 'Invalid capability id');
    return getCapability(m[1], m[2] || 1);
  }],
];

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const IS_LOCAL_BIND = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const server = http.createServer(async (req, res) => {
  // Block DNS rebinding when bound to loopback
  const hostHeader = req.headers.host;
  if (IS_LOCAL_BIND && hostHeader && !LOCAL_HOST_RE.test(hostHeader)) {
    return send(res, 403, { error: 'forbidden host' });
  }
  const url = new URL(req.url, `http://${hostHeader || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  }
  // Check Origin so other websites cannot send requests to this local server
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN_RE.test(origin)) {
    return send(res, 403, { error: 'forbidden origin' });
  }
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || method !== req.method) continue;
    try {
      const out = await handler(req, m, url);
      if (out && 'status' in out && 'body' in out) return send(res, out.status, out.body);
      return sendCli(res, out);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  }
  send(res, 404, { error: 'not found' });
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // the server keeps running even if the browser cannot be opened
    child.unref();
  } catch { /* ignore */ }
}

if (require.main === module) {
  // Never let a stray error take the whole server down; print it to the terminal instead.
  process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
  process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Another copy of this app is probably still running.\n  Close it (Ctrl+C in its terminal) or start this one on another port, e.g.  PORT=3800 npm start\n`);
    } else {
      console.error('[server] error:', err);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, async () => {
    await detectCli();
    console.log(`\n  SmartThings Virtual Device GUI running at:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  CLI: ${CLI} (${cliInfo?.version || 'cannot run: ' + cliInfo?.error})   profile: ${currentProfile}${process.env.SMARTTHINGS_TOKEN ? '   (using SMARTTHINGS_TOKEN)' : ''}\n`);
    if (!NO_OPEN) openBrowser(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

module.exports = { server, detectCli };
