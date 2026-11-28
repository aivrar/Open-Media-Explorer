import test from 'node:test';
import assert from 'node:assert/strict';
import { clearMissingComputerArt, computerArtSource, loadArtworkImage } from '../src/lib/artwork.js';
import { createComputerLibrary } from '../src/lib/computer-library.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { FakeElement } from './helpers/fake-dom.js';

const session = () => Response.json({ ok: true, data: { token: 'cover-token' } });
const settle = () => new Promise(setImmediate);

function imageTarget() {
  const image = new FakeElement('', 'img');
  Object.defineProperty(image, 'src', { set(value) {
    image.setAttribute('src', value);
    image.naturalWidth = 64;
    image.complete = true;
  } });
  return image;
}

test('computer artwork uses an authenticated same-origin request and remembers 404s across image elements', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const source = computerArtSource('missing-cover');
  assert.equal(source, '/api/v1/computer/art/missing-cover');
  assert.equal(computerArtSource('..'), '');
  assert.equal(computerArtSource('https://example.com'), '');
  const fetchImpl = t.mock.fn(async (url, options) => {
    if (url === '/api/v1/session') return session();
    assert.equal(url, source);
    assert.equal(options.headers['X-WorldMedia-Token'], 'cover-token');
    assert.equal(options.credentials, 'same-origin');
    return new Response(null, { status: 404 });
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(loadArtworkImage(new FakeElement('', 'img'), source, { fetchImpl }), { name: 'ArtworkImageError' });
  }
  assert.equal(fetchImpl.mock.callCount(), 2);
});

test('computer artwork remembers at most 512 missing covers', async (t) => {
  clearMissingComputerArt();
  resetControlSession();
  t.after(() => { clearMissingComputerArt(); resetControlSession(); });
  const fetchImpl = t.mock.fn(async (url) => url === '/api/v1/session'
    ? session() : new Response(null, { status: 404 }));
  const image = imageTarget();
  const miss = (id) => assert.rejects(loadArtworkImage(image, computerArtSource('limit-' + id), { fetchImpl }),
    { name: 'ArtworkImageError' });
  for (let id = 0; id <= 512; id++) await miss(id);
  assert.equal(fetchImpl.mock.callCount(), 514);
  for (let id = 1; id <= 512; id++) await miss(id);
  assert.equal(fetchImpl.mock.callCount(), 514);
  await miss(0);
  assert.equal(fetchImpl.mock.callCount(), 515);
});

test('computer JPEGs decode through an object URL and release it; transient failures can try again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetControlSession();
  t.after(resetControlSession);
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url === '/api/v1/session') return session();
    if (++calls === 1) return new Response(null, { status: 503 });
    return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const image = imageTarget();
  const createUrl = t.mock.fn(() => 'blob:computer-cover');
  const revokeUrl = t.mock.fn();
  const options = { createUrl, revokeUrl, fetchImpl, requireConnected: false };
  const source = computerArtSource('good-cover');
  await assert.rejects(loadArtworkImage(image, source, options), { name: 'ArtworkImageError' });
  assert.equal(await loadArtworkImage(image, source, options), image);
  assert.equal(image.getAttribute('src'), 'blob:computer-cover');
  assert.equal(createUrl.mock.calls[0].arguments[0].type, 'image/jpeg');
  assert.equal(revokeUrl.mock.calls[0].arguments[0], 'blob:computer-cover');
});

test('Computer pictures accept JPEG, PNG and WebP, and reject other types', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    const image = imageTarget();
    const createUrl = t.mock.fn(() => 'blob:computer-type');
    const result = loadArtworkImage(image, computerArtSource('image-types'), {
      fetchImpl: async (url) => url === '/api/v1/session' ? session() : new Response('image', {
        headers: { 'Content-Type': type },
      }),
      createUrl, revokeUrl() {}, requireConnected: false,
    });
    if (type === 'image/gif') {
      await assert.rejects(result, { name: 'ArtworkImageError' });
      assert.equal(createUrl.mock.callCount(), 0);
    } else {
      assert.equal(await result, image);
      assert.equal(createUrl.mock.calls[0].arguments[0].type, type);
    }
  }
});

test('a new Computer revision forgets missing artwork, including late 404 responses', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  let revision = 1;
  const status = () => ({ scanning: false, revision });
  const library = createComputerLibrary({
    loadComputerLibrary: async () => ({ revision, items: [], folders: [] }),
    startComputerScan: async () => status(),
    computerStatus: async () => status(),
  });
  t.after(library.closeComputerLibrary);
  await library.openComputerLibrary();

  const late = Promise.withResolvers();
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url === '/api/v1/session') return session();
    calls++;
    if (calls === 2) return late.promise;
    return revision === 1 ? new Response(null, { status: 404 }) : new Response('image', {
      headers: { 'Content-Type': 'image/png' },
    });
  };
  const image = imageTarget();
  const opts = { fetchImpl, requireConnected: false, createUrl: () => 'blob:fresh-cover', revokeUrl() {} };
  const cover = (id) => loadArtworkImage(image, computerArtSource(id), opts);
  await assert.rejects(cover('new-cover'), { name: 'ArtworkImageError' });
  await assert.rejects(cover('new-cover'), { name: 'ArtworkImageError' });
  assert.equal(calls, 1);
  const stale = assert.rejects(cover('returning-drive'), { name: 'ArtworkImageError' });
  await settle();
  assert.equal(calls, 2);

  revision++;
  await library.retry();
  late.resolve(new Response(null, { status: 404 }));
  await stale;
  assert.equal(await cover('new-cover'), image);
  assert.equal(await cover('returning-drive'), image);
  assert.equal(calls, 4);
});

test('cancelling a cover load aborts the fetch and never assigns a source to the image', async (t) => {
  resetControlSession();
  t.after(resetControlSession);
  const controller = new AbortController();
  const image = new FakeElement('', 'img');
  const fetchImpl = t.mock.fn((url, { signal }) => {
    if (url === '/api/v1/session') return session();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const result = loadArtworkImage(image, computerArtSource('abort-cover'), { fetchImpl, signal: controller.signal });
  await settle();
  assert.equal(fetchImpl.mock.callCount(), 2);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(fetchImpl.mock.calls[1].arguments[1].signal.aborted, true);
  assert.equal(image.getAttribute('src'), null);
});
