import test from 'node:test';
import assert from 'node:assert/strict';

import { resetControlSession } from '../src/lib/capture-client.js';
import {
  applyStationImageList, peekStationImageUrl, stationImageSourceFor, stationImageUrl,
} from '../src/lib/station-images.js';
import { loadArtworkImage } from '../src/lib/artwork.js';
import { createTunerCardArt } from '../src/lib/tuner-card-art.js';

/* Review points on the Tuner card pictures:
   1. Leaving the Tuner (or a card leaving the strip) must also stop a user's
      station picture that is still being fetched: no further request or retry,
      and a result that arrives late is ignored.
   2. A change of the station-images list while a card is loading is checked
      again for that card once its load settles. */

const id = (n) => String(n).repeat(32).slice(0, 32);
const source = (n, v = 'abc123') => `station-image:${id(n)}:${v}`;
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A backend whose picture answers are handed out by the test. */
function backend() {
  const calls = [];
  const waiting = [];
  const fetchImpl = (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/session') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { token: 'T'.repeat(64) } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const answer = (status = 200) => waiting.shift()(status === 200
    ? new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': 'image/png' } })
    : new Response('{}', { status, headers: { 'content-type': 'application/json' } }));
  const pictureCalls = () => calls.filter(({ url }) => url.startsWith('/api/v1/station-images/')).length;
  return { fetchImpl, calls, answer, pictureCalls, waiting };
}

function urls() {
  const made = [];
  return { made, createUrl: (blob) => { const url = `blob:test/${made.length}`; made.push(blob); return url; } };
}

test.beforeEach(() => {
  resetControlSession();
  applyStationImageList({ images: [] });
});

test('a caller that stops waiting stops the fetch and its retries, and is forgotten', async () => {
  const server = backend();
  const { made, createUrl } = urls();
  const sleeps = [];
  const sleep = () => new Promise((resolve) => sleeps.push(resolve));
  const controller = new AbortController();
  const wanted = stationImageUrl(source('a'), { fetchImpl: server.fetchImpl, createUrl, sleep, signal: controller.signal });
  await flush();
  assert.equal(server.pictureCalls(), 1);
  assert.ok(server.calls.at(-1).options.signal instanceof AbortSignal, 'the request can be cancelled');
  server.answer(503); // Busy: it would try again after a short wait.
  await flush();
  assert.equal(sleeps.length, 1);
  controller.abort();
  await assert.rejects(wanted, { name: 'AbortError' });
  assert.equal(server.calls.at(-1).options.signal.aborted, true);
  sleeps[0]();
  await flush();
  // No retry after the wait, no object URL, nothing kept.
  assert.equal(server.pictureCalls(), 1);
  assert.equal(made.length, 0);
  assert.equal(peekStationImageUrl(source('a')), '');
  // A later request starts afresh.
  const again = stationImageUrl(source('a'), { fetchImpl: server.fetchImpl, createUrl });
  await flush();
  assert.equal(server.pictureCalls(), 2);
  server.answer(200);
  assert.equal(await again, 'blob:test/0');
});

test('a result that arrives after the caller stopped is ignored', async () => {
  const server = backend();
  const { made, createUrl } = urls();
  const controller = new AbortController();
  const wanted = stationImageUrl(source('b'), { fetchImpl: server.fetchImpl, createUrl, signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(wanted, { name: 'AbortError' });
  server.answer(200); // The bytes come anyway.
  await flush();
  assert.equal(made.length, 0, 'no object URL for nobody');
  assert.equal(peekStationImageUrl(source('b')), '');
});

test('a fetch someone else still waits for (the player bar) goes on', async () => {
  const server = backend();
  const { createUrl } = urls();
  const controller = new AbortController();
  const card = stationImageUrl(source('c'), { fetchImpl: server.fetchImpl, createUrl, signal: controller.signal });
  const bar = stationImageUrl(source('c'), { fetchImpl: server.fetchImpl, createUrl });
  await flush();
  assert.equal(server.pictureCalls(), 1, 'one shared fetch');
  controller.abort();
  await assert.rejects(card, { name: 'AbortError' });
  assert.equal(server.calls.at(-1).options.signal.aborted, false);
  server.answer(200);
  assert.equal(await bar, 'blob:test/0');
  assert.equal(peekStationImageUrl(source('c')), 'blob:test/0');
  // Two cards: one leaving does not stop the other's.
  const server2 = backend();
  const one = new AbortController();
  const first = stationImageUrl(source('d'), { fetchImpl: server2.fetchImpl, createUrl, signal: one.signal });
  const second = stationImageUrl(source('d'), { fetchImpl: server2.fetchImpl, createUrl, signal: new AbortController().signal });
  await flush();
  one.abort();
  await assert.rejects(first, { name: 'AbortError' });
  server2.answer(200);
  assert.match(await second, /^blob:test\//);
});

test('loadArtworkImage passes the view\'s signal on: a stopped view leaves the picture usable', async () => {
  applyStationImageList({ images: [{ key: 'radio paradise', id: id('e'), v: 'abc123' }] });
  const item = { id: 'rb:1', source: 'radio-browser', title: 'Radio Paradise' };
  const server = backend();
  const { made, createUrl } = urls();
  const image = new (class extends EventTarget {
    isConnected = true; naturalWidth = 0; complete = false; url = '';
    get src() { return this.url; } set src(value) { this.url = value; }
    getAttribute(name) { return name === 'src' ? this.url || null : null; }
    removeAttribute(name) { if (name === 'src') this.url = ''; }
  })();
  const controller = new AbortController();
  const loading = loadArtworkImage(image, source('e'), {
    fetchImpl: server.fetchImpl, createUrl, signal: controller.signal, attempts: 1,
  });
  await flush();
  assert.equal(server.pictureCalls(), 1);
  controller.abort();
  await assert.rejects(loading, { name: 'AbortError' });
  server.answer(200);
  await flush();
  assert.equal(image.url, '');
  assert.equal(made.length, 0);
  // Stopping is not failing: the item keeps its picture for next time.
  assert.equal(stationImageSourceFor(item), source('e'));
});

/* ---- The Tuner's card controller, end to end with the real artwork path ---- */

class Img extends EventTarget {
  constructor() {
    super();
    this.tagName = 'IMG';
    this.className = '';
    this.parent = null;
    this.url = '';
    this.naturalWidth = 0;
    this.complete = false;
    this.isConnected = true;
    const node = this;
    this.classList = {
      add(name) { if (!node.classList.contains(name)) node.className = `${node.className} ${name}`.trim(); },
      contains(name) { return node.className.split(' ').includes(name); },
      toggle(name, force) { if (force) this.add(name); else node.className = node.className.split(' ').filter((n) => n !== name).join(' '); },
    };
  }
  get src() { return this.url; }
  set src(value) { this.url = value; }
  setAttribute() {}
  getAttribute(name) { return name === 'src' ? this.url || null : null; }
  removeAttribute(name) { if (name === 'src') this.url = ''; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
}
class Box {
  constructor() { this.children = []; this.className = ''; this.textContent = ''; this.style = { setProperty() {} }; }
  setAttribute() {}
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
}
const doc = { createElement: (tag) => (tag === 'img' ? new Img() : new Box()) };

function controller(options) {
  const timers = [];
  const art = createTunerCardArt({
    doc,
    setTimer: (fn) => { const timer = { fn, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
    ...options,
  });
  const fire = () => { for (const timer of timers.filter((t) => t.live)) { timer.live = false; timer.fn(); } };
  return { art, fire, timers };
}

test('leaving the Tuner stops a station picture being fetched for a card: no retry, no late picture', async () => {
  applyStationImageList({ images: [{ key: 'radio paradise', id: id('f'), v: 'abc123' }] });
  const server = backend();
  const { made, createUrl } = urls();
  const item = { id: 'rb:2', source: 'radio-browser', title: 'Radio Paradise' };
  const { art, fire } = controller({
    load: (img, src, opts) => loadArtworkImage(img, src, {
      ...opts, fetchImpl: server.fetchImpl, createUrl, attempts: 1, requireConnected: false,
    }),
    resolve: () => { throw new Error('not reached'); },
  });
  const box = art.box(item);
  art.commit();
  fire();
  await flush();
  assert.equal(server.pictureCalls(), 1);
  art.clear(); // Tuner left, or Small chosen.
  await flush();
  assert.equal(server.calls.at(-1).options.signal.aborted, true);
  server.answer(503);
  await flush();
  assert.equal(server.pictureCalls(), 1, 'no retry after teardown');
  assert.equal(made.length, 0);
  assert.equal(box.children.filter((child) => child.tagName === 'IMG').length, 0);
  assert.equal(art.stats.stopped, 1);
  // Not marked failed: the picture is still the one to show next time.
  assert.equal(stationImageSourceFor(item), source('f'));
});

test('a card leaving the strip stops its station picture fetch the same way', async () => {
  applyStationImageList({ images: [{ key: 'jazz fm', id: id('7'), v: 'abc123' }] });
  const server = backend();
  const { made, createUrl } = urls();
  const { art, fire } = controller({
    load: (img, src, opts) => loadArtworkImage(img, src, {
      ...opts, fetchImpl: server.fetchImpl, createUrl, attempts: 1, requireConnected: false,
    }),
  });
  art.box({ id: 'rb:3', source: 'radio-browser', title: 'Jazz FM' });
  art.commit();
  fire();
  await flush();
  assert.equal(server.pictureCalls(), 1);
  art.box({ id: 'rb:4', source: 'radio-browser', title: 'Other', thumbnail: '' });
  art.commit(); // rb:3 is no longer in the strip
  await flush();
  assert.equal(server.calls.at(-1).options.signal.aborted, true);
  server.answer(200);
  await flush();
  assert.equal(made.length, 0);
  assert.equal(server.pictureCalls(), 1);
});

test('a picture-list change during a load is checked again for that card once it settles', async () => {
  const OLD = source('8');
  const NEW = source('9');
  const pictures = new Map([['s1', OLD]]);
  const pending = [];
  const { art, fire, timers } = controller({
    customSourceFor: (item) => pictures.get(item.id) || '',
    sourceFor: (item) => pictures.get(item.id) || item.thumbnail || '',
    load: (img, src) => new Promise((resolve) => pending.push({ img, src, resolve })),
    resolve: (item) => Promise.resolve(item),
  });
  const items = [
    { id: 's1', title: 'One', thumbnail: '/api/v1/assets/aaaaaaaaaaaaaaaaaaaa' },
    { id: 's2', title: 'Two', thumbnail: '/api/v1/assets/bbbbbbbbbbbbbbbbbbbb' },
  ];
  for (const item of items) art.box(item);
  art.commit();
  fire();
  await flush();
  assert.deepEqual(pending.map(({ src }) => src), [OLD, items[1].thumbnail]);
  // Refresh: s1's picture was replaced while both cards were loading.
  pictures.set('s1', NEW);
  assert.equal(art.stationImagesChanged(), false, 'nothing finished to redraw yet');
  const liveBefore = timers.filter((timer) => timer.live).length;
  for (const { img, resolve } of pending.splice(0)) { img.naturalWidth = 40; resolve(); }
  await flush();
  // Only s1 is reset (its old picture removed) and waits for the usual pause.
  assert.equal(art.stats.rechecked, 1);
  assert.equal(timers.filter((timer) => timer.live).length, liveBefore + 1);
  assert.equal(pending.length, 0, 'nothing restarted before the pause');
  fire();
  await flush();
  assert.deepEqual(pending.map(({ src }) => src), [NEW], 'one new load, for s1 only');
  assert.equal(art.stats.started, 3);

  // A change that does not concern a loading card leaves it alone.
  pictures.set('s3', source('a'));
  pending[0].img.naturalWidth = 40;
  art.stationImagesChanged();
  pending.shift().resolve();
  await flush();
  fire();
  await flush();
  assert.equal(art.stats.rechecked, 1);
  assert.equal(art.stats.started, 3);
  assert.equal(pending.length, 0);
});
