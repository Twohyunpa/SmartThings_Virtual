'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MOCK_STATE_FILE = path.join(os.tmpdir(), `st-mock-test-${process.pid}-${Date.now()}.json`);
const TEST_PORT = 37900 + Math.floor(Math.random() * 900);

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON static response */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/info');
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Server did not become ready in time');
}

describe('server.js integration (mock CLI)', () => {
  let child;
  let locationId;
  let deviceId;

  before(async () => {
    child = spawn(process.execPath, [SERVER_PATH, '--mock', '--no-open'], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        ST_MOCK_STATE: MOCK_STATE_FILE,
        ST_CLI_CONCURRENCY: '3',
        ST_MOCK_LOGIN_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer();
  });

  after(() => {
    if (child && !child.killed) child.kill('SIGTERM');
    fs.rmSync(MOCK_STATE_FILE, { force: true });
  });

  it('serves static index.html and ES module files', async () => {
    const html = await request('GET', '/');
    assert.equal(html.status, 200);
    assert.match(html.raw, /type="module" src="js\/main\.js"/);

    const mod = await request('GET', '/js/schema.js');
    assert.equal(mod.status, 200);
    assert.match(mod.headers['content-type'], /text\/javascript/);
  });

  it('blocks disallowed Origin, disallowed Host (DNS rebinding), and path traversal', async () => {
    const badOrigin = await request('GET', '/api/info', { headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    const badHost = await request('GET', '/api/info', { headers: { Host: 'evil.example:3700' } });
    assert.equal(badHost.status, 403);

    const traversal = await request('GET', '/..%2fpackage.json');
    assert.equal(traversal.status, 403);

    const nullByte = await request('GET', '/%00');
    assert.equal(nullByte.status, 400);
  });

  it('rejects malformed JSON with 400 and oversized payload with 413', async () => {
    const badJson = await request('POST', '/api/profile', { body: '{invalid' });
    assert.equal(badJson.status, 400);

    const huge = 'x'.repeat(2 * 1024 * 1024 + 100);
    let tooLargeStatus = null;
    try {
      const r = await request('POST', '/api/profile', { body: huge });
      tooLargeStatus = r.status;
    } catch {
      // Server destroys socket on >2MB body, which may trigger ECONNRESET/EPIPE on client write
      tooLargeStatus = 413;
    }
    assert.equal(tooLargeStatus, 413);
  });

  it('returns CLI info, cached templates/presets, and locations', async () => {
    const info = await request('GET', '/api/info');
    assert.equal(info.status, 200);
    assert.equal(info.json.version, '3.0.1-mock');

    const tpl = await request('GET', '/api/templates');
    assert.equal(tpl.status, 200);
    assert.ok(Array.isArray(tpl.json.data.templates) && tpl.json.data.templates.length > 0);

    const matter = await request('GET', '/api/matter-templates');
    assert.equal(matter.status, 200);
    assert.equal(matter.json.data.templates.length, 36);

    const presets = await request('GET', '/api/presets');
    assert.equal(presets.status, 200);
    assert.ok(Array.isArray(presets.json.data) && presets.json.data.length > 0);

    const locs = await request('GET', '/api/locations');
    assert.equal(locs.status, 200);
    assert.ok(locs.json.data.length > 0);
    locationId = locs.json.data[0].locationId;
  });

  it('creates a virtual device, injects events, reads status, renames, and deletes', async () => {
    const created = await request('POST', '/api/devices/standard', {
      body: { name: 'Test Switch', prototype: 'VIRTUAL_SWITCH', locationId },
    });
    assert.equal(created.status, 200);
    deviceId = created.json.data.deviceId;
    assert.ok(deviceId);

    const injected = await request('POST', `/api/devices/${deviceId}/events`, {
      body: { events: [{ component: 'main', capability: 'switch', attribute: 'switch', value: 'on' }] },
    });
    assert.equal(injected.status, 200);
    assert.deepEqual(injected.json.data.output.stateChanges, [true]);

    const status = await request('GET', `/api/devices/${deviceId}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.json.data.components.main.switch.switch.value, 'on');

    const renamed = await request('PATCH', `/api/devices/${deviceId}`, {
      body: { label: 'Renamed Switch' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.data.label, 'Renamed Switch');

    const deleted = await request('DELETE', `/api/devices/${deviceId}`);
    assert.equal(deleted.status, 200);
  });

  it('deduplicates concurrent capability fetches and respects profile reset', async () => {
    await request('DELETE', '/api/log');
    const results = await Promise.all([
      request('GET', '/api/capabilities/switch/1'),
      request('GET', '/api/capabilities/switch/1'),
      request('GET', '/api/capabilities/switch/1'),
      request('GET', '/api/capabilities/temperatureMeasurement/1'),
    ]);
    for (const r of results) assert.equal(r.status, 200);

    const logRes = await request('GET', '/api/log');
    const switchCalls = logRes.json.data.filter((e) => e.command.includes('capabilities switch'));
    assert.equal(switchCalls.length, 1, 'concurrent requests for same capability should run CLI only once');

    const switched = await request('POST', '/api/profile', { body: { profile: 'test-profile' } });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.profile, 'test-profile');

    // After profile switch, capability cache should be cleared and CLI called again
    await request('GET', '/api/capabilities/switch/1');
    const logAfter = await request('GET', '/api/log');
    const switchCallsAfter = logAfter.json.data.filter((e) => e.command.includes('capabilities switch'));
    assert.equal(switchCallsAfter.length, 2);
  });

  it('shows the signed-in account, logs out, and switches to another account', async () => {
    const before = await request('GET', '/api/account');
    assert.equal(before.status, 200);
    assert.equal(before.json.data.signedIn, true);
    assert.equal(before.json.data.auth, 'login');
    const firstOrg = before.json.data.organization.name;
    assert.ok(firstOrg);
    assert.ok(before.json.data.locations.length > 0);
    assert.ok(!JSON.stringify(before.json).match(/accessToken|refreshToken/), 'tokens must never be returned');

    const out = await request('POST', '/api/account/logout');
    assert.equal(out.status, 200);
    const afterLogout = await request('GET', '/api/account');
    assert.equal(afterLogout.json.data.signedIn, false);
    assert.equal(afterLogout.json.data.auth, 'none');

    // concurrent sign-in requests share one CLI login
    await request('DELETE', '/api/log');
    const [a, b] = await Promise.all([request('POST', '/api/account/login'), request('POST', '/api/account/login')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data.signedIn, true);
    assert.notEqual(a.json.data.organization.name, firstOrg, 'mock signs in to the other account');
    const log = await request('GET', '/api/log');
    const locCalls = log.json.data.filter((e) => /^smartthings locations --json/.test(e.command)).length;
    assert.equal(locCalls, 3, 'one shared login call + one details call per request');
  });
});

describe('account helpers', () => {
  const { profileHasToken, cliDirs } = require('../server.js');
  it('detects a token configured under a CLI profile in config.yaml', () => {
    const file = path.join(os.tmpdir(), `st-cfg-${process.pid}.yaml`);
    fs.writeFileSync(file, 'default:\n  clientIdProvider: {}\nhub2:\n  token: abc-123\n');
    try {
      assert.equal(profileHasToken(file, 'hub2'), true);
      assert.equal(profileHasToken(file, 'default'), false);
      assert.equal(profileHasToken(file, 'missing'), false);
    } finally { fs.rmSync(file, { force: true }); }
  });
  it('builds CLI data/config paths for this OS', () => {
    const d = cliDirs();
    assert.match(d.dataDir, /@smartthings[\\/]cli/);
    assert.match(d.oldConfigDir, /@smartthings[\\/]cli/);
  });
});
