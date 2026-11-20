#!/usr/bin/env node
// SmartThings 가상 기기 GUI - 로컬 서버
// SmartThings CLI(`smartthings`)를 감싸서 브라우저 UI에서 가상 기기를 만들고 상태(이벤트)를 주입한다.
// 외부 의존성 없음. Node 18+.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3700);
const HOST = process.env.HOST || '127.0.0.1';
const NO_OPEN = process.argv.includes('--no-open') || !!process.env.ST_NO_OPEN;
const USE_MOCK = process.argv.includes('--mock'); // Windows 에서도 되도록 환경변수 대신 인자로 모의 CLI 선택
const CLI = USE_MOCK ? path.join(__dirname, 'mock', 'smartthings-mock.js') : (process.env.ST_CLI || 'smartthings');
const CLI_TIMEOUT_MS = Number(process.env.ST_CLI_TIMEOUT_MS || 120000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TEMPLATES_FILE = path.join(__dirname, 'templates', 'samsung-appliances.json');

let currentProfile = process.env.ST_PROFILE || 'default';
let cliMajor = null; // 감지된 CLI 메이저 버전 (1.x 는 oclif, 2.x 이상은 yargs 기반으로 일부 인자가 다름)
const commandLog = []; // 최근 실행한 CLI 명령 기록
const capabilityCache = new Map();

// ---------- CLI 실행 ----------

function quoteForDisplay(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function quoteForWindowsShell(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

function runCli(args, { json = true, api = true, input, inputFile } = {}) {
  const fullArgs = [...args];
  if (json) fullArgs.push('--json');
  if (api && currentProfile && currentProfile !== 'default') fullArgs.push('--profile', currentProfile);
  // 토큰은 화면/로그에 노출하지 않는다.
  // CLI 2.x 이상은 SMARTTHINGS_TOKEN 환경변수를 직접 읽으므로 1.x 에서만 --token 으로 넘긴다.
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
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, cmdArgs, { shell, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      const entry = { command: display, input, ok: false, ms: 0, error: err.message, at: new Date().toISOString() };
      pushLog(entry);
      return resolve({ ok: false, error: err.message, command: display });
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      const msg = err.code === 'ENOENT'
        ? `SmartThings CLI를 찾을 수 없습니다 ("${CLI}"). npm i -g @smartthings/cli 로 설치하거나 ST_CLI 환경변수로 경로를 지정하세요.`
        : err.message;
      pushLog({ command: display, input, ok: false, ms: Date.now() - started, error: msg, at: new Date().toISOString() });
      resolve({ ok: false, error: msg, command: display });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        const msg = cleanError(stderr || stdout) || `종료 코드 ${code}`;
        pushLog({ command: display, input, ok: false, ms, error: msg, at: new Date().toISOString() });
        return resolve({ ok: false, error: msg, command: display });
      }
      let data = stdout;
      if (json) {
        const trimmed = stdout.trim();
        try {
          data = trimmed ? JSON.parse(trimmed) : null;
        } catch {
          // JSON 앞에 경고 문구가 붙는 경우를 대비
          const i = trimmed.search(/[[{]/);
          try { data = i >= 0 ? JSON.parse(trimmed.slice(i)) : trimmed; } catch { data = trimmed; }
        }
      }
      pushLog({ command: display, input, ok: true, ms, at: new Date().toISOString() });
      resolve({ ok: true, data, command: display, stderr: stderr.trim() || undefined });
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
  commandLog.unshift(entry);
  if (commandLog.length > 200) commandLog.length = 200;
}

// 입력 JSON 을 임시 파일로 써서 `--input <file>` 로 넘긴다. 로그에는 input.json 과 그 내용이 표시된다.
async function runWithInput(args, obj, opts = {}) {
  const file = path.join(os.tmpdir(), `st-gui-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  try {
    return await runCli(args.map((a) => (a === '@INPUT' ? file : a)), { ...opts, input: obj, inputFile: file });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

// ---------- HTTP 유틸 ----------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function sendCli(res, result) {
  if (result.ok) send(res, 200, { data: result.data, command: result.command });
  else send(res, 502, { error: result.error, command: result.command });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('요청 본문이 너무 큽니다'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 형식이 올바르지 않습니다')); }
    });
    req.on('error', reject);
  });
}

const UUID = /^[0-9a-fA-F-]{8,64}$/;
const SAFE_ID = /^[\w.\-]{1,128}$/;
function assertId(v, name = 'id') {
  if (!v || !UUID.test(v)) throw httpError(400, `${name} 값이 올바르지 않습니다`);
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
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
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
  await detectCli();
  const args = cliMajor === 1 ? ['capabilities', id, String(version)] : ['capabilities', id, '--capability-version', String(version)];
  const r = await runCli(args);
  if (r.ok) capabilityCache.set(key, r.data);
  return r;
}

// 안전장치: 쓰기 작업(이벤트 주입/수정/삭제)은 가상 기기에만 허용한다. 확인된 id 는 캐시.
const verifiedVirtual = new Set();
async function assertVirtual(id) {
  if (verifiedVirtual.has(id)) return;
  const r = await runCli(['devices', id]);
  if (!r.ok) throw httpError(502, r.error);
  const d = r.data || {};
  if (!(d.type === 'VIRTUAL' || d.virtual)) throw httpError(403, '가상 기기가 아니어서 변경할 수 없습니다');
  verifiedVirtual.add(id);
}

const routes = [
  ['GET', /^\/api\/info$/, async () => {
    const info = await detectCli(true);
    return { status: 200, body: { cli: CLI, profile: currentProfile, version: info.version, major: cliMajor, error: info.error, tokenFromEnv: !!process.env.SMARTTHINGS_TOKEN } };
  }],
  ['POST', /^\/api\/profile$/, async (req) => {
    const { profile } = await readBody(req);
    if (!profile || !SAFE_ID.test(profile)) throw httpError(400, '프로필 이름이 올바르지 않습니다');
    currentProfile = profile;
    capabilityCache.clear();
    return { status: 200, body: { profile } };
  }],
  ['GET', /^\/api\/log$/, async () => ({ status: 200, body: { data: commandLog } })],
  ['DELETE', /^\/api\/log$/, async () => { commandLog.length = 0; return { status: 200, body: { ok: true } }; }],
  ['GET', /^\/api\/templates$/, async () => ({ status: 200, body: { data: JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')) } })],

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

  // 표준 프로토타입으로 생성
  ['POST', /^\/api\/devices\/standard$/, async (req) => {
    const b = await readBody(req);
    if (!b.name || !b.prototype || !b.locationId) throw httpError(400, 'name, prototype, locationId 가 필요합니다');
    assertId(b.locationId, 'locationId');
    if (!SAFE_ID.test(b.prototype)) throw httpError(400, 'prototype 값이 올바르지 않습니다');
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

  // 디바이스 프로필 ID 또는 인라인 프로필 정의로 생성
  ['POST', /^\/api\/devices\/profile$/, async (req) => {
    const b = await readBody(req);
    if (!b.name || !b.locationId || !(b.deviceProfileId || b.deviceProfile)) {
      throw httpError(400, 'name, locationId, 그리고 deviceProfileId 또는 deviceProfile 이 필요합니다');
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

  // 이벤트(상태) 주입: body = { events: [{component, capability, attribute, value, unit?}] }
  ['POST', /^\/api\/devices\/([^/]+)\/events$/, async (req, m) => {
    assertId(m[1]);
    await assertVirtual(m[1]);
    const { events } = await readBody(req);
    if (!Array.isArray(events) || events.length === 0) throw httpError(400, 'events 배열이 필요합니다');
    const clean = events.map((e) => {
      if (!e.capability || !e.attribute || e.value === undefined) throw httpError(400, '각 이벤트에 capability, attribute, value 가 필요합니다');
      const ev = { component: e.component || 'main', capability: e.capability, attribute: e.attribute, value: e.value };
      if (e.unit) ev.unit = e.unit;
      if (e.data) ev.data = e.data;
      return ev;
    });
    return runWithInput(['virtualdevices:events', m[1], '--input', '@INPUT'], clean);
  }],

  ['GET', /^\/api\/capabilities\/([^/]+)(?:\/(\d+))?$/, async (req, m) => {
    if (!SAFE_ID.test(m[1])) throw httpError(400, 'capability id 가 올바르지 않습니다');
    return getCapability(m[1], m[2] || 1);
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  }
  // 다른 사이트에서 로컬 서버로 요청을 보내는 것을 막기 위해 Origin 확인
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
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
    child.on('error', () => {}); // 브라우저를 못 열어도 서버는 계속 동작
    child.unref();
  } catch { /* ignore */ }
}

server.listen(PORT, HOST, async () => {
  await detectCli();
  console.log(`\n  SmartThings 가상 기기 GUI 실행 중:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  CLI: ${CLI} (${cliInfo?.version || '실행 불가: ' + cliInfo?.error})   프로필: ${currentProfile}${process.env.SMARTTHINGS_TOKEN ? '   (SMARTTHINGS_TOKEN 사용)' : ''}\n`);
  if (!NO_OPEN) openBrowser(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
