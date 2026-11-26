// Central application state, localStorage persistence, and device/capability helpers.

export const state = {
  locations: [],
  devices: [],
  templates: [],
  templatesMeta: null, // where the templates were derived from
  iotTemplates: [],   // IoT device templates (SmartThings Edge driver profiles)
  iotMeta: null,
  categories: ['Lighting', 'Plugs and actuators', 'Switches and controls', 'Sensors', 'Closures', 'HVAC',
    'Media', 'Robotic', 'Appliances', 'Energy management', 'Cameras', 'Other'], // Matter Device Library chapters
  presets: [],
  selectedId: null,
  device: null,       // result of `devices <id>`
  status: null,       // result of `devices:status`
  caps: {},           // `${capabilityId}@${version}` -> definition
  tab: 'control',
  autoRefresh: false,
  autoTimer: null,
  draft: [],          // steps of the scenario being edited
  activeRun: null,    // { deviceId, stop: boolean } for any running scenario
  account: null,      // result of GET /api/account
};

// Shared view action hooks populated by main.js to avoid circular imports.
export const actions = {
  loadDevices: async () => {},
  loadTemplates: async () => {},
  selectDevice: async () => {},
  refreshStatus: async () => {},
  renderTabBody: () => {},
  onSignedOut: () => {},
  onSigningIn: () => {},
  onSignedIn: () => {},
};

export const PROTOTYPES = [
  ['VIRTUAL_SWITCH', 'Switch'], ['VIRTUAL_DIMMER_SWITCH', 'Dimmer switch'], ['VIRTUAL_BUTTON', 'Button'],
  ['VIRTUAL_CAMERA', 'Camera'], ['VIRTUAL_COLOR_BULB', 'Color bulb'], ['VIRTUAL_CONTACT_SENSOR', 'Contact sensor'],
  ['VIRTUAL_DIMMER', 'Dimmer (no switch)'], ['VIRTUAL_GARAGE_DOOR_OPENER', 'Garage door opener'], ['VIRTUAL_LOCK', 'Lock'],
  ['VIRTUAL_METERED_SWITCH', 'Metered switch'], ['VIRTUAL_MOTION_SENSOR', 'Motion sensor'], ['VIRTUAL_MULTI_SENSOR', 'Multi-sensor'],
  ['VIRTUAL_PRESENCE_SENSOR', 'Presence sensor'], ['VIRTUAL_REFRIGERATOR', 'Refrigerator'], ['VIRTUAL_RGBW_BULB', 'RGBW bulb'],
  ['VIRTUAL_SIREN', 'Siren'], ['VIRTUAL_THERMOSTAT', 'Thermostat'],
];

export const fmtVal = (v) => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
}

export const capCacheKey = (id, version = 1) => `${id}@${version || 1}`;

export function getCapDef(id, version = 1) {
  return state.caps[capCacheKey(id, version)] || state.caps[capCacheKey(id, 1)];
}

export function setCapDef(id, version, def) {
  state.caps[capCacheKey(id, version)] = def;
}

export function clearCapDefs() {
  state.caps = {};
}

export function currentCapStatus(comp, cap) {
  return state.status?.components?.[comp]?.[cap];
}

export function currentAttr(comp, cap, attr) {
  return state.status?.components?.[comp]?.[cap]?.[attr];
}

export function deviceCapSet() {
  const set = new Set();
  (state.device?.components || []).forEach((c) => (c.capabilities || []).forEach((x) => set.add(`${c.id}/${x.id}`)));
  return set;
}

export function applicable(events) {
  const set = deviceCapSet();
  return events.every((e) => set.has(`${e.component || 'main'}/${e.capability}`));
}

export function evText(e) {
  return `${e.component && e.component !== 'main' ? e.component + ':' : ''}${e.capability}.${e.attribute} = ${fmtVal(e.value)}${e.unit ? ' ' + e.unit : ''}`;
}

export function stopAuto() {
  state.autoRefresh = false;
  clearInterval(state.autoTimer);
  state.autoTimer = null;
}

export function stopActiveRun() {
  if (state.activeRun) {
    state.activeRun.stop = true;
    state.activeRun = null;
  }
}

// Find an appliance or IoT template by id. IoT template ids start with "iot-"; devices created before the
// rename remember a "matter-" id, which maps to the same template.
export const findTemplate = (id) => {
  if (!id) return undefined;
  const iotId = String(id).replace(/^matter-/, 'iot-');
  return state.templates.find((x) => x.id === id) || state.iotTemplates.find((x) => x.id === iotId);
};
