import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { EQ_FREQUENCIES } from '../src/lib/audio-engine.js';
import {
  getEffectiveEq, loadEqState, normalizeEqCurve, saveEqState, setEqBypassed,
  setCustomEqPreset, setScopedEq, setStationEqPreset,
} from '../src/lib/eq-store.js';
import { customEqPresetId, getBuiltInEqPreset } from '../src/lib/eq-presets.js';
import { EXTRA_SETTINGS_STORAGE_KEY } from '../src/lib/profile-storage.js';
import { captureProfileStorage, LEGACY_PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import {
  clearCache, emit, getState, initState, normalizeSettings, removeFavorite, saveSettings,
  setCurrentItem, setPlaying, STORAGE_KEYS, subscribe,
} from '../src/lib/state.js';
import { curveAfterToneTurn, readTunerTone, readTunerToneCurve, TUNER_TONES, tunerToneValue, turnTunerTone } from '../src/lib/tuner-tone.js';
import { buildDialSvg } from '../src/modes/tuner-dial.js';
import { tunerStageLayout } from '../src/modes/tuner-layout.js';
import { mountToneKnobs } from '../src/modes/tuner-tone-knobs.js';
import { FakeElement } from './helpers/fake-dom.js';

const { bass, treble, loudness } = TUNER_TONES;

function memoryProfile(t) {
  const { localStorage } = globalThis;
  const { currentItem, favorites, isPlaying, settings } = getState();
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  t.after(() => {
    globalThis.localStorage = localStorage;
    getState().favorites = favorites;
    getState().settings = settings;
    setCurrentItem(currentItem);
    setPlaying(isPlaying);
  });
  return values;
}

test('tone weights use the real EQ bands and knob values use the primary bands and slider step', () => {
  const weights = (tone) => EQ_FREQUENCIES.flatMap((hz, index) => tone.weights[index] ? [[hz, tone.weights[index]]] : []);
  assert.deepEqual(weights(bass), [[31, 1], [62, 1], [125, 0.75], [250, 0.4]]);
  assert.deepEqual(weights(treble), [[4000, 0.4], [8000, 0.75], [16000, 1]]);
  const curve = normalizeEqCurve({ preamp: -2.5, bands: [2, 3.5, 11, 10, 9, 8, 7, 6, 5, -4.5] });
  assert.equal(tunerToneValue(bass, curve), 3);
  assert.equal(tunerToneValue(treble, curve), -4.5);
  assert.equal(tunerToneValue(loudness, curve), -2.5);
});

test('turns apply a weighted delta against the curve, clamp to the sliders, and reset to zero', () => {
  const curve = normalizeEqCurve({ preamp: 1, bands: [6, 2, 11, -12, 5, 5, 5, 10, 7, 8], presetId: 'rock' });
  const bassTurn = curveAfterToneTurn(curve, bass, 15);
  assert.deepEqual(bassTurn.bands, [12, 10, 12, -8.8, 5, 5, 5, 10, 7, 8]);
  assert.equal(tunerToneValue(bass, bassTurn), 11, 'show the curve even when a primary band clips');
  assert.equal(bassTurn.presetId, 'manual');
  assert.equal(bassTurn.preamp, 1);
  const trebleTurn = curveAfterToneTurn(curve, treble, 12);
  assert.deepEqual(trebleTurn.bands.slice(7), [11.6, 10, 12]);
  assert.deepEqual(curveAfterToneTurn(curve, bass, 0).bands.slice(0, 4), [2, -2, 8, -12]);
  const preampTurn = curveAfterToneTurn(curve, loudness, 12);
  assert.equal(preampTurn.preamp, 6);
  assert.equal(preampTurn.presetId, 'manual');
  assert.deepEqual(preampTurn.bands, curve.bands);
  assert.equal(curveAfterToneTurn(preampTurn, loudness, 0).preamp, 0);
  assert.equal(curveAfterToneTurn(curve, loudness, -24).preamp, -12);
});

test('a turn and its reverse recover the same gains when nothing clipped', () => {
  const curve = normalizeEqCurve({ preamp: 1, bands: [-0.5, 0.5, 0.25, 0.2, 5, 5, 5, -1.5, 2.5, -0.5] });
  for (const tone of Object.values(TUNER_TONES)) {
    const value = tunerToneValue(tone, curve);
    const raised = curveAfterToneTurn(curve, tone, value + 2.5);
    assert.equal(tunerToneValue(tone, raised), value + 2.5);
    assert.deepEqual(curveAfterToneTurn(raised, tone, value), { ...curve, presetId: 'manual' });
  }
});

test('a favorite with Main EQ saves its first turn to its own curve', (t) => {
  memoryProfile(t);
  const station = { type: 'radio', id: 'radio:one', title: 'One FM' };
  const other = { type: 'tv', id: 'tv:two' };
  getState().favorites = [station, other];
  setCurrentItem(station);
  setPlaying(true);
  const global = normalizeEqCurve({ bands: [1, 2, 3, 4, 5], preamp: -4, q: [2, 3] });
  saveEqState(setScopedEq(loadEqState(), station.id, false, global));
  assert.deepEqual(readTunerToneCurve(), global);

  assert.equal(turnTunerTone(bass, 3.5), true);
  const eq = loadEqState();
  const own = { ...global, bands: [3, 4, 4.5, 4.8, 5, 0, 0, 0, 0, 0], presetId: 'manual' };
  assert.deepEqual(eq.global, global);
  assert.deepEqual(eq.favorites, { [station.id]: own });
  assert.deepEqual(readTunerTone(), { curve: own, scope: 'Saved for One FM', stationName: 'One FM' });

  setCurrentItem(other);
  assert.deepEqual(readTunerTone().curve, global);
  setCurrentItem(station);
  assert.deepEqual(readTunerTone().curve, own);
  assert.equal(removeFavorite(station.id), true);
  assert.deepEqual(loadEqState().favorites, {});
  assert.deepEqual(readTunerTone(), { curve: global, scope: 'Adjusting the main EQ', stationName: '' });
});

test('the first turn copies an assigned preset and detaches it for that favorite only', (t) => {
  memoryProfile(t);
  const station = { type: 'radio', id: 'radio:one' };
  const other = { type: 'radio', id: 'radio:two' };
  getState().favorites = [station, other];
  setCurrentItem(station);
  setPlaying(true);
  const presetId = customEqPresetId('mix');
  let eq = loadEqState();
  const preset = normalizeEqCurve({ ...getBuiltInEqPreset('bass-boost'), q: [1.5, 2], presetId });
  eq = setCustomEqPreset(eq, 'mix', 'My mix', preset);
  eq = setEqBypassed(eq, undefined, false, true);
  const global = eq.global;
  saveEqState(setStationEqPreset(eq, [station.id, other.id], presetId));
  const events = [];
  const offGesture = subscribe('eq-user-gesture', ({ item }) => events.push(item.id));
  const offChange = subscribe('eq-change', () => events.push('changed'));
  t.after(offGesture);
  t.after(offChange);

  assert.deepEqual(readTunerTone().curve, { ...preset, bypassed: true });
  assert.equal(turnTunerTone(bass, 6.5), true);
  eq = loadEqState();
  const own = {
    ...preset, bands: [7, 6, 4.75, 2.4, ...preset.bands.slice(4)], presetId: 'manual', bypassed: false,
  };
  assert.deepEqual(events, ['changed', station.id]);
  assert.deepEqual(eq.assignments, { [other.id]: presetId });
  assert.deepEqual(eq.global, global);
  assert.deepEqual(eq.customPresets.mix, { ...preset, name: 'My mix' });
  assert.deepEqual(eq.favorites, { [station.id]: own });
  assert.deepEqual(readTunerTone().curve, own);
  setCurrentItem(other);
  assert.deepEqual(readTunerTone().curve, { ...preset, bypassed: true });
  setCurrentItem(station);
  assert.deepEqual(readTunerTone().curve, own);
});

test('tone toggle defaults off and survives reload through the extra settings only', async (t) => {
  const values = memoryProfile(t);
  assert.equal(normalizeSettings({}).tunerToneKnobs, false);
  assert.equal(normalizeSettings({ tunerToneKnobs: 'true' }).tunerToneKnobs, false);
  saveSettings({ theme: 'dark' });
  assert.equal(values.has(EXTRA_SETTINGS_STORAGE_KEY), false);
  await initState();
  assert.equal(getState().settings.tunerToneKnobs, false);
  saveSettings({ tunerToneKnobs: true });
  assert.equal(Object.hasOwn(JSON.parse(values.get(STORAGE_KEYS.settings)), 'tunerToneKnobs'), false);
  assert.equal(LEGACY_PROFILE_STORAGE_KEYS.includes(EXTRA_SETTINGS_STORAGE_KEY), false);
  const handoff = captureProfileStorage();
  assert.deepEqual(JSON.parse(handoff[EXTRA_SETTINGS_STORAGE_KEY]), { tunerToneKnobs: true });
  await initState();
  assert.equal(getState().settings.tunerToneKnobs, true);
  saveSettings({ tunerToneKnobs: false });
  await initState();
  assert.equal(getState().settings.tunerToneKnobs, false);
  values.set(EXTRA_SETTINGS_STORAGE_KEY, JSON.stringify({ tunerToneKnobs: true, futureSetting: 42 }));
  saveSettings({ theme: 'dark' });
  assert.equal(getState().settings.tunerToneKnobs, true, 'preserve a newer save from another window');
  saveSettings({ tunerToneKnobs: false });
  assert.deepEqual(JSON.parse(values.get(EXTRA_SETTINGS_STORAGE_KEY)), { tunerToneKnobs: false, futureSetting: 42 });
  await clearCache();
  assert.equal(values.has(EXTRA_SETTINGS_STORAGE_KEY), false);
  assert.equal(getState().settings.tunerToneKnobs, false);
});

test('Stations defaults on and saves and restores through the extra profile', async (t) => {
  const values = memoryProfile(t);
  values.set(STORAGE_KEYS.settings, JSON.stringify({ tunerStations: false }));
  await initState();
  assert.equal(getState().settings.tunerStations, true, 'read the toggle from extra preferences');
  values.set(EXTRA_SETTINGS_STORAGE_KEY, JSON.stringify({ tunerToneKnobs: true, future: 42 }));
  saveSettings({ tunerStations: false });
  assert.equal(Object.hasOwn(JSON.parse(values.get(STORAGE_KEYS.settings)), 'tunerStations'), false);
  assert.deepEqual(JSON.parse(captureProfileStorage()[EXTRA_SETTINGS_STORAGE_KEY]), {
    tunerToneKnobs: true, tunerStations: false, future: 42,
  });
  await initState();
  assert.equal(getState().settings.tunerStations, false);
  saveSettings({ tunerStations: true });
  await initState();
  assert.equal(getState().settings.tunerStations, true);
});

test('three knobs use full names below their rims and use a large outlined label', async () => {
  const css = await readFile(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  assert.match(css, /\.tuner-tone-label \{[^}]*position: absolute;/);
  assert.match(css, /\.tuner-tone-knob \{[^}]*font-size: var\(--tone-label-font\);[^}]*font-weight: 700;/);
  assert.doesNotMatch(css, /tuner-tone-value|tuner-tone-scope/);
  assert.match(buildDialSvg(), /viewBox="0 0 400 400"/);
  assert.match(buildDialSvg(), /id="knobGrad"/);
  const toneSvg = buildDialSvg(true);
  assert.doesNotMatch(toneSvg, /<defs>/);
  assert.match(toneSvg, /viewBox="9 9 382 382"/);
  assert.match(toneSvg, /<circle cx="200" cy="200" r="190" class="tuner-bezel"\/>/);
  assert.match(toneSvg, /fill="url\(#knobGrad\)"/);
  assert.match(toneSvg, /x1="200" y1="42" x2="200" y2="74"[^>]+stroke-width="8"/);
});

test('tone knobs share the dial shadow and hover colors with room for the scaled glow', async () => {
  const css = await readFile(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  assert.match(css, /--dial-shadow-color: rgba\(0, 0, 0, 0\.5\);/);
  assert.match(css, /--dial-glow-ring: color-mix\(in srgb, var\(--accent\) 30%, transparent\);/);
  assert.match(css, /--dial-glow-halo: color-mix\(in srgb, var\(--accent\) 32%, transparent\);/);
  assert.match(css, /\.tuner-dial \{[^}]*drop-shadow\(0 12px 32px var\(--dial-shadow-color\)\)/);
  assert.match(css, /\.tuner-dial\.can-turn:hover \{[^}]*var\(--dial-glow-ring\)[^}]*var\(--dial-glow-halo\)/);
  assert.match(css, /\.tuner-dial\.can-turn:hover ~ \.tuner-tone-column \.tuner-tone-knob svg \{[^}]*max\(3px, calc\(16px \* var\(--tone-glow-scale\)\)\)[^}]*max\(0\.75px, calc\(2px \* var\(--tone-glow-scale\)\)\) var\(--dial-glow-halo\)/);
  assert.match(css, /\.tuner-tone-knob svg \{[^}]*overflow: visible;[^}]*border-radius: 50%;[^}]*var\(--dial-shadow-color\)/);
  assert.doesNotMatch(css, /\.tuner-tone-(?:knob|column) \{[^}]*overflow: (?:hidden|clip)/);
});

test('pointer focus has no outline and keyboard focus paints the round bezel', async () => {
  const css = await readFile(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  assert.match(css, /\.tuner-tone-knob:focus \{ outline: none; \}/);
  assert.match(css, /\.tuner-tone-knob:focus-visible:not\(\.is-pointer-input\) \.tuner-bezel \{\s*stroke: var\(--accent\);\s*stroke-width: 2px;\s*vector-effect: non-scaling-stroke;\s*\}/);
  assert.match(css, /\.tuner-toggle:focus:not\(:focus-visible\) \{ outline: none; \}/);
});

function fakeStage(t) {
  class KnobElement extends FakeElement {
    constructor() {
      super();
      this.parts = new Map();
      this.style.setProperty = (name, value) => { this.style[name] = value; };
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      }
      node.parentElement = this;
      return super.appendChild(node);
    }
    querySelector(selector) {
      if (!this.parts.has(selector)) this.parts.set(selector, new KnobElement());
      return this.parts.get(selector);
    }
    focus() { assert.fail('pointer input must leave focus to the browser'); }
    remove() {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 50, height: 50 }; }
  }
  const globals = {
    document: Object.assign(new EventTarget(), { createElement: () => new KnobElement() }),
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const stage = new KnobElement();
  const mounted = mountToneKnobs(stage);
  mounted.setLayout(tunerStageLayout({ width: 1280, height: 607, tone: true }).knobs);
  const unmount = () => { if (mounted.column.parentElement) mounted.destroy(); };
  t.after(unmount);
  return { stage, mounted, unmount };
}

function dispatch(target, type, fields) {
  const event = Object.assign(new Event(type, { cancelable: true }), fields);
  target.dispatchEvent(event);
  return event;
}

test('mounted knobs follow preset previews and scope, capture rotary drag and announce only on commit', (t) => {
  memoryProfile(t);
  const station = { type: 'tv', id: 'tv:one', title: 'Channel One' };
  const other = { type: 'radio', id: 'radio:favorite', title: 'SomaFM Groove Salad' };
  getState().favorites = [station, other];
  setCurrentItem(station);
  setPlaying(true);
  saveEqState(setEqBypassed(loadEqState(), station.id, false, true));
  const { stage, mounted, unmount } = fakeStage(t);
  const [column] = stage.children;
  const [stack, scope, status] = column.children;
  const [bassKnob, trebleKnob, preampKnob] = stack.children;
  assert.equal(stack.children.length, 3);
  assert.equal(column.inert, false);
  const { knobs } = tunerStageLayout({ width: 1280, height: 607, tone: true });
  stack.children.forEach((node, index) => {
    const { knob, label } = knobs[index];
    assert.equal(node.dataset.size, knob.sizeClass);
    for (const [element, x, y, w, h] of [
      [node, knob.x, knob.y, knob.width, knob.height],
      [node.querySelector('.tuner-tone-label'), label.x - knob.x, label.y - knob.y, label.width, label.height],
    ]) {
      assert.deepEqual([element.style.left, element.style.top, element.style.width, element.style.height],
        [x, y, w, h].map(n => n + 'px'));
    }
  });
  assert.equal(scope.className, 'sr-only');
  assert.doesNotMatch(bassKnob.innerHTML, /tuner-tone-value|dB/);
  assert.equal(bassKnob.title, 'Bass · saved for Channel One · 0 dB');
  assert.equal(readTunerTone().curve.bypassed, true, 'showing the knobs never enables EQ');
  assert.equal(scope.textContent, '');
  assert.equal(scope.getAttribute('role'), 'status');
  assert.equal(scope.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(bassKnob.getAttribute('role'), 'slider');
  assert.equal(preampKnob.getAttribute('aria-valuemax'), '6');
  assert.equal(bassKnob.getAttribute('aria-valuetext'), 'Bass 0 dB');

  const preset = getBuiltInEqPreset('treble-boost');
  emit('eq-preview', { itemId: station.id, curve: preset });
  assert.equal(trebleKnob.getAttribute('aria-valuetext'), 'Treble +6 dB');
  assert.equal(preampKnob.getAttribute('aria-valuetext'), 'Loudness -6 dB');
  saveEqState(setScopedEq(loadEqState(), station.id, false, { ...preset, bypassed: true }));
  emit('eq-change');
  assert.equal(status.textContent, '');

  dispatch(bassKnob, 'pointerdown', { button: 2, pointerId: 1 });
  assert.equal(bassKnob.hasPointerCapture(1), false);
  assert.equal(bassKnob.classList.contains('is-pointer-input'), true);
  dispatch(document, 'keydown', { key: 'Tab' });
  assert.equal(bassKnob.classList.contains('is-pointer-input'), false);

  dispatch(bassKnob, 'pointerdown', { button: 0, pointerId: 1, clientX: 25, clientY: 0 });
  assert.equal(bassKnob.hasPointerCapture(1), true);
  assert.equal(bassKnob.classList.contains('is-pointer-input'), true);
  dispatch(bassKnob, 'pointermove', { pointerId: 1, clientX: 50, clientY: 25 });
  assert.equal(bassKnob.getAttribute('aria-valuetext'), 'Bass +7.5 dB');
  const svg = bassKnob.querySelector('svg');
  assert.equal(svg.querySelector('.tuner-pointer').getAttribute('transform'), 'rotate(84.375 200 200)');
  assert.equal(svg.querySelector('.dial-body').getAttribute('transform'), 'rotate(84.375 200 200)');
  dispatch(document, 'keydown', { key: 'Tab' });
  assert.equal(bassKnob.classList.contains('is-pointer-input'), true);
  assert.equal(readTunerTone().curve.bypassed, false);
  assert.equal(scope.textContent, 'Saved for Channel One');
  assert.equal(bassKnob.title, 'Bass · saved for Channel One · +7.5 dB');
  assert.equal(status.textContent, '');
  dispatch(bassKnob, 'pointerup', { pointerId: 1 });
  assert.equal(status.textContent, 'Bass +7.5 dB');
  assert.equal(bassKnob.classList.contains('is-pointer-input'), true);
  dispatch(document, 'keydown', { key: 'Tab' });
  assert.equal(bassKnob.classList.contains('is-pointer-input'), false);

  const wheel = dispatch(trebleKnob, 'wheel', { deltaY: -3, deltaMode: 1 });
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(trebleKnob.classList.contains('is-pointer-input'), true);
  dispatch(document, 'keydown', { key: 'Tab' });
  assert.equal(trebleKnob.classList.contains('is-pointer-input'), false);
  assert.equal(status.textContent, 'Treble +6.5 dB');
  dispatch(trebleKnob, 'keydown', { key: 'PageDown' });
  assert.equal(trebleKnob.getAttribute('aria-valuetext'), 'Treble +3.5 dB');
  assert.equal(status.textContent, 'Treble +6.5 dB');
  dispatch(trebleKnob, 'keyup', { key: 'PageDown' });
  assert.equal(status.textContent, 'Treble +3.5 dB');
  dispatch(trebleKnob, 'keydown', { key: 'Delete' });
  dispatch(trebleKnob, 'keyup', { key: 'Delete' });
  assert.equal(status.textContent, 'Treble 0 dB');
  dispatch(preampKnob, 'dblclick', {});
  assert.equal(status.textContent, 'Loudness 0 dB');
  const own = loadEqState().favorites[station.id];
  assert.equal(own.preamp, 0);
  assert.equal(own.bands[9], 0);
  assert.equal(tunerToneValue(bass, own), 7.5);

  mounted.setLayout(tunerStageLayout({ width: 700, height: 330, tone: true }).knobs);
  assert.equal(stack.children[2].querySelector('.tuner-tone-label').style.height, '17.5px');
  assert.equal(scope.getAttribute('aria-live'), 'polite');
  assert.equal(preampKnob.title, 'Loudness · saved for Channel One · 0 dB');

  assert.deepEqual(stage.children, [column]);
  assert.deepEqual(column.children, [stack, scope, status]);
  const compactGeometry = { ...stage.style };
  saveEqState(setScopedEq(loadEqState(), other.id, true, { bands: [2, 3], preamp: 4 }));
  setCurrentItem(other);
  assert.equal(bassKnob.getAttribute('aria-valuetext'), 'Bass +2.5 dB');
  assert.equal(preampKnob.getAttribute('aria-valuetext'), 'Loudness +4 dB');
  assert.equal(scope.textContent, 'Saved for SomaFM Groove Salad');
  assert.equal(preampKnob.title, 'Loudness · saved for SomaFM Groove Salad · +4 dB');
  assert.deepEqual(stage.style, compactGeometry);
  assert.equal(status.textContent, 'Loudness 0 dB');
  setCurrentItem(station);
  assert.equal(bassKnob.getAttribute('aria-valuetext'), 'Bass +7.5 dB');
  assert.equal(preampKnob.getAttribute('aria-valuetext'), 'Loudness 0 dB');
  setCurrentItem(other);

  unmount();
  assert.deepEqual(stage.children, []);
  emit('eq-preview', { itemId: other.id, curve: preset });
  dispatch(preampKnob, 'keydown', { key: 'Home' });
  assert.equal(preampKnob.getAttribute('aria-valuetext'), 'Loudness +4 dB');
  assert.equal(readTunerTone().curve.preamp, 4);
});

test('an unfavorited item and paused playback use Main EQ and show the scope', (t) => {
  memoryProfile(t);
  const station = { type: 'tv', id: 'tv:one', title: 'Channel One' };
  const favorite = { type: 'radio', id: 'radio:favorite', title: 'Two FM' };
  getState().favorites = [favorite];
  setCurrentItem(station);
  setPlaying(true);
  const own = normalizeEqCurve({ preamp: -4 });
  saveEqState(setScopedEq(loadEqState(), favorite.id, true, own));
  const { stage } = fakeStage(t);
  const [stack, scope, status] = stage.children[0].children;
  const [, , preamp] = stack.children;
  assert.equal(scope.textContent, 'Adjusting the main EQ');
  assert.equal(preamp.title, 'Loudness · main EQ · 0 dB');
  dispatch(preamp, 'keydown', { key: 'ArrowUp' });
  assert.equal(status.textContent, '');
  dispatch(preamp, 'keyup', { key: 'ArrowUp' });
  assert.equal(status.textContent, 'Loudness +0.5 dB');
  assert.equal(loadEqState().global.preamp, 0.5);
  assert.deepEqual(loadEqState().favorites, { [favorite.id]: own });

  setCurrentItem(favorite);
  assert.equal(preamp.getAttribute('aria-valuenow'), '-4');
  setPlaying(false);
  assert.equal(preamp.getAttribute('aria-valuenow'), '0.5');
  assert.equal(scope.textContent, 'Adjusting the main EQ');
  emit('eq-preview', { itemId: favorite.id, curve: own, mainEq: false });
  assert.equal(preamp.getAttribute('aria-valuenow'), '0.5');
  assert.equal(turnTunerTone(loudness, 1), true);
  assert.equal(loadEqState().global.preamp, 1);
  assert.deepEqual(loadEqState().favorites, { [favorite.id]: own });
  setPlaying(true);
  assert.equal(preamp.getAttribute('aria-valuenow'), '-4');
  setPlaying(false);
  setCurrentItem(station);
  emit('eq-preview', { itemId: station.id, curve: normalizeEqCurve({ preamp: 2 }), mainEq: true });
  assert.equal(preamp.getAttribute('aria-valuenow'), '2');
  setCurrentItem(null);
  assert.equal(preamp.getAttribute('aria-valuenow'), '1');
  assert.equal(scope.textContent, 'Adjusting the main EQ');
});
