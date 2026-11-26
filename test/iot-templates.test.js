'use strict';
// Checks templates/iot-devices.json: standard capabilities only, a main component, Matter Device Library
// categories, sample state that matches the profile, and presets that use real capabilities.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const data = require(path.join(__dirname, '..', 'templates', 'iot-devices.json'));
const appliances = require(path.join(__dirname, '..', 'templates', 'samsung-appliances.json')).templates;
const presets = require(path.join(__dirname, '..', 'templates', 'presets.json'));
const VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'];
const CATEGORIES = ['Lighting', 'Plugs and actuators', 'Switches and controls', 'Sensors', 'Closures', 'HVAC',
  'Media', 'Robotic', 'Appliances', 'Energy management', 'Cameras', 'Other'];

describe('IoT device templates', () => {
  it('records where the profiles came from', () => {
    assert.match(data.generatedFrom.repository, /SmartThingsEdgeDrivers/);
    assert.match(data.generatedFrom.commit, /^[0-9a-f]{40}$/);
    assert.equal(data.generatedFrom.license, 'Apache-2.0');
    assert.deepEqual(data.categories, CATEGORIES);
  });

  it('has 50 templates with unique ids and known categories', () => {
    assert.equal(data.templates.length, 50);
    assert.equal(new Set(data.templates.map((t) => t.id)).size, 50);
    for (const t of data.templates) {
      assert.match(t.id, /^iot-[a-z0-9-]+$/);
      assert.ok(CATEGORIES.includes(t.category), `${t.id}: category ${t.category}`);
      if (t.matter) {
        assert.ok(VERSIONS.includes(t.matter.version), `${t.id}: version ${t.matter.version}`);
        assert.ok(t.matter.deviceType);
      }
    }
  });

  it('gives every Samsung appliance template a known category', () => {
    for (const t of appliances) assert.ok(CATEGORIES.includes(t.category), `${t.id}: category ${t.category}`);
  });

  it('uses only standard capabilities and starts with a main component', () => {
    for (const t of data.templates) {
      const comps = t.deviceProfile.components;
      assert.equal(comps[0].id, 'main', t.id);
      assert.ok(t.deviceProfile.name.startsWith('Virtual '), t.id);
      assert.ok(!/matter/i.test(t.deviceProfile.name), `${t.id}: profile name should not say Matter`);
      for (const c of comps) {
        assert.ok(c.capabilities.length > 0, `${t.id}/${c.id} has no capabilities`);
        for (const x of c.capabilities) {
          assert.ok(!x.id.includes('.'), `${t.id}: non-standard capability ${x.id}`);
          assert.ok(!['firmwareUpdate', 'webrtc'].includes(x.id) && !x.id.startsWith('stateless'), `${t.id}: ${x.id} should be left out`);
        }
      }
    }
  });

  it('has a sample state that matches the profile', () => {
    for (const t of data.templates) {
      const have = new Set(t.deviceProfile.components.flatMap((c) => c.capabilities.map((x) => `${c.id}/${x.id}`)));
      assert.ok(Object.keys(t.sampleState).length > 0, `${t.id}: no sample state`);
      for (const [comp, caps] of Object.entries(t.sampleState)) {
        for (const cap of Object.keys(caps)) assert.ok(have.has(`${comp}/${cap}`), `${t.id}: sample uses ${comp}/${cap}`);
      }
    }
  });

  it('every template deviceProfile.name uses only SmartThings-safe characters (no & , / or brackets)', () => {
    for (const t of [...appliances, ...data.templates]) {
      assert.match(t.deviceProfile.name, /^[A-Za-z0-9 _-]+$/, `${t.id}: unsafe profile name "${t.deviceProfile.name}"`);
    }
  });

  it('every preset applies to at least one appliance or IoT template', () => {
    const all = [...appliances, ...data.templates];
    for (const p of presets) {
      const ok = all.some((t) => p.events.every((e) => t.deviceProfile.components.some((c) => c.id === e.component && c.capabilities.some((x) => x.id === e.capability))));
      assert.ok(ok, `preset "${p.label}" matches no template`);
    }
  });
});
