import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { SOURCES } from '../src/lib/sources.js';
import { normalizeSettings } from '../src/lib/state.js';

const FIXTURE_DIR = new URL('./fixtures/five-new-sources/', import.meta.url);
const readFixture = (name, encoding = null) => readFile(new URL(name, FIXTURE_DIR), encoding || undefined);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFixture('manifest.json', 'utf8'));
const contracts = JSON.parse(await readFixture('contracts.json', 'utf8'));

test('five-source fixture manifest covers every capture and verifies exact SHA-256 bytes', async () => {
  assert.equal(manifest.version, 1);
  assert.match(manifest.captured, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(manifest.hashAlgorithm, 'sha256');
  assert.equal(manifest.lineEndings, 'lf');

  const fixtureNames = (await readdir(FIXTURE_DIR))
    .filter((name) => name !== 'manifest.json')
    .sort();
  const declaredNames = manifest.files.map((entry) => entry.file).sort();
  assert.deepEqual(declaredNames, fixtureNames, 'every fixture must have provenance and no stale manifest entry');
  assert.equal(new Set(declaredNames).size, declaredNames.length, 'fixture names must be unique');

  for (const entry of manifest.files) {
    assert.ok(entry.provider, `${entry.file} missing provider`);
    assert.ok(entry.endpoint, `${entry.file} missing endpoint`);
    assert.notEqual(entry.status, undefined, `${entry.file} missing status`);
    assert.match(entry.contentType, /^[\w.+-]+\/[\w.+-]+$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(entry.cases) && entry.cases.length > 0);
    const bytes = await readFixture(entry.file);
    assert.equal(sha256(bytes), entry.sha256, `${entry.file} differs from its sanitized capture hash`);
    assert.equal(bytes.includes(13), false, `${entry.file} must remain LF-only for portable hashes`);
  }
});

test('sanitized provider captures contain no credentials, personal paths, or undeclared private URLs', async () => {
  const credentialPatterns = [
    /\bauthorization\s*:/i,
    /\bset-cookie\s*:/i,
    /["'](?:api[_-]?key|access[_-]?token|password|client[_-]?secret)["']\s*:/i,
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  ];
  const personalPathPatterns = [/[a-z]:[\\/]users[\\/]/i, /[\\/]appdata[\\/]/i, /[\\/]home[\\/][^/\s]+[\\/]/i];
  const privateUrlPatterns = [
    /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(?=[:/])/i,
    /https?:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?=[:/])/i,
  ];

  for (const entry of manifest.files) {
    const text = await readFixture(entry.file, 'utf8');
    for (const pattern of [...credentialPatterns, ...personalPathPatterns]) {
      assert.doesNotMatch(text, pattern, `${entry.file} contains sensitive fixture material`);
    }
    if (!entry.allowSecurityMarkers) {
      for (const pattern of privateUrlPatterns) {
        assert.doesNotMatch(text, pattern, `${entry.file} contains an undeclared private URL`);
      }
    }
  }
});

test('all Phase 8 source IDs, rating default, metadata, and stable identity vectors are registered', async () => {
  const expectedNewIds = ['media-ccc', 'library-of-congress', 'gpodder', 'peertube', 'owncast'];
  assert.deepEqual(contracts.sourceIds, expectedNewIds);
  assert.equal(new Set(contracts.sourceIds).size, contracts.sourceIds.length);
  assert.deepEqual(contracts.contentRating.values, ['explicit', 'not-explicit', 'unrated']);
  assert.equal(contracts.contentRating.setting, 'showExplicitContent');
  assert.equal(contracts.contentRating.default, false);
  assert.equal(contracts.persistence.favoritesKey, 'worldmedia.favorites.v1');
  assert.equal(contracts.persistence.eqKey, 'worldmedia.eq.v1');
  assert.match(contracts.persistence.rule, /never clear or replace saved favorites/);
  assert.match(contracts.persistence.testIsolation, /WORLDMEDIA_STATE_ROOT/);
  assert.equal(contracts.productionRegistrationPhase, 8);

  const currentIds = SOURCES.map((source) => source.id);
  assert.deepEqual(currentIds, [
    'radio-browser', 'iptv-org', 'internet-archive', 'nasa', 'wikimedia', 'librivox',
    ...expectedNewIds,
  ]);
  for (const id of expectedNewIds) assert.equal(currentIds.includes(id), true, `${id} missing in Phase 8`);
  for (const source of SOURCES) {
    assert.match(source.homepage, /^https:\/\//);
    assert.ok(source.description.length > 20);
    assert.ok(source.rightsNote.length > 20);
    assert.ok(Array.isArray(source.capabilities) && source.capabilities.length >= 3);
    assert.match(source.color, /^var\(--source-[a-z0-9-]+\)$/);
  }

  const vectorIds = contracts.stableIdentityVectors.map((vector) => vector.id);
  assert.equal(new Set(vectorIds).size, vectorIds.length);
  for (const vector of contracts.stableIdentityVectors) {
    assert.ok(expectedNewIds.includes(vector.source));
    assert.ok(vector.id.startsWith(`${vector.source}:`));
    if (vector.canonicalHashInput) {
      assert.equal(vector.id, `${vector.source}:${sha256(vector.canonicalHashInput)}`);
    }
  }

  const iptv = await readFile(new URL('../src/adapters/iptv-org.js', import.meta.url), 'utf8');
  const state = await readFile(new URL('../src/lib/state.js', import.meta.url), 'utf8');
  const eqStore = await readFile(new URL('../src/lib/eq-store.js', import.meta.url), 'utf8');
  assert.match(iptv, /content_rating:\s*isNsfw[\s\S]*?showExplicitContent !== true/,
    'IPTV must retain ratings and filter reversibly from the shared preference');
  assert.doesNotMatch(iptv, /if \(isNsfw\) continue;/,
    'Phase 8 must not irreversibly discard explicit IPTV rows at load time');
  assert.match(state, /favorites:\s*['"]worldmedia\.favorites\.v1['"]/);
  assert.match(eqStore, /worldmedia\.eq\.v1/);
  assert.match(state, /Object\.assign\(state\.favorites\[index\], normalized\)/,
    'favorite refresh must update in place instead of replacing the saved array entry');
});

test('the eleven-source paging, UI, settings, and packaged-chunk connections share one registry', async () => {
  const originalIds = [
    'radio-browser', 'iptv-org', 'internet-archive', 'nasa', 'wikimedia', 'librivox',
    ...contracts.sourceIds,
  ];
  assert.deepEqual(SOURCES.map((source) => source.id), originalIds);

  const migrated = normalizeSettings({
    version: 27,
    futureSetting: { preserve: true },
    enabledSources: { 'radio-browser': false, 'future-source': true },
  });
  assert.equal(migrated.version, 27);
  assert.deepEqual(migrated.futureSetting, { preserve: true });
  assert.equal(migrated.enabledSources['radio-browser'], false);
  assert.equal(migrated.enabledSources['future-source'], true);

  const [search, chain, render, sidebar, about] = await Promise.all([
    readFile(new URL('../src/lib/search.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modes/library/chain.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modes/library/render.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modes/library/sidebar.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modes/about.js', import.meta.url), 'utf8'),
  ]);
  assert.match(search, /items:\s*allowed\(page\.items\)/);
  for (const state of ['loading', 'more', 'complete', 'retrying', 'rate-limited', 'disabled', 'live', 'stale']) {
    assert.match(`${chain}\n${render}`, new RegExp(`['"]${state}['"]`), `missing source state ${state}`);
  }
  assert.match(sidebar, /items:\s*SOURCES\.map/);
  assert.match(sidebar, /poolIsEmpty\s*&&\s*headingNonFav/);
  assert.match(sidebar, /renderResults\(\);\s*renderStatus\(\);\s*updateSentinelStatus\(\);/s);
  assert.match(about, /import \{ SOURCES, getSourceColor \} from ['"]\.\.\/lib\/sources\.js['"]/);
  assert.match(about, /SOURCES\.map/);
  assert.match(about, /https:\/\/github\.com\/aivrar\/Open-Media-Explorer/);
  assert.match(about, /class="about-project-link"/);
  assert.doesNotMatch(about, /SOURCES_INFO|function dotColor/);

  const assets = await readdir(new URL('../frontend/assets/', import.meta.url));
  for (const id of originalIds) {
    assert.equal(assets.filter((name) => name.startsWith(`${id}-`) && name.endsWith('.js')).length, 1,
      `packaged frontend must contain exactly one ${id} adapter chunk`);
  }
});

test('provider fixtures retain every success, retry, safety, and schema-drift branch', async () => {
  const ccc = JSON.parse(await readFixture('media-ccc.json', 'utf8'));
  assert.ok(ccc.recent.body.events.length > 0);
  assert.ok(ccc.detail.recordings.some((entry) => entry.mime_type === 'video/mp4'));
  assert.ok(ccc.detail.recordings.some((entry) => entry.mime_type === 'audio/mpeg'));
  assert.ok(ccc.graphqlSearch.data.lectureSearch.length > 0);
  assert.ok(ccc.graphqlError.errors.length > 0);
  assert.deepEqual(ccc.liveEmpty, []);
  assert.ok(ccc.liveNonEmpty[0].groups[0].rooms[0].streams.length >= 2);

  const loc = JSON.parse(await readFixture('loc.json', 'utf8'));
  assert.equal(loc.downloadableItem.resources[0].canDownload, true);
  assert.equal(loc.restrictedItem.resources[0].download_restricted, true);
  assert.equal(loc.rateLimit.status, 429);
  assert.ok(Number(loc.rateLimit.headers['retry-after']) > 0);
  assert.match(await readFixture('loc-captcha.html', 'utf8'), /captcha/i);

  const gpodder = JSON.parse(await readFixture('gpodder.json', 'utf8'));
  assert.ok(gpodder.toplist.length && gpodder.search.length);
  assert.ok(gpodder.feedOutcomes.some((outcome) => outcome.status === 301));
  assert.ok(gpodder.feedOutcomes.some((outcome) => outcome.status === 404));
  assert.ok(gpodder.feedOutcomes.some((outcome) => outcome.timeout === true));

  const peertube = JSON.parse(await readFixture('peertube.json', 'utf8'));
  assert.ok(peertube.index.data.some((item) => item.isLive === false && item.nsfw === false));
  assert.ok(peertube.index.data.some((item) => item.isLive === true && item.nsfw === false));
  assert.ok(peertube.index.data.some((item) => item.nsfw === true));
  assert.ok(peertube.index.data.some((item) => item.privacy?.id === 3));
  assert.equal(peertube.originDetails.vod.downloadEnabled, true);
  assert.ok(peertube.originDetails.vod.streamingPlaylists[0].playlistUrl.endsWith('.m3u8'));
  assert.ok(peertube.originDetails.vod.files[0].fileDownloadUrl.endsWith('.mp4'));
  assert.equal(peertube.originDetails.live.isLive, true);
  assert.equal(peertube.originDetails.private.privacy.id, 3);
  assert.notEqual(peertube.originDetails.unpublished.state.id, 1);
  assert.equal(peertube.rateLimit.status, 429);

  const owncast = JSON.parse(await readFixture('owncast-home.json', 'utf8'));
  const instances = owncast.sections.flatMap((section) => section.instances || []);
  assert.ok(instances.some((item) => item.nsfw === false));
  assert.ok(instances.some((item) => item.nsfw === true));
  assert.ok(instances.some((item) => !Object.hasOwn(item, 'nsfw')));
  assert.ok(instances.some((item) => typeof item.nsfw === 'string'));
  assert.equal(typeof owncast.featured.nsfw, 'boolean');

  const m3u = await readFixture('owncast-directory.m3u', 'utf8');
  assert.ok(m3u.startsWith('#EXTM3U\n'));
  assert.match(m3u, /tvg-ID="Fixture Quoted, Comma"/);
  assert.match(m3u, /tvg-ID="Fixture\nMultiline Stream"/);
  assert.match(m3u, /http:\/\/http-stream\.example\.org:8080\/hls\/stream\.m3u8/);
  assert.match(m3u, /ftp:\/\/malformed\.example\.org\/stream\.m3u8/);
});
