// Which file or address an adapter picks to play: a recording or station the
// embedded browser plays is not passed over (Internet Archive, Wikimedia
// Commons, Radio Browser, LibriVox). media.ccc.de: tests/media-ccc.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let importSequence = 0;

function json(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

function xml(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
}

async function withFetch(handler, fn) {
  globalThis.fetch = async (input) => handler(String(input));
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const fresh = (path) => import(`../src/adapters/${path}?picks=${Date.now()}-${++importSequence}`);

test('Internet Archive: an H.264 original wins over a Theora derivative; Opus audio is played', async () => {
  // File lists shaped like archive.org /metadata answers (2026-11-21).
  const items = {
    'mp4-original-ogv-derivative': [
      { name: 'talk.mp4', source: 'original', format: 'MPEG4' },
      { name: 'talk.ogv', source: 'derivative', format: 'Ogg Video' },
      { name: 'talk.gif', source: 'derivative', format: 'Animated GIF' },
    ],
    'derivatives-as-before': [
      { name: 'film.mpeg', source: 'original', format: 'MPEG2' },
      { name: 'film.avi', source: 'derivative', format: 'Cinepack' },
      { name: 'film.ia.mp4', source: 'derivative', format: 'h.264 IA' },
      { name: 'film.ogv', source: 'derivative', format: 'Ogg Video' },
      { name: 'film_256kb.rm', source: 'derivative', format: 'Real Media' },
    ],
    'ogv-only': [{ name: 'old.ogv', source: 'derivative', format: 'Ogg Video' }],
    'opus-only': [
      { name: 'cover.jpg', source: 'original', format: 'JPEG' },
      { name: 'song.opus', source: 'original', format: 'Opus' },
    ],
    'mp3-before-ogg': [
      { name: 'track.flac', source: 'original', format: 'Flac' },
      { name: 'track.ogg', source: 'derivative', format: 'Ogg Vorbis' },
      { name: 'track.mp3', source: 'derivative', format: 'VBR MP3' },
    ],
  };
  await withFetch((url) => {
    const identifier = decodeURIComponent(url.split('/metadata/')[1] || '');
    if (!items[identifier]) throw new Error(`unexpected Internet Archive URL ${url}`);
    return json({ files: items[identifier] });
  }, async () => {
    const archive = await fresh('internet-archive.js');
    const picked = {};
    for (const identifier of Object.keys(items)) {
      const item = {
        id: `internet-archive:${identifier}`, source: 'internet-archive',
        type: identifier.includes('opus') || identifier.includes('mp3') ? 'audio' : 'video',
        stream_url: '', download_url: '', download_name: '',
        _extra: { identifier, needsResolve: true },
      };
      await archive.resolveStream(item);
      picked[identifier] = item.download_name;
      assert.equal(item._extra.needsResolve, false, identifier);
      assert.equal(item.stream_url, `https://archive.org/download/${identifier}/${encodeURIComponent(item.download_name)}`);
    }
    assert.deepEqual(picked, {
      'mp4-original-ogv-derivative': 'talk.mp4',
      'derivatives-as-before': 'film.ia.mp4',
      'ogv-only': 'old.ogv',
      'opus-only': 'song.opus',
      'mp3-before-ogg': 'track.mp3',
    });
  });
});

test('Wikimedia Commons: FLAC and Opus files are offered; MIDI still is not', async () => {
  const page = (pageid, file, mime) => ({
    pageid, index: pageid, title: `File:${file}`,
    canonicalurl: `https://commons.wikimedia.org/wiki/File:${file}`,
    imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`, mime, extmetadata: {} }],
  });
  await withFetch(() => json({ query: { pages: {
    1: page(1, 'Bach_prelude.flac', 'audio/x-flac'),
    2: page(2, 'Folk_song.opus', 'audio/ogg'),
    3: page(3, 'Choir.wav', 'audio/wav'),
    4: page(4, 'Sonata.mid', 'audio/midi'),
  } } }), async () => {
    const wiki = await fresh('wikimedia.js');
    const items = await wiki.search('music', { filetype: 'audio' });
    assert.deepEqual(items.map((item) => item.download_name), ['Bach prelude.flac', 'Folk song.opus', 'Choir.wav']);
    for (const item of items) {
      assert.equal(item.type, 'audio');
      assert.equal(item.stream_kind, 'audio');
      assert.equal(item.download_url, item.stream_url);
    }
  });
});

test('Radio Browser: a station without a resolved address plays from the address it was entered with', async () => {
  await withFetch((url) => {
    if (url.includes('/json/servers')) return json([]);
    return json([
      { stationuuid: 'resolved', name: 'Resolved FM', url: 'http://radio.example/listen.pls', url_resolved: 'https://radio.example/live.mp3' },
      { stationuuid: 'unresolved', name: 'New FM', url: 'https://new.example/stream.aac', url_resolved: '' },
      { stationuuid: 'unresolved-hls', name: 'HLS FM', url: 'https://hls.example/live.m3u8', url_resolved: null, hls: 1 },
      { stationuuid: 'no-address', name: 'Silent FM', url: '', url_resolved: '' },
      { name: 'No id FM', url_resolved: 'https://noid.example/live.mp3' },
    ]);
  }, async () => {
    const radio = await fresh('radio-browser.js');
    const items = await radio.search('fm', { limit: 10 });
    assert.deepEqual(items.map((item) => [item.id, item.stream_url, item.stream_kind]), [
      ['radio-browser:resolved', 'https://radio.example/live.mp3', 'audio'],
      ['radio-browser:unresolved', 'https://new.example/stream.aac', 'audio'],
      ['radio-browser:unresolved-hls', 'https://hls.example/live.m3u8', 'hls'],
    ]);
  });
});

test('LibriVox: the first MP3 still wins; a feed of other audio files plays its first one', async () => {
  const feeds = {
    // A real LibriVox feed carries MP3 enclosures only (librivox.org/rss/4441).
    mp3: '<rss><channel><item><enclosure url="https://www.archive.org/download/book/book_1_64kb.mp3" length="0" type="audio/mpeg" /></item>'
      + '<item><enclosure url="https://www.archive.org/download/book/book_2_64kb.m4a" type="audio/mp4" /></item></channel></rss>',
    m4a: '<rss><channel><item><enclosure url="https://cdn.example/book/chapter01.m4a" length="1" type="audio/mp4" /></item>'
      + '<item><enclosure url="https://cdn.example/book/chapter02.m4a" type="audio/mp4" /></item></channel></rss>',
    typed: '<rss><channel><item><enclosure type="image/jpeg" url="https://cdn.example/cover.jpg" /></item>'
      + '<item><enclosure type="audio/ogg" url="https://cdn.example/stream/chapter01" /></item></channel></rss>',
    none: '<rss><channel><item><enclosure url="https://cdn.example/cover.jpg" type="image/jpeg" /></item></channel></rss>',
  };
  await withFetch((url) => {
    const key = url.split('/rss/')[1];
    if (!feeds[key]) throw new Error(`unexpected LibriVox URL ${url}`);
    return xml(feeds[key]);
  }, async () => {
    const librivox = await fresh('librivox.js');
    const resolved = {};
    for (const key of Object.keys(feeds)) {
      const item = {
        id: `librivox:${key}`, source: 'librivox', title: key, type: 'audio', thumbnail: 'x',
        stream_url: '', download_url: '', download_name: '',
        _extra: { rssUrl: `https://librivox.org/rss/${key}`, needsResolve: true },
      };
      await librivox.resolveStream(item);
      resolved[key] = [item.stream_url, item._extra.needsResolve];
    }
    assert.deepEqual(resolved, {
      mp3: ['https://www.archive.org/download/book/book_1_64kb.mp3', false],
      m4a: ['https://cdn.example/book/chapter01.m4a', false],
      typed: ['https://cdn.example/stream/chapter01', false],
      none: ['', true],
    });
  });
});
