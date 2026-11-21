#!/usr/bin/env node
// Checks that every capability used by the templates is visible to your SmartThings account.
// Usage: npm run check-capabilities   (uses the same CLI / profile / SMARTTHINGS_TOKEN as the GUI)
// Any capability listed as MISSING cannot be used in a virtual device profile for your account.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = process.env.ST_CLI || 'smartthings';
const shell = process.platform === 'win32';
const run = (args) => (CLI.endsWith('.js')
  ? spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  : spawnSync(CLI, args, { encoding: 'utf8', shell }));

const ver = (run(['--version']).stdout || '').trim();
const major = Number((ver.match(/(\d+)\.\d+\.\d+/) || [])[1]);
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'samsung-appliances.json'), 'utf8'));

const caps = new Map();
for (const t of data.templates) {
  for (const c of t.deviceProfile.components) for (const x of c.capabilities) caps.set(`${x.id}@${x.version || 1}`, x);
}
const list = [...caps.values()].sort((a, b) => a.id.localeCompare(b.id));
console.log(`CLI ${ver || '(not found)'} - checking ${list.length} capabilities...\n`);

const missing = [];
for (const c of list) {
  const args = major === 1 ? ['capabilities', c.id, String(c.version || 1), '--json'] : ['capabilities', c.id, '--capability-version', String(c.version || 1), '--json'];
  const r = run(args);
  const ok = r.status === 0;
  if (!ok) missing.push(c.id);
  console.log(`${ok ? 'ok     ' : 'MISSING'} ${c.id}`);
}
console.log(`\n${list.length - missing.length} found, ${missing.length} not visible to this account.`);
if (missing.length) console.log('Not visible:\n  ' + missing.join('\n  '));
