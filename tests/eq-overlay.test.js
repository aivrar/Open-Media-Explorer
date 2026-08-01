import test from 'node:test';
import assert from 'node:assert/strict';

import {
  curveAfterEqInput, flushEqPersistence, initEqOverlay,
} from '../src/lib/eq-overlay.js';
import {
  BUILT_IN_EQ_PRESETS, createCustomEqPresetKey, customEqPresetId,
  customEqPresetKey, getBuiltInEqPreset, snapshotEqPreset,
} from '../src/lib/eq-presets.js';

test('built-in EQ presets are immutable, complete, and headroom-safe', () => {
  assert.deepEqual(BUILT_IN_EQ_PRESETS.map((preset) => preset.name), [
    'Flat', 'Bass Boost', 'Treble Boost', 'Vocal', 'Spoken Word',
    'Rock', 'Classical', 'Jazz', 'Electronic', 'Night',
  ]);
  for (const preset of BUILT_IN_EQ_PRESETS) {
    assert.equal(Object.isFrozen(preset), true);
    assert.equal(Object.isFrozen(preset.curve), true);
    assert.equal(Object.isFrozen(preset.curve.bands), true);
    assert.equal(preset.curve.bands.length, 10);
    assert.ok(
      preset.curve.preamp + Math.max(0, ...preset.curve.bands) <= 0,
      `${preset.name} must reserve headroom for its largest boost`,
    );
  }
  const flat = getBuiltInEqPreset('flat');
  flat.bands[0] = 12;
  assert.equal(getBuiltInEqPreset('flat').bands[0], 0, 'callers receive snapshots, not templates');
});

test('preamp retains preset identity, band edits detach built-ins, and custom presets stay live', () => {
  const preampEdit = curveAfterEqInput(getBuiltInEqPreset('rock'), {
    kind: 'preamp', gain: -6.5,
  });
  assert.equal(preampEdit.presetId, 'rock', 'preamp must retain the selected frequency preset');
  assert.equal(preampEdit.preamp, -6.5);

  const builtInEdit = curveAfterEqInput(getBuiltInEqPreset('rock'), {
    kind: 'band', index: 3, gain: 7.5,
  });
  assert.equal(builtInEdit.presetId, 'manual');
  assert.equal(builtInEdit.bands[3], 7.5);

  const customId = customEqPresetId('preset-abc');
  const customEdit = curveAfterEqInput({
    preamp: -3, bands: Array(10).fill(0), presetId: customId,
  }, { kind: 'preamp', gain: -5.5 });
  assert.equal(customEdit.presetId, customId);
  assert.equal(customEdit.preamp, -5.5);
  assert.equal(customEqPresetKey(customEdit.presetId), 'preset-abc');

  const bypassed = snapshotEqPreset(customEdit, customId);
  assert.equal(bypassed.presetId, customId);
  assert.equal(createCustomEqPresetKey(() => 'fixed-uuid'), 'preset-fixed-uuid');
});

test('EQ lifecycle owns one page-hide persistence hook and removes the same hook', () => {
  const previousWindow = globalThis.window;
  const added = [];
  const removed = [];
  globalThis.window = {
    addEventListener: (name, handler) => added.push([name, handler]),
    removeEventListener: (name, handler) => removed.push([name, handler]),
  };
  try {
    assert.doesNotThrow(() => flushEqPersistence(), 'no active overlay is a safe no-op');
    const lifecycle = initEqOverlay();
    assert.equal(added.length, 1);
    assert.equal(added[0][0], 'pagehide');
    lifecycle.destroy();
    assert.equal(removed.length, 1);
    assert.equal(removed[0][0], 'pagehide');
    assert.equal(removed[0][1], added[0][1]);
  } finally {
    globalThis.window = previousWindow;
  }
});
