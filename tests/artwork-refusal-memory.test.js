import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resetControlSession, ControlApiError } from '../src/lib/capture-client.js';
import {
  MAX_REFUSED_ASSETS, REFUSED_ASSET_CODES, REFUSED_ASSET_TTL_MS, assetRefusedThisSession, forgetRefusedAssets, isRefusedAssetError,
  registerCatalogAsset,
} from '../src/lib/catalog-client.js';
import { artworkNeedsResolution, artworkRequests, resolveArtworkRelay } from '../src/lib/artwork.js';
import { resolveItemArtwork } from '../src/modes/library/thumbnails.js';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null },
  };
}

/** A fake app: answers the session, and refuses or accepts each address. */
function fakeApp(answer) {
  const asked = [];
  const fetchImpl = async (path, options = {}) => {
    if (path === '/api/v1/session') return response(200, { ok: true, data: { token: 'refusal-token' } });
    const body = JSON.parse(options.body);
    asked.push(body.url);
    const [status, code] = answer(body.url);
    if (status >= 400) return response(status, { ok: false, error: { code, message: 'Refused.', retryable: false } });
    return response(201, { ok: true, data: { relay_url: '/api/v1/assets/opaque_asset_000000000099' } });
  };
  return { asked, fetchImpl };
}

const scope = (url) => ({ url, sourceId: 'owncast', itemId: 'owncast:one' });

test('an address the app refuses is remembered for the session and not asked again', async () => {
  resetControlSession();
  forgetRefusedAssets();
  const refused = 'https://owncast.example.org/logo.png';
  const app = fakeApp((url) => (url === refused ? [403, 'NON_GLOBAL_MEDIA_TARGET'] : [201, '']));
  for (let visit = 0; visit < 3; visit += 1) {
    await assert.rejects(registerCatalogAsset(scope(refused), { fetchImpl: app.fetchImpl }),
      (error) => error instanceof ControlApiError && error.code === 'NON_GLOBAL_MEDIA_TARGET'
        && error.status === 403 && isRefusedAssetError(error));
  }
  assert.deepEqual(app.asked, [refused], 'asked once, whatever the number of visits');
  assert.equal(assetRefusedThisSession(refused), true);
  assert.equal(assetRefusedThisSession(` ${refused} `), true);
  // Other addresses are still asked.
  const other = await registerCatalogAsset(scope('https://cdn.example.org/ok.png'), { fetchImpl: app.fetchImpl });
  assert.equal(other.relay_url, '/api/v1/assets/opaque_asset_000000000099');
  assert.deepEqual(app.asked, [refused, 'https://cdn.example.org/ok.png']);
  forgetRefusedAssets();
  assert.equal(assetRefusedThisSession(refused), false);
});

test('only refusals because of the address are remembered', async () => {
  resetControlSession();
  forgetRefusedAssets();
  assert.deepEqual([...REFUSED_ASSET_CODES], ['NON_GLOBAL_MEDIA_TARGET', 'CATALOG_TARGET_REJECTED']);
  for (const [status, code] of [[403, 'INVALID_TOKEN'], [403, 'ASSET_SCOPE_MISMATCH'], [400, 'NON_GLOBAL_MEDIA_TARGET'],
    [500, 'INTERNAL_ERROR'], [429, 'CATALOG_RATE_LIMITED']]) {
    const url = `https://art.example.org/${code}-${status}.png`;
    const app = fakeApp(() => [status, code]);
    await assert.rejects(registerCatalogAsset(scope(url), { fetchImpl: app.fetchImpl }));
    resetControlSession();
    await assert.rejects(registerCatalogAsset(scope(url), { fetchImpl: app.fetchImpl }));
    assert.equal(app.asked.length, 2, `${status} ${code} is asked again`);
    assert.equal(assetRefusedThisSession(url), false);
    resetControlSession();
  }
  const app = fakeApp(() => [403, 'CATALOG_TARGET_REJECTED']);
  await assert.rejects(registerCatalogAsset(scope('https://art.example.org/c.png'), { fetchImpl: app.fetchImpl }));
  assert.equal(assetRefusedThisSession('https://art.example.org/c.png'), true);
  // Missing input is still refused at once, before any request.
  assert.throws(() => registerCatalogAsset({ url: '', sourceId: 'owncast', itemId: 'x' }), ControlApiError);
  forgetRefusedAssets();
});

test('a refusal from a name lookup holds for 10 minutes; a target no catalog may reach holds for the session', async () => {
  resetControlSession();
  forgetRefusedAssets();
  assert.deepEqual({ ...REFUSED_ASSET_TTL_MS }, { NON_GLOBAL_MEDIA_TARGET: 10 * 60 * 1000 });
  let clock = 1_000_000;
  const now = () => clock;
  const lookup = 'https://portal.example.org/logo.png';
  const rejected = 'https://rejected.example.org/logo.png';
  const app = fakeApp((url) => (url === lookup ? [403, 'NON_GLOBAL_MEDIA_TARGET'] : [403, 'CATALOG_TARGET_REJECTED']));
  const ask = (url) => registerCatalogAsset(scope(url), { fetchImpl: app.fetchImpl, now });
  await assert.rejects(ask(lookup));
  await assert.rejects(ask(rejected));
  clock += 10 * 60 * 1000 - 1;
  await assert.rejects(ask(lookup));
  await assert.rejects(ask(rejected));
  assert.deepEqual(app.asked, [lookup, rejected], 'neither asked again within 10 minutes');
  assert.equal(assetRefusedThisSession(lookup, clock), true);
  clock += 1;
  assert.equal(assetRefusedThisSession(lookup, clock), false, 'the lookup refusal has run out');
  await assert.rejects(ask(lookup));
  await assert.rejects(ask(rejected));
  assert.deepEqual(app.asked, [lookup, rejected, lookup], 'the lookup refusal is asked again, once');
  clock += 60 * 60 * 1000;
  await assert.rejects(ask(rejected));
  assert.equal(app.asked.length, 3, 'the session refusal still holds after an hour');
  forgetRefusedAssets();
});

test('the remembered refusals are bounded', async () => {
  resetControlSession();
  forgetRefusedAssets();
  const app = fakeApp(() => [403, 'NON_GLOBAL_MEDIA_TARGET']);
  for (let index = 0; index <= MAX_REFUSED_ASSETS; index += 1) {
    await assert.rejects(registerCatalogAsset(scope(`https://art.example.org/${index}.png`), { fetchImpl: app.fetchImpl }));
  }
  assert.equal(assetRefusedThisSession('https://art.example.org/0.png'), false, 'the oldest is forgotten first');
  assert.equal(assetRefusedThisSession(`https://art.example.org/${MAX_REFUSED_ASSETS}.png`), true);
  forgetRefusedAssets();
});

test('a refused picture shows the initials tile on every visit without an error or a new request', async () => {
  resetControlSession();
  forgetRefusedAssets();
  const logo = 'https://owncast.example.org/logo.png';
  const app = fakeApp(() => [403, 'NON_GLOBAL_MEDIA_TARGET']);
  // Each visit builds new item objects for the same station.
  const visit = () => ({
    id: 'owncast:station', source: 'owncast', thumbnail: '', _extra: { artworkUrl: logo },
  });
  const registerAssetImpl = (args, options) => registerCatalogAsset(args, { ...options, fetchImpl: app.fetchImpl });
  for (let index = 0; index < 3; index += 1) {
    const item = visit();
    const resolved = await resolveArtworkRelay(item, { registerAssetImpl });
    assert.equal(resolved, item);
    assert.equal(item.thumbnail, '');
    assert.equal(artworkNeedsResolution(item), false, 'this item is not asked about again');
  }
  assert.deepEqual(app.asked, [logo]);
  assert.equal(artworkRequests.size, 0);
  forgetRefusedAssets();
});

test('an item refused by a name lookup asks again at its first render after 10 minutes', async () => {
  resetControlSession();
  forgetRefusedAssets();
  let clock = 5_000_000;
  const now = () => clock;
  const logo = 'https://portal.example.org/station.png';
  let accept = false;
  const app = fakeApp(() => (accept ? [201, ''] : [403, 'NON_GLOBAL_MEDIA_TARGET']));
  const registerAssetImpl = (args, options) => registerCatalogAsset(args, { ...options, fetchImpl: app.fetchImpl });
  // The same item object is rendered again, as the Library does.
  const item = { id: 'owncast:portal', source: 'owncast', thumbnail: logo };
  const render = () => resolveArtworkRelay(item, { registerAssetImpl, now });

  await render();
  assert.equal(item.thumbnail, '', 'initials tile');
  assert.deepEqual(app.asked, [logo]);
  clock += 9 * 60 * 1000;
  assert.equal(artworkNeedsResolution(item, clock), false);
  await render();
  assert.equal(item.thumbnail, '', 'still the initials tile at 9 minutes');
  assert.deepEqual(app.asked, [logo], 'no new request at 9 minutes');

  clock += 60 * 1000;
  accept = true;
  assert.equal(artworkNeedsResolution(item, clock), true, 'due again after 10 minutes');
  await render();
  assert.deepEqual(app.asked, [logo, logo], 'one new request');
  assert.equal(item.thumbnail, '/api/v1/assets/opaque_asset_000000000099', 'the picture is used now');
  await render();
  assert.equal(app.asked.length, 2);
  assert.equal(artworkRequests.size, 0);

  // A target no catalog may reach stays refused for the session for its item.
  forgetRefusedAssets();
  const rejected = { id: 'owncast:rejected', source: 'owncast', thumbnail: 'https://rejected.example.org/x.png' };
  const strict = fakeApp(() => [403, 'CATALOG_TARGET_REJECTED']);
  const strictRegister = (args, options) => registerCatalogAsset(args, { ...options, fetchImpl: strict.fetchImpl });
  await resolveArtworkRelay(rejected, { registerAssetImpl: strictRegister, now });
  clock += 60 * 60 * 1000;
  assert.equal(artworkNeedsResolution(rejected, clock), false);
  await resolveArtworkRelay(rejected, { registerAssetImpl: strictRegister, now });
  assert.equal(strict.asked.length, 1);
  forgetRefusedAssets();
});

test('the Library logs a failed picture only when it really failed', async () => {
  const thumbnails = (await readFile(new URL('../src/modes/library/thumbnails.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  // The warning is for a terminal failure. Refusals resolve and aborts skip it.
  assert.match(thumbnails, /return resolveArtworkRelay\(item, opts\)\.catch\(\(error\) => \{\n\s+if \(error\?\.name !== 'AbortError'\) console\.warn\('thumbnail hydrate failed:', error\);/);
  const artwork = (await readFile(new URL('../src/lib/artwork.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(artwork, /if \(isRefusedAssetError\(error\)\) return \{ relayUrl: '', canonicalUrl: '' \};/);
});

test('Library artwork resolution warns once for a failed lookup and stays quiet on cancellation', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const error = new Error('picture lookup failed');
  const item = (name) => ({ id: 'owncast:' + name, source: 'owncast', thumbnail: 'https://pictures.example/logo.png' });
  await assert.rejects(resolveItemArtwork(item('failed'), {
    registerAssetImpl: async () => { throw error; },
    retry: { attempts: 1 },
  }), error);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [['thumbnail hydrate failed:', error]]);

  const controller = new AbortController();
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  const cancelled = assert.rejects(resolveItemArtwork(item('cancelled'), {
    signal: controller.signal,
    registerAssetImpl: async (_scope, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      begin();
    }),
  }), { name: 'AbortError' });
  await started;
  controller.abort();
  await cancelled;
  assert.equal(warn.mock.callCount(), 1);
});
