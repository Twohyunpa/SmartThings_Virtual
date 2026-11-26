'use strict';
// Checks templates/matter-devices.json: standard capabilities only, a main component,
// sample state and mappings that match the profile, and presets that use real capabilities.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const data = require(path.join(__dirname, '..', 'templates', 'matter-devices.json'));
const presets = require(path.join(__dirname, '..', 'templates', 'presets.json'));
const VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'];
const CATEGORIES = ['Lighting', 'Plugs & switches', 'Sensors', 'Security', 'Climate', 'Appliances', 'Energy'];

describe('Matter device templates', () => {
  it('records where the profiles came from', () => {
    assert.match(data.generatedFrom.repository, /SmartThingsEdgeDrivers/);
    assert.match(data.generatedFrom.commit, /^[0-9a-f]{40}$/);
    assert.equal(data.generatedFrom.license, 'Apache-2.0');
  });

  it('has 36 templates with unique ids, known categories and Matter versions', () => {
    assert.equal(data.templates.length, 36);
    assert.equal(new Set(data.templates.map((t) => t.id)).size, 36);
    for (const t of data.templates) {
      assert.match(t.id, /^matter-[a-z0-9-]+$/);
      assert.ok(CATEGORIES.includes(t.category), `${t.id}: category ${t.category}`);
      assert.ok(VERSIONS.includes(t.matter.version), `${t.id}: version ${t.matter.version}`);
      assert.ok(t.matter.deviceType);
    }
  });

  it('uses only standard capabilities and starts with a main component', () => {
    for (const t of data.templates) {
      const comps = t.deviceProfile.components;
      assert.equal(comps[0].id, 'main', t.id);
      assert.ok(t.deviceProfile.name.startsWith('Virtual Matter '), t.id);
      for (const c of comps) {
        assert.ok(c.capabilities.length > 0, `${t.id}/${c.id} has no capabilities`);
        for (const x of c.capabilities) {
          assert.ok(!x.id.includes('.'), `${t.id}: non-standard capability ${x.id}`);
          assert.ok(!['firmwareUpdate', 'webrtc'].includes(x.id) && !x.id.startsWith('stateless'), `${t.id}: ${x.id} should be left out`);
        }
      }
    }
  });

  it('has a sample state and a cluster mapping that match the profile', () => {
    for (const t of data.templates) {
      const have = new Set(t.deviceProfile.components.flatMap((c) => c.capabilities.map((x) => `${c.id}/${x.id}`)));
      const capIds = new Set([...have].map((k) => k.split('/')[1]));
      assert.ok(Object.keys(t.sampleState).length > 0, `${t.id}: no sample state`);
      for (const [comp, caps] of Object.entries(t.sampleState)) {
        for (const cap of Object.keys(caps)) assert.ok(have.has(`${comp}/${cap}`), `${t.id}: sample uses ${comp}/${cap}`);
      }
      assert.deepEqual(new Set(t.mapping.map((r) => r.capability)), capIds, `${t.id}: mapping does not cover every capability`);
    }
  });

  it('every template deviceProfile.name uses only SmartThings-safe characters', () => {
    const appliances = require(path.join(__dirname, '..', 'templates', 'samsung-appliances.json')).templates;
    for (const t of [...appliances, ...data.templates]) {
      assert.match(t.deviceProfile.name, /^[A-Za-z0-9 ()_-]+$/, `${t.id}: unsafe profile name "${t.deviceProfile.name}"`);
    }
  });

  it('every preset applies to at least one appliance or Matter template', () => {
    const appliances = require(path.join(__dirname, '..', 'templates', 'samsung-appliances.json')).templates;
    const all = [...appliances, ...data.templates];
    for (const p of presets) {
      const ok = all.some((t) => p.events.every((e) => t.deviceProfile.components.some((c) => c.id === e.component && c.capabilities.some((x) => x.id === e.capability))));
      assert.ok(ok, `preset "${p.label}" matches no template`);
    }
  });
});
