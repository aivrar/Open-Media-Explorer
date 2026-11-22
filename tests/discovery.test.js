import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSourceProgress,
  recordSourceFailure,
  recordSourceSuccess,
  RETRY_BASE_MS,
  RETRY_MAX_MS, SLOW_RETRY_MAX_MS,
} from '../src/modes/library/progress.js';

const realFetch = globalThis.fetch;
const realRandom = Math.random;
const realDateNow = Date.now;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetch(handler, fn) {
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    Math.random = realRandom;
    Date.now = realDateNow;
  }
}

test('source failures preserve the cursor and back off instead of exhausting', () => {
  const progress = createSourceProgress();
  progress.cursor = { page: 7, seed: 'mars' };

  const firstDelay = recordSourceFailure(progress, new Error('temporary'), 1_000);
  assert.equal(firstDelay, RETRY_BASE_MS);
  assert.deepEqual(progress.cursor, { page: 7, seed: 'mars' });
  assert.equal(progress.exhausted, false);
  assert.equal(progress.retryAt, 1_000 + RETRY_BASE_MS);

  // Repeated failures slow the retries down to at most one every ten minutes.
  for (let i = 0; i < 10; i++) recordSourceFailure(progress, new Error('still temporary'), 2_000);
  assert.equal(progress.retryAt - 2_000, SLOW_RETRY_MAX_MS);
  assert.ok(RETRY_MAX_MS < SLOW_RETRY_MAX_MS);
  assert.deepEqual(progress.cursor, { page: 7, seed: 'mars' });

  recordSourceSuccess(progress, { cursor: { page: 8 }, exhausted: false }, 30);
  assert.equal(progress.failures, 0);
  assert.equal(progress.retryAt, 0);
  assert.equal(progress.error, '');
});

test('NASA browse cursor pins one seed across pages', async () => {
  const urls = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const page = Number(url.searchParams.get('page'));
    // A full page: a short one while total_hits says more is an error.
    return json({
      collection: {
        metadata: { total_hits: 1_000 },
        items: Array.from({ length: 30 }, (_, index) => ({
          href: `https://images-assets.nasa.gov/${page}-${index}.json`,
          data: [{ nasa_id: `nasa-${page}-${index}`, title: `NASA ${page}`, media_type: 'video' }],
          links: [],
        })),
      },
    });
  }, async () => {
    Math.random = () => 0;
    const nasa = await import(`../src/adapters/nasa.js?test=${Date.now()}`);
    const first = await nasa.browsePage({ limit: 30 });
    Math.random = () => 0.99;
    await nasa.browsePage({ limit: 30, cursor: first.cursor });
  });

  assert.equal(urls[0].searchParams.get('q'), urls[1].searchParams.get('q'));
  assert.equal(urls[0].searchParams.get('page'), '1');
  assert.equal(urls[1].searchParams.get('page'), '2');
});

test('Internet Archive cursor pins its rotation and round-robins collections when the clock bucket changes', async () => {
  const urls = [];
  const docs = Array.from({ length: 30 }, (_, index) => ({
    identifier: `item-${index}`,
    title: `Item ${index}`,
    mediatype: 'movies',
  }));
  await withFetch(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return json({ response: { numFound: 300, docs } });
  }, async () => {
    const bucket = 7 * 600_000;
    Date.now = () => bucket;
    const archive = await import(`../src/adapters/internet-archive.js?test=${bucket}`);
    const first = await archive.browsePage({ limit: 30 });
    assert.equal(first.cursor.startCollection, 'prelinger');
    assert.equal(first.cursor.nextCollection, 'feature_films');
    Date.now = () => bucket + 600_000;
    await archive.browsePage({ limit: 30, cursor: first.cursor });
  });

  const firstQuery = urls[0].searchParams.get('q');
  const secondQuery = urls[1].searchParams.get('q');
  const firstCollection = firstQuery.match(/collection:([^ )]+)/)?.[1];
  const secondCollection = secondQuery.match(/collection:([^ )]+)/)?.[1];
  assert.equal(firstCollection, 'prelinger');
  assert.equal(secondCollection, 'feature_films');
  assert.equal(urls[0].searchParams.get('page'), '1');
  assert.equal(urls[1].searchParams.get('page'), '1');
});

test('Internet Archive transient empty first page is retried instead of exhausted', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls === 1) return json({ response: { numFound: 100, docs: [] } });
    return json({
      response: {
        numFound: 1,
        docs: [{ identifier: 'recovered-item', title: 'Recovered item', mediatype: 'movies' }],
      },
    });
  }, async () => {
    const archive = await import(`../src/adapters/internet-archive.js?empty-test=${Date.now()}`);
    await assert.rejects(
      () => archive.browsePage({ collection: 'opensource_movies', limit: 30 }),
      /transient empty first page/,
    );
    const recovered = await archive.browsePage({ collection: 'opensource_movies', limit: 30 });
    assert.equal(recovered.items.length, 1);
    assert.equal(recovered.items[0].id, 'internet-archive:recovered-item');
  });
});

test('Internet Archive automatic browse skips an allowed empty bucket and continues its rotation', async () => {
  const calls = [];
  const docs = Array.from({ length: 30 }, (_, index) => ({
    identifier: `fallback-${index}`,
    title: `Fallback ${index}`,
    mediatype: 'audio',
  }));
  await withFetch(async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get('q').match(/collection:([^ )]+)/)?.[1];
    calls.push({ collection, page: url.searchParams.get('page') });
    if (collection === 'tvnews') return json({ response: { numFound: 0, docs: [] } });
    return json({ response: { numFound: 300, docs } });
  }, async () => {
    // Bucket index 5 selects tvnews, whose current unrestricted query is empty.
    Date.now = () => 5 * 600_000;
    const archive = await import(`../src/adapters/internet-archive.js?fallback=${Date.now()}`);
    const first = await archive.browsePage({ limit: 30 });
    assert.equal(first.cursor.startCollection, 'tvnews');
    assert.equal(first.cursor.nextCollection, 'prelinger');
    assert.equal(first.cursor.remainingCollections.includes('tvnews'), false);
    assert.equal(first.items.length, 30);

    await archive.browsePage({ limit: 30, cursor: first.cursor });
  });

  assert.deepEqual(calls.slice(0, 2), [
    { collection: 'tvnews', page: '1' },
    { collection: 'librivoxaudio', page: '1' },
  ]);
  assert.deepEqual(calls[2], { collection: 'prelinger', page: '1' });
});

test('Internet Archive ending the 81-item cartoon bucket continues into other collections', async () => {
  const calls = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get('q').match(/collection:([^ )]+)/)?.[1];
    const page = Number(url.searchParams.get('page'));
    calls.push({ collection, page });
    if (collection === 'classic_cartoons') {
      const docs = Array.from({ length: 21 }, (_, index) => ({
        identifier: `cartoon-${60 + index}`,
        title: `Cartoon ${60 + index}`,
        mediatype: 'movies',
      }));
      return json({ response: { numFound: 81, docs } });
    }
    if (collection === 'tvnews') return json({ response: { numFound: 0, docs: [] } });
    if (collection === 'librivoxaudio') {
      const docs = Array.from({ length: 30 }, (_, index) => ({
        identifier: `audio-${index}`,
        title: `Audio ${index}`,
        mediatype: 'audio',
      }));
      return json({ response: { numFound: 300, docs } });
    }
    throw new Error(`unexpected collection ${collection}`);
  }, async () => {
    Date.now = () => 4 * 600_000;
    const archive = await import(`../src/adapters/internet-archive.js?cartoons=${Date.now()}`);
    const cursor = {
      mode: 'automatic',
      startCollection: 'classic_cartoons',
      nextCollection: 'classic_cartoons',
      pages: { classic_cartoons: 3 },
      remainingCollections: archive.COLLECTIONS.map(({ id }) => id),
    };
    const cartoonsEnd = await archive.browsePage({ limit: 30, cursor });
    assert.equal(cartoonsEnd.items.length, 21);
    assert.equal(cartoonsEnd.exhausted, false);
    assert.equal(cartoonsEnd.cursor.remainingCollections.includes('classic_cartoons'), false);

    const continued = await archive.browsePage({ limit: 30, cursor: cartoonsEnd.cursor });
    assert.equal(continued.items.length, 30);
    assert.match(continued.items[0].id, /^internet-archive:audio-/);
    assert.equal(continued.exhausted, false);
  });

  assert.deepEqual(calls, [
    { collection: 'classic_cartoons', page: 3 },
    { collection: 'tvnews', page: 1 },
    { collection: 'librivoxaudio', page: 1 },
  ]);
});

test('Internet Archive automatic browse completes only after every collection ends', async () => {
  const collections = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get('q').match(/collection:([^ )]+)/)?.[1];
    collections.push(collection);
    return json({
      response: {
        numFound: 1,
        docs: [{ identifier: `${collection}-only`, title: collection, mediatype: 'movies' }],
      },
    });
  }, async () => {
    let now = 0;
    Date.now = () => (now += 250);
    const archive = await import(`../src/adapters/internet-archive.js?all-complete=${Date.now()}`);
    let cursor = null;
    for (let index = 0; index < archive.COLLECTIONS.length; index++) {
      const page = await archive.browsePage({ limit: 30, cursor });
      assert.equal(page.items.length, 1);
      assert.equal(page.exhausted, index === archive.COLLECTIONS.length - 1);
      cursor = page.cursor;
    }
  });
  assert.deepEqual(collections, [
    'prelinger', 'feature_films', 'classic_tv', 'fedflix',
    'classic_cartoons', 'tvnews', 'librivoxaudio',
  ]);
});

test('Internet Archive automatic empty-collection fallback is bounded', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return json({ response: { numFound: 0, docs: [] } });
  }, async () => {
    let tick = 0;
    Date.now = () => (5 * 600_000) + (tick++ * 250);
    const archive = await import(`../src/adapters/internet-archive.js?bounded=${Date.now()}`);
    await assert.rejects(
      () => archive.browsePage({ limit: 30 }),
      /transient empty/,
    );
  });
  assert.equal(calls, 7, 'each curated collection should be tried at most once');
});

test('Internet Archive one-shot browse and random modes also skip empty curated collections', async () => {
  const collections = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get('q').match(/collection:([^ )]+)/)?.[1];
    collections.push(collection);
    if (collection === 'tvnews' || collection === 'fedflix') {
      return json({ response: { numFound: 0, docs: [] } });
    }
    return json({
      response: {
        numFound: 1,
        docs: [{ identifier: `${collection}-item`, title: collection, mediatype: 'movies' }],
      },
    });
  }, async () => {
    Date.now = () => 5 * 600_000;
    Math.random = () => 0.5;
    const archive = await import(`../src/adapters/internet-archive.js?all-modes=${Date.now()}`);
    const browsed = await archive.browse({ limit: 30 });
    const random = await archive.random({ limit: 12 });
    assert.equal(browsed[0].id, 'internet-archive:librivoxaudio-item');
    assert.equal(random[0].id, 'internet-archive:classic_cartoons-item');
  });

  assert.deepEqual(collections, [
    'tvnews', 'librivoxaudio', 'fedflix', 'classic_cartoons',
  ]);
});

test('Internet Archive absorbs short retryable transport failures', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls < 3) return json({ error: 'temporary' }, 502);
    return json({
      response: {
        numFound: 1,
        docs: [{ identifier: 'after-retry', title: 'After retry', mediatype: 'movies' }],
      },
    });
  }, async () => {
    const archive = await import(`../src/adapters/internet-archive.js?retry=${Date.now()}`);
    const page = await archive.browsePage({
      collection: 'prelinger', limit: 30, retryBaseMs: 50,
    });
    assert.equal(page.items[0].id, 'internet-archive:after-retry');
  });
  assert.equal(calls, 3);
});

test('Wikimedia keeps independent video and audio continuation offsets', async () => {
  const calls = [];
  await withFetch(async (input) => {
    const url = new URL(String(input));
    const search = url.searchParams.get('gsrsearch');
    const type = search.includes('filetype:video') ? 'video' : 'audio';
    const offset = Number(url.searchParams.get('gsroffset'));
    calls.push({ type, offset, search });
    const ext = type === 'video' ? 'mp4' : 'mp3';
    const mime = type === 'video' ? 'video/mp4' : 'audio/mpeg';
    const id = type === 'video' ? 101 + offset : 202 + offset;
    return json({
      query: {
        pages: {
          [id]: {
            pageid: id,
            title: `File:${type}-${offset}.${ext}`,
            index: offset,
            imageinfo: [{ url: `https://upload.wikimedia.org/${type}-${offset}.${ext}`, mime }],
          },
        },
      },
      ...(offset === 0 ? { continue: { gsroffset: type === 'video' ? 30 : 40 } } : {}),
    });
  }, async () => {
    Math.random = () => 0;
    const wiki = await import(`../src/adapters/wikimedia.js?test=${Date.now()}`);
    const first = await wiki.browsePage({ limit: 30 });
    Math.random = () => 0.99;
    const second = await wiki.browsePage({ limit: 30, cursor: first.cursor });
    assert.equal(second.exhausted, true);
  });

  const secondVideo = calls.find((call) => call.type === 'video' && call.offset !== 0);
  const secondAudio = calls.find((call) => call.type === 'audio' && call.offset !== 0);
  assert.equal(secondVideo.offset, 30);
  assert.equal(secondAudio.offset, 40);
  assert.equal(secondVideo.search.split(' ').slice(1).join(' '), calls[0].search.split(' ').slice(1).join(' '));
});

test('adapter transport failures reject instead of becoming empty pages', async () => {
  await withFetch(async () => json({ error: 'temporary' }, 504), async () => {
    const nasa = await import(`../src/adapters/nasa.js?failure=${Date.now()}`);
    await assert.rejects(() => nasa.browsePage({ limit: 30 }), /HTTP 504/);
  });
});

test('NASA: a short or empty page while total_hits says more remains is an error; the true end and the depth limit end normally', async () => {
  let reply = { total: 0, count: 0 };
  await withFetch(async (input) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    return json({
      collection: {
        metadata: { total_hits: reply.total },
        items: Array.from({ length: reply.count }, (_, index) => ({
          href: `https://images-assets.nasa.gov/${page}-${index}.json`,
          data: [{ nasa_id: `nasa-${page}-${index}`, title: `NASA ${page}`, media_type: 'video' }],
          links: [],
        })),
      },
    });
  }, async () => {
    const nasa = await import(`../src/adapters/nasa.js?short=${Date.now()}`);
    const page = (number, limit = 30) => nasa.browsePage({ limit, cursor: { seed: 'mars', page: number } });

    reply = { total: 1_000, count: 12 };
    await assert.rejects(() => page(2), /NASA returned a transient incomplete page/);
    reply = { total: 1_000, count: 0 };
    await assert.rejects(() => page(1), /NASA returned a transient empty page/);

    // The last page of the total: short, and the end.
    reply = { total: 70, count: 10 };
    assert.equal((await page(3)).exhausted, true);
    reply = { total: 90, count: 30 };
    assert.equal((await page(3)).exhausted, true);
    reply = { total: 1_000, count: 30 };
    const middle = await page(2);
    assert.equal(middle.exhausted, false);
    assert.deepEqual(middle.cursor, { seed: 'mars', page: 3 });
    // No total reported: a short page still ends the listing.
    reply = { total: 0, count: 5 };
    assert.equal((await page(4)).exhausted, true);

    // NASA serves no page past 100 and no result past the 10,000th.
    reply = { total: 50_000, count: 30 };
    assert.equal((await page(99)).exhausted, false);
    assert.equal((await page(100)).exhausted, true);
    reply = { total: 50_000, count: 100 };
    assert.equal((await page(100, 100)).exhausted, true);
    reply = { total: 50_000, count: 0 };
    assert.equal((await page(101)).exhausted, true, 'past the limit is the end, not an error');
  });
});

test('NASA: the same page short three times in a row is the real end; a full page or another page starts the count again', async () => {
  let reply = { total: 0, count: 0 };
  await withFetch(async (input) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    return json({
      collection: {
        metadata: { total_hits: reply.total },
        items: Array.from({ length: reply.count }, (_, index) => ({
          href: `https://images-assets.nasa.gov/${page}-${index}.json`,
          data: [{ nasa_id: `nasa-${page}-${index}`, title: `NASA ${page}`, media_type: 'video' }],
          links: [],
        })),
      },
    });
  }, async () => {
    const nasa = await import(`../src/adapters/nasa.js?overstated=${Date.now()}`);
    const page = (number) => nasa.browsePage({ limit: 30, cursor: { seed: 'hubble', page: number } });
    const transient = /NASA returned a transient incomplete page/;

    // total_hits says 1,000 but NASA stops at 40.
    reply = { total: 1_000, count: 10 };
    await assert.rejects(() => page(2), transient);
    await assert.rejects(() => page(2), transient);
    // A full answer in between starts the count again.
    reply = { total: 1_000, count: 30 };
    assert.equal((await page(2)).exhausted, false);
    reply = { total: 1_000, count: 10 };
    await assert.rejects(() => page(2), transient);
    await assert.rejects(() => page(2), transient);
    // So does a short answer for another page.
    await assert.rejects(() => page(3), transient);
    await assert.rejects(() => page(2), transient);
    await assert.rejects(() => page(2), transient);
    const end = await page(2);
    assert.equal(end.exhausted, true, 'the third short answer in a row ends the listing');
    assert.equal(end.items.length, 10);
    // The count was cleared: the next short answer is again a transient error.
    await assert.rejects(() => page(2), transient);
  });
});

test('IPTV clears a rejected preload promise so the next call can recover', async () => {
  let failing = true;
  let requests = 0;
  await withFetch(async (input) => {
    requests += 1;
    if (failing) return json({ error: 'temporary' }, 504);
    const url = String(input);
    if (url.endsWith('/streams.json')) {
      return json([{ channel: 'test.us', title: 'Test TV', url: 'https://example.com/live.m3u8' }]);
    }
    if (url.endsWith('/channels.json')) {
      return json([{ id: 'test.us', name: 'Test TV', country: 'US', languages: ['eng'], categories: [] }]);
    }
    return json([]);
  }, async () => {
    const iptv = await import(`../src/adapters/iptv-org.js?test=${Date.now()}`);
    await assert.rejects(() => iptv.browsePage({ limit: 30 }), /HTTP 504/);
    const failedRequestCount = requests;
    failing = false;
    const recovered = await iptv.browsePage({ limit: 30 });
    assert.equal(recovered.items.length, 1);
    assert.ok(requests > failedRequestCount, 'second call should issue new requests');
  });
});
