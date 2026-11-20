import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import {
  VISUALIZER_FAVOURITES_MAX, normalizeVisualizerExtras, normalizeVisualizerFavourites, parseVisualizerFavourite,
} from '../src/lib/visualizer-settings.js';
import { normalizeSettings } from '../src/lib/state.js';
import { LOOP_MODES } from '../src/visualizer/loop.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { SCENES, sceneById } from '../src/visualizer/scenes.js';
import {
  SHUFFLE_MAX_DWELL_S, SHUFFLE_MIN_DWELL_S, costFilterMax, createShuffle, createShuffleTimer, lighterCost,
  recentCount, seededRandom, shuffleCostCap,
} from '../src/visualizer/shuffle.js';
import {
  MOOD_HOLD_S, MOOD_MIN_CHANGE_S, MOOD_STRENGTH, createMoodTracker, moodEnergy,
} from '../src/visualizer/mood.js';
import {
  favouriteEntries, favouriteKey, favouriteLooks, isFavourite, withFavourite,
} from '../src/visualizer/favourites.js';
import { HUD_FADE_MS } from '../src/visualizer/hud.js';
import { NOTICE } from '../src/visualizer/notice.js';
import { STEP_DOWN_GRACE_MS, STEP_DOWN_WINDOW_MS } from '../src/visualizer/step-down.js';
import {
  CROSSFADE_MS, CROSSFADE_SLOW_MS, NOTES, SHUFFLE_TEXT, mountVisualizer,
} from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* Slice 4 of the visualizer: the buttons over the picture and the side
   panel, favourites, the scene shuffle (seeded, with its no-repeat rules, bar
   timing, preparing ahead and the cross-fade), the music's mood, and the
   photosensitivity notice. No GPU; fake clocks. */

const LAYOUT = { width: 1280, height: 720 };
const byId = new Map(SCENES.map((scene) => [scene.id, scene]));
const event = (name, init = {}) => Object.assign(new Event(name), init);

/* ---------------- The shuffle's choices ---------------- */

/** `count` picks, each one then shown (as the tab does when it is installed). */
function picks(shuffle, count, context = {}) {
  const out = [];
  let current = context.current || null;
  for (let index = 0; index < count; index += 1) {
    current = shuffle.next({ ...context, current });
    shuffle.shown(current);
    out.push(current);
  }
  return out;
}

test('the shuffle is repeatable from a seed, and differs between seeds', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const first = Array.from({ length: 50 }, () => a());
  assert.deepEqual(first, Array.from({ length: 50 }, () => b()));
  assert.ok(first.every((value) => value >= 0 && value < 1));
  const context = { pool: 'all', costMax: 'heavy', mood: 'steady' };
  const one = picks(createShuffle({ scenes: SCENES, random: seededRandom(7) }), 300, context);
  const two = picks(createShuffle({ scenes: SCENES, random: seededRandom(7) }), 300, context);
  const other = picks(createShuffle({ scenes: SCENES, random: seededRandom(8) }), 300, context);
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, other);
});

/** The rules over a run of picks: { distinct, inARow, recentRepeats, categoryRuns, bags }. */
function ruleCheck(list, poolSize) {
  const keep = recentCount(poolSize);
  let inARow = 0;
  let recentRepeats = 0;
  let categoryRuns = 0;
  for (let at = 1; at < list.length; at += 1) {
    if (list[at] === list[at - 1]) inARow += 1;
    if (list.slice(Math.max(0, at - keep), at).includes(list[at])) recentRepeats += 1;
    if (at >= 2 && byId.get(list[at]).category === byId.get(list[at - 1]).category
      && byId.get(list[at]).category === byId.get(list[at - 2]).category) categoryRuns += 1;
  }
  // Each run of poolSize picks from the start is one full bag: every scene once.
  let bags = 0;
  for (let at = 0; at + poolSize <= list.length; at += poolSize) {
    if (new Set(list.slice(at, at + poolSize)).size === poolSize) bags += 1;
  }
  return {
    distinct: new Set(list).size, inARow, recentRepeats, categoryRuns, bags,
  };
}

test('5,000 picks: never the same scene twice running, none of the last few again, never three of a category running, every scene once per bag', () => {
  for (const [costMax, mood] of [['medium', 'steady'], ['heavy', 'calm'], ['light', 'energetic']]) {
    const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(2026) });
    const pool = shuffle.poolOf({ pool: 'all', costMax });
    const list = picks(shuffle, 5000, { pool: 'all', costMax, mood });
    const result = ruleCheck(list, pool.length);
    assert.equal(result.distinct, pool.length, `${costMax}: every scene shown`);
    assert.equal(result.inARow, 0);
    assert.equal(result.recentRepeats, 0, `${costMax}: none of the last ${recentCount(pool.length)} again`);
    assert.equal(result.categoryRuns, 0);
    assert.equal(result.bags, Math.floor(5000 / pool.length), `${costMax}: every bag complete`);
    assert.equal(shuffle.stats.relaxed.bag, 0, 'the bag is never let go');
    // Only scenes the cost filter lets in.
    const max = ['light', 'medium', 'heavy'].indexOf(costMax);
    assert.ok(list.every((id) => ['light', 'medium', 'heavy'].indexOf(byId.get(id).cost) <= max));
  }
});

test('small pools (favourites): never the same twice running, all of them visited', () => {
  for (const size of [1, 2, 3, 5, 8]) {
    const favourites = SCENES.slice(0, size).map((scene) => ({ scene: scene.id, look: null }));
    const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(size) });
    const list = picks(shuffle, 5000, { pool: 'favourites', favourites, costMax: 'heavy' });
    assert.equal(new Set(list).size, size);
    if (size > 1) assert.ok(list.every((id, at) => at === 0 || id !== list[at - 1]), `pool of ${size}`);
  }
  // An empty pool: nothing to pick.
  assert.equal(createShuffle({ scenes: SCENES }).next({ pool: 'favourites', favourites: [] }), null);
});

test('the mood biases the order inside each bag: calm scenes come earlier when the music is calm', () => {
  const meanPosition = (mood, tag) => {
    const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(11) });
    const size = shuffle.poolOf({ pool: 'all', costMax: 'heavy' }).length;
    const list = picks(shuffle, size * 60, { pool: 'all', costMax: 'heavy', mood });
    const at = [];
    list.forEach((id, index) => { if (byId.get(id).mood === tag) at.push(index % size); });
    return at.reduce((sum, value) => sum + value, 0) / at.length;
  };
  assert.ok(meanPosition('calm', 'calm') < meanPosition('energetic', 'calm') - 3);
  assert.ok(meanPosition('energetic', 'lively') < meanPosition('calm', 'lively') - 3);
  for (const scene of SCENES) {
    assert.ok(['calm', 'lively'].includes(scene.mood), scene.id);
    assert.ok(['warm', 'cool', 'rainbow'].includes(scene.hue), scene.id);
  }
});

test('looks: not the one a scene had last time, and in favourites mode only starred looks', () => {
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(3) });
  let last = null;
  for (let index = 0; index < 500; index += 1) {
    const look = shuffle.look('plasma', 6);
    assert.notEqual(look, last);
    assert.ok(look >= 0 && look < 6);
    last = look;
  }
  const allowed = new Set();
  for (let index = 0; index < 200; index += 1) allowed.add(shuffle.look('tunnel', 6, [1, 4]));
  assert.deepEqual([...allowed].sort(), [1, 4]);
  assert.equal(shuffle.look('tunnel', 6, [4]), 4, 'one starred look: that one');
  assert.equal(shuffle.look('moire', 0), null, 'no looks');
});

test('cost filter and the step-down cap: never heavier than the picture can hold', () => {
  assert.equal(costFilterMax('light'), 'light');
  assert.equal(costFilterMax('medium'), 'medium');
  assert.equal(costFilterMax('all'), 'heavy');
  assert.equal(shuffleCostCap('heavy'), 'medium');
  assert.equal(shuffleCostCap('medium'), 'light');
  assert.equal(shuffleCostCap('light'), 'light');
  assert.equal(lighterCost('heavy', 'light'), 'light');
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(1) });
  const light = shuffle.poolOf({ pool: 'all', costMax: lighterCost('medium', shuffleCostCap('medium')) });
  assert.ok(light.length > 0 && light.every((id) => byId.get(id).cost === 'light'));
});

/* ---------------- When ---------------- */

/** Steps `timer` from `from` to `to` seconds at 60 a second; the first
 *  time it is due, or null. beatsAt(t) and confidence as given. */
function runTimer(timer, from, to, beatsAt, confidence) {
  for (let t = from; t <= to + 1e-9; t += 1 / 60) {
    if (timer.step(t, beatsAt(t), confidence)) return t;
  }
  return null;
}

test('timing: every N bars on the beat clock when the tempo is sure, on a bar line, within the dwell limits', () => {
  const at120 = (t) => t * 2; // 120 BPM: two beats a second, a bar every 2 s
  const timer = createShuffleTimer({ bars: 16 });
  const due = runTimer(timer, 0, 200, at120, 0.9);
  assert.ok(Math.abs(due - 32) < 0.05, `16 bars at 120 BPM: ${due}`);
  assert.equal(timer.byClock, true);
  assert.equal(timer.step(due + 5, at120(due + 5), 0.9), true, 'stays due until restarted');
  // 8 bars (16 s) is under the shortest stay: the first bar line after 20 s.
  const short = createShuffleTimer({ bars: 8 });
  const shortDue = runTimer(short, 0, 200, at120, 0.9);
  assert.ok(shortDue >= SHUFFLE_MIN_DWELL_S && shortDue <= SHUFFLE_MIN_DWELL_S + 2.05, `8 bars: ${shortDue}`);
  assert.ok(Math.abs(at120(shortDue) / 4 - Math.round(at120(shortDue) / 4)) < 0.05, 'on a bar line');
  // 32 bars at 60 BPM would be 128 s: the longest stay ends it at 120 s.
  const slow = createShuffleTimer({ bars: 32 });
  const slowDue = runTimer(slow, 0, 300, (t) => t, 0.9);
  assert.ok(Math.abs(slowDue - SHUFFLE_MAX_DWELL_S) < 0.05, `longest stay: ${slowDue}`);
  // A new track (the beat clock starts again) starts the bar count again.
  const fresh = createShuffleTimer({ bars: 16 });
  runTimer(fresh, 0, 20, at120, 0.9);
  const again = runTimer(fresh, 20.01, 200, (t) => (t - 20) * 2, 0.9);
  assert.ok(Math.abs(again - 52) < 0.05, `counted from the new track: ${again}`);
});

test('timing: without a sure tempo, the time N bars take at 120 BPM; nothing counted while no sound plays', () => {
  for (const [bars, seconds] of [[8, 20], [16, 32], [32, 64]]) {
    const timer = createShuffleTimer({ bars });
    assert.equal(timer.fallbackSeconds(), seconds);
    const due = runTimer(timer, 0, 300, () => Number.NaN, 0.2);
    assert.ok(Math.abs(due - seconds) < 0.05, `${bars} bars: ${due}`);
    assert.equal(timer.byClock, false);
  }
  // Ten seconds of sound, a long silence (the timer is not stepped), then
  // sound again: the silence does not count.
  const timer = createShuffleTimer({ bars: 16 });
  runTimer(timer, 0, 10, () => Number.NaN, 0);
  assert.ok(Math.abs(timer.dwell - 10) < 0.05);
  timer.step(500, Number.NaN, 0);
  assert.ok(timer.dwell < 10.6, `a gap counts at most half a second: ${timer.dwell}`);
  const due = runTimer(timer, 500, 700, () => Number.NaN, 0);
  assert.ok(due > 521 && due < 522.6, `due after 32 s of sound: ${due}`);
  timer.restart();
  assert.equal(timer.due, false);
  assert.equal(timer.dwell, 0);
});

/* ---------------- Mood ---------------- */

/** A synthetic reactor: `hits` onsets a second on the kick, sure of `bpm`. */
function feed(tracker, from, seconds, { hits = 0, confidence = 0, bpm = 0, level = 0.5 } = {}) {
  for (let t = from; t < from + seconds; t += 1 / 60) {
    const phase = hits > 0 ? (t * hits) % 1 : 1;
    tracker.step(t, {
      kick: phase < 0.1 ? 0.9 : 0, snare: 0, hat: 0, level, confidence, bpm,
    });
  }
  return from + seconds;
}

test('mood: calm, steady or energetic from hits a second and beat confidence, held for a while, at most one change in ten seconds', () => {
  assert.ok(moodEnergy(0, 0, 0) < 0.3);
  assert.ok(moodEnergy(6, 0.9, 128) > 0.65);
  const tracker = createMoodTracker();
  assert.equal(tracker.mood, 'steady');
  let t = feed(tracker, 0, 2, { hits: 6, confidence: 0.9, bpm: 128 });
  assert.equal(tracker.mood, 'steady', 'not before it has held');
  while (tracker.mood !== 'energetic' && t < 10) t = feed(tracker, t, 0.1, { hits: 6, confidence: 0.9, bpm: 128 });
  assert.equal(tracker.mood, 'energetic');
  assert.ok(t >= MOOD_HOLD_S, 'after it has held');
  // Straight to near silence (calm as soon as it has held): still energetic
  // until ten seconds after the last change.
  const changedAt = t;
  const before = tracker.stats.changes;
  while (tracker.stats.changes === before && t < changedAt + 30) t = feed(tracker, t, 0.1, { level: 0 });
  assert.equal(tracker.mood, 'calm');
  assert.ok(t - changedAt >= MOOD_MIN_CHANGE_S - 0.15, `changed after ${(t - changedAt).toFixed(1)} s`);
  assert.ok(t - changedAt < MOOD_MIN_CHANGE_S + 0.5, 'and then at once');
  t = feed(tracker, t, 12, { level: 0 });
  // Near silence is calm whatever else.
  const quiet = createMoodTracker();
  feed(quiet, 0, MOOD_HOLD_S + 8, {
    hits: 6, confidence: 0.9, bpm: 128, level: 0,
  });
  assert.equal(quiet.mood, 'calm');
  // Hysteresis: energy wobbling around the energetic line does not flip it.
  const wobble = createMoodTracker();
  let w = feed(wobble, 0, 12, { hits: 6, confidence: 0.9, bpm: 128 });
  assert.equal(wobble.mood, 'energetic');
  const changes = wobble.stats.changes;
  for (let round = 0; round < 6; round += 1) {
    w = feed(wobble, w, 2, { hits: 4, confidence: 0.8, bpm: 128 });
    w = feed(wobble, w, 2, { hits: 5, confidence: 0.9, bpm: 128 });
  }
  assert.equal(wobble.stats.changes, changes);
  // The reaction strength follows the mood slowly.
  assert.ok(Math.abs(tracker.strength - MOOD_STRENGTH.calm) < 0.05);
});

/* ---------------- Favourites and settings ---------------- */

test('favourites: short strings, starred and unstarred, capped with the unknown and then the oldest dropped', () => {
  assert.equal(favouriteKey('plasma', 2), 'plasma:2');
  assert.equal(favouriteKey('moire', null), 'moire');
  assert.deepEqual(parseVisualizerFavourite('plasma:2'), {
    scene: 'plasma', look: 2, fx: [], overlays: [],
  });
  assert.deepEqual(parseVisualizerFavourite('moire'), {
    scene: 'moire', look: null, fx: [], overlays: [],
  });
  let list = withFavourite([], 'plasma', 2, true);
  list = withFavourite(list, 'moire', null, true);
  assert.deepEqual(list, ['plasma:2', 'moire']);
  assert.ok(isFavourite(list, 'plasma', 2));
  assert.ok(!isFavourite(list, 'plasma', 1));
  assert.deepEqual(favouriteLooks(list, 'plasma'), [2]);
  assert.deepEqual(favouriteEntries(list), [{
    scene: 'plasma', look: 2, fx: [], overlays: [],
  }, {
    scene: 'moire', look: null, fx: [], overlays: [],
  }]);
  assert.deepEqual(withFavourite(list, 'plasma', 2, false), ['moire']);
  // Full: a scene this build lacks goes first, then the oldest.
  const known = SCENES.map((scene) => scene.id);
  const full = Array.from({ length: VISUALIZER_FAVOURITES_MAX }, (_, n) => (n === 5 ? 'gone_scene' : `${SCENES[n % SCENES.length].id}:${Math.floor(n / SCENES.length)}`));
  const unknownOut = withFavourite(full, 'tunnel', 9, true, known);
  assert.equal(unknownOut.length, VISUALIZER_FAVOURITES_MAX);
  assert.ok(!unknownOut.includes('gone_scene'));
  assert.equal(unknownOut.at(-1), 'tunnel:9');
  const oldestOut = withFavourite(unknownOut, 'moire', null, true, known);
  assert.equal(oldestOut.length, VISUALIZER_FAVOURITES_MAX);
  assert.equal(oldestOut[0], unknownOut[1], 'the oldest went');
  // The setting: checked for shape, deduplicated, capped.
  assert.deepEqual(normalizeVisualizerFavourites(['plasma:1', 'plasma:1', 'Bad Id', 7, 'x:999', 'moire']), ['plasma:1', 'moire']);
  assert.equal(normalizeVisualizerFavourites(Array.from({ length: 300 }, (_, n) => `s${n}`)).length, VISUALIZER_FAVOURITES_MAX);
  assert.deepEqual(normalizeVisualizerFavourites('plasma'), []);
});

test('the slice 4 settings: defaults, checked values, kept by normalizeSettings', () => {
  const {
    visualizerFx, visualizerFxShuffle, visualizerFxIntensity, visualizerFxTiming, visualizerFxFlash, visualizerFxSet,
    visualizerOverlays, visualizerOverlayShuffle, visualizerOverlaySet, visualizerOverlayGlow, visualizerDrift,
    visualizerOverlayStyles, visualizerFolded, ...slice4
  } = normalizeVisualizerExtras({});
  assert.deepEqual(visualizerFolded, [], 'every section of the side panel open');
  assert.deepEqual(visualizerOverlayStyles, {}, 'no Style picked: Any');
  assert.equal(visualizerDrift, true, 'slow drift: on');
  assert.equal(visualizerOverlayGlow, false, 'extra glow: off');
  assert.deepEqual([visualizerOverlays, visualizerOverlayShuffle, visualizerOverlaySet], [false, true, []], 'the overlays (slice 6): off');
  assert.deepEqual([visualizerFx, visualizerFxShuffle, visualizerFxIntensity, visualizerFxTiming, visualizerFxFlash, visualizerFxSet], [false, true, 'normal', 'scene', false, []], 'the effects (slice 5): off');
  assert.deepEqual(slice4, {
    visualizerPanelOpen: false,
    visualizerShuffle: false,
    visualizerShufflePool: 'all',
    visualizerShuffleCost: 'medium',
    visualizerShuffleBars: 16,
    visualizerFavourites: [],
    visualizerNoticeSeen: false,
  });
  const odd = normalizeVisualizerExtras({
    visualizerPanelOpen: 'yes', visualizerShuffle: 1, visualizerShufflePool: 'mine', visualizerShuffleCost: 'huge', visualizerShuffleBars: 12, visualizerNoticeSeen: 'true',
  });
  assert.deepEqual([odd.visualizerPanelOpen, odd.visualizerShuffle, odd.visualizerShufflePool, odd.visualizerShuffleCost, odd.visualizerShuffleBars, odd.visualizerNoticeSeen], [false, false, 'all', 'medium', 16, false]);
  const kept = normalizeSettings({
    visualizerPanelOpen: true, visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerShuffleCost: 'light', visualizerShuffleBars: '32', visualizerFavourites: ['plasma:1'], visualizerNoticeSeen: true,
  });
  assert.deepEqual([kept.visualizerPanelOpen, kept.visualizerShuffle, kept.visualizerShufflePool, kept.visualizerShuffleCost, kept.visualizerShuffleBars, kept.visualizerFavourites, kept.visualizerNoticeSeen], [true, true, 'favourites', 'light', 32, ['plasma:1'], true]);
});

/* ---------------- In the tab ---------------- */

function playingSource() {
  const node = fakeAnalyser({ level: 60, db: -60 });
  return {
    node,
    playing: false,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
}

async function mount({
  settings = {}, scenes = SCENES, seen = true, seed = 5, animate = false,
} = {}) {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const motion = fakeMotion(false);
  const win = fakeResizeObserverWin(motion);
  const source = playingSource();
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  const saved = [];
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: seen, ...settings });
  const root = new FakeNodeEl('div');
  // The cross-fade's canvas (the second one made) can get a 2D context and
  // Web Animations (watchFade); without, the transition dips instead.
  const fades = { copies: [], animations: [], alphas: [], fills: 0 };
  if (animate) {
    let canvases = 0;
    const make = vis.doc.createElement;
    vis.doc.createElement = (tag) => {
      const node = make(tag);
      if (tag === 'canvas' && ++canvases === 2) watchFade(node, fades);
      return node;
    };
  }
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { saved.push(partial); current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win,
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    scenes,
    loopOptions: h.io,
    flashLedger: createFlashLedger(), // its own: tests start their clocks afresh
    random: seededRandom(seed),
  });
  const m = {
    h, vis, gl, saved, root, session, source, signal, fades,
    stage: root.children[0],
    controls: session.controls,
    get settings() { return current; },
    apply(partial) { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    async until(done, label = 'condition') {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        h.run(COMPILE_POLL_MS);
      }
      assert.fail(`never reached: ${label}`);
    },
    /** Run `ms` of frames, letting scene loads settle every half second. */
    async play(ms, frameMs = 1000 / 60) {
      for (let left = ms; left > 0; left -= 500) {
        h.run(Math.min(500, left), frameMs);
        await settle(() => false, 3);
      }
    },
    start() { source.playing = true; signal.refresh(); },
  };
  if (seen) await m.until(() => Boolean(session.switcher.current), 'first scene');
  return m;
}

/** A canvas double for the cross-fade: a 2D context and a Web Animation. */
function watchFade(node, seen) {
  const g2 = {
    globalAlpha: 1,
    fillStyle: '',
    fillRect() { seen.fills += 1; },
    drawImage(source) { seen.copies.push(source); seen.alphas.push(g2.globalAlpha); },
  };
  node.getContext = (kind) => (kind === '2d' ? g2 : null);
  node.animate = (frames, options) => {
    const animation = {
      frames, options, cancelled: false, cancel() { this.cancelled = true; },
    };
    seen.animations.push(animation);
    return animation;
  };
}

test('the photosensitivity notice comes first: nothing loaded, armed or scheduled until Continue; Not now leaves a placeholder with a start button', async () => {
  const m = await mount({ seen: false });
  const { session, controls, h } = m;
  assert.equal(session.notice.open, true);
  assert.equal(session.notice.element.getAttribute('role'), 'dialog');
  assert.equal(session.notice.element.getAttribute('aria-modal'), 'true');
  assert.match(NOTICE.text.join(' '), /pulsing/);
  assert.match(NOTICE.text.join(' '), /photosensitive/);
  assert.match(NOTICE.text.join(' '), /flash limiter is always on/);
  assert.equal(session.started, false);
  assert.equal(session.loop.mode, LOOP_MODES.off);
  // Nothing at all: no scene asked for, loaded or compiled, no timer.
  await settle(() => false, 20);
  assert.equal(h.pending(), 0, 'nothing scheduled');
  assert.equal(session.switcher.stats.requests, 0, 'no scene asked for');
  assert.equal(session.switcher.current, null);
  assert.equal(session.renderer.stats.compiles, 0, 'nothing compiled');
  assert.equal(m.gl.draws, 0, 'a placeholder only');
  assert.equal(session.hud.element.hidden, true);
  // Mouse, touch and keys over it arm nothing; sound is not listened to.
  m.stage.dispatchEvent(new Event('pointermove'));
  m.stage.dispatchEvent(new Event('pointerdown'));
  m.stage.dispatchEvent(event('keydown', { key: 'a' }));
  session.hud.element.dispatchEvent(new Event('pointerleave'));
  session.notice.element.dispatchEvent(event('keydown', { key: 'Tab' }));
  m.start();
  h.run(5000);
  assert.equal(h.pending(), 0, 'still nothing scheduled');
  assert.equal(session.hud.pending, false);
  assert.equal(m.signal.subscriberCount, 0, 'the sound is not even listened to');
  // A scene chosen meanwhile (settings) is only remembered.
  m.apply({ visualizerScene: 'tunnel' });
  await settle(() => false, 20);
  assert.equal(session.switcher.stats.requests, 0);
  // Escape is Not now.
  session.notice.element.dispatchEvent(event('keydown', { key: 'Escape' }));
  assert.equal(session.notice.open, false);
  assert.equal(session.notice.startBox.hidden, false);
  assert.equal(session.started, false);
  assert.ok(!m.saved.some((p) => 'visualizerNoticeSeen' in p), 'not accepted');
  assert.equal(h.pending(), 0);
  // The start button: moving, and remembered; the scene asked for is loaded.
  session.notice.buttons.start.dispatchEvent(new Event('click'));
  assert.equal(session.started, true);
  assert.equal(session.notice.startBox.hidden, true);
  assert.equal(session.hud.element.hidden, false);
  assert.ok(m.saved.some((p) => p.visualizerNoticeSeen === true));
  await m.until(() => session.switcher.current === 'tunnel', 'the scene asked for');
  h.run(500);
  assert.equal(session.loop.mode, LOOP_MODES.live);
  // The panel's line shows it again; Not now then leaves the picture still.
  controls.noticeLine.dispatchEvent(new Event('click'));
  assert.equal(session.notice.open, true);
  session.notice.buttons.decline.dispatchEvent(new Event('click'));
  assert.equal(session.started, false);
  assert.equal(session.loop.mode, LOOP_MODES.off);
  session.notice.buttons.start.dispatchEvent(new Event('click'));
  assert.equal(session.started, true);
  session.destroy();
  // Accepted once: straight to a moving picture next time.
  const next = await mount({ seen: true });
  assert.equal(next.session.notice.open, false);
  assert.equal(next.session.started, true);
  next.session.destroy();
});

test('the buttons over the picture fade after 3 s without movement, come back with movement or focus, and leave no timer behind', async () => {
  const m = await mount();
  const { session, h, stage } = m;
  const hud = session.hud;
  assert.deepEqual(Object.keys(hud.buttons), ['prev', 'next', 'shuffle', 'star', 'panel']);
  for (const button of Object.values(hud.buttons)) assert.ok(button.getAttribute('aria-label'), 'a name for each');
  stage.dispatchEvent(new Event('pointermove')); // timed from here (the mount took a moment)
  h.run(HUD_FADE_MS - 50);
  assert.equal(hud.faded, false);
  h.run(100);
  assert.equal(hud.faded, true);
  assert.ok(hud.element.classList.contains('viz-hud-faded'));
  assert.ok(stage.classList.contains('viz-hud-away'), 'no mouse pointer over the picture');
  assert.equal(hud.pending, false, 'nothing scheduled once faded');
  // Movement: back, and one timer however much the mouse moves.
  const timers = hud.stats.timers;
  for (let index = 0; index < 100; index += 1) {
    stage.dispatchEvent(new Event('pointermove'));
    h.run(20);
  }
  assert.equal(hud.faded, false);
  assert.ok(hud.stats.timers - timers <= 2, `timers: ${hud.stats.timers - timers}`);
  h.run(HUD_FADE_MS + 50);
  assert.equal(hud.faded, true);
  // A key (Tab into the buttons): shown while focus is in them, no timer.
  hud.element.dispatchEvent(new Event('focusin'));
  assert.equal(hud.faded, false);
  assert.equal(hud.pending, false);
  h.run(HUD_FADE_MS * 3);
  assert.equal(hud.faded, false, 'kept while focused');
  hud.element.dispatchEvent(event('focusout', { relatedTarget: null }));
  h.run(HUD_FADE_MS + 50);
  assert.equal(hud.faded, true);
  // Any key while the tab is open, with focus on the tab's button or the
  // page itself (the document gets it), not only over the picture.
  m.vis.press({ key: 'a' });
  assert.equal(hud.faded, false, 'a key anywhere brings them back');
  h.run(HUD_FADE_MS + 50);
  assert.equal(hud.faded, true);
  // Hovering keeps them too.
  hud.element.dispatchEvent(new Event('pointerenter'));
  h.run(HUD_FADE_MS * 2);
  assert.equal(hud.faded, false);
  hud.element.dispatchEvent(new Event('pointerleave'));
  assert.equal(hud.pending, true);
  // Leaving the tab cancels the timer, and the key listener goes with it.
  const keyListeners = (m.vis.listeners.get('keydown') || new Set()).size;
  session.destroy();
  assert.equal(hud.pending, false);
  assert.equal(h.pending(), 0);
  assert.ok((m.vis.listeners.get('keydown') || new Set()).size < keyListeners, 'the document key listener removed');
  m.vis.press({ key: 'a' });
  assert.equal(h.pending(), 0, 'a key after closing arms nothing');
});

test('the side panel: opened and closed from the keyboard, Escape closes it, focus moves sensibly, and its state is remembered', async () => {
  const m = await mount();
  const { session, controls } = m;
  const focused = [];
  controls.panelClose.focus = () => focused.push('close');
  controls.panelButton.focus = () => focused.push('panel button');
  assert.equal(controls.panel.hidden, true);
  assert.equal(controls.panelButton.getAttribute('aria-expanded'), 'false');
  assert.equal(controls.panelButton.getAttribute('aria-controls'), 'viz-panel');
  assert.equal(controls.panel.getAttribute('id'), 'viz-panel');
  // Enter or Space on a button is a click.
  controls.panelButton.dispatchEvent(new Event('click'));
  assert.equal(controls.panel.hidden, false);
  assert.equal(controls.panelButton.getAttribute('aria-expanded'), 'true');
  assert.ok(m.root.classList.contains('viz-panel-open'));
  assert.deepEqual(m.saved.at(-1), { visualizerPanelOpen: true });
  assert.deepEqual(focused, ['close']);
  // Everything else is in it.
  for (const name of ['sceneButton', 'lookGroup', 'shuffleMode', 'shuffleCost', 'shuffleBars', 'qualitySelect', 'brightSlider', 'fpsToggle', 'noticeLine']) {
    assert.ok(controls.panel.contains(controls[name]), name);
  }
  assert.ok(controls.fpsButtons.every((button) => controls.panel.contains(button)));
  // Escape closes it and gives focus back to its button.
  const escape = event('keydown', { key: 'Escape' });
  controls.panel.dispatchEvent(escape);
  assert.equal(controls.panel.hidden, true);
  assert.deepEqual(m.saved.at(-1), { visualizerPanelOpen: false });
  assert.deepEqual(focused, ['close', 'panel button']);
  // The close button too.
  controls.panelButton.dispatchEvent(new Event('click'));
  controls.panelClose.dispatchEvent(new Event('click'));
  assert.equal(controls.panel.hidden, true);
  // Closing it closes the scene list in it.
  controls.panelButton.dispatchEvent(new Event('click'));
  controls.sceneButton.dispatchEvent(new Event('click'));
  assert.equal(session.sceneList.open, true);
  controls.panelClose.dispatchEvent(new Event('click'));
  assert.equal(session.sceneList.open, false);
  session.destroy();
  // Remembered: open at once next time.
  const again = await mount({ settings: { visualizerPanelOpen: true } });
  assert.equal(again.controls.panel.hidden, false);
  assert.equal(again.controls.panelButton.getAttribute('aria-expanded'), 'true');
  again.session.destroy();
});

test('favourites in the tab: the star saves the scene and look shown, marks it in the list, and the list can show only favourites', async () => {
  const m = await mount({ settings: { visualizerScene: 'aurora' } });
  const { session, controls } = m;
  const star = controls.star;
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(star.getAttribute('aria-label'), 'Add to favorites');
  star.dispatchEvent(new Event('click'));
  const saved = m.saved.at(-1).visualizerFavourites;
  assert.deepEqual(saved, ['aurora:0'], 'the scene and the look shown');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(star.getAttribute('aria-label'), 'Remove from favorites');
  // Another look of the same scene is not starred.
  controls.lookNext.dispatchEvent(new Event('click'));
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  controls.lookPrev.dispatchEvent(new Event('click'));
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  // The list: a star mark, and the Favourites filter.
  const list = session.sceneList;
  const aurora = list.options.get('aurora');
  assert.equal(aurora.children.find((child) => child.className === 'viz-scene-star').hidden, false);
  assert.match(aurora.getAttribute('aria-label'), /favorite/);
  assert.equal(list.options.get('plasma').children.find((child) => child.className === 'viz-scene-star').hidden, true);
  controls.sceneButton.dispatchEvent(new Event('click'));
  controls.favouritesOnly.dispatchEvent(new Event('click'));
  assert.equal(controls.favouritesOnly.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(list.shown, ['aurora']);
  // Unstarred: an empty favourites list says how to star one.
  list.close();
  star.dispatchEvent(new Event('click'));
  assert.deepEqual(m.settings.visualizerFavourites, []);
  controls.sceneButton.dispatchEvent(new Event('click'));
  assert.deepEqual(list.shown, []);
  assert.match(list.panel.children[2].textContent, /No favorites yet/);
  session.destroy();
});

test('shuffle in the tab: prepared ahead and shown from the staging slot, with a cross-fade charged to the flash budget', async () => {
  const m = await mount({ settings: { visualizerShuffle: true, visualizerShuffleBars: 8 }, animate: true });
  const { session, controls } = m;
  const fade = m.fades;
  assert.equal(controls.shuffleButton.getAttribute('aria-pressed'), 'true');
  assert.equal(controls.shuffleMode.value, 'all');
  m.start();
  await m.play(1000);
  const ahead = session.nextPick;
  assert.ok(ahead && ahead !== 'plasma', 'the next scene is chosen ahead');
  assert.ok(['light', 'medium'].includes(sceneById(ahead).cost), 'light and medium by default');
  await m.until(() => session.switcher.staged(ahead), 'prepared ahead');
  assert.equal(session.switcher.current, 'plasma', 'not shown before it is due');
  const transitions = session.bridge.limiter.stats.transitions;
  await m.play(19500); // 8 bars at 120 BPM is under the 20 s stay
  assert.equal(session.switcher.current, ahead);
  assert.equal(session.shuffleStats.changes, 1);
  assert.equal(session.switcher.stats.fromStage, 1, 'installed from the staging slot');
  assert.notEqual(session.note.textContent, NOTES.preparing);
  assert.equal(session.bridge.limiter.stats.transitions, transitions + 1, 'charged to the flash budget');
  // The cross-fade: the outgoing picture, faded out by the compositor.
  assert.equal(fade.copies.length, 1);
  assert.equal(fade.copies[0], session.canvas);
  assert.equal(fade.animations.length, 1);
  const [animation] = fade.animations;
  assert.deepEqual(animation.frames, [{ opacity: 1 }, { opacity: 0 }]);
  assert.equal(animation.options.duration, CROSSFADE_MS);
  assert.equal(animation.options.easing, 'linear');
  // Flash rules: a full swing of light spread over at least 30 frames at 60 Hz.
  assert.ok(CROSSFADE_MS >= 500);
  assert.equal(session.fade.hidden, false);
  m.h.run(CROSSFADE_MS);
  assert.equal(session.fade.hidden, true);
  assert.deepEqual([session.fade.width, session.fade.height], [0, 0], 'its memory back');
  // Not saved as the scene's own look, and the timer starts again.
  assert.ok(m.saved.some((p) => p.visualizerScene === ahead), 'the scene is remembered');
  assert.equal(session.shuffleTimer.due, false);
  session.destroy();
  assert.equal(m.h.pending(), 0);
});

test('shuffle never shows a blank: a scene not ready when due is waited for, and a full flash budget delays the change', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scenes = SCENES.map((scene) => (scene.id === 'plasma' ? scene : { ...scene, load: () => gate.then(() => scene.load()) }));
  const m = await mount({ scenes, settings: { visualizerShuffle: true, visualizerShuffleBars: 8 }, animate: true });
  const { session } = m;
  m.start();
  await m.play(22000);
  const waiting = session.nextPick;
  assert.ok(waiting);
  assert.equal(session.shuffleTimer.due, true);
  assert.equal(session.switcher.current, 'plasma', 'the scene showing stays');
  assert.ok(session.shuffleStats.waitedNotReady > 0);
  const draws = m.gl.draws;
  await m.play(1000);
  assert.ok(m.gl.draws >= draws + 20, `and keeps moving: ${m.gl.draws - draws} frames`);
  assert.equal(session.loop.mode, LOOP_MODES.live);
  // Ready: but the flash budget is full, so it waits for room.
  release();
  await m.until(() => session.switcher.staged(waiting), 'prepared');
  const limiter = session.bridge.limiter;
  const now = m.h.now / 1000;
  while (limiter.transition(now)) { /* fill the budget */ }
  m.h.run(100);
  assert.equal(session.switcher.current, 'plasma');
  assert.ok(session.shuffleStats.waitedBudget > 0);
  await m.play(1500);
  assert.equal(session.switcher.current, waiting, 'shown once the budget has room');
  // A change by hand never waits for the budget.
  while (limiter.transition(m.h.now / 1000)) { /* fill the budget */ }
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  session.destroy();
});

test('shuffle: previous and next walk back and forth through the scenes it showed; with nothing playing it rests', async () => {
  const m = await mount({ settings: { visualizerShuffle: true } });
  const { session, controls, h } = m;
  const shown = () => session.switcher.current;
  controls.next.dispatchEvent(new Event('click'));
  await m.until(() => shown() !== 'plasma', 'first shuffled');
  const a = shown();
  controls.next.dispatchEvent(new Event('click'));
  await m.until(() => shown() !== a, 'second shuffled');
  const b = shown();
  assert.deepEqual(session.trail, ['plasma', a, b]);
  controls.prev.dispatchEvent(new Event('click'));
  await m.until(() => shown() === a, 'back to a');
  controls.prev.dispatchEvent(new Event('click'));
  await m.until(() => shown() === 'plasma', 'back to plasma');
  controls.prev.dispatchEvent(new Event('click'));
  assert.equal(session.switcher.wanted, 'plasma', 'nothing before the first');
  controls.next.dispatchEvent(new Event('click'));
  await m.until(() => shown() === a, 'forward to a');
  controls.next.dispatchEvent(new Event('click'));
  await m.until(() => shown() === b, 'forward to b');
  controls.next.dispatchEvent(new Event('click'));
  await m.until(() => ![a, b, 'plasma'].includes(shown()), 'a new one past the end');
  assert.deepEqual(session.trail.slice(0, 3), ['plasma', a, b]);
  // Nothing playing: idle for 20 s, then a still picture; no change, nothing scheduled.
  const changes = session.shuffleStats.changes;
  const current = shown();
  h.run(150000);
  assert.equal(session.loop.mode, LOOP_MODES.rest);
  assert.equal(shown(), current);
  assert.equal(session.shuffleStats.changes, changes);
  assert.equal(session.shuffleTimer.dwell, 0, 'not counted without sound');
  assert.equal(h.pending(), 0);
  // Off: previous and next follow the list again.
  controls.shuffleMode.value = 'off';
  controls.shuffleMode.dispatchEvent(new Event('change'));
  assert.equal(controls.shuffleButton.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(m.saved.at(-1), { visualizerShuffle: false, visualizerShufflePool: 'all' });
  session.destroy();
});

test('shuffle settings: favourites only, the cost filter, change every N bars, and the step-down cap', async () => {
  const m = await mount({
    settings: {
      visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: ['tunnel', 'moire', 'plasma'], visualizerQuality: 'high', visualizerFps: 60,
    },
  });
  const { session, controls, h } = m;
  assert.equal(controls.shuffleMode.value, 'favourites');
  m.start();
  await m.play(500);
  assert.ok(['tunnel', 'moire'].includes(session.nextPick), `a favourite: ${session.nextPick}`);
  // The cost filter and bars, saved.
  controls.shuffleCost.value = 'light';
  controls.shuffleCost.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerShuffleCost: 'light', visualizerShuffleCostPicked: true });
  controls.shuffleBars.value = '32';
  controls.shuffleBars.dispatchEvent(new Event('change'));
  assert.deepEqual(m.saved.at(-1), { visualizerShuffleBars: 32 });
  assert.equal(session.shuffleTimer.bars, 32);
  // All scenes, then a computer that cannot keep up while a medium scene shows:
  // the shuffle keeps to lighter scenes from then on.
  controls.shuffleMode.value = 'all';
  controls.shuffleMode.dispatchEvent(new Event('change'));
  controls.shuffleCost.value = 'all';
  controls.shuffleCost.dispatchEvent(new Event('change'));
  session.sceneList.pick('kaleidoscope');
  await m.until(() => session.switcher.current === 'kaleidoscope', 'kaleidoscope');
  assert.equal(sceneById('kaleidoscope').cost, 'medium');
  h.run(500, 1000 / 60);
  h.run(2 * STEP_DOWN_WINDOW_MS + STEP_DOWN_GRACE_MS + 1000, 40);
  assert.equal(session.stepDown.lowered, true);
  assert.equal(session.costCap, 'light');
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(1) });
  assert.ok(shuffle.poolOf({ pool: 'all', costMax: lighterCost('heavy', session.costCap) }).every((id) => sceneById(id).cost === 'light'));
  // The tab's next pick follows the cap.
  controls.shuffleBars.value = '8';
  controls.shuffleBars.dispatchEvent(new Event('change'));
  m.start();
  await m.play(500);
  assert.ok(session.nextPick && sceneById(session.nextPick).cost === 'light', `capped: ${session.nextPick}`);
  // A quality picked by hand clears it.
  controls.qualitySelect.value = 'high';
  controls.qualitySelect.dispatchEvent(new Event('change'));
  assert.equal(session.costCap, null);
  session.destroy();
});

/* ---------------- Review fixes (slice 4) ---------------- */

test('a look change goes through the guarded transition: a cross-fade charged to the flash budget, one at a time, the latest wins, slower when the budget is full', async () => {
  const m = await mount({ settings: { visualizerScene: 'aurora' }, animate: true });
  const { session, controls, h } = m;
  m.start();
  await m.play(1000);
  const limiter = session.bridge.limiter;
  const charged = limiter.stats.transitions;
  controls.lookNext.dispatchEvent(new Event('click'));
  assert.equal(m.fades.animations.length, 1, 'a cross-fade');
  assert.equal(m.fades.animations[0].options.duration, CROSSFADE_MS);
  assert.equal(limiter.stats.transitions, charged + 1, 'charged');
  assert.equal(session.renderer.values.scheme, 1, 'the new look under the outgoing picture');
  // Pressed again and again: nothing more until that one is done, then one
  // more change, to the last look asked for.
  for (let index = 0; index < 5; index += 1) controls.lookNext.dispatchEvent(new Event('click'));
  assert.equal(m.fades.animations.length, 1);
  assert.equal(session.renderer.values.scheme, 1, 'waits');
  h.run(CROSSFADE_MS + 20);
  assert.equal(m.fades.animations.length, 2, 'one more change for five presses');
  assert.equal(session.renderer.values.scheme, m.settings.visualizerLooks.aurora ?? 0);
  h.run(CROSSFADE_MS + 20);
  // The budget full: a press still changes the look, but more slowly.
  while (limiter.transition(h.now / 1000)) { /* fill it */ }
  controls.lookPrev.dispatchEvent(new Event('click'));
  assert.equal(m.fades.animations.length, 3);
  assert.equal(m.fades.animations[2].options.duration, CROSSFADE_SLOW_MS);
  // From the settings (another window): the same way.
  h.run(CROSSFADE_SLOW_MS + 20);
  m.apply({ visualizerLooks: { aurora: 3 } });
  assert.equal(m.fades.animations.length, 4);
  assert.equal(session.renderer.values.scheme, 3);
  session.destroy();
});

test('without Web Animations or a 2D copy, a change dips to black and back (a CSS ramp), never a hard cut', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = await mount({ settings: { visualizerScene: 'aurora' } });
  const { session, controls, h } = m;
  const canvas = session.canvas;
  m.start();
  await m.play(1000);
  // A look: down first, changed in the dark, then up.
  controls.lookNext.dispatchEvent(new Event('click'));
  const half = Math.round(CROSSFADE_MS / 2);
  assert.equal(canvas.style.opacity, '0');
  assert.equal(canvas.style.transition, `opacity ${half}ms linear`);
  assert.equal(session.renderer.values.scheme, 0, 'not yet');
  h.run(half + 5);
  assert.equal(session.renderer.values.scheme, 1, 'changed in the dark');
  assert.equal(canvas.style.opacity, '', 'ramping back up');
  h.run(half + 5);
  assert.equal(canvas.style.transition, '', 'done');
  assert.equal(session.transition.stats.dips, 1);
  // A scene: compiled, held until the picture is dark, then installed.
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.stats.held >= 1, 'held');
  assert.equal(session.switcher.current, 'aurora', 'the old one until dark');
  assert.equal(canvas.style.opacity, '0');
  await m.until(() => session.switcher.current === 'tunnel', 'installed');
  h.run(half + 5);
  assert.equal(canvas.style.opacity, '');
  // Brightness: the dip ramps back to it.
  m.apply({ visualizerBrightness: 50 });
  h.run(1000);
  // A copy that fails: a dip as well.
  session.fade.animate = () => ({ cancel() {} });
  session.fade.getContext = () => ({ fillRect() {}, drawImage() { throw new Error('copy failed'); } });
  const dips = session.transition.stats.dips;
  session.sceneList.pick('moire');
  await m.until(() => session.switcher.current === 'moire', 'moire');
  assert.equal(session.transition.stats.dips, dips + 1);
  h.run(half + 5);
  assert.equal(canvas.style.opacity, '0.5', 'back to the brightness chosen');
  session.destroy();
});

test('mashing Next cannot strobe: changes coalesce, the latest wins, one transition at a time', async () => {
  const m = await mount({ animate: true });
  const { session, controls, h } = m;
  m.start();
  await m.play(1000);
  const starts = [];
  const push = m.fades.animations.push.bind(m.fades.animations);
  m.fades.animations.push = (animation) => { starts.push(h.now); return push(animation); };
  for (let index = 0; index < 12; index += 1) {
    controls.next.dispatchEvent(new Event('click'));
    h.run(40);
    await settle(() => false, 3);
  }
  const wanted = m.settings.visualizerScene;
  await m.until(() => session.switcher.current === wanted && !session.transition.busy, 'the last one asked for');
  assert.ok(starts.length >= 1 && starts.length <= 3, `${starts.length} changes shown for 12 presses`);
  for (let at = 1; at < starts.length; at += 1) {
    assert.ok(starts[at] - starts[at - 1] >= CROSSFADE_MS, 'never two at once');
  }
  session.destroy();
});

test('at reduced brightness the cross-fade is a true one: the outgoing frame is copied already dimmed and faded from 1 to 0', async () => {
  const m = await mount({ settings: { visualizerBrightness: 50 }, animate: true });
  const { session } = m;
  m.start();
  await m.play(1000);
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  assert.equal(session.canvas.style.opacity, '0.5', 'the incoming frame is dimmed');
  assert.ok(m.fades.fills >= 1, 'over black');
  assert.equal(m.fades.alphas.at(-1), 0.5, 'the outgoing frame copied at the same brightness');
  assert.deepEqual(m.fades.animations.at(-1).frames, [{ opacity: 1 }, { opacity: 0 }]);
  // So on screen: a x 0.5 x old + (1 - a) x 0.5 x new, never above the brighter.
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    for (const [old, now] of [[1, 0], [0, 1], [1, 1], [0.3, 0.8]]) {
      assert.ok(a * 0.5 * old + (1 - a) * 0.5 * now <= 0.5 * Math.max(old, now) + 1e-12);
    }
  }
  session.destroy();
});

test('shuffle: a favourite unstarred (or no longer eligible) while prepared ahead is dropped and another picked', async () => {
  const m = await mount({ settings: { visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: ['tunnel', 'moire'], visualizerShuffleBars: 8 }, animate: true });
  const { session } = m;
  m.start();
  await m.play(500);
  const ahead = session.nextPick;
  assert.ok(['tunnel', 'moire'].includes(ahead));
  await m.until(() => session.switcher.staged(ahead), 'prepared');
  const other = ahead === 'tunnel' ? 'moire' : 'tunnel';
  m.apply({ visualizerFavourites: [other] });
  assert.notEqual(session.nextPick, ahead, 'dropped at once');
  assert.notEqual(session.switcher.stagedId, ahead);
  assert.ok(session.shuffleStats.dropped >= 1);
  await m.play(25000);
  assert.equal(session.switcher.current, other, 'only a favourite is shown');
  // Shuffle off: nothing ahead.
  m.apply({ visualizerShuffle: false });
  assert.equal(session.nextPick, null);
  session.destroy();
});

test('a scene that fails to load no longer counts as wanted: nothing stays busy and the shuffle carries on', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = {
    id: 'broken', name: 'Broken', category: 'Test', file: 'effects/broken.js', cost: 'heavy', audio: 'motion', links: null, defaults: null, mood: 'calm', hue: 'cool',
    load: () => Promise.reject(new Error('no such chunk')),
  };
  const m = await mount({ scenes: [...SCENES, broken], settings: { visualizerShuffle: true, visualizerShuffleBars: 8 }, animate: true });
  const { session } = m;
  m.start();
  await m.play(1000);
  session.sceneList.pick('broken');
  await m.until(() => session.switcher.stats.failures >= 1, 'failed');
  assert.equal(session.switcher.wanted, 'plasma');
  assert.equal(session.switcher.busy, false);
  await m.play(25000);
  assert.ok(session.shuffleStats.changes >= 1, 'shuffle carried on');
  session.destroy();
});

test('the shuffle remembers a pick only when it is shown: a pick dropped before then stays in the bag', () => {
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(4) });
  const context = { pool: 'all', costMax: 'heavy' };
  const a = shuffle.next(context);
  assert.ok(shuffle.bag.includes(a), 'still in the bag');
  assert.deepEqual(shuffle.history, []);
  shuffle.shown(a);
  assert.ok(!shuffle.bag.includes(a));
  assert.deepEqual(shuffle.history, [a]);
});

test('the notice is modal: Tab stays in it, the rest is inert while it is open, focus goes back when it closes', async () => {
  const m = await mount({ seen: false });
  const { session, controls, vis } = m;
  const focusable = (node) => { node.focus = () => { vis.doc.activeElement = node; }; };
  const { accept, decline, start } = session.notice.buttons;
  [accept, decline, start, controls.noticeLine].forEach(focusable);
  for (const node of [session.canvas, controls.hud, controls.panel]) assert.equal(node.inert, true);
  const tab = (shiftKey = false) => session.notice.element.dispatchEvent(event('keydown', { key: 'Tab', shiftKey }));
  vis.doc.activeElement = accept;
  tab();
  assert.equal(vis.doc.activeElement, decline);
  tab();
  assert.equal(vis.doc.activeElement, accept, 'round to the first');
  tab(true);
  assert.equal(vis.doc.activeElement, decline, 'and back');
  // Escape still reaches it: Not now; nothing inert any more.
  session.notice.element.dispatchEvent(event('keydown', { key: 'Escape' }));
  assert.equal(session.notice.open, false);
  for (const node of [session.canvas, controls.hud, controls.panel]) assert.equal(node.inert, false);
  assert.equal(vis.doc.activeElement, start);
  start.dispatchEvent(new Event('click'));
  await m.until(() => Boolean(session.switcher.current), 'started');
  // Shown again from the panel: focus comes back to the panel's line.
  vis.doc.activeElement = controls.noticeLine;
  controls.noticeLine.dispatchEvent(new Event('click'));
  assert.equal(vis.doc.activeElement, accept);
  accept.dispatchEvent(new Event('click'));
  assert.equal(vis.doc.activeElement, controls.noticeLine);
  session.destroy();
});

test('hidden: the buttons\' timer, "Preparing" and a running fade stop at once, a scene finishing meanwhile goes in without a fade, and the shuffle\'s clock waits', async () => {
  const m = await mount({ settings: { visualizerShuffle: true }, animate: true });
  const { session, h } = m;
  m.start();
  await m.play(1000);
  session.sceneList.pick('tunnel');
  await m.until(() => session.switcher.current === 'tunnel', 'tunnel');
  assert.equal(session.fading, true);
  assert.equal(session.hud.pending, true);
  session.sceneList.pick('moire'); // loading: "Preparing" armed
  const dwell = session.shuffleTimer.dwell;
  m.vis.setVisible(false);
  assert.equal(session.fading, false, 'the fade finished at once');
  assert.equal(session.fade.hidden, true);
  assert.equal(session.hud.pending, false, 'no timer for the buttons');
  assert.equal(session.transition.pending, false);
  const cuts = session.transition.stats.cuts;
  await m.until(() => session.switcher.current === 'moire', 'moire');
  assert.equal(session.transition.stats.cuts, cuts + 1, 'installed without a fade');
  assert.notEqual(session.note.textContent, NOTES.preparing);
  h.run(30000);
  assert.equal(session.shuffleTimer.dwell, dwell, 'the shuffle\'s clock did not move');
  assert.equal(session.shuffleStats.changes, 0);
  m.vis.setVisible(true);
  assert.equal(session.hud.faded, false);
  session.destroy();
});

test('the notice shown again pauses everything behind it: no motion, no shuffle; Continue resumes, Not now leaves the still frame', async () => {
  const m = await mount({ settings: { visualizerShuffle: true, visualizerShuffleBars: 8 }, animate: true });
  const { session, controls } = m;
  m.start();
  await m.play(1000);
  await m.until(() => session.nextPick && session.switcher.staged(session.nextPick), 'prepared ahead');
  controls.noticeLine.dispatchEvent(new Event('click'));
  assert.equal(session.started, false);
  assert.equal(session.loop.mode, LOOP_MODES.off);
  assert.equal(session.nextPick, null);
  assert.equal(session.switcher.stagedId, null);
  assert.equal(controls.hud.hidden, true);
  const draws = m.gl.draws;
  const current = session.switcher.current;
  await m.play(30000);
  assert.equal(m.gl.draws, draws, 'no motion');
  assert.equal(session.switcher.current, current, 'no shuffle');
  assert.equal(session.shuffleStats.changes, 0);
  assert.equal(m.h.pending(), 0, 'nothing scheduled');
  // Not now: still, with the start button; nothing redrawn.
  session.notice.buttons.decline.dispatchEvent(new Event('click'));
  assert.equal(session.notice.startBox.hidden, false);
  assert.equal(m.gl.draws, draws);
  // Start: moving and shuffling again.
  session.notice.buttons.start.dispatchEvent(new Event('click'));
  assert.equal(session.started, true);
  await m.play(25000);
  assert.ok(session.shuffleStats.changes >= 1);
  session.destroy();
});

test('the live path allocates nothing for the shuffle and mood: one music object, and an empty pool is not asked again every frame', async () => {
  const m = await mount({ settings: { visualizerShuffle: true, visualizerShufflePool: 'favourites' } });
  const { session } = m;
  assert.equal(session.bridge.music(), session.bridge.music(), 'the same object');
  let asked = 0;
  const next = session.shuffle.next;
  session.shuffle.next = (context) => { asked += 1; return next(context); };
  m.start();
  await m.play(3000);
  assert.ok(asked <= 1, `asked ${asked} times`);
  m.apply({ visualizerFavourites: ['tunnel'] });
  await m.play(200);
  assert.equal(session.nextPick, 'tunnel', 'asked again once the pool changed');
  session.destroy();
});

test('favourites-only shuffle with no favourites says so and does not show the shuffle as running; with one favourite showing, nothing is prepared, installed or charged again', async () => {
  const m = await mount({ settings: { visualizerShuffle: true, visualizerShufflePool: 'favourites', visualizerFavourites: [], visualizerShuffleBars: 8 }, animate: true });
  const { session, controls } = m;
  m.start();
  await m.play(1000);
  assert.equal(controls.shuffleMode.value, 'favourites', 'the choice made stays');
  assert.equal(controls.shuffleNote.textContent, SHUFFLE_TEXT.noFavourites);
  assert.equal(session.hud.buttons.shuffle.getAttribute('aria-pressed'), 'false', 'not shown as running');
  // One favourite: the scene showing (plasma has no looks in the favourite).
  const current = session.switcher.current;
  m.apply({ visualizerFavourites: [current] });
  assert.equal(controls.shuffleNote.textContent, '');
  assert.equal(session.hud.buttons.shuffle.getAttribute('aria-pressed'), 'true');
  const installs = session.renderer.stats.compiles;
  const preloads = session.switcher.stats.preloads;
  const fades = session.transition.stats.fades + session.transition.stats.dips + session.transition.stats.cuts;
  const charged = session.bridge.limiter.stats.pulses;
  await m.play(40000);
  assert.equal(session.switcher.current, current);
  assert.ok(session.shuffleStats.nothingNew >= 1, 'seen as nothing new');
  assert.equal(session.shuffleStats.changes, 0, 'no change made');
  assert.equal(session.switcher.stats.preloads, preloads, 'nothing prepared ahead');
  assert.equal(session.renderer.stats.compiles, installs, 'nothing compiled again');
  assert.equal(session.transition.stats.fades + session.transition.stats.dips + session.transition.stats.cuts, fades, 'no change of picture charged');
  assert.ok(session.bridge.limiter.stats.pulses >= charged);
  // A second favourite: the shuffle moves again.
  m.apply({ visualizerFavourites: [current, 'tunnel'] });
  await m.play(40000);
  assert.ok(session.shuffleStats.changes >= 1);
  session.destroy();
});
