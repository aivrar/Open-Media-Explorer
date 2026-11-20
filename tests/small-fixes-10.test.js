import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { PROCESSOR_USE_LABELS, PROCESSOR_USE_NAMES, normalizeProcessorUse } from '../src/lib/processor-budget.js';
import { PROCESSOR_LIMIT_HINTS, PROCESSOR_USE_HINT } from '../src/lib/settings.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { COST_LABELS } from '../src/visualizer/scene-list.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { MOOD_ANNOUNCE_MS, SHUFFLE_COST_CHOICES, mountVisualizer } from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Processor use is shown as Low (default), Balanced, High; the stored value stays "light"; scene cost keeps Light', () => {
  assert.deepEqual(Object.values(PROCESSOR_USE_LABELS), ['Low (default)', 'Balanced', 'High']);
  assert.deepEqual(Object.keys(PROCESSOR_USE_LABELS), ['light', 'balanced', 'high']);
  assert.equal(PROCESSOR_USE_NAMES.light, 'Low');
  assert.equal(normalizeProcessorUse('light'), 'light');
  for (const text of [PROCESSOR_USE_HINT, ...Object.values(PROCESSOR_LIMIT_HINTS)]) assert.doesNotMatch(text, /\bLight\b/, text);
  const about = read('src/modes/about.js');
  const section = about.slice(about.indexOf('id="about-processor-use"'), about.indexOf('data-about-credits-slot'));
  assert.doesNotMatch(section, /\bLight\b/);
  // The scene cost classes are unchanged.
  assert.equal(COST_LABELS.light, 'Light');
  assert.deepEqual(SHUFFLE_COST_CHOICES.map(([, label]) => label), ['Light only', 'Light and medium', 'All, heavy too']);
});

test('the mood line is not announced on every change: said once when the panel opens, and adds no Tab stop', async () => {
  const h = createClockHarness();
  const vis = fakeDocWithElements({ width: 1280, height: 720 });
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false, isPlaying() { return this.playing; }, isAudible: () => true, getAnalyser() { return this.playing ? node : null; }, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  let current = normalizeSettings({ visualizerNoticeSeen: true, visualizerPanelOpen: false });
  const session = mountVisualizer(new FakeNodeEl('div'), {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); },
    subscribeSettings: () => () => {},
    win: fakeResizeObserverWin(fakeMotion(false)),
    doc: vis.doc,
    createContext: () => ({ gl: new FakeGL(), mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(3),
  });
  for (let round = 0; round < 200 && !session.switcher.current; round += 1) { await settle(() => session.switcher.current, 20); h.run(30); }
  source.playing = true;
  signal.refresh();
  h.run(2000, 1000 / 30);
  const line = session.controls.moodLine;
  assert.match(line.textContent, /^Music: /);
  assert.equal(line.getAttribute('aria-live'), 'off', 'not a live region while it changes');
  assert.equal(line.getAttribute('tabindex'), null, 'no Tab stop of its own');
  // Count writes from here on.
  let text = line.textContent;
  let writes = 0;
  Object.defineProperty(line, 'textContent', { get: () => text, set: (value) => { writes += 1; text = value; }, configurable: true });
  session.controls.panelButton.dispatchEvent(new Event('click'));
  assert.equal(line.getAttribute('aria-live'), 'polite', 'live for the one announcement');
  assert.equal(writes, 0, 'not yet');
  h.run(MOOD_ANNOUNCE_MS + 50, 1000 / 30);
  assert.equal(writes, 1, 'the same text written once, so it is said');
  assert.match(text, /^Music: /);
  session.destroy();
});

test('hit areas: Move buttons in a 2 x 2 block of 24 px buttons answering over 26 x 26; effect rows at least 24 px tall', () => {
  const library = read('src/styles/library.css');
  assert.match(library, /\.card-order \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, 24px\);[^}]*grid-auto-rows: 24px;[^}]*gap: 2px;/);
  assert.match(library, /\.card-order-btn \{[^}]*position: relative;[^}]*width: 24px;[^}]*height: 24px;/);
  // 24 + 1 + 1 = 26 (at least 24 also at 175%); the 2 px gap means
  // neighbours' layers touch, never overlap.
  assert.match(library, /\.card-order-btn::before \{ content: ''; position: absolute; inset: -1px; \}/);
  assert.match(library, /\.card\.has-order-controls \.card-body \{ padding-right: 100px; \}/);
  const viz = read('src/visualizer/visualizer.css');
  assert.match(viz, /\.viz-fx-list \{[^}]*gap: 0 8px;/);
  assert.match(viz, /\.viz-fx-item \{[^}]*min-height: 24px;/);
});
