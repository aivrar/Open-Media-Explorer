import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNowPlayingPoller, normalizeSongTitle, songLine, MAX_SONG_TITLE_CHARS,
  NOW_PLAYING_FIRST_POLL_MS, NOW_PLAYING_POLL_MS, SONG_MARK,
} from '../src/lib/now-playing.js';

const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A manual clock: timers run only when advance() passes their deadline. */
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    get pending() { return timers.size; },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}

/** Requests answered from `titles`, or held until released. */
function fakeServer() {
  const server = {
    titles: new Map(), calls: [], held: [], hold: false, fail: false,
    async fetchTitle(mediaId, options = {}) {
      server.calls.push({ mediaId, signal: options.signal });
      if (server.fail) throw new TypeError('Failed to fetch');
      const answer = () => server.titles.get(mediaId) || { title: null, changed_at: null };
      if (server.hold) {
        return new Promise((resolve) => { server.held.push({ mediaId, resolve: (value) => resolve(value ?? answer()) }); });
      }
      return answer();
    },
  };
  return server;
}

function setup(overrides = {}) {
  const clock = fakeClock();
  const server = fakeServer();
  const changes = [];
  const poller = createNowPlayingPoller({
    fetchTitle: server.fetchTitle,
    onChange: (state) => changes.push(state),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...overrides,
  });
  return { clock, server, changes, poller };
}

test('follows a token: first poll after a short delay, then every 5 s, events only on change', async () => {
  const { clock, server, changes, poller } = setup();
  server.titles.set('m1', { title: 'Artist - Song', changed_at: 1_700_000_000.5 });
  poller.follow('m1', { itemId: 'radio:a' });
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS - 1);
  assert.equal(server.calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(server.calls.map((call) => call.mediaId), ['m1']);
  assert.deepEqual(changes, [{
    itemId: 'radio:a', mediaId: 'm1', title: 'Artist - Song', changedAt: 1_700_000_000_500,
  }]);
  assert.deepEqual(poller.state, changes[0]);

  await clock.advance(NOW_PLAYING_POLL_MS);
  assert.equal(server.calls.length, 2);
  assert.equal(changes.length, 1, 'the same title again is not a change');

  poller.follow('m1', { itemId: 'radio:a' }); // already following: nothing restarts
  await clock.advance(NOW_PLAYING_POLL_MS - 1);
  assert.equal(server.calls.length, 2);
  await clock.advance(1);
  assert.equal(server.calls.length, 3);

  server.titles.set('m1', { title: null, changed_at: null });
  await clock.advance(NOW_PLAYING_POLL_MS);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].title, null);
  assert.equal(changes[1].changedAt, clock.now());
  poller.stop();
  assert.equal(changes.length, 2, 'stopping with no title reports nothing');
  assert.equal(clock.pending, 0);
});

test('stop ends polling, aborts the request in flight and reports the title gone', async () => {
  const { clock, server, changes, poller } = setup();
  server.titles.set('m1', { title: 'Song', changed_at: 10 });
  poller.follow('m1', { itemId: 'a' });
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS);
  server.hold = true;
  await clock.advance(NOW_PLAYING_POLL_MS);
  assert.equal(server.held.length, 1);
  poller.stop();
  assert.equal(server.calls[1].signal.aborted, true);
  assert.deepEqual(changes.map((change) => change.title), ['Song', null]);
  assert.equal(changes[1].mediaId, 'm1');
  assert.equal(changes[1].itemId, 'a');
  server.held.shift().resolve({ title: 'Late', changed_at: 11 });
  await settle();
  await clock.advance(60_000);
  assert.equal(server.calls.length, 2);
  assert.equal(changes.length, 2);
  assert.equal(poller.state, null);
  assert.equal(clock.pending, 0);
});

test('switching ignores a late reply for the previous token and follows the new one', async () => {
  const { clock, server, changes, poller } = setup();
  server.hold = true;
  poller.follow('old', { itemId: 'a' });
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(server.held.length, 1);
  poller.follow('new', { itemId: 'b' });
  server.held.shift().resolve({ title: 'Old station song', changed_at: 1 });
  await settle();
  assert.deepEqual(changes, []);
  server.hold = false;
  server.titles.set('new', { title: 'New station song', changed_at: 2 });
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(server.calls.map((call) => call.mediaId), ['old', 'new']);
  assert.deepEqual(changes.map((change) => [change.mediaId, change.title]), [['new', 'New station song']]);

  // Switching away from a station with a title reports it gone first.
  poller.follow('third', { itemId: 'c' });
  assert.deepEqual(changes.at(-1), { itemId: 'b', mediaId: 'new', title: null, changedAt: clock.now() });
  poller.follow('');
  assert.equal(poller.state, null);
});

test('a failed poll keeps the last title and polling goes on', async () => {
  const { clock, server, changes, poller } = setup();
  server.titles.set('m1', { title: 'Kept', changed_at: 5 });
  poller.follow('m1');
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS);
  server.fail = true;
  await clock.advance(NOW_PLAYING_POLL_MS);
  assert.equal(poller.state.title, 'Kept');
  server.fail = false;
  server.titles.set('m1', { title: 'Next', changed_at: 6 });
  await clock.advance(NOW_PLAYING_POLL_MS);
  assert.deepEqual(changes.map((change) => change.title), ['Kept', 'Next']);
  poller.stop();
});

test('a listener that throws or stops polling from inside the event is safe', async () => {
  let poller = null;
  const clock = fakeClock();
  const calls = [];
  poller = createNowPlayingPoller({
    fetchTitle: async (mediaId) => { calls.push(mediaId); return { title: 'Song', changed_at: 1 }; },
    onChange: (state) => {
      if (state.title) poller.stop();
      throw new Error('listener failed');
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  poller.follow('m1');
  await clock.advance(NOW_PLAYING_FIRST_POLL_MS);
  await clock.advance(60_000);
  assert.deepEqual(calls, ['m1']);
  assert.equal(clock.pending, 0);
});

test('titles are one plain line of at most 200 characters', () => {
  assert.equal(normalizeSongTitle('  A\u0007B\nC\tD\u0000E  '), 'A B C D E');
  assert.equal(normalizeSongTitle('Safe\u202Eevil\u200B\uFEFF'), 'Safeevil');
  assert.equal(normalizeSongTitle('<b>Bold</b> & "quoted"'), '<b>Bold</b> & "quoted"');
  assert.equal(normalizeSongTitle(42), '');
  assert.equal(normalizeSongTitle(null), '');
  assert.equal(normalizeSongTitle('x'.repeat(500)).length, MAX_SONG_TITLE_CHARS);
  const emoji = normalizeSongTitle('\u{1F3B5}'.repeat(300));
  assert.equal(Array.from(emoji).length, MAX_SONG_TITLE_CHARS, 'never cuts a character in half');
  assert.equal(songLine('Song'), `${SONG_MARK} Song`);
  assert.equal(SONG_MARK, '\u266A');
});
