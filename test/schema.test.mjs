import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertValue,
  valueSchema,
  pairScore,
  computeCapPairs,
  valueOptions,
  listOptions,
  listHint,
} from '../public/js/schema.js';

describe('schema: convertValue', () => {
  it('converts integer, number, boolean, array, object, string', () => {
    assert.equal(convertValue('42', 'integer'), 42);
    assert.equal(convertValue('3.14', 'number'), 3.14);
    assert.equal(convertValue('true', 'boolean'), true);
    assert.equal(convertValue('false', 'boolean'), false);
    assert.deepEqual(convertValue('["a","b"]', 'array'), ['a', 'b']);
    assert.deepEqual(convertValue('{"k":1}', 'object'), { k: 1 });
    assert.equal(convertValue('cool', 'string'), 'cool');
  });

  it('throws on invalid numbers', () => {
    assert.throws(() => convertValue('abc', 'integer'), /Enter an integer/);
    assert.throws(() => convertValue('xyz', 'number'), /Enter a number/);
  });
});

describe('schema: computeCapPairs / valueOptions / listOptions', () => {
  const acFanCap = {
    id: 'airConditionerFanMode',
    attributes: {
      fanMode: { schema: { properties: { value: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'turbo'] } } } },
      supportedAcFanModes: { schema: { properties: { value: { type: 'array' } } } },
      availableAcFanModes: { schema: { properties: { value: { type: 'array' } } } },
    },
  };

  it('pairs supported* and available* lists with their value attribute', () => {
    assert.ok(pairScore('supportedAcFanModes', 'fanMode') > 0);
    const { byValue, byList } = computeCapPairs(acFanCap);
    assert.deepEqual(byValue.fanMode, {
      supported: 'supportedAcFanModes',
      available: 'availableAcFanModes',
    });
    assert.equal(byList.supportedAcFanModes, 'fanMode');
    assert.equal(byList.availableAcFanModes, 'fanMode');
  });

  it('builds grouped valueOptions prioritizing available* over supported* over capability enum', () => {
    const status = {
      supportedAcFanModes: { value: ['auto', 'low', 'medium', 'high'] },
      availableAcFanModes: { value: ['auto', 'low'] },
    };
    const groups = valueOptions(acFanCap, status, 'fanMode');
    assert.deepEqual(groups, [
      ['availableAcFanModes', ['auto', 'low']],
      ['in supportedAcFanModes, not availableAcFanModes', ['medium', 'high']],
      ['other values from the capability', ['turbo']],
    ]);
  });

  it('falls back to supported* when available* is empty', () => {
    const status = {
      supportedAcFanModes: { value: ['auto', 'low'] },
      availableAcFanModes: { value: [] },
    };
    const groups = valueOptions(acFanCap, status, 'fanMode');
    assert.equal(groups[0][0], 'supportedAcFanModes');
    assert.deepEqual(groups[0][1], ['auto', 'low']);
  });

  it('builds listOptions combining supported values, capability enum, and current values without duplicates', () => {
    const status = {
      supportedAcFanModes: { value: ['auto', 'low', 'customWind'] },
      availableAcFanModes: { value: ['auto'] },
    };
    const opts = listOptions(acFanCap, status, 'availableAcFanModes');
    assert.deepEqual(opts, ['auto', 'low', 'customWind', 'medium', 'high', 'turbo']);
  });

  it('keeps list of objects as JSON (returns null for listOptions)', () => {
    const status = {
      supportedAcFanModes: { value: [{ name: 'complex' }] },
    };
    assert.equal(listOptions(acFanCap, status, 'supportedAcFanModes'), null);
  });

  it('returns helpful hints for supported* and available* attributes', () => {
    assert.match(listHint('supportedAcModes'), /supported/);
    assert.match(listHint('availableAcFanModes'), /available/);
    assert.equal(listHint('fanMode'), '');
  });

  it('extracts valueSchema defaults and units', () => {
    const tempCap = {
      attributes: {
        temperature: {
          schema: {
            properties: {
              value: { type: 'number', minimum: -460, maximum: 10000 },
              unit: { type: 'string', enum: ['C', 'F'], default: 'C' },
            },
            required: ['value'],
          },
        },
      },
    };
    const s = valueSchema(tempCap, 'temperature');
    assert.equal(s.type, 'number');
    assert.equal(s.min, -460);
    assert.equal(s.max, 10000);
    assert.deepEqual(s.units, ['C', 'F']);
    assert.equal(s.unitDefault, 'C');
  });
});
