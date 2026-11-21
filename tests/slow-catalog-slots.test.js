import test from 'node:test';
import assert from 'node:assert/strict';

import { resetControlSession } from '../src/lib/capture-client.js';
import {
  SLOW_CATALOG_SLOTS, createRequestSlots, expireCatalogAsset, getOwncastSnapshot, registerCatalogAsset,
  resolvePeerTubeVideo, resolvePodcastFeed, slowCatalogLoad,
} from '../src/lib/catalog-client.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Tasks that start when the slots let them and end when the test says. */
function tasks() {
  const started = [];
  const ends = new Map();
  return {
    started,
    task(name) {
      return () => {
        started.push(name);
        const end = deferred();
        ends.set(name, end);
        return end.promise;
      };
    },
    answer(name, value = name) { ends.get(name).resolve(value); },
    fail(name, error = new Error(`${name} failed`)) { ends.get(name).reject(error); },
  };
}

test('at most three slow catalogue requests run at once; the others wait in order', async () => {
  assert.equal(SLOW_CATALOG_SLOTS, 3);
  const slots = createRequestSlots(3);
  const work = tasks();
  const results = ['a', 'b', 'c', 'd', 'e'].map((name) => slots.run(work.task(name)));
  await drain();
  assert.deepEqual(work.started, ['a', 'b', 'c']);
  assert.deepEqual([slots.active, slots.waiting], [3, 2]);
  work.answer('b');
  assert.equal(await results[1], 'b');
  await drain();
  assert.deepEqual(work.started, ['a', 'b', 'c', 'd']);
  // A new request waits behind the queue even with a place about to free.
  const late = slots.run(work.task('f'));
  work.answer('a');
  await drain();
  assert.deepEqual(work.started, ['a', 'b', 'c', 'd', 'e']);
  for (const name of ['c', 'd', 'e']) work.answer(name);
  await drain();
  assert.deepEqual(work.started, ['a', 'b', 'c', 'd', 'e', 'f']);
  work.answer('f');
  assert.equal(await late, 'f');
  assert.deepEqual([slots.active, slots.waiting], [0, 0]);
});

test('a failed request, and one that throws at once, free their place', async () => {
  const slots = createRequestSlots(1);
  const work = tasks();
  const failing = slots.run(work.task('a'));
  const throwing = slots.run(() => { throw new Error('thrown at once'); });
  const after = slots.run(work.task('c'));
  await drain();
  work.fail('a');
  await assert.rejects(failing, /a failed/);
  await assert.rejects(throwing, /thrown at once/);
  await drain();
  assert.deepEqual(work.started, ['a', 'c']);
  work.answer('c');
  assert.equal(await after, 'c');
  assert.deepEqual([slots.active, slots.waiting], [0, 0]);
});

test('a waiter that aborts leaves the queue at once and frees nothing it did not hold', async () => {
  const slots = createRequestSlots(2);
  const work = tasks();
  const running = [slots.run(work.task('a')), slots.run(work.task('b'))];
  const controller = new AbortController();
  const queued = slots.run(work.task('c'), { signal: controller.signal });
  const behind = slots.run(work.task('d'));
  await drain();
  assert.deepEqual([slots.active, slots.waiting], [2, 2]);
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.deepEqual([slots.active, slots.waiting], [2, 1], 'the running two keep their places');
  assert.deepEqual(work.started, ['a', 'b']);
  work.answer('a');
  await drain();
  assert.deepEqual(work.started, ['a', 'b', 'd'], 'the aborted one never runs');
  work.answer('b');
  work.answer('d');
  await Promise.all([...running, behind]);
  assert.deepEqual([slots.active, slots.waiting], [0, 0]);
  // Already aborted: refused without taking a place; the reason is kept.
  const reason = new Error('left the view');
  const gone = new AbortController();
  gone.abort(reason);
  await assert.rejects(slots.run(work.task('e'), { signal: gone.signal }), (error) => error === reason);
  assert.deepEqual(work.started, ['a', 'b', 'd']);
  assert.deepEqual([slots.active, slots.waiting], [0, 0]);
});

test('a request aborted while it runs frees its place for the next one', async () => {
  const slots = createRequestSlots(1);
  const controller = new AbortController();
  const running = slots.run(() => new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }), { signal: controller.signal });
  const work = tasks();
  const next = slots.run(work.task('next'));
  await drain();
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  await drain();
  assert.deepEqual(work.started, ['next']);
  work.answer('next');
  await next;
  assert.deepEqual([slots.active, slots.waiting], [0, 0]);
});

test('feed, PeerTube and Owncast requests share the three places; artwork requests do not wait for them', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const held = [];
  const seen = [];
  const fetchImpl = (path, options = {}) => {
    seen.push(path);
    if (path === '/api/v1/session') return Promise.resolve(json({ ok: true, data: { token: 'slots-token' } }));
    if (path.startsWith('/api/v1/catalog/')) {
      const answer = deferred();
      held.push({ path, answer });
      options.signal?.addEventListener('abort', () => answer.reject(new DOMException('Aborted', 'AbortError')), { once: true });
      return answer.promise;
    }
    return Promise.resolve(json({ ok: true, data: { asset_id: 'opaque_asset_1234567890' } }, 201));
  };
  const controller = new AbortController();
  const requests = [
    resolvePodcastFeed('https://feeds.example/1.xml', { fetchImpl }),
    resolvePeerTubeVideo('https://video.example/w/11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111', { fetchImpl }),
    getOwncastSnapshot({ fetchImpl }),
    resolvePodcastFeed('https://feeds.example/4.xml', { fetchImpl, signal: controller.signal }),
    resolvePodcastFeed('https://feeds.example/5.xml', { fetchImpl }),
  ];
  for (const request of requests) request.catch(() => {});
  for (let index = 0; index < 5; index += 1) await drain();
  assert.equal(held.length, 3);
  assert.deepEqual(slowCatalogLoad(), { active: 3, waiting: 2 });
  // Quick routes go straight through.
  await registerCatalogAsset({ url: 'https://images.example/a.png', sourceId: 'gpodder', itemId: 'gpodder:a' }, { fetchImpl });
  await expireCatalogAsset('opaque_asset_1234567890', 'gpodder', 'gpodder:a', { fetchImpl });
  // The aborted waiter leaves; a failure frees a place for the next one.
  controller.abort();
  await assert.rejects(requests[3], { name: 'AbortError' });
  assert.deepEqual(slowCatalogLoad(), { active: 3, waiting: 1 });
  held[0].answer.resolve(json({ ok: false, error: { code: 'CATALOG_UPSTREAM_STATUS', message: 'No.' } }, 502));
  await assert.rejects(requests[0], { code: 'CATALOG_UPSTREAM_STATUS' });
  for (let index = 0; index < 5; index += 1) await drain();
  assert.equal(held.length, 4);
  assert.equal(held[3].path, '/api/v1/catalog/feed/resolve');
  assert.equal(seen.filter((path) => path === '/api/v1/catalog/feed/resolve').length, 2, 'the aborted one was never sent');
  for (const entry of held.slice(1)) entry.answer.resolve(json({ ok: true, data: { done: true } }));
  await Promise.allSettled(requests);
  assert.deepEqual(slowCatalogLoad(), { active: 0, waiting: 0 });
});

test('a resolve for Play starts at once while three slow browse lookups run and more wait, and takes no place', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const held = [];
  const fetchImpl = (path, options = {}) => {
    if (path === '/api/v1/session') return Promise.resolve(json({ ok: true, data: { token: 'play-token' } }));
    const answer = deferred();
    held.push({ path, body: options.body ? JSON.parse(options.body) : null, answer });
    return answer.promise;
  };
  const browse = [1, 2, 3, 4, 5].map((index) => resolvePodcastFeed(`https://feeds.example/${index}.xml`, { fetchImpl }));
  for (const request of browse) request.catch(() => {});
  for (let index = 0; index < 5; index += 1) await drain();
  assert.equal(held.length, 3);
  assert.deepEqual(slowCatalogLoad(), { active: 3, waiting: 2 });
  const play = resolvePodcastFeed('https://feeds.example/playing.xml', { fetchImpl, forPlayback: true });
  const video = resolvePeerTubeVideo('https://video.example/w/11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111', { fetchImpl, forPlayback: true });
  for (let index = 0; index < 5; index += 1) await drain();
  assert.equal(held.length, 5, 'both sent at once');
  assert.deepEqual(held[3].body, { url: 'https://feeds.example/playing.xml' }, 'the flag is not sent');
  assert.equal(held[4].path, '/api/v1/catalog/peertube/resolve');
  assert.deepEqual(slowCatalogLoad(), { active: 3, waiting: 2 }, 'no place taken, nothing jumped the queue');
  held[3].answer.resolve(json({ ok: true, data: { items: [] } }));
  held[4].answer.resolve(json({ ok: true, data: { video: true } }));
  assert.deepEqual(await play, { items: [] });
  await video;
  for (const entry of held.slice(0, 3)) entry.answer.resolve(json({ ok: true, data: {} }));
  for (let index = 0; index < 5; index += 1) await drain();
  for (const entry of held.slice(5)) entry.answer.resolve(json({ ok: true, data: {} }));
  await Promise.allSettled(browse);
  assert.deepEqual(slowCatalogLoad(), { active: 0, waiting: 0 });
});

function json(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300, status, json: async () => payload, headers: { get: () => null },
  };
}
