import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BEST_STREAM_STATUS_TEXT, OTHER_STREAMS_TEXT, createBestStreamStatus } from '../src/modes/library/other-streams.js';
import {
  NAME_HEAD_MIN_CHARS, keepOwnStream, keepsOwnStream, sameStationName, storeVerification, streamVeto,
} from '../src/lib/stream-verify.js';
import { PROCESSOR_LIMIT_NOTE_MS, PROCESSOR_LIMIT_RANGE_TEXT, bindProcessorUse } from '../src/lib/settings.js';
import { FakeElement } from './helpers/fake-dom.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function withStorage(fn) {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  try { return fn(values); } finally { globalThis.localStorage = previous; }
}

class Node extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.hidden = false; }
  get textContent() { return this._text; }
  set textContent(value) { this._text = value; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { const list = this.parentNode?.children; if (list) list.splice(list.indexOf(this), 1); this.parentNode = null; }
}
function withDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (value) => Object.assign(new Node('#text'), { _text: value }) };
  try { return fn(); } finally { globalThis.document = previous; }
}

/* ============ 1. Verified, used from the next start ============ */

test('Auto: a stream verified while the station plays its own one says it is used from the next start, and offers the way back at once without a restart', () => {
  withStorage(() => withDocument(() => {
    const item = { id: 'radio-browser:drone', source: 'radio-browser', title: 'Drone Zone' };
    let playing = null; // the station plays its own stream
    const played = [];
    const listeners = { auto: null };
    const status = createBestStreamStatus(item, {
      settings: () => ({ bestStreamMode: 'auto' }),
      verified: () => playing,
      checking: () => true,
      keepOwn: (id) => keepOwnStream(id, { handoff: () => {} }),
      current: () => item,
      play: (now) => { played.push(now.id); return Promise.resolve(); },
      onAutoChange: (fn) => { listeners.auto = fn; return () => {}; },
      on: () => () => {},
    });
    const line = status.node.children[0];
    const buttons = () => status.node.children.filter((node) => node.tagName === 'BUTTON');
    assert.equal(line.textContent, 'Better stream: checking...');
    assert.equal(buttons().length, 0);
    // The second check verifies it while the panel is open.
    storeVerification('drone', { alt: { url: 'https://ice.somafm.example/dronezone-256-mp3', bitrate: 256, codec: 'MP3' } }, Date.now());
    listeners.auto();
    assert.equal(line.textContent, `Better stream: 256 kbps MP3, verified. ${BEST_STREAM_STATUS_TEXT.nextStart}`);
    assert.equal(BEST_STREAM_STATUS_TEXT.nextStart, 'It is used from the next start.');
    assert.equal(buttons().length, 1, 'the way back is there at once');
    assert.equal(buttons()[0].textContent, OTHER_STREAMS_TEXT.useOwn);
    buttons()[0].dispatchEvent(new Event('click'));
    assert.deepEqual(played, [], 'nothing restarts: it plays its own stream already');
    assert.equal(keepsOwnStream('drone'), true);
    assert.equal(buttons().length, 0);
    assert.equal(line.textContent, '');
    status.destroy();
  }));
});

test('Auto: once the verified stream plays, the line is as before and the way back switches at once', () => {
  withStorage(() => withDocument(() => {
    const item = { id: 'radio-browser:drone', source: 'radio-browser', title: 'Drone Zone' };
    const alt = { url: 'https://ice.somafm.example/dronezone-256-mp3', bitrate: 256, codec: 'MP3' };
    storeVerification('drone', { alt }, Date.now());
    let playing = { itemId: item.id, ...alt };
    const played = [];
    const status = createBestStreamStatus(item, {
      settings: () => ({ bestStreamMode: 'auto' }),
      verified: () => playing,
      checking: () => false,
      keepOwn: (id) => keepOwnStream(id, { handoff: () => {} }),
      current: () => item,
      play: (now) => { played.push(now.id); playing = null; return Promise.resolve(); },
      onAutoChange: () => () => {},
      on: () => () => {},
    });
    const line = status.node.children[0];
    assert.equal(line.textContent, 'Better stream: 256 kbps MP3, verified');
    const use = status.node.children.find((node) => node.tagName === 'BUTTON');
    use.dispatchEvent(new Event('click'));
    assert.deepEqual(played, [item.id], 'switched back to its own stream at once');
    status.destroy();
  }));
});

/* ============ 2. Announced station names ============ */

test('station names: the same name with a description after it, and the same trailing tag, is the same station', () => {
  // The real pair: SomaFM Drone Zone at 64k and at 256k.
  assert.equal(sameStationName('Drone Zone [SomaFM]', 'Drone Zone: Atmospheric ambient space music. Serve Best Chilled. Safe with most medications. [SomaFM]'), true);
  assert.equal(sameStationName('Drone Zone: Atmospheric ambient space music... [SomaFM]', 'Drone Zone [SomaFM]'), true);
  for (const separator of [': more', ' - more', ' | more', ' (more)']) {
    assert.equal(sameStationName('Jazz Lounge', `Jazz Lounge${separator}`), true, separator);
  }
  // Two stations of one network.
  assert.equal(sameStationName('Groove Salad [SomaFM]', 'Drone Zone [SomaFM]'), false);
  assert.equal(sameStationName('Drone Zone [SomaFM]', 'Drone Zone: ambient [Other Net]'), false, 'different tags');
  // A longer name without a separator is another name.
  assert.equal(sameStationName('Jazz FM', 'Jazz FM Lounge'), false);
  // Short or empty names prove nothing.
  assert.equal(NAME_HEAD_MIN_CHARS, 4);
  assert.equal(sameStationName('FM1: rock', 'FM1: jazz'), false);
  assert.equal(sameStationName('', ''), false);
  assert.equal(sameStationName('[SomaFM]', '[SomaFM]: x'), false);
  assert.equal(sameStationName('Drone Zone', ''), false);
  assert.equal(sameStationName(': a', ': b'), false);
  // Equal as before.
  assert.equal(sameStationName('Jazz FM', 'jazz  fm!'), true);
});

test('stream checks: the Drone Zone pair passes the name check; the rest of the checks are unchanged', () => {
  const own = { url: 'https://ice1.somafm.com/dronezone-64-aac', kind: 'audio', bitrate: 64, codec: 'AAC', title: 'Drone Zone' };
  const alt = { url: 'https://ice2.somafm.com/dronezone-256-mp3', kind: 'audio', bitrate: 256, codec: 'MP3' };
  const facts = (overrides) => ({
    ok: true, audio_bytes: 64 * 1024, final_scheme: 'https', url: 'https://somafm.com/',
    title: 'Steve Roach - Structures From Silence', ...overrides,
  });
  const ownFacts = facts({ content_type: 'audio/aacp', bitrate: 64, name: 'Drone Zone [SomaFM]', final_host: 'ice1.somafm.com' });
  const altFacts = facts({
    content_type: 'audio/mpeg', bitrate: 256, final_host: 'ice2.somafm.com',
    name: 'Drone Zone: Atmospheric ambient space music. Serve Best Chilled. Safe with most medications. [SomaFM]',
  });
  assert.equal(streamVeto(own, alt, ownFacts, altFacts), null);
  assert.equal(streamVeto(own, alt, { ...ownFacts, name: 'Groove Salad [SomaFM]' }, altFacts), 'differentName');
  assert.equal(streamVeto(own, alt, ownFacts, { ...altFacts, url: 'https://other.example/' }), 'differentName');
  assert.equal(streamVeto(own, alt, ownFacts, { ...altFacts, title: 'Brian Eno - An Ending' }), 'differentTitle');
});

/* ============ 3. Move buttons at fractional display scales ============ */

test('Move buttons answer over at least 24 x 24 also at 175%, and the block stays clear of the star and the category button', () => {
  const css = read('src/styles/library.css');
  const px = (re) => Number(css.match(re)[1]);
  const button = px(/\.card-order-btn \{[^}]*width: (\d+)px;/);
  const inset = px(/\.card-order-btn::before \{ content: ''; position: absolute; inset: -(\d+)px; \}/);
  const gap = px(/\.card-order \{[^}]*gap: (\d+)px;/);
  const right = px(/\.card-order \{[^}]*right: (\d+)px;/);
  const area = button + 2 * inset;
  // At 175% the browser measured a 24 px area as 23.25 x 23.5: up to 0.75 px lost.
  assert.ok(area - 0.75 >= 24, `answers over ${area} px`);
  assert.ok(gap >= 2 * inset, 'neighbours touch, never overlap');
  const block = 2 * button + gap;
  assert.equal(block, 50);
  // The star keeps its place: the block's right edge is where it was.
  assert.equal(right, 40);
  // The category button starts left of the block's hit layers.
  const category = px(/\.card\.has-order-controls \.card-category \{ right: (\d+)px; \}/);
  assert.ok(category > right + block + inset, `category at ${category}`);
  const padding = px(/\.card\.has-category-control\.has-order-controls \.card-body \{ padding-right: (\d+)px; \}/);
  assert.ok(padding >= category + 22 + 4, 'the text clears the category button');
  const orderPadding = px(/\.library-root\.is-personal-view \.card\.has-order-controls \.card-body \{ padding-right: (\d+)px; \}/);
  assert.ok(orderPadding >= right + block + 8, 'the text clears the block');
});

/* ============ 4. The limit says its range when it was corrected ============ */

test('Processor use: a limit typed out of range is corrected and the range is said in the hint\'s place for a moment', () => {
  const select = new FakeElement('settings-processor-use', 'select');
  const input = new FakeElement('settings-processor-limit', 'input');
  const hint = new FakeElement('', 'span');
  const hints = new FakeElement('', 'span');
  const note = new FakeElement('', 'span');
  const root = {
    querySelector: (selector) => ({
      'select[data-field="processorUse"]': select,
      'input[data-field="processorLimit"]': input,
      '[data-processor-limit-hint]': hint,
      '[data-processor-limit-hints]': hints,
      '[data-processor-limit-note]': note,
    }[selector] || null),
  };
  const timers = [];
  const saved = [];
  bindProcessorUse(root, { processorUse: 'balanced' }, {
    save: (partial) => saved.push(partial),
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.live = false; },
  });
  assert.equal(note.textContent, '');
  for (const [typed, kept] of [['1', 2], ['81', 80], ['-5', 2], ['1000', 80]]) {
    input.value = typed;
    input.dispatchEvent(new Event('change'));
    assert.deepEqual(saved.at(-1), { processorLimit: kept }, typed);
    assert.equal(input.value, String(kept));
    assert.equal(note.textContent, PROCESSOR_LIMIT_RANGE_TEXT, typed);
    assert.equal(hints.classList.contains('is-noting'), true, 'the hint keeps its room, hidden');
  }
  assert.equal(PROCESSOR_LIMIT_RANGE_TEXT, 'The limit is from 2% to 80%.');
  assert.equal(timers.filter((timer) => timer.live).length, 1, 'one timer at a time');
  const [live] = timers.filter((timer) => timer.live);
  assert.equal(live.ms, PROCESSOR_LIMIT_NOTE_MS);
  live.fn();
  assert.equal(note.textContent, '');
  assert.equal(hints.classList.contains('is-noting'), false);
  // A value in range says nothing.
  input.value = '55';
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(saved.at(-1), { processorLimit: 55 });
  assert.equal(note.textContent, '');
  // The markup: a status region in the same grid cell as the hint.
  const settings = read('src/lib/settings.js');
  assert.match(settings, /<span class="processor-limit-hints" data-processor-limit-hints><span class="description" id="settings-processor-limit-hint" data-processor-limit-hint><\/span><span class="description processor-limit-note" role="status" data-processor-limit-note><\/span><\/span>/);
  const base = read('src/styles/base.css');
  assert.match(base, /\.processor-limit-hints \{ display: grid; \}/);
  assert.match(base, /\.processor-limit-hints > \* \{ grid-area: 1 \/ 1; \}/);
  assert.match(base, /\.processor-limit-hints\.is-noting \[data-processor-limit-hint\] \{ visibility: hidden; \}/);
});
