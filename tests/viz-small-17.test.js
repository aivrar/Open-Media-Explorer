import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { normalizeVisualizerExtras, normalizeVisualizerOverlayStyles } from '../src/lib/visualizer-settings.js';
import loadOverlays from '../src/visualizer/vendor/psychedelia/engine/overlays.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { CROSSFADE_SLOW_MS, mountVisualizer } from '../src/visualizer/index.js';
import {
  MOOD_CALM_BELOW, MOOD_ENERGETIC_ABOVE, createMoodTracker, moodEnergy,
} from '../src/visualizer/mood.js';
import { overlayRow } from '../src/visualizer/overlay-catalog.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

const LAYOUT = { width: 1280, height: 720 };
const SETTLE_MS = CROSSFADE_SLOW_MS + 800;

/** A mount whose settings live in `store.current` (as the app keeps them). */
async function mount(store) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const listeners = new Set();
  const root = new FakeNodeEl('div');
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => store.current,
    saveSettings: (partial) => {
      store.saved.push(partial);
      store.current = normalizeSettings({ ...store.current, ...partial });
      for (const fn of listeners) fn(store.current);
    },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(3),
    loadFxLibrary: async () => import('../src/visualizer/vendor/psychedelia/engine/post-fx-library.js'),
    loadOverlays: async () => ({ default: loadOverlays }),
  });
  const m = {
    h, session, source, signal,
    async until(done, label) {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        h.run(COMPILE_POLL_MS);
      }
      assert.fail(`never reached: ${label}`);
    },
    async play(ms, frameMs = 1000 / 30) {
      for (let left = ms; left > 0; left -= 500) {
        h.run(Math.min(500, left), frameMs);
        await settle(() => false, 3);
      }
    },
  };
  await m.until(() => Boolean(session.switcher.current), 'first scene');
  source.playing = true;
  signal.refresh();
  await m.play(SETTLE_MS);
  return m;
}

const strobeRow = (session) => session.overlays.rows.find((row) => row.id === 'color_strobe');
const change = (node, value) => { node.value = value; node.dispatchEvent(new Event('change')); };

/* ============ 5. The Strobe's Style is kept when the tab is left ============ */

test('the overlays\' Style choice is saved with the Visualizer settings and comes back when the tab is opened again', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = {
    saved: [],
    current: normalizeSettings({
      visualizerNoticeSeen: true, visualizerScene: 'tunnel', visualizerOverlays: true,
      visualizerOverlayShuffle: false, visualizerOverlaySet: ['color_strobe'],
    }),
  };
  assert.deepEqual(store.current.visualizerOverlayStyles, {}, 'none picked: Any');
  const first = await mount(store);
  const row = strobeRow(first.session);
  assert.ok(row, 'the Strobe has its row');
  assert.equal(row.style.value, 'any');
  change(row.style, '2'); // Sweep
  assert.deepEqual(store.saved.at(-1), { visualizerOverlayStyles: { color_strobe: 2 } });
  assert.deepEqual(store.current.visualizerOverlayStyles, { color_strobe: 2 });
  first.session.destroy();
  // The tab opened again: Sweep, and drawn so.
  const second = await mount(store);
  assert.equal(strobeRow(second.session).style.value, '2');
  assert.equal(second.session.overlays.drawn.find((item) => item.id === 'color_strobe')?.values?.style, 2);
  // Any again: saved too.
  change(strobeRow(second.session).style, 'any');
  assert.deepEqual(store.current.visualizerOverlayStyles, {});
  second.session.destroy();
  // A style the overlay does not have reads as Any.
  store.current = normalizeSettings({ ...store.current, visualizerOverlayStyles: { color_strobe: 9 } });
  const third = await mount(store);
  assert.equal(strobeRow(third.session).style.value, 'any');
  third.session.destroy();
});

test('the saved Style choices: only overlay ids with a style number, inside the settings value', () => {
  assert.equal(overlayRow('color_strobe').styles.length, 4);
  assert.deepEqual(normalizeVisualizerOverlayStyles(undefined), {});
  assert.deepEqual(normalizeVisualizerOverlayStyles([1, 2]), {});
  assert.deepEqual(normalizeVisualizerOverlayStyles('x'), {});
  assert.deepEqual(normalizeVisualizerOverlayStyles({
    color_strobe: 3, petals: 1.5, 'Bad Id': 1, rings: -1, lasers: '2', bokeh: 99,
  }), { color_strobe: 3 });
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`o${index}`, 1]));
  assert.equal(Object.keys(normalizeVisualizerOverlayStyles(many)).length, 32);
  // A field of the Visualizer's settings: older values without it read as Any.
  assert.deepEqual(normalizeVisualizerExtras({}).visualizerOverlayStyles, {});
  assert.deepEqual(normalizeSettings({ visualizerOverlayStyles: { color_strobe: 1 } }).visualizerOverlayStyles, { color_strobe: 1 });
});

/* ============ 6. The mood's numbers, readable in the built app ============ */

test('the mood line carries the mood\'s numbers as data attributes, at most once a second, with nothing shown or said', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = { saved: [], current: normalizeSettings({ visualizerNoticeSeen: true, visualizerScene: 'tunnel' }) };
  const m = await mount(store);
  const line = m.session.controls.moodLine;
  assert.equal(line.getAttribute('data-calm-below'), '0.30');
  assert.equal(line.getAttribute('data-energetic-above'), '0.48');
  assert.equal(MOOD_CALM_BELOW, 0.30);
  assert.equal(MOOD_ENERGETIC_ABOVE, 0.48);
  for (const name of ['data-energy', 'data-hits-per-second', 'data-bpm', 'data-tempo-confidence']) {
    assert.match(line.getAttribute(name) ?? '', /^\d+(\.\d\d)?$/, name);
  }
  assert.equal(line.getAttribute('data-energy'), m.session.mood.energy.toFixed(2));
  assert.equal(line.getAttribute('aria-live'), 'off', 'nothing said');
  assert.match(line.textContent, /^Music: (calm|steady|energetic)$/, 'the text is as before');
  // Not per frame: a stand-in energy that changes every frame is written at
  // most once a second.
  let frames = 0;
  Object.defineProperty(m.session.mood, 'energy', { get: () => { frames += 1; return 0.5 + frames / 10; } });
  const writes = [];
  const setAttribute = line.setAttribute.bind(line);
  line.setAttribute = (name, value) => { if (name === 'data-energy') writes.push(value); setAttribute(name, value); };
  await m.play(3000);
  assert.ok(frames >= 2 && frames <= 4, `read ${frames} times in 3 s`);
  assert.equal(writes.length, frames, 'each new value written once');
  assert.equal(line.getAttribute('data-energy'), (0.5 + frames / 10).toFixed(2));
  // An unchanged value is not written again.
  Object.defineProperty(m.session.mood, 'energy', { get: () => 0.25 });
  await m.play(3000);
  assert.equal(writes.filter((value) => value === '0.25').length, 1);
  m.session.destroy();
});

test('the mood tracker gives its hits a second; the energy formula on idealized music', () => {
  const tracker = createMoodTracker();
  assert.equal(tracker.hitsPerSecond, 0);
  // A kick every half second for 9 s: two hits a second.
  for (let step = 0; step <= 180; step += 1) {
    const kick = step % 10 === 0 ? 1 : 0;
    tracker.step(step * 0.05, { kick, level: 0.5 });
  }
  assert.ok(Math.abs(tracker.hitsPerSecond - 2) < 0.2, String(tracker.hitsPerSecond));
  tracker.reset();
  assert.equal(tracker.hitsPerSecond, 0);
  // energy = 0.6 x min(1, max(0, hits - 1) / 4) + 0.4 x confidence x clamp((bpm - 80) / 60, 0, 1)
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} vs ${expected}`);
  near(moodEnergy(128 / 60 * 1.5, 1, 128), 0.6 * (3.2 - 1) / 4 + 0.4 * 0.8); // 0.65
  near(moodEnergy(3, 0.4, 150), 0.3 + 0.16); // 0.46
  near(moodEnergy(70 / 60 * 1.5, 1, 70), 0.6 * (1.75 - 1) / 4); // 0.1125
  near(moodEnergy(0, 0, 0), 0);
});
