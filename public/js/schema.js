// Pure capability schema & supported*/available* option pairing helpers.
// Zero DOM or global-state dependencies so this module can be unit-tested directly in Node.

export const LIST_PREFIX = /^(supported|available)(?=[A-Z])/;

const camelWords = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
const listBase = (name) => name.replace(LIST_PREFIX, '').toLowerCase().replace(/s$/, '');

export function convertValue(raw, type) {
  switch (type) {
    case 'integer': {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) throw new Error('Enter an integer');
      return n;
    }
    case 'number': {
      const n = parseFloat(raw);
      if (Number.isNaN(n)) throw new Error('Enter a number');
      return n;
    }
    case 'boolean':
      return raw === true || raw === 'true';
    case 'array':
    case 'object':
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    default:
      return raw;
  }
}

export function valueSchema(capDef, attrName) {
  const attr = capDef?.attributes?.[attrName];
  const props = attr?.schema?.properties || {};
  const v = props.value || {};
  let type = v.type;
  if (!type && v.enum) type = 'string';
  if (!type && (v.oneOf || v.anyOf)) type = 'string';
  const unit = props.unit || {};
  return {
    type: type || 'string',
    enum: v.enum,
    min: v.minimum,
    max: v.maximum,
    units: unit.enum || (unit.default ? [unit.default] : null),
    unitDefault: unit.default,
    required: attr?.schema?.required,
    itemsEnum: v.items?.enum,
  };
}

export function pairScore(listName, attrName) {
  const base = listBase(listName);
  const a = attrName.toLowerCase();
  if (base === a || base === a.replace(/s$/, '')) return 3;
  if (base.endsWith(a) || a.endsWith(base)) return 2;
  const lw = camelWords(listName.replace(LIST_PREFIX, '')).pop().replace(/s$/, '');
  return camelWords(attrName).pop() === lw ? 1 : 0;
}

// WeakMap keyed by capDef object: automatically invalidated when capability definitions are reloaded or cleared.
const pairCache = new WeakMap();

export function computeCapPairs(capDef) {
  if (!capDef || typeof capDef !== 'object') return { byValue: {}, byList: {} };
  if (pairCache.has(capDef)) return pairCache.get(capDef);

  const attrs = Object.keys(capDef.attributes || {});
  const lists = attrs.filter((a) => LIST_PREFIX.test(a) && valueSchema(capDef, a).type === 'array');
  const values = attrs.filter((a) => !LIST_PREFIX.test(a) && valueSchema(capDef, a).type === 'string');
  const byValue = {};
  const byList = {};

  for (const l of lists) {
    // Give each list to the value attribute that matches it best (ties are ambiguous -> no pairing).
    const scored = values
      .map((v) => [v, pairScore(l, v)])
      .filter(([, sc]) => sc > 0)
      .sort((x, y) => y[1] - x[1]);
    if (!scored.length || (scored[1] && scored[1][1] === scored[0][1])) continue;
    const v = scored[0][0];
    const kind = l.startsWith('available') ? 'available' : 'supported';
    byValue[v] = byValue[v] || {};
    if (!byValue[v][kind]) byValue[v][kind] = l;
    byList[l] = v;
  }

  const result = { byValue, byList };
  pairCache.set(capDef, result);
  return result;
}

function listValueFromStatus(capStatus, attr) {
  const v = attr ? capStatus?.[attr]?.value : undefined;
  return Array.isArray(v) ? v.filter((x) => x !== null && typeof x !== 'object') : [];
}

function uniq(arr) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Options for a single string value: groups of [label, values]. null = no device-provided list.
export function valueOptions(capDef, capStatus, attrName) {
  const pair = computeCapPairs(capDef).byValue[attrName];
  if (!pair) return null;
  const supported = listValueFromStatus(capStatus, pair.supported);
  const available = listValueFromStatus(capStatus, pair.available);
  const main = pair.available && available.length ? available : supported;
  if (!main.length) return null;
  const s = valueSchema(capDef, attrName);
  const groups = [[pair.available && available.length ? pair.available : pair.supported, main]];
  const notAvail = supported.filter((v) => !main.includes(v));
  if (notAvail.length) groups.push([`in ${pair.supported}, not ${pair.available}`, notAvail]);
  const others = (s.enum || []).filter((v) => !main.includes(v) && !notAvail.includes(v));
  if (others.length) groups.push(['other values from the capability', others]);
  return groups;
}

// Options for a list attribute (supportedX / availableX / any array with items.enum). null = keep JSON box.
export function listOptions(capDef, capStatus, attrName) {
  const s = valueSchema(capDef, attrName);
  const { byValue, byList } = computeCapPairs(capDef);
  const valueAttr = byList[attrName];
  const own = listValueFromStatus(capStatus, attrName);
  const opts = [...(s.itemsEnum || [])];
  if (valueAttr) {
    const pair = byValue[valueAttr] || {};
    if (attrName === pair.available) opts.push(...listValueFromStatus(capStatus, pair.supported));
    opts.push(...(valueSchema(capDef, valueAttr).enum || []));
  }
  const cur = capStatus?.[attrName]?.value;
  if (!valueAttr && !s.itemsEnum) return null;
  if (cur !== undefined && cur !== null && !Array.isArray(cur)) return null;
  if (Array.isArray(cur) && cur.some((x) => x !== null && typeof x === 'object')) return null; // lists of objects stay JSON
  return uniq([...opts, ...own]);
}

// Short explanation shown (via the ⓘ button) for every supportedX / availableX attribute, whatever the capability.
export function listHint(attrName) {
  const m = LIST_PREFIX.exec(attrName);
  if (!m) return '';
  return m[1] === 'supported'
    ? '<b>supported…</b> = everything this device can do at all. It rarely changes.'
    : '<b>available…</b> = what can be chosen <em>right now</em>: a subset of the matching <code>supported…</code> list that changes with the current mode (for example, in dry mode a high fan speed may be unavailable). <b>Test tip:</b> inject a shorter list here to check that your app hides or blocks the rest.';
}
