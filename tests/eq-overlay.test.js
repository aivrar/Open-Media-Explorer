import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  curveAfterEqInput, flushEqPersistence, initEqOverlay, openEqOverlay,
} from '../src/lib/eq-overlay.js';
import {
  BUILT_IN_EQ_PRESETS, createCustomEqPresetKey, customEqPresetId,
  customEqPresetKey, getBuiltInEqPreset, snapshotEqPreset,
} from '../src/lib/eq-presets.js';

import {
  EQ_STORAGE_KEY, freshEqState, getEffectiveEq, loadEqState, saveEqState, setCustomEqPreset,
  setScopedEq, setStationEqPreset,
} from '../src/lib/eq-store.js';
import { cancelScheduledProfileHandoff } from '../src/lib/profile-transfer.js';
import { getAudioFrequencyResponse } from '../src/lib/player.js';
import { emit, getState, setCurrentItem, setPlaying, subscribe } from '../src/lib/state.js';
import { TUNER_TONES, turnTunerTone } from '../src/lib/tuner-tone.js';
import { FakeElement, createFakeDocument } from './helpers/fake-dom.js';

test('built-in EQ presets are immutable, complete, and headroom-safe', () => {
  assert.deepEqual(BUILT_IN_EQ_PRESETS.map((preset) => preset.name), [
    'Flat', 'Bass Boost', 'Treble Boost', 'Vocal', 'Spoken Word',
    'Rock', 'Classical', 'Jazz', 'Electronic', 'Night',
  ]);
  for (const preset of BUILT_IN_EQ_PRESETS) {
    assert.equal(Object.isFrozen(preset), true);
    assert.equal(Object.isFrozen(preset.curve), true);
    assert.equal(Object.isFrozen(preset.curve.bands), true);
    assert.equal(Object.isFrozen(preset.curve.q), true);
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

test('preamp and custom edits retain preset identity and band edits detach built-ins', () => {
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

test('a Q edit changes only one width and Reset can restore the preset defaults', () => {
  const rock = getBuiltInEqPreset('rock');
  const changed = curveAfterEqInput(rock, { kind: 'q', index: 3, gain: 3.5 });
  assert.equal(changed.presetId, 'manual');
  assert.deepEqual(changed.bands, rock.bands);
  assert.equal(changed.preamp, rock.preamp);
  assert.deepEqual(changed.q, rock.q.map((value, index) => index === 3 ? 3.5 : value));
  const flat = getBuiltInEqPreset('flat');
  assert.equal(flat.preamp, 0);
  assert.deepEqual(flat.q, rock.q);
});

test('station and Q controls use labelled inputs and default to closed', () => {
  const overlay = readFileSync(new URL('../src/lib/eq-overlay.js', import.meta.url), 'utf8');
  assert.match(overlay, /<details class="eq-stations" data-eq-stations>\s*<summary>Stations\.\.\.<\/summary>/);
  assert.match(overlay, /<details class="eq-advanced">\s*<summary>Advanced<\/summary>/);
  assert.match(overlay, /<label for="eq-station-filter">Filter stations<\/label>/);
  assert.match(overlay, /<label for="eq-station-preset">Use preset<\/label>/);
  assert.match(overlay, /Stop using for this station/);
});

test('short EQ fits the faders and labels at 640px and the Advanced row at 800px', () => {
  const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  assert.match(css, /\.eq-content \{\s*overflow: auto;\s*overscroll-behavior: contain;/);
  assert.match(css, /\.eq-band \{\s*display: grid;\s*grid-template-rows: 24px 190px 22px;/);
  assert.match(css, /\.eq-band-slider \{[^}]*height: 184px;/);
  const short = css.split('@media (height < 900px) {')[1].split('\n}')[0];
  const padding = selector => 2 * Number(short.match(new RegExp(selector + ' \\{\\s*padding-block: (\\d+)px;'))[1]);
  const header = 15 * 1.45 + 3 + 12 * 1.45 + 1 + padding('.eq-header');
  const toolbar = 13 * 1.45 + 14 + 1 + padding('.eq-preset-row');
  const preset = 34 + 1 + padding('.eq-preset-row');
  const presetName = 14 * 1.45 + 16 + 1 + padding('.eq-preset-row');
  const summary = 14 * 1.45 + 6 + padding('.eq-advanced');
  assert.match(short, /\.eq-toolbar,\s*\.eq-preset-row \{/);
  assert.match(short, /\.eq-stations,\s*\.eq-advanced \{/);
  assert.match(short, /\.eq-response \{ height: clamp\(64px, 10vh, 96px\); margin-top: 8px; \}/);
  assert.match(short, /\.eq-bands \{\s*--eq-fader-height: clamp\(130px, 20vh, 172px\);\s*min-height: 0;\s*padding-block: 6px;/);
  assert.match(short, /grid-template-rows: 20px calc\(var\(--eq-fader-height\) \+ 6px\) 18px;\s*padding-block: 2px;/);
  assert.match(short, /\.eq-band-slider \{ height: var\(--eq-fader-height\); \}/);

  for (const height of [640, 800]) {
    const curve = Math.max(64, Math.min(height * 0.1, 96)) + 8;
    const slider = Math.max(130, Math.min(height * 0.2, 172));
    const bands = 20 + slider + 6 + 18 + 4 + 12;
    const throughBands = 2 + header + toolbar + preset + presetName + summary + 1 + curve + bands;
    // Include the stacked player at 640px, which leaves less room than the 74px player.
    const maxHeight = Math.min(height * 0.88, height - 20 - (height === 640 ? 120 : 74));
    assert.ok(slider - 20 >= 110, 'the fader has room for at least 110px of travel with a 20px thumb');
    assert.ok(throughBands + (height === 800 ? summary : 0) <= maxHeight);
  }
});

function withOverlay(run) {
  class Element extends FakeElement {
    get childElementCount() { return this.children.length; }
    get childNodes() { return this.children; }
    append(...children) { for (const child of children) this.appendChild(child); }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    replaceChildren(...children) {
      if (this !== document.activeElement && this.contains(document.activeElement)) document.activeElement = document.body;
      this.children = children.flatMap((child) => child.tagName === '#FRAGMENT' ? child.children : [child]);
    }
    focus() { document.activeElement = this; }
  }

  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const { currentItem: previousItem, isPlaying: wasPlaying } = getState();
  const previousFavorites = getState().favorites;
  const elements = new Map();
  const op = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const action = (name) => op(`[data-eq-act="${name}"]`);
  const slider = new Element();
  slider.dataset = { kind: 'band', index: '0' };
  slider.closest = (selector) => selector === 'input[data-kind]' ? slider : op('band-label');
  op('band-label').querySelector = () => op('band-value');
  const root = new Element();
  root.querySelector = op;
  root.querySelectorAll = () => [slider];
  const document = createFakeDocument([new Element('app')]);
  document.createElement = (tag) => tag === 'div' ? root : new Element('', tag);
  document.createDocumentFragment = () => new Element('', '#fragment');
  const stored = new Map();
  globalThis.document = document;
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.window = { setTimeout, clearTimeout };
  const current = { id: 'radio:one', type: 'radio', title: 'One FM' };
  const change = (value) => {
    slider.value = String(value);
    const input = new Event('input');
    Object.defineProperty(input, 'target', { value: slider });
    root.dispatchEvent(input);
    flushEqPersistence();
  };
  try {
    setCurrentItem(current);
    setPlaying(true);
    run({ action, op, slider, document, current, change });
  } finally {
    root._close?.();
    cancelScheduledProfileHandoff();
    getState().favorites = previousFavorites;
    setCurrentItem(previousItem);
    setPlaying(wasPlaying);
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
  }
}

test('assigned controls stay locked until Edit preset is selected', () => {
  withOverlay(({ action, op, slider, current, change }) => {
    const other = 'radio:two';
    const id = customEqPresetId('shared');
    const eq = setCustomEqPreset(freshEqState(), 'shared', 'Shared', { bands: [4] });
    saveEqState(setStationEqPreset(eq, [current.id, other], id));
    openEqOverlay();
    assert.equal(op('[data-eq-assigned-name]').textContent, 'Using preset Shared for this station');
    assert.equal(slider.disabled, true);
    change(9);
    assert.equal(getEffectiveEq(loadEqState(), other).bands[0], 4);

    action('edit-preset').dispatchEvent(new Event('click'));
    assert.equal(slider.disabled, false);
    change(7);
    assert.equal(getEffectiveEq(loadEqState(), other).bands[0], 7);
    assert.equal(loadEqState().global.bands[0], 0);

    action('edit-preset').dispatchEvent(new Event('click'));
    assert.equal(slider.disabled, true);
    action('stop-preset').dispatchEvent(new Event('click'));
    assert.equal(slider.disabled, false);
    assert.equal(slider.value, '0');
    assert.deepEqual(loadEqState().assignments, { [other]: id });
  });
});

test('the EQ panel opens on the favorite curve saved by a tone knob', (t) => {
  const previews = [];
  t.after(subscribe('eq-preview', (preview) => previews.push(preview)));
  withOverlay(({ current, op, slider, change }) => {
    getState().favorites = [current];
    assert.equal(turnTunerTone(TUNER_TONES.bass, 2), true);
    openEqOverlay();
    const scope = op('[data-eq-scope]');
    assert.equal(scope.dataset.scope, 'favorite');
    assert.equal(scope.textContent, 'One FM');
    assert.equal(slider.value, '2');
    change(3);
    assert.equal(previews.at(-1).itemId, current.id);
    assert.equal(previews.at(-1).mainEq, false);
    assert.equal(previews.at(-1).curve.bands[0], 3);
    assert.equal(loadEqState().favorites[current.id].bands[0], 3);
    assert.equal(loadEqState().global.bands[0], 0);
  });
});

test('a tone turn flushes pending slider edits and refreshes the open overlay', () => {
  withOverlay(({ current, op, slider }) => {
    getState().favorites = [current];
    const rock = getBuiltInEqPreset('rock');
    saveEqState(setScopedEq(loadEqState(), current.id, false, { ...rock, bypassed: true }));
    const root = openEqOverlay();
    slider.value = '7';
    const input = new Event('input');
    Object.defineProperty(input, 'target', { value: slider });
    root.dispatchEvent(input);
    assert.equal(loadEqState().global.bands[0], 4, 'the overlay has a pending edit');
    assert.equal(turnTunerTone(TUNER_TONES.bass, 6), true);
    assert.equal(slider.value, '8');
    assert.equal(op('[data-eq-bypass]').checked, false);
    assert.equal(op('[data-eq-preset]').value, 'manual');
    assert.equal(op('[data-eq-scope]').dataset.scope, 'favorite');
    const eq = loadEqState();
    assert.equal(getEffectiveEq(eq, current.id, true).bands[1], 4);
    assert.equal(eq.global.bands[0], 7);
    assert.equal(eq.global.bypassed, true);
  });
});

test('closing the preset editor restores the saved favorite curve even without input', () => {
  withOverlay(({ action, current }) => {
    getState().favorites = [current];
    const presetId = customEqPresetId('shared');
    const eq = setCustomEqPreset(freshEqState(), 'shared', 'Shared', { bands: [8] });
    saveEqState(setScopedEq(eq, current.id, true, { bands: [2], presetId }));
    const response = () => getAudioFrequencyResponse([10])[0];
    openEqOverlay();
    const saved = response();
    action('edit-preset').dispatchEvent(new Event('click'));
    assert.ok(response() > saved + 3);
    action('close').dispatchEvent(new Event('click'));
    assert.equal(response(), saved);
    assert.equal(loadEqState().favorites[current.id].bands[0], 2);
  });
});

test('the station list restores checkbox focus on refresh and falls back to the filter', () => {
  withOverlay(({ op, document, current }) => {
    getState().favorites = [{ ...current, title: 'One FM' }];
    openEqOverlay();
    op('[data-eq-stations]').open = true;
    const list = op('.eq-station-list');
    const checkbox = () => list.children[0].children[0].children[0];
    emit('playlists-change');
    checkbox().focus();
    emit('playlists-change');
    assert.equal(document.activeElement, checkbox());
    getState().favorites = [];
    emit('playlists-change');
    assert.equal(document.activeElement, op('#eq-station-filter'));
  });
});

test('the EQ editor shows why a save would exceed the combined profile limit', () => {
  withOverlay(({ action, op }) => {
    saveEqState(freshEqState());
    const before = localStorage.getItem(EQ_STORAGE_KEY);
    localStorage.setItem('worldmedia.settings.v1', 'x'.repeat(2 * 1024 * 1024 - before.length));
    openEqOverlay();
    op('[data-eq-preset-name]').value = 'A new preset';
    action('new-preset').dispatchEvent(new Event('click'));
    assert.equal(localStorage.getItem(EQ_STORAGE_KEY), before);
    assert.match(op('[data-eq-save-message]').textContent, /profile is full/i);
    assert.equal(op('[data-eq-save-message]').hidden, false);
  });
});
