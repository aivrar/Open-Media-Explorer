import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OTHER_STREAMS_TEXT, createBestStreamStatus } from '../src/modes/library/other-streams.js';

/* Keyboard and screen reader details of the new controls: the verified
   stream line, the Settings rows for the best stream and the processor
   limit, the Song log row star and the drag edge with forced colors. */

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

class Node extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelector(selector) {
    if (selector !== '.detail-actions button') return null;
    const actions = this.all().find((node) => node.className === 'detail-actions');
    return actions?.all().find((node) => node.tagName === 'BUTTON') || null;
  }
  focus() { globalThis.document.activeElement = this; }
}

test('"Use the station\'s own stream": its button goes away and focus moves to the panel\'s first action, not lost', () => {
  const previous = globalThis.document;
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => Object.assign(new Node('#text'), { textContent: text }),
  };
  try {
    const item = { id: 'radio-browser:abc', source: 'radio-browser', title: 'Radio One' };
    const kept = [];
    const played = [];
    let playing = { itemId: item.id, url: 'https://example.org/a', bitrate: 320, codec: 'MP3' };
    const status = createBestStreamStatus(item, {
      settings: () => ({ bestStreamMode: 'auto' }),
      verified: () => playing,
      checking: () => false,
      keepOwn: (id) => kept.push(id),
      current: () => item,
      // Playing the station again starts it on its own stream.
      play: (now) => { played.push(now.id); playing = null; return Promise.resolve(); },
      onAutoChange: () => () => {},
      on: () => () => {},
    });
    assert.ok(status);
    const note = status.node;
    const panel = new Node('aside');
    const actions = Object.assign(new Node('div'), { className: 'detail-actions' });
    const playButton = Object.assign(new Node('button'), { textContent: 'Play' });
    actions.appendChild(playButton);
    panel.appendChild(actions);
    panel.appendChild(note);
    const use = note.all().find((node) => node.tagName === 'BUTTON');
    assert.equal(use.textContent, OTHER_STREAMS_TEXT.useOwn);
    use.focus();
    use.dispatchEvent(new Event('click'));
    assert.equal(kept.length, 1);
    assert.deepEqual(played, [item.id]);
    assert.equal(note.all().some((node) => node.tagName === 'BUTTON'), false, 'the button is gone');
    assert.equal(panel.children.includes(note), true, 'the line keeps its place');
    assert.equal(globalThis.document.activeElement, playButton, 'focus on the first action');
  } finally {
    globalThis.document = previous;
  }
});

test('"Use the station\'s own stream" outside the Library: focus moves to the control the caller names', () => {
  const previous = globalThis.document;
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => Object.assign(new Node('#text'), { textContent: text }),
  };
  try {
    const item = { id: 'radio-browser:abc', source: 'radio-browser', title: 'Radio One' };
    const make = (focusAfterUse) => createBestStreamStatus(item, {
      settings: () => ({ bestStreamMode: 'auto' }),
      verified: () => ({ itemId: item.id, url: 'https://example.org/a', bitrate: 320, codec: 'MP3' }),
      checking: () => false,
      keepOwn: () => {},
      current: () => null,
      play: () => Promise.resolve(),
      onAutoChange: () => () => {},
      on: () => () => {},
      ...(focusAfterUse === undefined ? {} : { focusAfterUse }),
    });
    const press = (status) => {
      const use = status.node.all().find((node) => node.tagName === 'BUTTON');
      use.focus();
      use.dispatchEvent(new Event('click'));
      return use;
    };
    // The Now Playing tab: no details panel, the favorite star is named.
    const host = new Node('section');
    const star = new Node('button');
    host.appendChild(star);
    const inTab = make(() => star);
    host.appendChild(inTab.node);
    press(inTab);
    assert.equal(globalThis.document.activeElement, star, 'focus on the named control');
    // Named but gone (returns nothing): the Library's own rule still applies.
    const panel = new Node('aside');
    const actions = Object.assign(new Node('div'), { className: 'detail-actions' });
    const playButton = actions.appendChild(new Node('button'));
    panel.appendChild(actions);
    const fallback = make(() => null);
    panel.appendChild(fallback.node);
    press(fallback);
    assert.equal(globalThis.document.activeElement, playButton);
    // The Library passes nothing: unchanged (the test above).
    const source = read('src/modes/library/detail.js');
    assert.match(source, /detailBestStream = createBestStreamStatus\(item\);/);
    // The tab passes its favorite star.
    assert.match(read('src/modes/now-playing.js'), /deps\.bestStream\(item, \{ focusAfterUse: \(\) => fav \}\)/);
  } finally {
    globalThis.document = previous;
  }
});

test('Settings: the best stream choice and the processor limit are described by their lines; the limit is a real disabled input at Light', () => {
  const settings = read('src/lib/settings.js');
  assert.match(settings, /<div class="description" id="settings-best-stream-hint">\s+When a station or channel lists several streams:\s+<ul>[\s\S]*?<\/ul>\s+<\/div>/);
  assert.match(settings, /<select id="settings-best-stream" data-field="bestStreamMode" aria-describedby="settings-best-stream-hint">/);
  assert.match(settings, /<span class="description" id="settings-processor-limit-hint" data-processor-limit-hint><\/span><span class="description processor-limit-note" role="status" data-processor-limit-note><\/span>/);
  assert.match(settings, /<input id="settings-processor-limit" type="number" data-field="processorLimit" aria-describedby="settings-processor-limit-hint"/);
  assert.match(settings, /limitInput\.disabled = !budget\.readsUse;/);
});

test('the Song log row star is at least 24 px tall; the drag edge has a forced-colors form', () => {
  const songLog = read('src/styles/song-log.css');
  assert.match(songLog, /\.btn\.song-star \{\s*min-width: 28px;\s*min-height: 24px;/);
  const library = read('src/styles/library.css');
  const forced = library.slice(library.indexOf('.card.drop-after {'));
  assert.match(forced, /@media \(forced-colors: active\) \{\s*\.card\.drop-before \{ border-top: 4px solid Highlight; border-left: 4px solid Highlight; \}\s*\.card\.drop-after \{ border-bottom: 4px solid Highlight; border-right: 4px solid Highlight; \}/);
});
