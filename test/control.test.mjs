import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { state, setCapDef } from '../public/js/state.js';
import { updateCurrentValues } from '../public/js/views/control.js';

function setupRow(value = '60') {
  const input = { value };
  const range = { value };
  const current = { textContent: `${value} %`, parentElement: { classList: { add() {}, remove() {} } } };
  const row = {
    dataset: { comp: 'main', cap: 'audioVolume', ver: '1', attr: 'volume', type: 'integer', opts: '', numericValue: value },
    querySelector(selector) {
      return { '.attr-cur .val': current, 'input.inp': input, 'input.rng': range }[selector] || null;
    },
    querySelectorAll() { return []; },
  };
  globalThis.document = {
    activeElement: {},
    querySelectorAll: () => [row],
    querySelector: () => null,
  };
  setCapDef('audioVolume', 1, {
    attributes: { volume: { schema: { properties: { value: { type: 'integer', minimum: 0, maximum: 100 } } } } },
  });
  return { input, range, current, row };
}

function refreshVolume(value) {
  state.status = { components: { main: { audioVolume: { volume: { value, unit: '%' } } } } };
  updateCurrentValues(false);
}

describe('control: refreshing numeric values', () => {
  afterEach(() => {
    delete globalThis.document;
    state.status = null;
    state.caps = {};
  });

  it('updates both an unchanged slider and its number input from the new status', () => {
    const { input, range, current } = setupRow();
    refreshVolume(42);
    assert.equal(current.textContent, '42 %');
    assert.equal(input.value, '42');
    assert.equal(range.value, '42');
    refreshVolume(0);
    assert.equal(input.value, '0');
    assert.equal(range.value, '0');
  });

  it('preserves an unsent edit across status refreshes', () => {
    const { input, range, current } = setupRow();
    input.value = '75';
    range.value = '75';
    refreshVolume(42);
    refreshVolume(43);
    assert.equal(current.textContent, '43 %');
    assert.equal(input.value, '75');
    assert.equal(range.value, '75');
    refreshVolume(75);
    refreshVolume(25);
    assert.equal(input.value, '25');
    assert.equal(range.value, '25');
  });

  it('does not replace a focused numeric input while the user is editing', () => {
    const { input, range, current } = setupRow();
    document.activeElement = input;
    refreshVolume(42);
    assert.equal(current.textContent, '42 %');
    assert.equal(input.value, '60');
    assert.equal(range.value, '60');
  });
});
