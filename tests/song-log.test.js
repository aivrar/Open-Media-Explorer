import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SONG_LOG_EXPORT_ROUTE, SONG_LOG_LIMIT, SONG_LOG_ROUTE, SONG_LOG_SAVE_FAILED, SONG_LOG_UNREADABLE_NOTICE,
  cleanSongLogText, createSongLog, exportSongLog, makeSongLogEntry, parseSongLogEntries, songLog,
} from '../src/lib/song-log.js';
import { NOW_PLAYING_EVENT } from '../src/lib/now-playing.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { clearCache, emit, subscribe } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);

const STATIONS = {
  'radio-browser:jazz': { id: 'radio-browser:jazz', title: 'Jazz FM', source: 'radio-browser' },
  'radio-browser:rock': { id: 'radio-browser:rock', title: 'Rock 24', source: 'radio-browser' },
  // The same station played from an imported playlist: another id, same name.
  'playlist:jazz-copy': { id: 'playlist:jazz-copy', title: 'Jazz FM', source: 'playlist' },
};

function song(title, itemId = 'radio-browser:jazz', changedAt = T0) {
  return { itemId, mediaId: `relay-${itemId}`, title, changedAt };
}

function saved(title, stationId = 'radio-browser:jazz', time = T0) {
  return { time, station: STATIONS[stationId]?.title || '', stationId, source: 'radio-browser', title };
}

/**
 * A data folder that behaves like worldmedia_songlog.py: a write is applied
 * only when its revision is newer than the stored one, otherwise it is
 * answered with what is stored. Requests can be held and released by the
 * test, in any order.
 */
function fakeServer({ entries = [], revision = 0, hold = false } = {}) {
  const server = {
    entries,
    revision,
    unreadable: false,
    hold,
    gets: 0,
    posts: [],
    applied: [],
    inFlight: 0,
    maxInFlight: 0,
    waiting: [],
    failGets: false,
    failPosts: false,
    getAnswer: undefined,
    request(path, options = {}) {
      assert.equal(path, SONG_LOG_ROUTE);
      const run = () => {
        if (options.method === 'POST') {
          assert.deepEqual(Object.keys(options.body), ['revision', 'entries']);
          server.posts.push(options.body.entries);
          if (server.failPosts) throw new Error('Disk full');
          if (options.body.revision <= server.revision) {
            return { saved: false, stale: true, revision: server.revision, entries: server.entries };
          }
          server.revision = options.body.revision;
          server.entries = options.body.entries;
          server.unreadable = false;
          server.applied.push(options.body.revision);
          return { saved: true, revision: server.revision, count: server.entries.length };
        }
        server.gets += 1;
        if (server.failGets) throw new Error('Not ready');
        if (server.getAnswer !== undefined) return server.getAnswer;
        return { entries: server.entries, revision: server.revision, unreadable: server.unreadable };
      };
      if (!server.hold) return Promise.resolve().then(run);
      server.inFlight += 1;
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      return new Promise((resolve, reject) => {
        server.waiting.push(() => {
          server.inFlight -= 1;
          try { resolve(run()); } catch (error) { reject(error); }
        });
      });
    },
    async releaseNext() {
      await server.release(0);
    },
    /** Let the request waiting at `index` arrive (0 = the oldest). */
    async release(index) {
      await drain(); // requests are sent a microtask later
      server.waiting.splice(index, 1)[0]();
      await drain();
    },
  };
  return server;
}

const titles = (list) => list.map((item) => item.title);

function makeLog(server, extra = {}) {
  const failures = [];
  const log = createSongLog({
    request: server.request,
    getItem: (itemId) => STATIONS[itemId] || null,
    now: () => T0 + 999,
    onSaveFailed: (error) => failures.push(error),
    onSaved: () => {},
    ...extra,
  });
  return { log, failures };
}

function bus() {
  const listeners = new Map();
  return {
    subscribe(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
    emit(event, payload) { listeners.get(event)?.(payload); },
  };
}

test('a station-announced song becomes one plain, frozen entry', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  const events = bus();
  log.start(events.subscribe);
  await drain();
  events.emit(NOW_PLAYING_EVENT, song('Miles Davis - So What'));
  await drain();
  const [entry] = log.entries();
  assert.deepEqual(entry, {
    time: T0, station: 'Jazz FM', stationId: 'radio-browser:jazz', source: 'radio-browser', title: 'Miles Davis - So What',
  });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.getPrototypeOf(entry), Object.prototype);
  assert.deepEqual(server.posts, [[entry]]);
});

test('no title, an empty title or the song going away logs nothing', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  for (const title of [null, '', '   ', '\u200B', undefined, 42]) log.handleNowPlaying(song(title));
  await drain();
  assert.equal(log.size, 0);
  assert.deepEqual(server.posts, []);
});

test('the same station repeating its song is one entry, also after a pause or a reconnect', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('A - One'));
  log.handleNowPlaying(song(null)); // paused: the song goes away
  log.handleNowPlaying(song('A - One', 'radio-browser:jazz', T0 + 60_000)); // resumed
  log.handleNowPlaying({ ...song('A - One', 'radio-browser:jazz', T0 + 90_000), mediaId: 'new-relay' }); // reconnect
  log.handleNowPlaying(song('  A -   One ')); // same text once cleaned
  await drain();
  assert.deepEqual(log.entries().map((entry) => entry.title), ['A - One']);
  assert.equal(server.posts.length, 1, 'one write per new song');
  log.handleNowPlaying(song('B - Two', 'radio-browser:jazz', T0 + 200_000));
  log.handleNowPlaying(song('A - One', 'radio-browser:jazz', T0 + 400_000)); // played again later
  await drain();
  assert.deepEqual(log.entries().map((entry) => entry.title), ['A - One', 'B - Two', 'A - One']);
  assert.equal(server.posts.length, 3);
});

test('restarting the app while the same song plays does not log it again', async () => {
  const server = fakeServer({ entries: [saved('Rock 24 song', 'radio-browser:rock', T0 - 60_000), saved('A - One')], revision: 4 });
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('A - One', 'radio-browser:jazz', T0 + 120_000)); // same station, same song
  await drain();
  assert.deepEqual(titles(log.entries()), ['Rock 24 song', 'A - One']);
  assert.deepEqual(server.posts, [], 'nothing to write');
  log.handleNowPlaying(song('B - Two', 'radio-browser:jazz', T0 + 300_000));
  await drain();
  assert.deepEqual(titles(server.entries), ['Rock 24 song', 'A - One', 'B - Two']);
  assert.deepEqual(server.applied, [5], 'the next write follows the loaded revision');
});

test('a repeat that arrives before the saved log is read is dropped when it is read', async () => {
  const server = fakeServer({ entries: [saved('A - One')], revision: 2, hold: true });
  const { log } = makeLog(server);
  log.start(() => {});
  log.handleNowPlaying(song('A - One', 'radio-browser:jazz', T0 + 90_000));
  await server.releaseNext(); // the read
  assert.deepEqual(titles(log.entries()), ['A - One']);
  while (server.waiting.length) await server.release(0);
  assert.deepEqual(titles(server.entries), ['A - One']);
  assert.equal(server.revision, 3);
});

test('the same station under another id is recognised by its name', async () => {
  const { log } = makeLog(fakeServer());
  log.handleNowPlaying(song('Same', 'radio-browser:jazz'));
  log.handleNowPlaying(song(null, 'radio-browser:jazz')); // stopped
  log.handleNowPlaying(song('Same', 'playlist:jazz-copy')); // started again from a playlist
  assert.deepEqual(log.entries().map((item) => item.stationId), ['radio-browser:jazz']);
  log.handleNowPlaying(song('Same', 'radio-browser:rock')); // a different station: a new row
  log.handleNowPlaying(song('Same', 'radio-browser:jazz')); // back again, but not in a row
  log.handleNowPlaying(song('Other', 'radio-browser:jazz')); // a different title
  assert.deepEqual(log.entries().map((item) => `${item.station}/${item.title}`),
    ['Jazz FM/Same', 'Rock 24/Same', 'Jazz FM/Same', 'Jazz FM/Other']);
});

test('a station whose title never changes keeps a single row', async () => {
  const { log } = makeLog(fakeServer());
  for (let n = 0; n < 5; n += 1) {
    log.handleNowPlaying(song('Radio X - Live', 'radio-browser:rock', T0 + n * 600_000));
    log.handleNowPlaying(song(null, 'radio-browser:rock'));
  }
  assert.equal(log.size, 1);
});

test('another station playing the same song is a new entry', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('Hit - Song', 'radio-browser:jazz'));
  log.handleNowPlaying(song('Hit - Song', 'radio-browser:rock'));
  log.handleNowPlaying(song('Hit - Song', 'radio-browser:jazz'));
  await drain();
  assert.deepEqual(log.entries().map((entry) => entry.station), ['Jazz FM', 'Rock 24', 'Jazz FM']);
});

test('a station that is not the playing item is logged without a name', async () => {
  const { log } = makeLog(fakeServer());
  log.handleNowPlaying(song('X', 'unknown:item'));
  assert.deepEqual(log.entries()[0], { time: T0, station: '', stationId: 'unknown:item', source: '', title: 'X' });
  log.handleNowPlaying({ itemId: 'radio-browser:jazz', title: 'Y', changedAt: 'soon' });
  assert.equal(log.entries()[1].time, T0 + 999, 'an unusable time is replaced by now');
});

test('the log keeps the newest 500 songs and drops the oldest', async () => {
  const server = fakeServer({ entries: Array.from({ length: 498 }, (_, n) => saved(`Saved ${n}`, 'radio-browser:jazz', T0 + n)) });
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  for (let n = 0; n < 5; n += 1) log.handleNowPlaying(song(`New ${n}`, 'radio-browser:rock', T0 + 10_000 + n));
  await drain();
  const titles = log.entries().map((entry) => entry.title);
  assert.equal(titles.length, SONG_LOG_LIMIT);
  assert.equal(titles[0], 'Saved 3');
  assert.equal(titles.at(-1), 'New 4');
  assert.equal(server.entries.length, SONG_LOG_LIMIT);
  assert.deepEqual(server.entries.at(-1).title, 'New 4');
});

test('the log is saved in the data folder and read back by the next start', async () => {
  const server = fakeServer();
  const first = makeLog(server).log;
  first.start(() => {});
  await drain();
  first.handleNowPlaying(song('One'));
  first.handleNowPlaying(song('Two', 'radio-browser:rock', T0 + 5000));
  await drain();
  const second = makeLog(server).log;
  second.start(() => {});
  await drain();
  assert.deepEqual(second.entries(), first.entries());
  assert.equal(server.gets, 2);
});

test('nothing is written before the saved log is read; a failed read never replaces it', async () => {
  const server = fakeServer({ entries: [saved('Saved')] });
  server.failGets = true;
  const { log, failures } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('New', 'radio-browser:rock'));
  await drain();
  assert.deepEqual(server.posts, [], 'not written over an unread log');
  assert.equal(failures.length, 1);
  assert.equal(server.gets, 2, 'read again with the next song');
  server.failGets = false;
  log.handleNowPlaying(song('Newer', 'radio-browser:rock'));
  await drain();
  assert.deepEqual(log.entries().map((entry) => entry.title), ['Saved', 'New', 'Newer']);
  assert.deepEqual(server.entries.map((entry) => entry.title), ['Saved', 'New', 'Newer']);
});

test('songs logged while the saved log is read come after it, without a repeat at the join', async () => {
  const server = fakeServer({ entries: [saved('Playing now')], hold: true });
  const { log } = makeLog(server);
  log.start(() => {});
  log.handleNowPlaying(song('Playing now'));
  log.handleNowPlaying(song('Next'));
  await server.releaseNext(); // the read
  assert.deepEqual(log.entries().map((entry) => entry.title), ['Playing now', 'Next']);
  while (server.waiting.length) await server.releaseNext();
  assert.deepEqual(server.entries.map((entry) => entry.title), ['Playing now', 'Next']);
});

test('one write at a time; changes made meanwhile are sent together, newest last', async () => {
  const server = fakeServer({ hold: true });
  const { log } = makeLog(server);
  log.start(() => {});
  await server.releaseNext(); // the read
  log.handleNowPlaying(song('One'));
  log.handleNowPlaying(song('Two'));
  log.handleNowPlaying(song('Three'));
  await drain();
  assert.equal(server.waiting.length, 1);
  await server.releaseNext();
  assert.equal(server.waiting.length, 1, 'the changes made meanwhile share one write');
  await server.releaseNext();
  assert.equal(server.maxInFlight, 1);
  assert.deepEqual(server.posts.map((entries) => entries.length), [1, 3]);
  assert.deepEqual(server.entries.map((entry) => entry.title), ['One', 'Two', 'Three']);
});

test('a failed write is reported and the next song saves everything', async () => {
  const server = fakeServer();
  const { log, failures } = makeLog(server);
  log.start(() => {});
  await drain();
  server.failPosts = true;
  log.handleNowPlaying(song('One'));
  await drain();
  assert.equal(failures.length, 1);
  server.failPosts = false;
  log.handleNowPlaying(song('Two'));
  await drain();
  assert.deepEqual(server.entries.map((entry) => entry.title), ['One', 'Two']);
});

test('corrupt or unexpected saved data is ignored safely', async () => {
  for (const answer of [null, {}, { entries: 'x' }, { entries: {} }, { entries: [null, 7, 'x', [], {}] }]) {
    const server = fakeServer();
    server.getAnswer = answer;
    const { log } = makeLog(server);
    log.start(() => {});
    await drain();
    assert.deepEqual(log.entries(), []);
  }
  const mixed = [
    { title: 'no time' }, saved('Good'), { ...saved('Bad time'), time: -5 }, { ...saved('Fraction'), time: 1.5e12 + 0.4 },
    { ...saved(''), title: '' }, { ...saved('Number'), station: 5 }, { ...saved('<b>x</b>'), extra: '<script>' },
  ];
  assert.deepEqual(parseSongLogEntries(mixed).map((entry) => entry.title), ['Good', 'Fraction', 'Number', '<b>x</b>']);
  assert.equal(parseSongLogEntries(mixed)[2].station, '', 'a non-text station becomes empty text');
  assert.equal('extra' in parseSongLogEntries(mixed)[3], false);
  assert.equal(parseSongLogEntries(Array.from({ length: 600 }, (_, n) => saved(`S${n}`))).length, SONG_LOG_LIMIT);
});

test('untrusted text is kept as plain text, on one line, and bounded', () => {
  const markup = '<img src=x onerror="alert(1)"> & =SUM(A1)';
  const entry = makeSongLogEntry({ time: T0, station: markup, stationId: 'x', source: 'y', title: markup });
  assert.equal(entry.title, markup);
  assert.equal(entry.station, markup);
  assert.equal(cleanSongLogText('a\nb\tc\u2028d\u0000e\u202Ef', 50), 'a b c d ef');
  assert.equal(cleanSongLogText('bad \uD800 half', 50), 'bad \uFFFD half');
  assert.equal(Array.from(cleanSongLogText('\u{1F3B5}'.repeat(300), 200)).length, 200);
  const long = makeSongLogEntry({ time: T0, title: 't'.repeat(999), station: 's'.repeat(999), stationId: 'i'.repeat(999), source: 'o'.repeat(999) });
  assert.deepEqual([long.title.length, long.station.length, long.stationId.length, long.source.length], [200, 200, 300, 64]);
});

test('remove takes out exactly that entry and saves', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('One'));
  log.handleNowPlaying(song('Two'));
  log.handleNowPlaying(song('One', 'radio-browser:rock'));
  await drain();
  const [, two] = log.entries();
  assert.equal(await log.remove(two), true);
  assert.deepEqual(server.entries.map((entry) => entry.title), ['One', 'One']);
  assert.equal(await log.remove(two), false, 'already gone');
});

test('clear empties the log and the saved copy, also while the saved log is still being read', async () => {
  const server = fakeServer({ entries: [saved('Old')], hold: true });
  const { log } = makeLog(server);
  const changes = [];
  log.onChange((entries) => changes.push(entries.length));
  log.start(() => {});
  const cleared = log.clear();
  await drain();
  await server.releaseNext(); // the read: its old entries must not come back
  while (server.waiting.length) await server.releaseNext();
  assert.equal(await cleared, true);
  assert.deepEqual(log.entries(), []);
  assert.deepEqual(server.entries, []);
  assert.ok(changes.length > 0 && changes.every((count) => count === 0), 'the old songs never reappear');
});

const timedOut = () => new Promise((resolve) => setTimeout(resolve, 40));

test('a write that timed out and arrives late never undoes a newer one, in either order', async () => {
  for (const order of ['newer first', 'older first']) {
    const server = fakeServer({ hold: true });
    const { log, failures } = makeLog(server, { timeoutMs: 20 });
    log.start(() => {});
    await server.releaseNext(); // the read
    log.handleNowPlaying(song('One'));
    await timedOut(); // the page gives up on this write; the server has not seen it yet
    assert.equal(failures.length, 1);
    log.handleNowPlaying(song('Two', 'radio-browser:rock'));
    await drain();
    assert.equal(server.waiting.length, 2);
    if (order === 'newer first') {
      await server.release(1);
      await server.release(0); // the old [One] arrives late: not newer, not applied
      assert.deepEqual(server.applied, [1]);
    } else {
      await server.release(0); // the old [One] lands first
      await server.release(0); // the newer one is answered as stale and sent again
      await server.release(0);
      assert.deepEqual(server.applied, [1, 2]);
    }
    assert.deepEqual(titles(server.entries), ['One', 'Two'], order);
    assert.deepEqual(titles(log.entries()), ['One', 'Two']);
  }
});

test('a late older write after a clear does not bring songs back', async () => {
  for (const order of ['clear first', 'old write first']) {
    const server = fakeServer({ hold: true });
    const { log } = makeLog(server, { timeoutMs: 20 });
    log.start(() => {});
    await server.releaseNext(); // the read
    log.handleNowPlaying(song('One'));
    log.handleNowPlaying(song('Two'));
    await timedOut();
    const cleared = log.clear();
    await drain();
    if (order === 'clear first') {
      await server.release(server.waiting.length - 1);
      while (server.waiting.length) await server.release(0);
    } else {
      while (server.waiting.length) await server.release(0); // old write, stale clear, clear again
    }
    assert.equal(await cleared, true, order);
    assert.deepEqual(server.entries, [], order);
    assert.deepEqual(log.entries(), [], order);
  }
});

test('two windows on the same app merge each other\'s songs instead of overwriting them', async () => {
  const server = fakeServer();
  const first = makeLog(server).log;
  const second = makeLog(server).log;
  first.start(() => {});
  second.start(() => {});
  await drain();
  first.handleNowPlaying(song('A1', 'radio-browser:jazz', T0 + 1000));
  await drain();
  second.handleNowPlaying(song('B1', 'radio-browser:rock', T0 + 2000)); // second still thinks revision 0
  await drain();
  assert.deepEqual(titles(server.entries), ['A1', 'B1']);
  assert.deepEqual(titles(second.entries()), ['A1', 'B1'], 'the second window now shows the first one\'s song');
  first.handleNowPlaying(song('A2', 'radio-browser:jazz', T0 + 3000));
  await drain();
  assert.deepEqual(titles(server.entries), ['A1', 'B1', 'A2']);
  assert.deepEqual(titles(first.entries()), ['A1', 'B1', 'A2']);
  // A song one window removed stays removed when it merges the other's songs.
  await second.remove(second.entries().find((item) => item.title === 'B1'));
  assert.deepEqual(titles(server.entries), ['A1', 'A2']);
  assert.deepEqual(titles(second.entries()), ['A1', 'A2']);
});

test('an unreadable saved log gives one plain notice', async () => {
  const server = fakeServer();
  server.unreadable = true;
  const { log } = makeLog(server);
  assert.equal(log.readNotice, '');
  log.start(() => {});
  await drain();
  assert.equal(log.readNotice, SONG_LOG_UNREADABLE_NOTICE);
  assert.match(log.readNotice, /^[^<>]+$/);
  log.handleNowPlaying(song('First of the new log'));
  await drain();
  assert.deepEqual(titles(server.entries), ['First of the new log']);
});

test('a saved log that cannot be read right now is read again later, and nothing is written meanwhile', async () => {
  const server = fakeServer({ entries: [saved('Saved')], revision: 7 });
  server.failGets = true;
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  assert.deepEqual(server.posts, []);
  server.failGets = false;
  await log.load();
  assert.deepEqual(titles(log.entries()), ['Saved']);
  log.handleNowPlaying(song('New', 'radio-browser:rock'));
  await drain();
  assert.deepEqual(server.applied, [8]);
});

test('a failed clear puts the songs back so it can be tried again', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  log.handleNowPlaying(song('One'));
  log.handleNowPlaying(song('Two'));
  await drain();
  server.failPosts = true;
  const clearing = log.clear();
  assert.equal(log.size, 0, 'the list empties at once');
  await assert.rejects(clearing, /Disk full/);
  assert.deepEqual(titles(log.entries()), ['One', 'Two']);
  server.failPosts = false;
  assert.equal(await log.clear(), true);
  assert.deepEqual(log.entries(), []);
  assert.deepEqual(server.entries, []);
});

test('clear rejects when the saved copy could not be cleared', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.start(() => {});
  await drain();
  server.failPosts = true;
  await assert.rejects(log.clear(), /Disk full/);
});

test('a log that was never started stays in memory and sends nothing', async () => {
  const server = fakeServer();
  const { log } = makeLog(server);
  log.handleNowPlaying(song('One'));
  assert.equal(await log.clear(), true);
  assert.equal(server.gets + server.posts.length, 0);
});

test('Clear cache clears the app song log too', async () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    songLog.handleNowPlaying(song('Before clearing'));
    assert.equal(songLog.size, 1);
    await clearCache();
    assert.equal(songLog.size, 0);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test('the app song log listens on the state bus once started', async () => {
  const previousFetch = globalThis.fetch;
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:' };
  const bodies = [];
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 't' } }) };
    bodies.push([path, options.method, options.body]);
    const data = options.method === 'POST' ? { saved: true } : { entries: [] };
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  resetControlSession();
  try {
    const { startSongLog } = await import('../src/lib/song-log.js');
    startSongLog(subscribe, (itemId) => STATIONS[itemId] || null);
    await drain();
    emit(NOW_PLAYING_EVENT, song('From the bus'));
    for (let n = 0; n < 5; n += 1) await drain();
    assert.equal(songLog.entries().at(-1).station, 'Jazz FM');
    assert.deepEqual(bodies.map(([path, method]) => [path, method || 'GET']), [
      [SONG_LOG_ROUTE, 'GET'], [SONG_LOG_ROUTE, 'POST'],
    ]);
    assert.deepEqual(JSON.parse(bodies[1][2]).entries.map((entry) => entry.title), ['From the bus']);
    await songLog.clear();
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
    resetControlSession();
  }
});

test('Save to file sends only plain entries, newest first, and no path', async () => {
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 't' } }) };
    sent.push([path, options.method, JSON.parse(options.body)]);
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { name: 'WorldMedia-song-log-20261115-080000.csv', count: 2 } }) };
  };
  resetControlSession();
  try {
    const entries = [makeSongLogEntry(saved('Newest')), makeSongLogEntry(saved('Older'))];
    const result = await exportSongLog(entries);
    assert.equal(result.name, 'WorldMedia-song-log-20261115-080000.csv');
    assert.equal(sent[0][0], SONG_LOG_EXPORT_ROUTE);
    assert.equal(sent[0][1], 'POST');
    assert.deepEqual(Object.keys(sent[0][2]), ['entries']);
    assert.deepEqual(sent[0][2].entries.map((entry) => entry.title), ['Newest', 'Older']);
    assert.deepEqual(Object.keys(sent[0][2].entries[0]).sort(), ['source', 'station', 'stationId', 'time', 'title']);
  } finally {
    globalThis.fetch = previousFetch;
    resetControlSession();
  }
});

test('the song log is never a profile key, and the profile key lists match on both sides', async () => {
  const runtime = await readFile(new URL('../worldmedia_runtime.py', import.meta.url), 'utf8');
  const block = runtime.match(/PROFILE_TRANSFER_KEYS = frozenset\(\{([\s\S]*?)\}\)/);
  assert.ok(block, 'PROFILE_TRANSFER_KEYS found');
  const pythonKeys = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...PROFILE_STORAGE_KEYS].sort(), pythonKeys);
  for (const keys of [PROFILE_STORAGE_KEYS, pythonKeys]) {
    assert.equal(keys.some((key) => /song/i.test(key)), false);
  }
  const source = await readFile(new URL('../src/lib/song-log.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\blocalStorage\s*[.[]|profile-transfer\.js/, 'the song log stays out of the mirrored profile');
});

test('the save failure notice is plain text', () => {
  assert.match(SONG_LOG_SAVE_FAILED, /^[^<>]+$/);
});
