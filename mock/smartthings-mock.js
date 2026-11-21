#!/usr/bin/env node
// Mock of the SmartThings CLI (for trying the UI). Lets you explore the GUI without a real SmartThings account.
// Usage: node server.js --mock   (or npm run mock)
// State is stored in st-mock-state.json in the OS temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = process.env.ST_MOCK_STATE || path.join(os.tmpdir(), 'st-mock-state.json');
const LOC = '6f3a2c1e-0000-4000-8000-000000000001';

const str = (e) => ({ type: 'string', ...(e ? { enum: e } : {}) });
const num = (min, max, units, def) => ({ value: { type: 'number', ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) }, unit: units ? { type: 'string', enum: units, default: def || units[0] } : undefined });
const attr = (value, unit) => ({ schema: { type: 'object', properties: { value, ...(unit ? { unit } : {}) }, required: ['value'] } });
const numAttr = (min, max, units, def) => { const n = num(min, max, units, def); return attr(n.value, n.unit); };
const intAttr = (min, max, units) => attr({ type: 'integer', minimum: min, maximum: max }, units ? { type: 'string', enum: units, default: units[0] } : undefined);

const CAPS = {
  switch: { switch: attr(str(['on', 'off'])) },
  switchLevel: { level: intAttr(0, 100, ['%']) },
  refresh: {},
  button: { button: attr(str(['pushed', 'held', 'double', 'pushed_2x'])), numberOfButtons: attr({ type: 'integer' }) },
  contactSensor: { contact: attr(str(['open', 'closed'])) },
  motionSensor: { motion: attr(str(['active', 'inactive'])) },
  presenceSensor: { presence: attr(str(['present', 'not present'])) },
  lock: { lock: attr(str(['locked', 'unlocked', 'unknown', 'unlocked with timeout'])) },
  temperatureMeasurement: { temperature: numAttr(-460, 10000, ['C', 'F']) },
  relativeHumidityMeasurement: { humidity: numAttr(0, 100, ['%']) },
  battery: { battery: intAttr(0, 100, ['%']) },
  powerMeter: { power: numAttr(0, undefined, ['W']) },
  energyMeter: { energy: numAttr(0, undefined, ['Wh', 'kWh', 'mWh', 'kVAh']) },
  colorControl: { hue: numAttr(0, 100, ['%']), saturation: numAttr(0, 100, ['%']), color: attr({ type: 'object' }) },
  colorTemperature: { colorTemperature: intAttr(1, 30000, ['K']) },
  thermostatCoolingSetpoint: { coolingSetpoint: numAttr(-460, 10000, ['C', 'F']) },
  thermostatHeatingSetpoint: { heatingSetpoint: numAttr(-460, 10000, ['C', 'F']) },
  thermostatMode: { thermostatMode: attr(str(['auto', 'cool', 'heat', 'off', 'emergency heat'])), supportedThermostatModes: attr({ type: 'array' }) },
  washerOperatingState: { machineState: attr(str(['pause', 'run', 'stop'])), washerJobState: attr(str(['airWash', 'cooling', 'delayWash', 'drying', 'finish', 'none', 'preWash', 'rinse', 'spin', 'wash', 'weightSensing', 'wrinklePrevent'])), completionTime: attr(str()), supportedMachineStates: attr({ type: 'array' }) },
  washerMode: { washerMode: attr(str(['regular', 'heavy', 'rinse', 'spinDry'])) },
  dryerOperatingState: { machineState: attr(str(['pause', 'run', 'stop'])), dryerJobState: attr(str(['cooling', 'delayWash', 'drying', 'finished', 'none', 'weightSensing', 'wrinklePrevent'])), completionTime: attr(str()) },
  dryerMode: { dryerMode: attr(str(['regular', 'lowHeat', 'highHeat'])) },
  remoteControlStatus: { remoteControlEnabled: attr(str(['false', 'true'])) },
  airConditionerMode: { airConditionerMode: attr(str(['auto', 'cool', 'dry', 'coolClean', 'dryClean', 'fanOnly', 'heat', 'heatClean'])), supportedAcModes: attr({ type: 'array' }) },
  airConditionerFanMode: { fanMode: attr(str()), supportedAcFanModes: attr({ type: 'array' }), availableAcFanModes: attr({ type: 'array' }) },
  airPurifierFanMode: { airPurifierFanMode: attr(str(['auto', 'sleep', 'low', 'medium', 'high', 'quiet', 'windFree', 'off'])) },
  dustSensor: { dustLevel: intAttr(0, 999, ['μg/m^3']), fineDustLevel: intAttr(0, 999, ['μg/m^3']) },
  fineDustSensor: { fineDustLevel: intAttr(0, 999, ['μg/m^3']) },
  airQualitySensor: { airQuality: intAttr(0, 999, ['CAQI']) },
  robotCleanerMovement: { robotCleanerMovement: attr(str(['homing', 'idle', 'charging', 'alarm', 'powerOff', 'reserve', 'point', 'after', 'cleaning', 'pause'])) },
  robotCleanerCleaningMode: { robotCleanerCleaningMode: attr(str(['auto', 'part', 'repeat', 'manual', 'stop', 'map'])) },
  dishwasherOperatingState: { machineState: attr(str(['pause', 'run', 'stop'])), dishwasherJobState: attr(str(['airwash', 'cooling', 'drying', 'finish', 'preDrain', 'prewash', 'rinse', 'spin', 'wash', 'wrinklePrevent', 'unknown'])) },
  dishwasherMode: { dishwasherMode: attr(str(['eco', 'intense', 'auto', 'quick', 'rinse', 'dry'])) },
  audioVolume: { volume: intAttr(0, 100, ['%']) },
  audioMute: { mute: attr(str(['muted', 'unmuted'])) },
  mediaInputSource: { inputSource: attr(str(['AM', 'CD', 'FM', 'HDMI', 'HDMI1', 'HDMI2', 'HDMI3', 'USB', 'digitalTv'])) },
  tvChannel: { tvChannel: attr(str()), tvChannelName: attr(str()) },
  doorControl: { door: attr(str(['closed', 'closing', 'open', 'opening', 'unknown'])) },
  alarm: { alarm: attr(str(['both', 'off', 'siren', 'strobe'])) },
  videoStream: { stream: attr({ type: 'object' }) },
};

const PROTO_CAPS = {
  VIRTUAL_SWITCH: ['switch'], VIRTUAL_DIMMER_SWITCH: ['switch', 'switchLevel'], VIRTUAL_DIMMER: ['switchLevel'],
  VIRTUAL_BUTTON: ['button'], VIRTUAL_CAMERA: ['switch', 'videoStream'], VIRTUAL_COLOR_BULB: ['switch', 'switchLevel', 'colorControl'],
  VIRTUAL_RGBW_BULB: ['switch', 'switchLevel', 'colorControl', 'colorTemperature'], VIRTUAL_CONTACT_SENSOR: ['contactSensor', 'battery'],
  VIRTUAL_MOTION_SENSOR: ['motionSensor', 'battery'], VIRTUAL_PRESENCE_SENSOR: ['presenceSensor'], VIRTUAL_LOCK: ['lock', 'battery'],
  VIRTUAL_METERED_SWITCH: ['switch', 'powerMeter', 'energyMeter'], VIRTUAL_MULTI_SENSOR: ['contactSensor', 'motionSensor', 'temperatureMeasurement', 'battery'],
  VIRTUAL_GARAGE_DOOR_OPENER: ['doorControl'], VIRTUAL_SIREN: ['alarm'],
  VIRTUAL_THERMOSTAT: ['temperatureMeasurement', 'thermostatMode', 'thermostatHeatingSetpoint', 'thermostatCoolingSetpoint'],
  VIRTUAL_REFRIGERATOR: ['contactSensor', 'temperatureMeasurement', 'thermostatCoolingSetpoint'],
};

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {
    return { devices: {} };
  }
}
function save(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function fail(msg) { process.stderr.write(`Error: ${msg}\n`); process.exit(1); }

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['json', 'dry-run', 'version', 'yaml', 'verbose'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const cmd = pos.shift();
const readInput = () => JSON.parse(fs.readFileSync(flags.input, 'utf8'));

if (flags.version && !cmd) { console.log('3.0.1-mock'); process.exit(0); }

const s = load();
const getDev = (id) => s.devices[id] || fail(`device ${id} not found`);

function makeDevice(name, owner, roomId, components, typeName) {
  const id = crypto.randomUUID();
  const status = {};
  for (const c of components) {
    status[c.id] = {};
    for (const cap of c.capabilities) {
      status[c.id][cap.id] = {};
      for (const a of Object.keys(CAPS[cap.id] || {})) status[c.id][cap.id][a] = { value: null };
    }
  }
  const dev = {
    deviceId: id, name, label: name, locationId: owner.ownerId, ownerId: owner.ownerId, roomId,
    deviceTypeName: typeName, components, type: 'VIRTUAL', virtual: { name, executionTarget: 'CLOUD' }, createTime: new Date().toISOString(),
  };
  return { dev, status };
}

switch (cmd) {
  case 'locations':
    out([{ locationId: LOC, name: 'Mock Home (mock)' }]);
    break;
  case 'locations:rooms':
    out([{ roomId: '6f3a2c1e-0000-4000-8000-0000000000a1', locationId: LOC, name: 'Living Room' }, { roomId: '6f3a2c1e-0000-4000-8000-0000000000a2', locationId: LOC, name: 'Utility Room' }]);
    break;
  case 'deviceprofiles':
    out([{ id: '6f3a2c1e-0000-4000-8000-0000000000f1', name: 'Mock Washer Profile', status: 'PUBLISHED' }]);
    break;
  case 'virtualdevices':
    out(Object.values(s.devices).map((d) => d.dev).filter((d) => !flags.location || d.locationId === flags.location));
    break;
  case 'devices':
    out(getDev(pos[0]).dev);
    break;
  case 'devices:status':
    out({ components: getDev(pos[0]).status });
    break;
  case 'capabilities': {
    const id = pos[0];
    out({ id, version: Number(pos[1] || 1), status: 'live', name: id, attributes: CAPS[id] || {}, commands: {} }); // unknown capabilities: empty definition
    break;
  }
  case 'virtualdevices:create-standard': {
    const inp = readInput();
    const caps = PROTO_CAPS[inp.prototype];
    if (!caps) fail(`unknown prototype ${inp.prototype}`);
    if (flags['dry-run']) { out(inp); break; }
    const { dev, status } = makeDevice(inp.name, inp.owner, inp.roomId, [{ id: 'main', capabilities: caps.map((id) => ({ id, version: 1 })), categories: [] }], inp.prototype);
    s.devices[dev.deviceId] = { dev, status };
    save(s); out(dev);
    break;
  }
  case 'virtualdevices:create': {
    const inp = readInput();
    if (flags['dry-run']) { out(inp); break; }
    let comps = inp.deviceProfile?.components;
    if (!comps && inp.deviceProfileId) comps = [{ id: 'main', capabilities: ['switch', 'washerOperatingState'].map((id) => ({ id, version: 1 })) }];
    if (!comps) fail('deviceProfile or deviceProfileId required');
    const { dev, status } = makeDevice(inp.name, inp.owner, inp.roomId, comps, inp.deviceProfile?.name || 'profile');
    s.devices[dev.deviceId] = { dev, status };
    save(s); out(dev);
    break;
  }
  case 'virtualdevices:events': {
    const d = getDev(pos[0]);
    const events = readInput();
    const changes = events.map((e) => {
      const comp = e.component || 'main';
      if (!d.dev.components.some((c) => c.id === comp && c.capabilities.some((x) => x.id === e.capability))) fail(`capability ${comp}:${e.capability} not on device`);
      d.status[comp] = d.status[comp] || {};
      d.status[comp][e.capability] = d.status[comp][e.capability] || {};
      const slot = d.status[comp][e.capability];
      if (!(e.attribute in slot)) slot[e.attribute] = { value: null }; // the mock does not know every capability's attributes
      const changed = JSON.stringify(slot[e.attribute].value) !== JSON.stringify(e.value);
      slot[e.attribute] = { value: e.value, ...(e.unit ? { unit: e.unit } : {}), timestamp: new Date().toISOString() };
      return changed;
    });
    save(s); out({ input: events, output: { stateChanges: changes } });
    break;
  }
  case 'virtualdevices:update': {
    const d = getDev(pos[0]);
    Object.assign(d.dev, readInput());
    save(s); out(d.dev);
    break;
  }
  case 'virtualdevices:delete':
    getDev(pos[0]);
    delete s.devices[pos[0]];
    save(s); console.log(`Device ${pos[0]} deleted.`);
    break;
  default:
    fail(`mock: unsupported command ${cmd}`);
}
