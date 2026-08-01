import test from 'node:test';
import assert from 'node:assert/strict';

import { resetControlSession, ControlApiError } from '../src/lib/capture-client.js';
import {
  clearCatalogCache,
  expireCatalogAsset,
  getOwncastSnapshot,
  registerCatalogAsset,
  resolvePeerTubeVideo,
  resolvePodcastFeed,
} from '../src/lib/catalog-client.js';

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

test('catalog client uses only fixed authenticated routes and exact bodies', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'catalog-token' } });
    return response(path.includes('/assets/register') ? 201 : 200, { ok: true, data: { path } });
  };
  await resolvePodcastFeed(' https://feeds.example/show.xml ', { fetchImpl });
  await resolvePeerTubeVideo(
    'https://video.example/videos/watch/11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    { fetchImpl },
  );
  await getOwncastSnapshot({ fetchImpl });
  await registerCatalogAsset({
    url: 'https://images.example/cover.png', sourceId: 'gpodder', itemId: 'gpodder:one',
  }, { fetchImpl });
  await expireCatalogAsset('opaque_asset_1234567890', 'gpodder', 'gpodder:one', { fetchImpl });
  await clearCatalogCache({ fetchImpl });

  assert.deepEqual(calls.slice(1).map(({ path }) => path), [
    '/api/v1/catalog/feed/resolve',
    '/api/v1/catalog/peertube/resolve',
    '/api/v1/catalog/owncast/snapshot',
    '/api/v1/assets/register',
    '/api/v1/assets/opaque_asset_1234567890/expire',
    '/api/v1/catalog/cache/clear',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: 'https://feeds.example/show.xml' });
  assert.equal(calls[3].options.method, 'GET');
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    url: 'https://images.example/cover.png', source_id: 'gpodder', item_id: 'gpodder:one',
  });
  assert.equal(calls.slice(1).every(({ options }) => options.headers['X-WorldMedia-Token'] === 'catalog-token'), true);
});

test('catalog client rejects incomplete inputs before session or outbound work', async () => {
  resetControlSession();
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not fetch'); };
  assert.throws(() => resolvePodcastFeed('', { fetchImpl }), ControlApiError);
  assert.throws(() => resolvePeerTubeVideo('https://video.example/watch', '', { fetchImpl }), ControlApiError);
  assert.throws(() => registerCatalogAsset({ url: 'x', sourceId: '', itemId: 'one' }, { fetchImpl }), ControlApiError);
  assert.throws(() => expireCatalogAsset('', 'gpodder', 'one', { fetchImpl }), ControlApiError);
  assert.equal(calls, 0);
});

test('catalog client preserves bounded Retry-After guidance', async () => {
  resetControlSession();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return response(200, { ok: true, data: { token: 'retry-token' } });
    return response(429, {
      ok: false, error: { code: 'CATALOG_RATE_LIMITED', message: 'Retry later.', retryable: true },
    }, { 'retry-after': '37' });
  };
  await assert.rejects(
    resolvePodcastFeed('https://feeds.example/show.xml', { fetchImpl }),
    (error) => error instanceof ControlApiError
      && error.code === 'CATALOG_RATE_LIMITED'
      && error.retryable
      && error.retryAfter === 37,
  );
});
