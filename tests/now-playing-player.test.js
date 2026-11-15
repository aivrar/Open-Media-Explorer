import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom } from './helpers/fake-dom.js';
import { subscribe } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { RECONNECTING_TEXT } from '../src/lib/live-resume.js';
import { NOW_PLAYING_EVENT, NOW_PLAYING_FIRST_POLL_MS, NOW_PLAYING_POLL_MS } from '../src/lib/now-playing.js';

const TEST_TIMEOUT_MS = 20_000;
const NOTE = '\u266A';

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

class FakeMediaMetadata {
  constructor(init = {}) { Object.assign(this, init); }
}

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ ok: !error, data, error }),
});

const mediaId = (index) => `song_media_${String(index).padStart(12, '0')}`;

function liveItem(id, overrides = {}) {
  return {
    id: `test-song:${id}`, title: `Station ${id}`, description: '', source: 'radio-browser',
    type: 'radio', stream_kind: 'audio', stream_url: `https://radio.example/${id}`,
    delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
    country: '', language: '',
    _extra: { streamCandidates: [] },
    ...overrides,
  };
}

async function setup(t) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    MediaMetadata: Object.getOwnPropertyDescriptor(globalThis, 'MediaMetadata'),
  };
  const { elements, document } = createPlayerDom();
  const net = { registrations: 0, titles: new Map(), polls: [], held: [], hold: false };
  const mediaSession = {
    playbackState: 'none', metadata: 'metadata-before-song', setActionHandler() {},
  };
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
  Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, writable: true, value: FakeMediaMetadata });
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'song-token' });
    if (path === '/api/v1/media/register') {
      net.registrations++;
      const id = mediaId(net.registrations);
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    const match = String(path).match(/^\/api\/v1\/media\/([A-Za-z0-9_-]+)\/now-playing$/);
    if (match) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['X-WorldMedia-Token'], 'song-token');
      net.polls.push(match[1]);
      const answer = () => envelope(200, net.titles.get(match[1]) || { title: null, changed_at: null });
      if (net.hold) return new Promise((resolve) => net.held.push({ id: match[1], resolve: () => resolve(answer()) }));
      return answer();
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  const events = [];
  const unsubscribe = subscribe(NOW_PLAYING_EVENT, (payload) => events.push(payload));
  let player = null;
  t.after(() => {
    unsubscribe();
    try { player?.stop(); } catch (_) {}
    while (net.held.length) net.held.shift().resolve();
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator', 'MediaMetadata']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?nowPlaying=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const audio = elements['audio-el'];
  const source = elements['player-source'];
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const progress = (seconds = 1.5) => {
    for (let moved = 0; moved < seconds; moved += 0.5) {
      audio.currentTime += 0.5;
      audio.emit('timeupdate');
    }
  };
  return { player, elements, audio, source, net, mediaSession, events, tick, progress };
}

test('a playing station shows its song with the source line on hover, and Stop ends it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, mediaSession, events, tick } = await setup(t);
  await player.playItem(liveItem('a'));
  await settle();
  const normalLine = source.textContent;
  assert.ok(normalLine, 'the normal source line');
  assert.equal(source.title, '');

  net.titles.set(mediaId(1), { title: 'Artist - Song', changed_at: 1_700_000_000 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls, [mediaId(1)]);
  assert.equal(source.textContent, `${NOTE} Artist - Song`);
  assert.equal(source.title, `${NOTE} Artist - Song\n${normalLine}`);
  assert.ok(mediaSession.metadata instanceof FakeMediaMetadata);
  assert.equal(mediaSession.metadata.title, 'Artist - Song');
  assert.equal(mediaSession.metadata.artist, 'Station a');
  assert.deepEqual(events, [{
    itemId: 'test-song:a', mediaId: mediaId(1), title: 'Artist - Song', changedAt: 1_700_000_000_000,
  }]);
  assert.deepEqual(player.getNowPlaying(), events[0]);

  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(net.polls.length, 2);
  assert.equal(events.length, 1, 'no event without a change');

  // The station stops announcing: the meta line is exactly as before.
  net.titles.set(mediaId(1), { title: null, changed_at: null });
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.textContent, normalLine);
  assert.equal(source.title, '');
  assert.equal(mediaSession.metadata, 'metadata-before-song');
  assert.equal(events.at(-1).title, null);

  net.titles.set(mediaId(1), { title: 'Second', changed_at: 1_700_000_100 });
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Second`);
  player.stop();
  assert.equal(mediaSession.metadata, 'metadata-before-song');
  assert.equal(events.at(-1).title, null);
  assert.equal(player.getNowPlaying(), null);
  const polls = net.polls.length;
  await tick(60_000);
  assert.equal(net.polls.length, polls, 'no polling after Stop');
});

test('pause stops polling and clears the song; Play brings it back', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick } = await setup(t);
  await player.playItem(liveItem('p'));
  await settle();
  const normalLine = source.textContent;
  net.titles.set(mediaId(1), { title: 'Paused Song', changed_at: 5 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Paused Song`);

  await player.togglePlay();
  assert.equal(audio.paused, true);
  assert.equal(source.textContent, normalLine);
  const polls = net.polls.length;
  await tick(30_000);
  assert.equal(net.polls.length, polls);

  await player.togglePlay();
  await settle();
  assert.equal(audio.paused, false);
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.polls.length, polls + 1);
  assert.equal(source.textContent, `${NOTE} Paused Song`);
  player.stop();
});

test('switching stations follows the new token and a late reply for the old one is ignored', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, events, tick } = await setup(t);
  await player.playItem(liveItem('old'));
  await settle();
  net.titles.set(mediaId(1), { title: 'Old Song', changed_at: 1 });
  net.hold = true;
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.held.length, 1);

  await player.playItem(liveItem('new'));
  await settle();
  const newLine = source.textContent;
  net.held.shift().resolve();
  await settle();
  assert.equal(source.textContent, newLine);
  assert.deepEqual(events, []);

  net.hold = false;
  net.titles.set(mediaId(2), { title: 'New Song', changed_at: 2 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls, [mediaId(1), mediaId(2)]);
  assert.equal(source.textContent, `${NOTE} New Song`);
  assert.deepEqual(events.map((event) => [event.itemId, event.title]), [['test-song:new', 'New Song']]);
  player.stop();
});

test('a switch, Play or Stop drops the song before any await, so a pending poll cannot leak', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, mediaSession, events, tick } = await setup(t);
  for (const action of ['switch', 'replay', 'stop']) {
    await player.playItem(liveItem(`${action}-old`));
    await settle();
    const oldId = mediaId(net.registrations);
    net.titles.set(oldId, { title: `Old ${action}`, changed_at: 1 });
    await tick(NOW_PLAYING_FIRST_POLL_MS);
    assert.equal(mediaSession.metadata.title, `Old ${action}`);
    net.titles.set(oldId, { title: `Late ${action}`, changed_at: 2 });
    net.hold = true;
    await tick(NOW_PLAYING_POLL_MS);
    assert.equal(net.held.length, 1, 'a poll for the old station is on its way');
    const eventsBefore = events.length;

    // Not awaited: everything below must already hold synchronously.
    const pending = action === 'switch' ? player.playItem(liveItem(`${action}-new`))
      : action === 'replay' ? player.playItem(liveItem(`${action}-old`))
        : (player.stop(), Promise.resolve());
    assert.equal(player.getNowPlaying(), null);
    assert.equal(mediaSession.metadata, 'metadata-before-song');
    assert.equal(source.textContent.startsWith(NOTE), false);
    assert.equal(events.at(-1).title, null);

    net.held.shift().resolve(); // the old reply arrives while the new start is still awaiting
    await pending;
    await settle();
    net.hold = false;
    assert.equal(mediaSession.metadata, 'metadata-before-song');
    assert.equal(source.textContent.includes('Late'), false);
    assert.equal(events.slice(eventsBefore).some((event) => event.title), false);
  }
});

test('a reconnect status takes priority, polling waits, and the song returns on the new token', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('r'));
  await settle();
  progress();
  net.titles.set(mediaId(1), { title: 'Before Drop', changed_at: 1 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Before Drop`);

  audio.emit('error');
  await settle();
  assert.equal(source.textContent, RECONNECTING_TEXT, 'the status, not the song');
  assert.equal(source.title, RECONNECTING_TEXT);
  const polls = net.polls.length;
  net.titles.set(mediaId(2), { title: 'After Reconnect', changed_at: 2 });
  await tick(1_999);
  assert.equal(net.polls.length, polls, 'no polling while waiting to reconnect');
  await tick(1); // the reconnect attempt: a new registration and relay token
  assert.equal(net.registrations, 2);
  assert.notEqual(source.textContent, RECONNECTING_TEXT);
  progress();
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls.slice(polls), [mediaId(2)]);
  assert.equal(source.textContent, `${NOTE} After Reconnect`);
  player.stop();
});

test('errors stop polling, and on-demand or video items are never polled', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick } = await setup(t);
  await player.playItem(liveItem('dead'));
  await settle();
  audio.emit('error'); // never played: the plain broken state
  await settle();
  assert.equal(source.textContent, 'Playback error');
  await tick(30_000);
  assert.deepEqual(net.polls, []);

  await player.playItem(liveItem('vod', { delivery: 'on-demand', stream_url: 'https://media.example/show.mp3' }));
  await settle();
  await tick(30_000);
  await player.playItem(liveItem('tv', { type: 'tv', stream_kind: 'video', stream_url: 'https://tv.example/live.mp4' }));
  await settle();
  await tick(30_000);
  assert.deepEqual(net.polls, []);

  // Undeclared delivery counts once the element reports an unbounded stream.
  await player.playItem(liveItem('unknown', { delivery: 'unknown' }));
  await settle();
  await tick(30_000);
  assert.deepEqual(net.polls, []);
  audio.duration = Infinity;
  audio.emit('durationchange');
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.polls.length, 1);
  audio.duration = Number.NaN;
  player.stop();
});

test('station text is shown as plain text only', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, source, net, mediaSession, tick } = await setup(t);
  await player.playItem(liveItem('x'));
  await settle();
  net.titles.set(mediaId(1), { title: '<img src=x onerror=alert(1)>\u0007 Song\u202E', changed_at: 1 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} <img src=x onerror=alert(1)> Song`);
  assert.equal(mediaSession.metadata.title, '<img src=x onerror=alert(1)> Song');
  for (const element of Object.values(elements)) {
    assert.equal(Object.hasOwn(element, 'innerHTML'), false);
    assert.equal(Object.hasOwn(element, 'outerHTML'), false);
  }
  player.stop();
});
