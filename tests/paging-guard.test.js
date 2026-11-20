import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AUTO_RETRY_LIMIT, createSourceProgress, isClientRefusal, recordSourceFailure, recordSourceSuccess,
} from '../src/modes/library/progress.js';
import { SEPIASEARCH_MAX_END, normalizeSepiaResponse } from '../src/adapters/peertube.js';
import { HttpError } from '../src/lib/http.js';
import { CatalogScheduler } from '../src/lib/catalog-scheduler.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** The Library chain's gate (chain.js fetchBrowsePage / scheduleNextLoad):
 *  a page is asked for only when the source is not exhausted, not stopped
 *  and its retry time has come. Runs `minutes` of a session in which every
 *  request is answered by `answer(cursor)`. */
function simulate(answer, { minutes = 70 } = {}) {
  const progress = createSourceProgress();
  progress.cursor = { start: 9030 };
  const requests = [];
  let now = 0;
  const end = minutes * 60_000;
  while (now < end) {
    const may = !progress.exhausted && !progress.stopped && progress.retryAt <= now;
    if (may) {
      requests.push(JSON.stringify(progress.cursor));
      const result = answer(progress.cursor);
      if (result instanceof Error) recordSourceFailure(progress, result, now);
      else recordSourceSuccess(progress, result, 0);
    }
    now += 500; // the chain's own timer, or the user scrolling
  }
  return { progress, requests };
}

const httpError = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

test('a 400 at a deep page gives one request, not a loop, and ends that listing', () => {
  const { progress, requests } = simulate(() => httpError(400));
  assert.equal(requests.length, 1);
  assert.equal(progress.exhausted, true);
  assert.equal(progress.cursor, null);
  assert.equal(progress.error, '', 'an end, not an error to retry');
});

test('a 5xx or network failure backs off and stops after the bound until the user acts', () => {
  for (const error of [httpError(503), httpError(0), new TypeError('Failed to fetch')]) {
    const { progress, requests } = simulate(() => error);
    assert.equal(requests.length, AUTO_RETRY_LIMIT, String(error.message));
    assert.equal(progress.stopped, true);
    assert.equal(progress.exhausted, false, 'the cursor is kept for Retry');
    assert.deepEqual(progress.cursor, { start: 9030 });
  }
  // The app's own HTTP errors carry retryAfterMs: null when the answer had no
  // Retry-After. That is no declared wait: it backs off and stops as well.
  for (const status of [500, 503, 0]) {
    const { progress, requests } = simulate(() => new HttpError('failed', { status }));
    assert.equal(requests.length, AUTO_RETRY_LIMIT, `HttpError ${status}`);
    assert.equal(progress.rateLimited, false);
    assert.equal(progress.stopped, true);
  }
  {
    const { progress, requests } = simulate(() => new HttpError('Bad Request', { status: 400 }));
    assert.equal(requests.length, 1);
    assert.equal(progress.exhausted, true);
  }
  // A failure in between successes does not add up.
  let calls = 0;
  const { requests } = simulate(() => {
    calls += 1;
    return calls % 2 ? httpError(503) : { items: [], cursor: { start: 9030 + calls }, exhausted: false };
  }, { minutes: 2 });
  assert.ok(requests.length > AUTO_RETRY_LIMIT);
});

test('a declared wait (429, or a block with Retry-After) is held, not ended or stopped', () => {
  const progress = createSourceProgress();
  progress.cursor = { start: 30 };
  recordSourceFailure(progress, httpError(429, { retryAfterMs: 60_000 }), 0);
  recordSourceFailure(progress, httpError(403, { retryAfterMs: 60_000 }), 0);
  assert.equal(progress.exhausted, false);
  assert.equal(progress.stopped, false);
  assert.equal(isClientRefusal(httpError(404)), true);
  assert.equal(isClientRefusal(httpError(408)), false);
  assert.equal(isClientRefusal(httpError(403, { retryAfterMs: 1000 })), false);
});

test('the chain never asks a stopped source again by itself; Retry clears it', async () => {
  const chain = await read('src/modes/library/chain.js');
  assert.match(chain, /\.filter\(\(progress\) => !progress\.exhausted && !progress\.inFlight && !progress\.stopped\)/);
  assert.match(chain, /if \(progress\.exhausted \|\| progress\.stopped \|\| progress\.inFlight/);
  assert.match(chain, /progress\.rateLimited = false;\s*progress\.stopped = false;/);
});

function sepiaPage(start, count = 30, total = 500_000) {
  return {
    total,
    data: Array.from({ length: count }, (_, index) => {
      const number = start + index;
      const id = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
      const host = 'video-1.example.org';
      return {
        id: 10_000 + number, uuid: id, shortUUID: `Fixture${String(number).padStart(12, '0')}`,
        url: `https://${host}/videos/watch/${id}`, name: `Fixture ${number}`, duration: 120,
        publishedAt: '2026-07-10T12:00:00.000Z', privacy: { id: 1, label: 'Public' },
        isLive: false, nsfw: false, nsfwFlags: 0,
        thumbnailUrl: `https://${host}/lazy-static/thumbnails/${id}.jpg`,
        account: { displayName: 'Publisher', host }, channel: { displayName: 'Channel', host },
      };
    }),
  };
}

test('SepiaSearch: start plus page size never passes the index depth', () => {
  assert.equal(SEPIASEARCH_MAX_END, 9030);
  const before = normalizeSepiaResponse(sepiaPage(8970), { start: 8970, count: 30 });
  assert.equal(before.nextStart, 9000);
  const last = normalizeSepiaResponse(sepiaPage(9000), { start: 9000, count: 30 });
  assert.equal(last.exhausted, true);
  assert.equal(last.nextStart, null, 'start=9030 is never asked for');
});

test('a failed request without Retry-After backs off: retryAfterMs null is not a wait of 0 ms', () => {
  const progress = createSourceProgress();
  const delay = recordSourceFailure(progress, new HttpError('failed', { status: 503 }), 1_000);
  assert.ok(delay > 0, 'the ordinary backoff');
  assert.equal(progress.retryAt, 1_000 + delay);
  assert.equal(progress.rateLimited, false);
  // A real Retry-After is still honoured.
  const held = createSourceProgress();
  assert.equal(recordSourceFailure(held, new HttpError('busy', { status: 503, retryAfterMs: 20_000 }), 0), 20_000);
  assert.equal(held.rateLimited, true);
  // The shared scheduler reads it the same way.
  const scheduler = new CatalogScheduler({ cooldownBaseMs: 1_500, cooldownMaxMs: 30_000 });
  assert.equal(scheduler.recordFailure('peertube', new HttpError('failed', { status: 503 })), 1_500);
});

