import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const realRandom = Math.random;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

async function withFetch(handler, fn) {
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
}

/** Lets pending fetches and promise chains finish (setImmediate is not mocked). */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

const loadIptv = () => import(`../src/adapters/iptv-org.js?robust=${Date.now()}-${realRandom()}`);
const loadRadio = () => import(`../src/adapters/radio-browser.js?robust=${Date.now()}-${realRandom()}`);

const channel = (key) => ({ id: key, name: `Channel ${key}`, country: 'US', languages: ['eng'], categories: [] });
const stream = (key) => ({ channel: key, title: `Channel ${key}`, url: `https://tv.example/${key}.m3u8` });
const STREAMS = [stream('a.us')];
const CHANNELS = [channel('a.us')];
const LOGOS = [{ channel: 'a.us', url: 'https://logo.example/a.png', in_use: true, tags: [] }];

/* ============ iptv-org ============ */

test('iptv-org: a slow logos file holds the channel list back for a short time only, and is used when it arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseLogos;
  const logosGate = new Promise((resolve) => { releaseLogos = resolve; });
  let logoRequests = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) return json(STREAMS);
    if (url.endsWith('/channels.json')) return json(CHANNELS);
    if (url.endsWith('/feeds.json')) return json([]);
    logoRequests += 1;
    await logosGate;
    return json(LOGOS);
  }, async () => {
    const iptv = await loadIptv();
    let done = false;
    const first = iptv.browse({ limit: 30 }).then((items) => { done = true; return items; });
    await settle();
    assert.equal(done, false, 'the list waits a little for the logos');
    t.mock.timers.tick(iptv.LOGO_WAIT_MS - 1);
    await settle();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    const items = await first;
    assert.equal(items.length, 1);
    assert.equal(items[0].thumbnail, '', 'built without the logos');

    releaseLogos();
    await settle();
    const later = await iptv.browse({ limit: 30 });
    assert.equal(later[0].thumbnail, 'https://logo.example/a.png', 'logos that arrive later are used');
    assert.equal(logoRequests, 1, 'without a second download');
  });
});

test('iptv-org: a failed logos file does not hold the list back and is asked for again on a later load', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let logoRequests = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) return json(STREAMS);
    if (url.endsWith('/channels.json')) return json(CHANNELS);
    if (url.endsWith('/feeds.json')) return json([]);
    logoRequests += 1;
    return logoRequests === 1 ? json({ error: 'busy' }, 503) : json(LOGOS);
  }, async () => {
    const iptv = await loadIptv();
    const items = await iptv.browse({ limit: 30 });
    assert.equal(items[0].thumbnail, '');
    await iptv.browse({ limit: 30 });
    await settle();
    assert.equal(logoRequests, 1, 'not asked again at once');
    t.mock.timers.tick(10 * 60 * 1000);
    const stillOld = await iptv.browse({ limit: 30 });
    assert.equal(stillOld[0].thumbnail, '', 'the kept list answers at once');
    await settle();
    assert.equal(logoRequests, 2);
    const withLogos = await iptv.browse({ limit: 30 });
    assert.equal(withLogos[0].thumbnail, 'https://logo.example/a.png');
  });
});

test('iptv-org: an empty answer is a failure that is never kept; a stale list is refreshed and a failed refresh keeps it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let streams = [];
  let channels = CHANNELS;
  let streamRequests = 0;
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) { streamRequests += 1; return json(streams); }
    if (url.endsWith('/channels.json')) return json(channels);
    return json(LOGOS);
  }, async () => {
    const iptv = await loadIptv();
    await assert.rejects(() => iptv.browsePage({ limit: 30 }), /no streams or no channels/);
    streams = STREAMS;
    const good = await iptv.browsePage({ limit: 30 });
    assert.equal(good.items.length, 1, 'the empty answer was not kept');
    assert.equal(streamRequests, 2);

    // Fresh: no new download.
    await iptv.browse({ limit: 30 });
    assert.equal(streamRequests, 2);

    // Stale, and the refresh answers empty: the old list stays.
    t.mock.timers.tick(iptv.IPTV_FRESH_MS);
    channels = [];
    const during = await iptv.browse({ limit: 30 });
    assert.deepEqual(during.map((item) => item.id), ['iptv-org:a.us']);
    await settle();
    assert.equal(streamRequests, 3);
    const afterFailed = await iptv.browse({ limit: 30 });
    assert.deepEqual(afterFailed.map((item) => item.id), ['iptv-org:a.us']);
    await settle();
    assert.equal(streamRequests, 3, 'a failed refresh is not repeated at once');

    // Later the refresh works and replaces the list.
    t.mock.timers.tick(10 * 60 * 1000);
    channels = [...CHANNELS, channel('b.us')];
    streams = [...STREAMS, stream('b.us')];
    const stillOld = await iptv.browse({ limit: 30 });
    assert.equal(stillOld.length, 1, 'the old list is used until the new one is good');
    await settle();
    const fresh = await iptv.browse({ limit: 30 });
    assert.deepEqual(fresh.map((item) => item.id).sort(), ['iptv-org:a.us', 'iptv-org:b.us']);
    assert.equal(streamRequests, 4);
  });
});

test('iptv-org: broadcast language comes from the stream feed or the channel main feed', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) return json([
      { ...stream('a.us'), feed: 'Main', url: 'http://tv.example/alternate.m3u8' },
      { ...stream('a.us'), feed: 'Other' },
      stream('b.us'), stream('c.us'),
    ]);
    if (url.endsWith('/channels.json')) return json(
      ['a.us', 'b.us', 'c.us'].map((id) => ({ id, name: id, country: 'US' })),
    );
    if (url.endsWith('/feeds.json')) return json([
      { channel: 'a.us', id: 'Main', is_main: true, languages: ['eng'] },
      { channel: 'a.us', id: 'Other', languages: ['fra'] },
      { channel: 'b.us', id: 'Main', is_main: true, languages: ['eng'] },
      { channel: 'b.us', id: 'Other', languages: ['deu'] },
    ]);
    return json(LOGOS);
  }, async () => {
    const iptv = await loadIptv();
    const items = await iptv.browse();
    assert.deepEqual(Object.fromEntries(items.map(({ id, language }) => [id, language])), {
      'iptv-org:a.us': 'fra', 'iptv-org:b.us': 'eng', 'iptv-org:c.us': '',
    });
  });
});

test('iptv-org: the random pick draws from the whole filtered pool, not only its first 240', async () => {
  const keys = Array.from({ length: 1000 }, (_, index) => `c${index}.us`);
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/streams.json')) return json(keys.map(stream));
    if (url.endsWith('/channels.json')) return json(keys.map(channel));
    return json([]);
  }, async () => {
    const iptv = await loadIptv();
    const firstPage = new Set((await iptv.browsePage({ limit: 240 })).items.map((item) => item.id));
    assert.equal(firstPage.size, 240);
    Math.random = () => 0.9;
    const picked = await iptv.random({ limit: 20 });
    assert.equal(picked.length, 20);
    assert.equal(new Set(picked.map((item) => item.id)).size, 20);
    assert.ok(picked.some((item) => !firstPage.has(item.id)), 'a channel past the first 240 can come up');
  });
});

/* ============ Radio Browser ============ */

const STATION = { stationuuid: 'st-1', name: 'Fixture Radio', url_resolved: 'https://stream.example/one' };

test('Radio Browser: mirrors are probed at the same time, the first healthy one wins and the others are cancelled', async () => {
  const probed = [];
  let slowProbeAborted = false;
  const stationHosts = [];
  await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/servers') return json([{ name: 'slow.example' }, { name: 'good.example' }]);
    if (url.pathname === '/json/stats') {
      probed.push(url.host);
      if (url.host === 'good.example') return json({ status: 'OK' });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { slowProbeAborted = true; reject(init.signal.reason); });
      });
    }
    stationHosts.push(url.host);
    return json([STATION]);
  }, async () => {
    const adapter = await loadRadio();
    const started = Date.now();
    const items = await adapter.search('fixture', { limit: 1 });
    assert.equal(items.length, 1);
    assert.ok(Date.now() - started < 2_000, 'no wait on the silent mirror');
    assert.deepEqual(probed.sort(), ['good.example', 'slow.example']);
    assert.deepEqual(stationHosts, ['good.example']);
    assert.equal(slowProbeAborted, true);
    assert.equal(adapter.PROBE_TIMEOUT_MS, 5_000);
  });
});

test('Radio Browser: a mirror that failed a station request is left out of the new mirror search', async () => {
  const stationHosts = [];
  let serverLists = 0;
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/servers') {
      serverLists += 1;
      return json([{ name: 'fast.example' }, { name: 'other.example' }]);
    }
    if (url.pathname === '/json/stats') {
      // The failing mirror answers its probe first, so without the exclusion it would win again.
      if (url.host === 'other.example') await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ status: 'OK' });
    }
    stationHosts.push(url.host);
    return url.host === 'fast.example' ? json({ error: 'down' }, 500) : json([STATION]);
  }, async () => {
    const adapter = await loadRadio();
    const items = await adapter.search('fixture', { limit: 1 });
    assert.equal(items.length, 1);
    assert.deepEqual(stationHosts, ['fast.example', 'other.example']);
    assert.equal(serverLists, 2);
  });
});

test('Radio Browser: with only the built-in mirror left, a failed request is not sent to it again', async () => {
  let stationRequests = 0;
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/servers') return json([]);
    stationRequests += 1;
    return json({ error: 'down' }, 500);
  }, async () => {
    const adapter = await loadRadio();
    await assert.rejects(() => adapter.search('fixture', { limit: 1 }), /HTTP 500/);
    assert.equal(stationRequests, 1);
  });
});

test('Radio Browser: a 429 or a Retry-After goes to the caller unchanged, with no switch of mirror', async () => {
  let serverLists = 0;
  let stationRequests = 0;
  let answer = () => json({ error: 'slow down' }, 429, { 'retry-after': '30' });
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/servers') { serverLists += 1; return json([{ name: 'one.example' }, { name: 'two.example' }]); }
    if (url.pathname === '/json/stats') return json({ status: 'OK' });
    stationRequests += 1;
    return answer();
  }, async () => {
    const adapter = await loadRadio();
    await assert.rejects(() => adapter.search('fixture', { limit: 1 }), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
    assert.equal(stationRequests, 1, 'no failover on a rate limit');
    answer = () => json({ error: 'busy' }, 503, { 'retry-after': '5' });
    await assert.rejects(() => adapter.search('fixture', { limit: 1 }), (error) => error.status === 503 && error.retryAfterMs === 5_000);
    assert.equal(stationRequests, 2);
    answer = () => json([STATION]);
    assert.equal((await adapter.search('fixture', { limit: 1 })).length, 1);
    assert.equal(serverLists, 1, 'the mirror was kept');
  });
});

test('Radio Browser: a Library page asks for a block of 300 stations and moves on by what it received', async () => {
  const asked = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/servers') return json([{ name: 'good.example' }]);
    if (url.pathname === '/json/stats') return json({ status: 'OK' });
    asked.push({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
    const offset = Number(url.searchParams.get('offset'));
    const count = offset === 0 ? 300 : 12;
    return json(Array.from({ length: count }, (_unused, index) => ({
      stationuuid: `st-${offset + index}`, name: `Radio ${offset + index}`, url_resolved: `https://stream.example/${offset + index}`,
    })));
  }, async () => {
    const adapter = await loadRadio();
    assert.equal(adapter.BROWSE_BLOCK, 300);
    // The Library passes its own small page size; the block is what is asked for.
    const first = await adapter.browsePage({ limit: 30 });
    assert.equal(first.items.length, 300);
    assert.deepEqual(first.cursor, { offset: 300 });
    assert.equal(first.exhausted, false);
    const second = await adapter.browsePage({ limit: 30, cursor: first.cursor });
    assert.equal(second.items.length, 12);
    assert.deepEqual(second.cursor, { offset: 312 });
    assert.equal(second.exhausted, true);
    assert.deepEqual(asked, [{ limit: '300', offset: '0' }, { limit: '300', offset: '300' }]);
    // A search keeps its own, smaller limit.
    await adapter.search('fixture', { limit: 30 });
    assert.equal(asked.at(-1).limit, '30');
  });
});
