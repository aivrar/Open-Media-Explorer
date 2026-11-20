import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { FLASH_LIMITS } from '../src/visualizer/flash-limiter.js';
import { TRIGGER_IDLE_AGE } from '../src/visualizer/fx-chain.js';
import { COMPILE_POLL_MS } from '../src/visualizer/scene-renderer.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness } from './helpers/signal-harness.js';
import { danceTrack, simulatedAnalyser } from './helpers/audio-sim.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* The flash budget across the tab's whole life (review round 3): every large
   change of light the picture shows, counted from what reaches it - pulses
   from the limiter's limited output, wraps from the beat clock it gives a
   scene that shows it, trigger firings from the u_age each effect program
   gets, and fast cross-fades as they start - in one rolling history kept
   across a scene change mid-burst, the tab closed and opened again within
   the same second, a pause and resume, a context loss and restore, and the
   frame rate changed from 60 to 15 and back. Slow 1.5 s fades (started
   when the budget was full) are a gradual change by design (transition.js)
   and are logged but not counted. No GPU; fake clocks. */

const LAYOUT = { width: 1280, height: 720 };
const FAMILY = { kick: 'low', beat: 'low', snare: 'mid', hat: 'high', flash: 'flash' };
const PULSES = Object.keys(FAMILY);

/** One page: a clock, the sound, the page's flash window, and what was seen. */
function page() {
  const h = createClockHarness();
  const vis = fakeDocWithElements(LAYOUT);
  const win = fakeResizeObserverWin(fakeMotion(false));
  const node = simulatedAnalyser({ track: danceTrack({ bpm: 175, busy: true }), clock: h.io.clock });
  const source = {
    playing: true,
    isPlaying() { return this.playing; },
    isAudible: () => true,
    getAnalyser() { return this.playing ? node : null; },
    getVolume: () => 1,
    release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const seen = []; // { t, kind }
  const slow = [];
  let current = normalizeSettings({
    visualizerNoticeSeen: true,
    visualizerScene: 'islamic_stars', // shows the beat clock
    visualizerFx: true,
    visualizerFxShuffle: false,
    visualizerFxSet: ['shockwave'],
    visualizerFps: 60,
  });
  const p = {
    h, vis, win, signal, seen, slow, session: null, gl: null,
    get ledger() { return p.session.bridge.limiter.ledger; },
    get settings() { return current; },
    now: () => h.now / 1000,
    /** Open the tab (again): a new session on the same page. */
    async open() {
      const gl = new FakeGL();
      p.gl = gl;
      watchGl(p, gl);
      const root = new FakeNodeEl('div');
      const listeners = new Set();
      p.session = mountVisualizer(root, {
        signal,
        getSettings: () => current,
        saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
        subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        win,
        doc: vis.doc,
        createContext: () => ({ gl, mode: 'webgl2' }),
        loopOptions: h.io,
        random: seededRandom(5),
        loadFxLibrary: async () => import('../src/visualizer/vendor/psychedelia/engine/post-fx-library.js'),
        // (No flashLedger: the page's own, index.js, as in the app.)
      });
      watchSession(p, p.session);
      // (Little time passes meanwhile: reopened, it draws within the second.)
      await p.until(() => Boolean(p.session.switcher.current) && Boolean(p.session.fx.shuffle), 'scene and effects', 2);
      signal.refresh();
    },
    async until(done, label, stepMs = COMPILE_POLL_MS) {
      for (let round = 0; round < 400; round += 1) {
        if (done()) return;
        await settle(done, 20);
        if (done()) return;
        p.step(stepMs);
      }
      assert.fail(`never reached: ${label}`);
    },
    /** `ms` of time, one display frame at a time, watching the fades. */
    step(ms) {
      const end = h.now + ms;
      while (h.now < end - 1e-9) {
        h.run(Math.min(1000 / 60, end - h.now));
        p.lookAtFades();
      }
    },
    async play(ms) {
      for (let left = ms; left > 0; left -= 250) {
        p.step(Math.min(250, left));
        await settle(() => false, 2);
      }
    },
    lookAtFades() {
      const stats = p.session?.transition?.stats;
      if (!stats) return;
      const started = stats.fades + stats.dips;
      const slowNow = stats.slow;
      const was = p.fadeSeen || { started: 0, slow: 0, session: null };
      if (was.session !== p.session) { p.fadeSeen = { started, slow: slowNow, session: p.session }; return; }
      const newSlow = slowNow - was.slow;
      const newAll = started - was.started;
      for (let i = 0; i < newSlow; i += 1) slow.push(p.now());
      for (let i = 0; i < newAll - newSlow; i += 1) seen.push({ t: p.now(), kind: 'fade' });
      p.fadeSeen = { started, slow: slowNow, session: p.session };
    },
  };
  return p;
}

/** Trigger firings from the u_age each effect program is given. */
function watchGl(p, gl) {
  const ages = new Map();
  const uniform1f = gl.uniform1f.bind(gl);
  gl.uniform1f = (at, value) => {
    if (at?.name === 'u_age') {
      const before = ages.get(gl.current);
      const fired = before === undefined ? value < TRIGGER_IDLE_AGE - 1 : value < before - 1e-9;
      if (fired) p.seen.push({ t: p.now(), kind: 'trigger' });
      ages.set(gl.current, value);
    }
    uniform1f(at, value);
  };
}

/** Pulses from the limited output (a family's edges within the coincidence
 *  window are one hit, as the limiter counts them), and wraps of the beat
 *  clock while the scene shows it. */
function watchSession(p, session) {
  const { limiter } = session.bridge;
  const armed = {};
  const familyAt = {};
  for (const name of PULSES) armed[name] = true;
  const step = limiter.step;
  limiter.step = (now, input) => {
    const out = step(now, input);
    for (const name of PULSES) {
      const value = out[name];
      if (value < FLASH_LIMITS.rearmLevel) armed[name] = true;
      else if (armed[name] && value >= FLASH_LIMITS.pulseThreshold) {
        armed[name] = false;
        const family = FAMILY[name];
        if (!(now - (familyAt[family] ?? -Infinity) <= FLASH_LIMITS.coincidenceSeconds)) {
          familyAt[family] = now;
          p.seen.push({ t: p.now(), kind: 'pulse' });
        }
      }
    }
    return out;
  };
  let given = Number.NaN;
  const beatClock = limiter.beatClock;
  limiter.beatClock = (beats, bpm) => {
    const value = beatClock(beats, bpm);
    if (limiter.clockShown && Number.isFinite(given) && Math.floor(value) > Math.floor(given)) p.seen.push({ t: p.now(), kind: 'wrap' });
    given = value;
    return value;
  };
}

/** The most changes seen in any rolling second (the same instant: one). */
function mostInASecond(seen) {
  const times = [...new Set(seen.map((event) => event.t))].sort((a, b) => a - b);
  let most = 0;
  let at = 0;
  for (let start = 0; start < times.length; start += 1) {
    let end = start;
    while (end < times.length && times[end] - times[start] < 1 - 1e-9) end += 1;
    if (end - start > most) { most = end - start; at = times[start]; }
  }
  return { most, at };
}

/** The whole life of the tab, in one history. */
async function life() {
  const p = page();
  await p.open();
  // (The notice was seen before: the picture moves once the scene is up.)
  await p.play(4000);
  // A scene change mid-burst, then another at once, and back.
  const burst = () => p.seen.filter((event) => event.t > p.now() - 0.3).length;
  await p.until(() => burst() >= 1, 'a burst');
  p.session.sceneList.pick('tunnel');
  await p.play(200);
  p.session.sceneList.pick('liquid_chrome');
  await p.play(200);
  p.session.sceneList.pick('islamic_stars');
  await p.play(3000);
  // A change when the budget has room: a fast cross-fade (counted).
  await p.until(() => p.ledger.count('envelope') === 0 && p.ledger.total <= 1, 'room in the budget');
  p.session.sceneList.pick('liquid_chrome');
  await p.play(1500);
  await p.until(() => p.ledger.count('envelope') === 0 && p.ledger.total <= 1, 'room in the budget');
  p.session.sceneList.pick('islamic_stars');
  await p.play(1500);
  // The tab closed and opened again within the same second, its second full.
  await p.until(() => p.ledger.total >= FLASH_LIMITS.maxPulsesPerSecond, 'a full second');
  p.closedAt = p.now();
  p.session.destroy();
  await p.open();
  p.carried = p.ledger.total; // what the reopened tab counts from the second before
  p.reopenedAt = p.now();
  await p.play(3000);
  // Pause ("Not now") and resume.
  p.session.notice.buttons.decline.dispatchEvent(new Event('click'));
  await p.play(700);
  p.session.notice.buttons.start.dispatchEvent(new Event('click'));
  await p.play(3000);
  // The context lost and restored.
  p.session.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  await p.play(300);
  p.session.canvas.dispatchEvent(new Event('webglcontextrestored'));
  await p.play(3000);
  // The frame rate from 60 to 15 and back.
  const fps = (value) => p.session.controls.fpsButtons.find((button) => button.textContent === String(value));
  fps(15).dispatchEvent(new Event('click'));
  await p.play(3000);
  fps(60).dispatchEvent(new Event('click'));
  await p.play(3000);
  p.session.destroy();
  return p;
}

test('the flash budget over the tab\'s whole life: scene changes, closing and opening, pause, context loss and frame rate changes never show more than 3 large changes in a rolling second', async () => {
  const p = await life();
  const count = (kind) => p.seen.filter((event) => event.kind === kind).length;
  assert.ok(count('pulse') >= 20, `pulses seen: ${count('pulse')}`);
  assert.ok(count('wrap') >= 5, `clock wraps seen: ${count('wrap')}`);
  assert.ok(count('trigger') >= 3, `trigger firings seen: ${count('trigger')}`);
  assert.ok(count('fade') >= 1, `fast cross-fades seen: ${count('fade')}`);
  // (Slow fades: logged, not counted.)
  const { most, at } = mostInASecond(p.seen);
  const near = p.seen.filter((event) => event.t >= at && event.t < at + 1).map((event) => `${event.kind}@${event.t.toFixed(3)}`).join(' ');
  assert.ok(most <= FLASH_LIMITS.maxPulsesPerSecond, `at most 3 in any second (${most} from ${at.toFixed(3)} s: ${near}); slow fades logged: ${p.slow.length}`);
});

test('the tab closed and opened again within the second goes on counting the second it closed in (the page keeps one window)', async () => {
  const p = await life();
  assert.ok(p.carried >= 2, `the reopened tab starts from the changes still in the last second (${p.carried})`);
  assert.ok(p.reopenedAt - p.closedAt < 1, `reopened within the second (${(p.reopenedAt - p.closedAt).toFixed(3)} s)`);
});
