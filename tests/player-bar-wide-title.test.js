import { bindPlayerBarFit } from '../src/lib/player-bar-fit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeElement } from './helpers/fake-dom.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// Live with a 160px title area; a song occupies a second line in that track.
function liveWidths(picture) {
  const controls = 38 + 8 + 38;
  const actions = 126 + 8 + 68 + (picture ? 8 + 64 : 0);
  const volume = 38 + 4 + 30;
  const base = 28 + 4 * 8 + 160 + controls + actions + volume;
  return [base + 90 + 8 + 44, base + 44, base - 8, base - 8 - 88, base - 8 - 88 - 30];
}

test('the live footer refits at each boundary and after content changes', t => {
  const bar = new FakeElement('player-bar', 'footer');
  let resize, mutation;
  class Observer {
    observe(target) { assert.equal(target, bar); }
    disconnect() {}
  }
  class Resize extends Observer {
    constructor(fn) { super(); resize = fn; }
  }
  class Mutation extends Observer {
    constructor(fn) { super(); mutation = fn; }
  }
  const states = ['full', 'meter', 'time', 'record', 'eq'];
  let width = 1024, picture = true, extra = 0;
  bar.getBoundingClientRect = () => ({
    width: bar.dataset.measuring === undefined ? width : liveWidths(picture)[states.indexOf(bar.dataset.fit)] + extra,
  });
  t.after(bindPlayerBarFit(bar, { ResizeObserver: Resize, MutationObserver: Mutation }));
  for (picture of [true, false]) {
    mutation([{ type: 'attributes', target: bar }]);
    const steps = liveWidths(picture);
    assert.deepEqual(steps, picture ? [792, 694, 642, 554, 524] : [720, 622, 570, 482, 452]);
    for (const w of [1024, 967, ...steps.flatMap(n => [n + 1, n, n - 1])]) {
      width = w;
      resize();
      assert.equal(bar.dataset.fit, states[steps.findIndex(n => n <= width)] || 'stack');
      assert.equal(bar.dataset.measuring, undefined);
    }
  }
  width = 967;
  resize();
  assert.equal(bar.dataset.fit, 'full');
  extra = 280;
  mutation([{ type: 'childList', target: { closest: () => true } }]);
  assert.equal(bar.dataset.fit, 'meter');
  extra = 0;
  mutation([{ type: 'attributes', target: bar }]);
  assert.equal(bar.dataset.fit, 'full');
});

test('Computer track buttons compact before other footer controls', async (t) => {
  const bar = new FakeElement('player-bar', 'footer');
  let resize;
  let width = 1120;
  class Resize {
    constructor(fn) { resize = fn; }
    observe() {}
    disconnect() {}
  }
  class Mutation {
    observe() {}
    disconnect() {}
  }
  const videoWidths = { full: 1060, tracks: 991, meter: 893 };
  bar.querySelector = (selector) => selector === '.player-track-button:not([hidden])' ? {} : null;
  bar.getBoundingClientRect = () => ({
    width: bar.dataset.measuring === undefined ? width : videoWidths[bar.dataset.fit],
  });
  t.after(bindPlayerBarFit(bar, { ResizeObserver: Resize, MutationObserver: Mutation }));
  assert.equal(bar.dataset.fit, 'full');
  width = 1024;
  resize();
  assert.equal(bar.dataset.fit, 'tracks');
  width = 990;
  resize();
  assert.equal(bar.dataset.fit, 'meter');

  const html = await read('src/index.html');
  const css = await read('src/styles/base.css');
  assert.match(html, /id="player-picture"[^>]*>[\s\S]*?id="player-subtitles"[^>]*title="Subtitles \(C\)"[\s\S]*?id="player-audio"[^>]*title="Audio"/);
  assert.match(css, /@media \(max-width: 1024px\) \{\s*\.player-bar \.player-track-button \{ width: 36px; padding: 0; \}\s*\.player-bar \.player-track-button span \{ display: none; \}/);
});

test('one-row measurement uses the visible buttons, gaps and title floor', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /#player-bar\[data-measuring\] \{\s*width: max-content;\s*grid-template-columns: 160px repeat\(4, max-content\)/);
  assert.match(css, /grid-template-columns: minmax\(160px, 1\.4fr\) auto auto minmax\(max-content, 1fr\) auto/);
  assert.match(css, /\.player-picture \{ width: 64px;/);
  assert.match(css, /\.player-volume > \.volume-stepper \{ width: 30px;/);
  assert.match(css, /\.player-picture-slot\[inert\] \{ display: none;/);
  assert.match(css, /\.player-action \{ flex: none; width: 126px;/);
  assert.match(css, /\.player-eq \{\s*width: 68px;/);
  for (const [selector, states] of [['player-meter', ['meter', 'time', 'record', 'eq', 'stack']],
    ['player-time', ['time', 'record', 'eq', 'stack']], ['player-action-label', ['record', 'eq', 'stack']],
    ['player-eq-state', ['eq', 'stack']]]) {
    const rule = css.split('\n').find(line => line.startsWith('.player-bar:is(') && line.includes(' .' + selector));
    assert.deepEqual([...rule.matchAll(/data-fit="(\w+)"/g)].map(m => m[1]), states);
  }
  assert.match(css, /#player-bar\[data-fit="stack"\] \{[^}]*grid-template-areas: "primary primary primary" "actions progress volume"/);
  assert.match(css, /\.player-bar\.is-capture-only \{[^}]*grid-template-areas: "actions"/);
  assert.match(css, /#player-capture-status-text \{\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
});

test('resume choices occupy the title slot in either player grid', async () => {
  const html = await read('src/index.html');
  const css = await read('src/styles/base.css');
  assert.match(html, /class="player-text">\s*<div id="player-title"[^>]*><\/div>\s*<div id="player-resume-actions"[^>]*hidden>[\s\S]*?id="player-resume-part"[\s\S]*?id="player-start-over"[\s\S]*?class="player-source-row"/);
  assert.match(css, /\.player-text:has\([^{}]*\[hidden\][^{}]*\) > \.player-title \{ display: none; \}/);
  assert.doesNotMatch(css, /\.player-resume-actions\s*\{[^}]*grid-column:/);
});

test('the same footer groups fill the one-row and stacked layouts', async () => {
  const html = await read('src/index.html');
  assert.equal((html.match(/class="player-part-slot" hidden>/g) || []).length, 2);
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  const bar = new FakeElement('player-bar');
  const stack = [bar];
  for (const [tag] of footer.matchAll(/<\/?div\b[^>]*>/g)) {
    if (tag.startsWith('</')) stack.pop();
    else {
      const node = new FakeElement();
      node.className = tag.match(/class="([^"]+)"/)?.[1];
      stack.at(-1).appendChild(node);
      stack.push(node);
    }
  }
  assert.deepEqual(stack, [bar]);
  assert.deepEqual(bar.children.map(n => n.className), ['player-primary', 'player-actions', 'player-progress', 'player-volume']);
  assert.deepEqual(bar.children[0].children.map(n => n.className), ['player-meta', 'player-controls']);
});

test('Clear cache keeps its full label in Settings', async () => {
  const base = await read('src/styles/base.css');
  assert.match(base, /\.modal\[aria-labelledby="settings-title"\] \.btn \{[^}]*white-space: nowrap;/);
  assert.match(base, /\.modal\[aria-labelledby="settings-title"\] \[data-act="clear-cache"\] \{ min-inline-size: max-content; \}/);
});
