import test from 'node:test';
import assert from 'node:assert/strict';

import { makeItem, sanitizeCaptureHeaders, validateItem } from '../src/lib/item-model.js';
import {
  classifyDashManifest,
  classifyHlsManifest,
  firstHlsVariantUrl,
  inspectManifestDelivery,
  repairFiniteMediaFields,
  resolveMediaAction,
} from '../src/lib/media-capabilities.js';

const realFetch = globalThis.fetch;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function text(body, contentType = 'text/plain') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

async function withFetch(handler, fn) {
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

function assertContract(item, delivery, action) {
  assert.deepEqual(validateItem(item), []);
  assert.equal(item.delivery, delivery);
  assert.equal(typeof item.download_url, 'string');
  assert.equal(typeof item.download_name, 'string');
  assert.equal(typeof item.capture_headers, 'object');
  assert.equal(resolveMediaAction(item), action);
}

test('item normalization sanitizes capture headers and defaults capabilities', () => {
  const item = makeItem({
    id: 'test:item', title: 'Item', description: '', source: 'test', type: 'audio',
    stream_url: 'https://media.example/item.mp3', stream_kind: 'audio', tags: [],
    capture_headers: {
      referer: 'https://catalog.example/item',
      userAgent: 'Fixture/1',
      cookie: 'secret=1',
    },
  });
  assert.equal(item.delivery, 'unknown');
  assert.equal(item.download_url, '');
  assert.deepEqual(item.capture_headers, {
    referer: 'https://catalog.example/item',
    userAgent: 'Fixture/1',
  });
  assert.deepEqual(sanitizeCaptureHeaders({
    referer: 'https://safe.example/\r\nX-Evil: yes',
    userAgent: 'Safe Agent',
    Authorization: 'no',
  }), { userAgent: 'Safe Agent' });
});

test('legacy finite favorites recover download capability without source-specific rules', () => {
  const declared = makeItem({
    id: 'archive:declared', title: 'Declared', source: 'archive', type: 'audio',
    stream_kind: 'audio', stream_url: 'https://media.example/resolved', delivery: 'on-demand',
  });
  repairFiniteMediaFields(declared);
  assert.equal(declared.download_url, declared.stream_url);
  assert.equal(resolveMediaAction(declared), 'download');

  const legacy = makeItem({
    id: 'archive:legacy', title: 'Legacy', source: 'archive', type: 'audio',
    stream_kind: 'audio', stream_url: 'https://media.example/program.mp3?download=1',
  });
  repairFiniteMediaFields(legacy);
  assert.equal(legacy.delivery, 'on-demand');
  assert.equal(legacy.download_url, legacy.stream_url);
  assert.equal(resolveMediaAction(legacy), 'download');

  const live = makeItem({
    id: 'radio:live', title: 'Live', source: 'radio', type: 'radio',
    stream_kind: 'audio', stream_url: 'https://radio.example/live.mp3', delivery: 'unknown',
  });
  repairFiniteMediaFields(live);
  assert.equal(live.delivery, 'unknown');
  assert.equal(live.download_url, '');

  const authoritative = makeItem({
    id: 'archive:restricted', title: 'Stream only', source: 'archive', type: 'audio',
    stream_kind: 'audio', stream_url: 'https://media.example/stream-only.mp3',
    delivery: 'on-demand', _extra: { downloadResolved: true },
  });
  repairFiniteMediaFields(authoritative);
  assert.equal(authoritative.download_url, '');
  assert.equal(resolveMediaAction(authoritative), 'unavailable');
});

test('legacy radio and TV favorites infer live capture before unknown HLS inspection', () => {
  assert.equal(resolveMediaAction(makeItem({
    id: 'legacy:tv', title: 'Old TV', source: 'legacy', type: 'tv',
    stream_kind: 'hls', stream_url: 'https://example.test/live.m3u8', delivery: 'unknown',
  })), 'record-video');
  assert.equal(resolveMediaAction(makeItem({
    id: 'legacy:radio', title: 'Old radio', source: 'legacy', type: 'radio',
    stream_kind: 'audio', stream_url: 'https://example.test/live', delivery: 'unknown',
  })), 'record-audio');
});

test('declared live media waits for a resolved stream before offering record', () => {
  const unresolved = makeItem({
    id: 'lazy:live', title: 'Lazy live TV', source: 'lazy', type: 'tv',
    stream_kind: 'hls', stream_url: '', delivery: 'live',
    _extra: { needsResolve: true },
  });
  assert.equal(resolveMediaAction(unresolved), 'checking');

  unresolved._extra.needsResolve = false;
  assert.equal(resolveMediaAction(unresolved), 'unavailable');

  unresolved.stream_url = 'https://example.test/live.m3u8';
  assert.equal(resolveMediaAction(unresolved), 'record-video');
});

test('manifest inspection classifies VOD/live without overriding adapter declarations', async () => {
  const vod = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n';
  const live = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:4,\nseg.ts\n';
  assert.equal(classifyHlsManifest(vod), 'on-demand');
  assert.equal(classifyHlsManifest(live), 'live');
  assert.equal(classifyHlsManifest('broken'), 'unknown');
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nmedia/vod.m3u8\n';
  assert.equal(classifyHlsManifest(master), 'unknown');
  assert.equal(firstHlsVariantUrl(master, 'https://media.example/master.m3u8'), 'https://media.example/media/vod.m3u8');
  const audioMaster = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/live.m3u8"\n';
  assert.equal(firstHlsVariantUrl(audioMaster, 'https://media.example/master.m3u8'), 'https://media.example/audio/live.m3u8');
  assert.equal(classifyDashManifest('<MPD type="static"></MPD>'), 'on-demand');
  assert.equal(classifyDashManifest('<MPD type="dynamic"></MPD>'), 'live');
  assert.equal(classifyDashManifest('<html></html>'), 'unknown');

  const unknown = makeItem({
    id: 'test:hls', title: 'HLS', source: 'test', type: 'video',
    stream_url: 'https://media.example/vod.m3u8', stream_kind: 'hls', delivery: 'unknown',
  });
  await inspectManifestDelivery(unknown, { loadText: async () => vod });
  assert.equal(unknown.delivery, 'on-demand');
  assert.equal(unknown.download_url, unknown.stream_url);
  assert.equal(resolveMediaAction(unknown), 'download');

  const restrictedUnknown = makeItem({
    id: 'test:restricted-hls', title: 'Restricted HLS', source: 'test', type: 'video',
    stream_url: 'https://media.example/restricted.m3u8', stream_kind: 'hls', delivery: 'unknown',
    _extra: { downloadResolved: true },
  });
  await inspectManifestDelivery(restrictedUnknown, { loadText: async () => vod });
  assert.equal(restrictedUnknown.delivery, 'on-demand');
  assert.equal(restrictedUnknown.download_url, '');
  assert.equal(resolveMediaAction(restrictedUnknown), 'unavailable');

  const masterItem = makeItem({
    id: 'test:master', title: 'Master HLS', source: 'test', type: 'video',
    stream_url: 'https://media.example/master.m3u8', stream_kind: 'hls', delivery: 'unknown',
  });
  const requested = [];
  await inspectManifestDelivery(masterItem, { loadText: async (url) => {
    requested.push(url);
    return url.endsWith('/master.m3u8') ? master : vod;
  } });
  assert.deepEqual(requested, [
    'https://media.example/master.m3u8',
    'https://media.example/media/vod.m3u8',
  ]);
  assert.equal(masterItem.delivery, 'on-demand');

  const declared = makeItem({
    id: 'test:declared', title: 'Declared live', source: 'test', type: 'tv',
    stream_url: 'https://media.example/live.m3u8', stream_kind: 'hls', delivery: 'live',
  });
  let called = false;
  await inspectManifestDelivery(declared, { loadText: async () => { called = true; return vod; } });
  assert.equal(called, false);
  assert.equal(declared.delivery, 'live');
  assert.equal(resolveMediaAction(declared), 'record-video');
});

test('the existing six adapters retain approved capabilities before and after lazy resolution', async () => {
  await testRadioBrowser();
  await testIptv();
  await testInternetArchive();
  await testNasa();
  await testWikimedia();
  await testLibriVox();
});

async function testRadioBrowser() {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/json/servers')) return json([]);
    return json([{
      stationuuid: 'radio-1', name: 'Fixture Radio',
      // Radio Browser mirrors may serialize this flag as either 1 or "1".
      url_resolved: 'https://radio.example/live.m3u8?token=1', hls: '1',
      favicon: '', countrycode: 'US', languagecodes: 'eng', tags: 'music',
    }]);
  }, async () => {
    const adapter = await import(`../src/adapters/radio-browser.js?p2=${Date.now()}`);
    const [item] = await adapter.search('fixture', { limit: 1 });
    assertContract(item, 'live', 'record-audio');
    assert.equal(item.stream_kind, 'hls');
  });
}

async function testIptv() {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) return json([{
      channel: 'fixture.us', title: 'Fixture TV', url: 'https://tv.example/live.mpd',
      user_agent: 'DashFixture/1',
    }, {
      channel: 'fixture.us', title: 'Fixture TV', url: 'https://tv.example/live.m3u8',
      http_referrer: 'https://guide.example/\r\nX-Evil: yes', user_agent: 'FixtureTV/1',
    }, {
      channel: 'fixture.us', title: 'Fixture TV backup', url: 'http://backup.example/live.m3u8',
      referrer: 'https://guide.example/',
    }]);
    if (url.endsWith('/channels.json')) return json([{
      id: 'fixture.us', name: 'Fixture TV', country: 'US', languages: ['eng'], categories: [],
    }]);
    return json([]);
  }, async () => {
    const adapter = await import(`../src/adapters/iptv-org.js?p2=${Date.now()}`);
    const [item] = await adapter.browse({ limit: 1 });
    assertContract(item, 'live', 'record-video');
    assert.equal(item.stream_url, 'https://tv.example/live.m3u8');
    assert.deepEqual(item.capture_headers, { userAgent: 'FixtureTV/1' });
    assert.equal(item._extra.streamCandidates.length, 3);
    assert.deepEqual(item._extra.streamCandidates.map((candidate) => candidate.kind), ['hls', 'hls', 'dash']);
    assert.equal('httpReferrer' in item._extra, false);

    const saved = { ...item, stream_url: 'https://retired.example/live.m3u8', _extra: {} };
    await adapter.refreshStreamCandidates(saved);
    assert.equal(saved._extra.streamCandidates.length, 3);
  });
}

async function testInternetArchive() {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/advancedsearch.php')) return json({ response: { numFound: 1, docs: [{
      identifier: 'ia-fixture', title: 'IA Fixture', mediatype: 'movies',
    }] } });
    if (url.includes('/metadata/ia-fixture')) return json({ files: [{
      name: 'fixture.mp4', source: 'derivative',
    }] });
    throw new Error(`unexpected IA URL ${url}`);
  }, async () => {
    const adapter = await import(`../src/adapters/internet-archive.js?p2=${Date.now()}`);
    const [item] = await adapter.search('fixture', { limit: 1 });
    assertContract(item, 'on-demand', 'checking');
    await adapter.resolveStream(item);
    assertContract(item, 'on-demand', 'download');
    assert.equal(item.download_url, item.stream_url);
    assert.equal(item.download_name, 'fixture.mp4');
  });
}

async function testNasa() {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/search?')) return json({ collection: { metadata: { total_hits: 1 }, items: [{
      href: 'https://images-assets.nasa.gov/fixture.json',
      data: [{ nasa_id: 'NASA-1', title: 'NASA Fixture', media_type: 'video' }], links: [],
    }] } });
    if (url.endsWith('/fixture.json')) return json(['https://images-assets.nasa.gov/fixture~orig.mp4']);
    throw new Error(`unexpected NASA URL ${url}`);
  }, async () => {
    const adapter = await import(`../src/adapters/nasa.js?p2=${Date.now()}`);
    const [item] = await adapter.search('fixture', { limit: 1 });
    assertContract(item, 'on-demand', 'checking');
    await adapter.resolveStream(item);
    assertContract(item, 'on-demand', 'download');
    assert.equal(item.download_name, 'fixture~orig.mp4');
  });
}

async function testWikimedia() {
  await withFetch(async () => json({ query: { pages: { 7: {
    pageid: 7, title: 'File:Fixture.webm', canonicalurl: 'https://commons.wikimedia.org/?curid=7',
    imageinfo: [{ url: 'https://upload.wikimedia.org/fixture.webm', mime: 'video/webm', extmetadata: {} }],
  } } } }), async () => {
    const adapter = await import(`../src/adapters/wikimedia.js?p2=${Date.now()}`);
    const [item] = await adapter.search('fixture', { limit: 1, filetype: 'video' });
    assertContract(item, 'on-demand', 'download');
    assert.equal(item.download_url, item.stream_url);
    assert.equal(item.download_name, 'Fixture.webm');
  });
}

async function testLibriVox() {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.includes('/api/feed/audiobooks')) return json({ books: [{
      id: '42', title: 'Fixture Book', url_rss: 'https://librivox.org/rss/42',
      url_zip_file: 'https://archive.org/download/fixture/fixture_book.zip', language: 'English',
    }] });
    if (url.includes('/rss/42')) return text('<rss><enclosure url="https://archive.org/download/fixture/chapter01.mp3"/></rss>', 'application/xml');
    throw new Error(`unexpected LibriVox URL ${url}`);
  }, async () => {
    const adapter = await import(`../src/adapters/librivox.js?p2=${Date.now()}`);
    const [item] = await adapter.search('fixture', { limit: 1 });
    assertContract(item, 'on-demand', 'download');
    assert.equal(item.download_name, 'fixture_book.zip');
    await adapter.resolveStream(item);
    assert.equal(item.stream_url, 'https://archive.org/download/fixture/chapter01.mp3');
    assert.equal(item.download_url, 'https://archive.org/download/fixture/fixture_book.zip');
    assertContract(item, 'on-demand', 'download');
  });
}
