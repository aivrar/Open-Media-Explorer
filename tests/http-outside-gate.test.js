import test from 'node:test';
import assert from 'node:assert/strict';

// The gate only applies to requests that leave through the local proxy, which
// the page marks with window.WORLDMEDIA_PROXY.
globalThis.window = globalThis.window || {};
globalThis.window.WORLDMEDIA_PROXY = '/api/proxy?url=';

const {
  getJson, OUTSIDE_REQUEST_LIMIT, outsideRequestCounts,
} = await import('../src/lib/http.js');

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

/** A fetch whose answers are released by hand, in the order asked. */
function heldFetch() {
  const open = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const entry = { url, resolve, reject };
    open.push(entry);
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  return { open, fetchImpl };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('at most four proxied requests are on their way; the rest wait in order', async () => {
  assert.equal(OUTSIDE_REQUEST_LIMIT, 4);
  const { open, fetchImpl } = heldFetch();
  const results = [];
  const all = [1, 2, 3, 4, 5, 6].map((n) => getJson(`https://example.org/${n}`, { fetchImpl, timeoutMs: 0 })
    .then((value) => results.push(value.n)));
  await tick();
  assert.equal(open.length, 4);
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 2 });
  assert.ok(open[0].url.startsWith('/api/proxy?url='));

  open[1].resolve(json({ n: 2 }));
  await tick();
  await tick();
  assert.equal(open.length, 5, 'the fifth request is sent when a place is free');
  assert.ok(open[4].url.endsWith(encodeURIComponent('https://example.org/5')));

  for (const entry of open) entry.resolve(json({ n: Number(decodeURIComponent(entry.url).split('/').pop()) }));
  await tick();
  await tick();
  open[5].resolve(json({ n: 6 }));
  await Promise.all(all);
  assert.deepEqual(results.sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 });
});

test('the time-out of a waiting request starts when it is sent', async () => {
  const { open, fetchImpl } = heldFetch();
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  const options = { fetchImpl, timeoutMs: 1000, setTimer, clearTimer };
  const first = [1, 2, 3, 4].map((n) => getJson(`https://example.org/a${n}`, options));
  const fifth = getJson('https://example.org/a5', options);
  await tick();
  // One waiting limit for the fifth (set at once), then four request time-outs.
  assert.equal(timers.length, 5);
  const waitingLimit = timers[0];
  open[0].resolve(json({ ok: true }));
  await first[0];
  await tick();
  assert.equal(open.length, 5);
  assert.equal(waitingLimit.cleared, true, 'the waiting limit ends when the request is sent');
  assert.equal(timers.length, 6, 'and its own time-out starts then');
  for (const entry of open.slice(1)) entry.resolve(json({ ok: true }));
  await Promise.all([...first.slice(1), fifth]);
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 });
});

test('a request that waits longer than its time-out fails as a time-out and frees nothing it never held', async () => {
  const { open, fetchImpl } = heldFetch();
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  const held = [1, 2, 3, 4].map((n) => getJson(`https://example.org/b${n}`, { fetchImpl, timeoutMs: 0 }));
  const late = getJson('https://example.org/b5', { fetchImpl, timeoutMs: 500, setTimer, clearTimer });
  await tick();
  assert.equal(timers.length, 1);
  timers[0].fn();
  await assert.rejects(late, (error) => error.code === 'TIMEOUT' && /waiting to send/.test(error.message));
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 0 });
  for (const entry of open) entry.resolve(json({ ok: true }));
  await Promise.all(held);
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 });
});

test('a waiting request that is cancelled leaves the line; a failed one gives its place back', async () => {
  const { open, fetchImpl } = heldFetch();
  const held = [1, 2, 3, 4].map((n) => getJson(`https://example.org/c${n}`, { fetchImpl, timeoutMs: 0 }));
  const controller = new AbortController();
  const cancelled = getJson('https://example.org/c5', { fetchImpl, timeoutMs: 0, signal: controller.signal });
  const sixth = getJson('https://example.org/c6', { fetchImpl, timeoutMs: 0 });
  await tick();
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 2 });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.name === 'AbortError');
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 1 });

  open[0].reject(new TypeError('network down'));
  await assert.rejects(held[0]);
  await tick();
  assert.equal(open.length, 5, 'the sixth request took the place of the failed one');
  for (const entry of open.slice(1)) entry.resolve(json({ ok: true }));
  await Promise.all([...held.slice(1), sixth]);
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 });
});

test('a retry pause does not keep a place, and an urgent request does not wait', async () => {
  const { open, fetchImpl } = heldFetch();
  let wake = null;
  const sleeping = new Promise((resolve) => { wake = resolve; });
  let failed = false;
  const flaky = (url, init) => {
    if (!failed) {
      failed = true;
      return Promise.resolve(new Response('busy', { status: 503 }));
    }
    return fetchImpl(url, init);
  };
  const retried = getJson('https://example.org/d1', {
    fetchImpl: flaky, timeoutMs: 0, retries: 1, sleep: () => sleeping,
  });
  await tick();
  await tick();
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 }, 'nothing is held while it pauses');

  const held = [2, 3, 4, 5].map((n) => getJson(`https://example.org/d${n}`, { fetchImpl, timeoutMs: 0 }));
  await tick();
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 0 });
  const urgent = getJson('https://example.org/check', { fetchImpl, timeoutMs: 0, urgent: true });
  await tick();
  assert.equal(open.length, 5, 'the urgent request was sent although four are on their way');
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 0 });

  wake();
  await tick();
  await tick();
  assert.deepEqual(outsideRequestCounts(), { active: 4, waiting: 1 }, 'the retry waits its turn again');
  for (const entry of open) entry.resolve(json({ ok: true }));
  await tick();
  await tick();
  for (const entry of open) entry.resolve(json({ ok: true }));
  await Promise.all([...held, urgent, retried]);
  assert.deepEqual(outsideRequestCounts(), { active: 0, waiting: 0 });
});
