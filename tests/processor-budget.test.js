import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUDGET_BOUNCE_MS, BUDGET_HEADROOM, BUDGET_OVER_MS, BUDGET_READ_MS, BUDGET_SETTLE_MS, BUDGET_UNDER_MS,
  DEFAULT_PROCESSOR_USE, PROCESSOR_LIMIT_MAX, PROCESSOR_LIMIT_MIN, PROCESSOR_LIMIT_PRESETS, PROCESSOR_USE_LEVELS,
  createBudgetSteer, createUseReader, isSoftwareRenderer, normalizeProcessorLimit, normalizeProcessorUse,
  processorBudget, rendererName,
} from '../src/lib/processor-budget.js';
import { normalizeSettings } from '../src/lib/state.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import {
  DEFAULT_VISUALIZER_FPS, DEFAULT_VISUALIZER_QUALITY, DEFAULT_VISUALIZER_SHUFFLE_COST, VISUALIZER_FRAME_RATES,
  VISUALIZER_PRESETS,
} from '../src/lib/visualizer-settings.js';
import {
  STEP_DOWN_GRACE_MS, STEP_DOWN_SETTLE_MS, STEP_DOWN_SHARE, STEP_DOWN_WINDOW_MS, STEP_DOWN_WINDOWS_NEEDED,
  createStepDown,
} from '../src/visualizer/step-down.js';
import { LINE_MAX_SEGMENTS, LINE_QUALITY } from '../src/visualizer/line-host.js';
import { PROCESSOR_LIMIT_HINTS, PROCESSOR_USE_HINT, bindProcessorUse } from '../src/lib/settings.js';
import { FakeElement } from './helpers/fake-dom.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/* ---- The setting: storage and defaults ---- */

test('Processor use is stored in the settings, Light by default, with a limit of 10 to 80 %', () => {
  assert.equal(DEFAULT_PROCESSOR_USE, 'light');
  const fresh = normalizeSettings({});
  assert.equal(fresh.processorUse, 'light');
  assert.equal(fresh.processorLimit, null, 'the level preset until the user sets one');
  assert.deepEqual(PROCESSOR_USE_LEVELS, ['light', 'balanced', 'high']);
  assert.equal(normalizeSettings({ processorUse: 'high', processorLimit: 55 }).processorUse, 'high');
  assert.equal(normalizeSettings({ processorUse: 'high', processorLimit: 55 }).processorLimit, 55);
  assert.equal(normalizeSettings({ processorUse: 'turbo' }).processorUse, 'light');
  assert.equal(normalizeProcessorUse(undefined), 'light');
  assert.equal(PROCESSOR_LIMIT_MIN, 2);
  for (const [given, kept] of [[1, PROCESSOR_LIMIT_MIN], [99, PROCESSOR_LIMIT_MAX], [42, 42], ['63', 63], [2.4, 2], [3, 3],
    ['x', null], [null, null], ['', null], [Number.NaN, null]]) {
    assert.equal(normalizeProcessorLimit(given), kept, String(given));
  }
  // Inside the one settings key: carried by the profile copy and the backup,
  // no new top-level key anywhere.
  assert.ok(PROFILE_STORAGE_KEYS.includes('worldmedia.settings.v1'));
});

test('what each level allows', () => {
  assert.deepEqual(PROCESSOR_LIMIT_PRESETS, { light: 25, balanced: 40, high: 60 });
  assert.deepEqual({ ...processorBudget({}) }, {
    level: 'light', limit: 25, limitShare: 0.25, readsUse: false, stepsUp: false, softwareQuality: 'low',
  });
  assert.deepEqual({ ...processorBudget({ processorUse: 'balanced' }) }, {
    level: 'balanced', limit: 40, limitShare: 0.4, readsUse: true, stepsUp: true, softwareQuality: null,
  });
  assert.deepEqual({ ...processorBudget({ processorUse: 'high', processorLimit: 70 }) }, {
    level: 'high', limit: 70, limitShare: 0.7, readsUse: true, stepsUp: true, softwareQuality: null,
  });
});

/* ---- Light is today's behaviour ---- */

test('Light leaves every Visualizer limit as it is today (a table against the current constants)', async () => {
  const today = {
    presets: { low: [0.5, 600000], medium: [0.75, 1200000], high: [1, 2400000] },
    rates: [15, 30, 60], quality: 'medium', fps: 30, shuffleCost: 'medium',
    stepDown: [3000, 0.8, 1000, 2, 1500],
    lines: { low: [0.5, 4000], medium: [0.75, 8000], high: [1, 12000], most: 12000 },
  };
  assert.deepEqual(Object.fromEntries(Object.entries(VISUALIZER_PRESETS).map(([id, p]) => [id, [p.scale, p.maxPixels]])),
    today.presets);
  assert.deepEqual([...VISUALIZER_FRAME_RATES], today.rates);
  assert.equal(DEFAULT_VISUALIZER_QUALITY, today.quality);
  assert.equal(DEFAULT_VISUALIZER_FPS, today.fps);
  assert.equal(DEFAULT_VISUALIZER_SHUFFLE_COST, today.shuffleCost);
  assert.deepEqual([STEP_DOWN_WINDOW_MS, STEP_DOWN_SHARE, STEP_DOWN_SETTLE_MS, STEP_DOWN_WINDOWS_NEEDED,
    STEP_DOWN_GRACE_MS], today.stepDown);
  assert.deepEqual({ ...Object.fromEntries(Object.entries(LINE_QUALITY).map(([id, q]) => [id, [q.trailScale, q.segments]])),
    most: LINE_MAX_SEGMENTS }, today.lines);
  // No size, rate, simulation or line module reads the budget: the levels
  // change none of what the flash and brightness measurements were made with.
  for (const path of ['src/lib/visualizer-settings.js', 'src/visualizer/scenes.js', 'src/visualizer/sim-host.js',
    'src/visualizer/line-host.js', 'src/visualizer/line-scenes.js', 'src/visualizer/flash-limiter.js',
    'src/visualizer/looks.js', 'src/visualizer/fx-catalog.js']) {
    assert.doesNotMatch(await read(path), /processor-budget/, path);
  }
  // At Light the Visualizer draws the chosen quality (Low only for a picture
  // drawn by the processor when no quality was ever picked), reads nothing
  // and never steps up.
  const viz = await read('src/visualizer/index.js');
  assert.match(viz, /const drawQuality = \(\) => \(softwareRendering && budget\.softwareQuality && !qualityPicked \? budget\.softwareQuality : offeredQuality\(\)\);/);
  // (offeredQuality: the chosen one, Very high read as High where the level does not offer it.)
  assert.match(viz, /quality === VISUALIZER_QUALITY_VERY_HIGH && !processorExtras\(budget\.level\)\.qualityAboveHigh \? VISUALIZER_QUALITY_HIGH : quality;/);
  assert.match(viz, /if \(budgetLive && budget\.readsUse && !destroyed\) useReader\.start\(\);/);
});

/* ---- Steering ---- */

test('steering: over the limit for several seconds steps down; brief peaks do not', () => {
  const steer = createBudgetSteer({ limit: 0.4 });
  let now = 0;
  const feed = (share) => { now += BUDGET_READ_MS; return steer.feed(share, now); };
  for (let i = 0; i < 5; i += 1) assert.equal(feed(0.3), null, 'between the headroom and the limit: hold');
  // One peak, then back under: nothing.
  assert.equal(feed(0.9), null);
  for (let i = 0; i < 10; i += 1) assert.equal(feed(0.3), null, 'a brief peak is not sustained');
  // Sustained over the limit.
  const answers = [];
  for (let i = 0; i < 5; i += 1) answers.push(feed(0.9));
  assert.equal(answers.filter((a) => a === 'down').length, 1, 'one notch, then it settles');
  assert.ok(answers.indexOf('down') * BUDGET_READ_MS >= BUDGET_OVER_MS - BUDGET_READ_MS);
});

test('steering: steps back up only with clear headroom, slowly', () => {
  const steer = createBudgetSteer({ limit: 0.5 });
  let now = 0;
  const answers = [];
  for (let t = 0; t <= BUDGET_UNDER_MS + 2 * BUDGET_READ_MS; t += BUDGET_READ_MS) {
    now = t;
    answers.push(steer.feed(0.5 * BUDGET_HEADROOM - 0.05, now));
  }
  assert.equal(answers.filter((a) => a === 'up').length, 1);
  assert.ok(answers.indexOf('up') * BUDGET_READ_MS >= BUDGET_UNDER_MS);
  // Just under the limit but not clearly: never up.
  const close = createBudgetSteer({ limit: 0.5 });
  for (let t = 0; t <= 5 * BUDGET_UNDER_MS; t += BUDGET_READ_MS) assert.notEqual(close.feed(0.45, t), 'up');
  // Light never steps up.
  const light = createBudgetSteer({ limit: 0.5, stepsUp: false });
  for (let t = 0; t <= 5 * BUDGET_UNDER_MS; t += BUDGET_READ_MS) assert.notEqual(light.feed(0, t), 'up');
});

test('steering never swings back and forth', () => {
  // A load that goes over the limit whenever a notch is given back.
  const steer = createBudgetSteer({ limit: 0.5 });
  let notch = 0;
  const changes = [];
  for (let t = 0; t <= 30 * 60_000; t += BUDGET_READ_MS) {
    const share = notch === 0 ? 0.8 : 0.2;
    const answer = steer.feed(share, t);
    if (answer === 'down') { notch += 1; changes.push([t, 'down']); }
    if (answer === 'up') { notch -= 1; steer.raised(t); changes.push([t, 'up']); }
  }
  assert.ok(changes.length <= 3, `changes: ${JSON.stringify(changes)}`);
  assert.equal(steer.upsBlocked, true, 'a bounce stops further step-ups');
  // Between changes there is always at least the settle time.
  for (let i = 1; i < changes.length; i += 1) assert.ok(changes[i][0] - changes[i - 1][0] >= BUDGET_SETTLE_MS);
  assert.ok(BUDGET_BOUNCE_MS > BUDGET_UNDER_MS);
  steer.reset();
  assert.equal(steer.upsBlocked, false, 'a new scene starts free');
});

test('a frame-time step-down soon after a real raise is a bounce: no second raise', () => {
  const steer = createBudgetSteer({ limit: 0.5 });
  const roomy = 0.5 * BUDGET_HEADROOM - 0.1;
  let t = 0;
  let up = null;
  for (; up === null; t += BUDGET_READ_MS) up = steer.feed(roomy, t) === 'up' ? t : null;
  steer.raised(up);
  // The raise made frames slow: the frame-time step-down took a notch.
  steer.changed(up + 10_000);
  assert.equal(steer.upsBlocked, true);
  for (t = up + 10_000; t < up + 10 * BUDGET_UNDER_MS; t += BUDGET_READ_MS) {
    assert.notEqual(steer.feed(roomy, t), 'up', String(t));
  }
  // An 'up' that changed nothing is no raise: a later frame-time step-down
  // is no bounce.
  const idle = createBudgetSteer({ limit: 0.5 });
  let at = 0;
  while (idle.feed(roomy, at) !== 'up') at += BUDGET_READ_MS;
  idle.changed(at + 10_000);
  assert.equal(idle.upsBlocked, false);
  // Long after a raise, a step-down is no bounce either.
  const late = createBudgetSteer({ limit: 0.5 });
  late.raised(0);
  late.changed(BUDGET_BOUNCE_MS + 1);
  assert.equal(late.upsBlocked, false);
});

test('steering without a reading decides nothing and holds nothing over the gap', () => {
  const steer = createBudgetSteer({ limit: 0.4 });
  let t = 0;
  for (; t < BUDGET_OVER_MS - BUDGET_READ_MS; t += BUDGET_READ_MS) assert.equal(steer.feed(0.9, t), null);
  assert.equal(steer.feed(null, t), null);
  assert.equal(steer.smoothed, null);
  // The time over the limit starts again after the gap.
  t += BUDGET_READ_MS;
  assert.equal(steer.feed(0.9, t), null);
  for (const value of [undefined, Number.NaN, 'x']) assert.equal(steer.feed(value, t += 1), null);
  assert.equal(createBudgetSteer({}).feed(0.9, 0), null, 'no limit: no steering');
});

test('the step-down takes and gives back notches when the budget asks', () => {
  const steps = [];
  const stepDown = createStepDown({ quality: 'high', fps: 60, onStep: (to) => steps.push(to) });
  stepDown.newScene('plasma');
  assert.equal(stepDown.lower(1000), true);
  assert.equal(stepDown.quality, 'medium');
  assert.equal(stepDown.lower(2000), true);
  assert.equal(stepDown.quality, 'low');
  assert.equal(stepDown.raise(3000), true);
  assert.equal(stepDown.quality, 'medium');
  assert.deepEqual(stepDown.neededBy('plasma'), { quality: 'medium', fps: 60, fx: Infinity, overlays: Infinity });
  assert.equal(stepDown.raise(4000), true);
  assert.equal(stepDown.neededBy('plasma'), null, 'back at the chosen quality');
  assert.equal(stepDown.raise(5000), false, 'never above what was chosen');
  assert.equal(steps.length, 4);
  // Effects and overlays come back after the quality, overlays first.
  const capped = createStepDown({ quality: 'low', fps: 30, fxInUse: () => 2, overlaysInUse: () => 2 });
  capped.lower(0);
  capped.lower(1);
  assert.equal(capped.fx, 0);
  assert.equal(capped.raise(2), true);
  assert.equal(capped.fx, 1);
  assert.equal(capped.raise(3), true);
  assert.equal(capped.fx, Infinity);
});

/* ---- Reading ---- */

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); },
    async fire() {
      const timer = timers.shift();
      timer.fn();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

test('nothing is read and no timer runs until something asks; stop ends it at once', async () => {
  const clock = fakeTimers();
  const readings = [];
  let asked = 0;
  const reader = createUseReader({
    read: async () => { asked += 1; return asked === 2 ? Promise.reject(new Error('down')) : { share: 0.3 }; },
    onReading: (share) => readings.push(share),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.equal(clock.timers.length, 0, 'zero cost while nothing uses the budget');
  assert.equal(asked, 0);
  reader.start();
  reader.start();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, BUDGET_READ_MS);
  await clock.fire();
  await clock.fire();
  assert.deepEqual(readings, [0.3, null], 'a failed reading is no reading');
  reader.stop();
  assert.equal(clock.timers.length, 0);
  assert.equal(reader.running, false);
});

test('a reply that arrives after stop is dropped', async () => {
  const clock = fakeTimers();
  let answer;
  const readings = [];
  const reader = createUseReader({
    read: () => new Promise((resolve) => { answer = resolve; }),
    onReading: (share) => readings.push(share),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  reader.start();
  await clock.fire();
  reader.stop();
  answer({ share: 0.9 });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.deepEqual(readings, []);
  assert.equal(clock.timers.length, 0);
});

/* ---- Software rendering ---- */

test('a renderer that draws with the processor is recognised', () => {
  for (const name of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
    'llvmpipe (LLVM 15.0.7, 256 bits)', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)']) {
    assert.equal(isSoftwareRenderer(name), true, name);
  }
  for (const name of ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', '', null]) {
    assert.equal(isSoftwareRenderer(name), false, String(name));
  }
  const gl = {
    RENDERER: 7937,
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null),
    getParameter: (value) => (value === 37446 ? 'Google SwiftShader' : 'WebKit WebGL'),
  };
  assert.equal(rendererName(gl), 'Google SwiftShader');
  assert.equal(rendererName({ RENDERER: 1, getExtension: () => null, getParameter: () => 'WebKit WebGL' }), 'WebKit WebGL');
  assert.equal(rendererName({ getParameter() { throw new Error('lost'); } }), '');
  assert.equal(rendererName(null), '');
});

/* ---- Settings and About ---- */

test('the Settings controls save the level and limit; a new level starts at its preset', () => {
  const select = new FakeElement('settings-processor-use', 'select');
  const input = new FakeElement('settings-processor-limit', 'input');
  const hint = new FakeElement('', 'span');
  const link = new FakeElement('', 'a');
  const root = {
    querySelector: (selector) => ({
      'select[data-field="processorUse"]': select,
      'input[data-field="processorLimit"]': input,
      '[data-processor-limit-hint]': hint,
      '[data-act="processor-about"]': link,
    }[selector] || null),
  };
  const saved = [];
  let opened = 0;
  bindProcessorUse(root, {}, { save: (partial) => saved.push(partial), openAbout: () => { opened += 1; } });
  assert.equal(select.value, 'light');
  assert.equal(input.value, '25');
  assert.equal(input.disabled, true, 'the limit is used at Balanced and High only');
  assert.equal(hint.textContent, PROCESSOR_LIMIT_HINTS.light);
  select.value = 'high';
  select.dispatchEvent(new Event('change'));
  assert.deepEqual(saved.at(-1), { processorUse: 'high', processorLimit: null });
  assert.equal(input.value, '60');
  assert.equal(input.disabled, false);
  input.value = '73.4';
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(saved.at(-1), { processorLimit: 73 });
  assert.equal(input.value, '73');
  const click = new Event('click');
  link.dispatchEvent(click);
  assert.equal(opened, 1);
  assert.match(PROCESSOR_USE_HINT, /Low .* default/);
  assert.match(PROCESSOR_USE_HINT, /without a graphics card/);
});

test('the About tab explains Processor use', async () => {
  const about = await read('src/modes/about.js');
  const section = about.slice(about.indexOf('id="about-processor-use"'), about.indexOf('data-about-credits-slot'));
  assert.match(section, /<h2>Processor use<\/h2>/);
  for (const words of [/designed to stay light/, /<strong>Low<\/strong>[\s\S]*default/, /Balanced/, /High/,
    /not a hard cap/, /fans/, /battery/, /other programs may slow down/, /sound\s+can stutter/,
    /drop again by itself/, /Without a graphics card/, /To go back, choose <strong>Low<\/strong>/]) {
    assert.match(section, words);
  }
  assert.doesNotMatch(section, /\d+\s*(fps|frames)/i, 'no numbers about specific computers');
  const settings = await read('src/lib/settings.js');
  assert.match(settings, /<a href="#about-processor-use" data-act="processor-about">What this means<\/a>/);
});
