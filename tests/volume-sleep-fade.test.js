import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

/** As in a browser: changing volume or muted queues a volumechange. */
function emitVolumeChanges(el) {
  let volume = el.volume;
  let muted = el.muted;
  const queue = () => queueMicrotask(() => el.emit('volumechange'));
  Object.defineProperty(el, 'volume', {
    configurable: true, get: () => volume, set: (value) => { if (value !== volume) { volume = value; queue(); } },
  });
  Object.defineProperty(el, 'muted', {
    configurable: true, get: () => muted, set: (value) => { if (value !== muted) { muted = value; queue(); } },
  });
}

/** The sleep timer's host, as in sleep-timer-menu.test.js. */
function sleepHost() {
  const host = new FakeElement('sleep-timer');
  const select = new FakeElement('sleep-select', 'select');
  select.value = '0';
  const parts = {
    '[data-role="select"]': select,
    '[data-role="display"]': new FakeElement('', 'span'),
    '[data-role="custom-running"]': new FakeElement('', 'option'),
  };
  let markup = '';
  Object.defineProperty(host, 'innerHTML', { get: () => markup, set: (value) => { markup = value; } });
  Object.defineProperty(host, 'firstChild', { get: () => (markup ? select : null) });
  host.querySelector = (selector) => parts[selector] ?? null;
  return { host, select };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the volume and the sleep-timer fade: a level set while it fades is the one that comes back, mute follows the video, and a fade to the end changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_795_000_000_000 });
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, storage: globalThis.localStorage,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
  };
  let player;
  t.after(() => {
    player?.stop();
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.localStorage = previous.storage;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
  });
  const { elements, document } = createPlayerDom();
  const { host, select } = sleepHost();
  document.register(host);
  globalThis.document = document;
  globalThis.window = {};
  globalThis.localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaSession: { playbackState: 'none', setActionHandler() {} } },
  });
  const audio = elements['audio-el'];
  const video = elements['video-el'];
  emitVolumeChanges(audio);
  emitVolumeChanges(video);

  globalThis.fetch = async (path) => {
    let data;
    if (path === '/api/v1/session') data = { token: 'sleep-fade-test' };
    else if (path === '/api/v1/media/register') {
      data = { media_id: 'sleep_fade_video', relay_url: '/api/v1/media/sleep_fade_video' };
    } else if (path === '/api/v1/media/sleep_fade_video/expire') data = { expired: true };
    else assert.fail('Unexpected request: ' + path);
    return Response.json({ ok: true, data });
  };
  player = await import(`../src/lib/player.js?sleepFade=${Date.now()}`);
  const { initSleepTimer } = await import(`../src/lib/sleep-timer.js?sleepFade=${Date.now()}`);
  const { loadVolume, subscribe } = await import('../src/lib/state.js');
  player.initPlayer();
  initSleepTimer();
  await player.playItem({
    id: 'playlist:sleep-video', source: 'playlist', title: 'Test video', type: 'video',
    delivery: 'on-demand', stream_kind: 'video', stream_url: 'https://media.example/test.mp4',
    _extra: { streamCandidates: [] },
  });
  await flush();
  assert.equal(video.paused, false);
  assert.equal(audio.paused, true);
  const silenceChanges = [];
  const unsubscribe = subscribe(player.PLAYER_SILENT_CHANGE, (silent) => silenceChanges.push(silent));
  t.after(unsubscribe);
  const group = elements['player-volume-control'];
  const choose = (value) => { select.value = value; select.dispatchEvent(new Event('change')); };
  const key = (name) => group.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: name }));
  const shows = (level, label) => {
    assert.equal(elements['player-volume'].value, String(level), `${label}: the store`);
    assert.equal(elements['player-volume-readout'].textContent, String(level), `${label}: the readout`);
    assert.equal(loadVolume(), level, `${label}: saved`);
  };

  player.setVolume(80);
  await flush();
  shows(80, 'start');

  key('Home');
  await flush();
  shows(0, 'compact volume at zero');
  assert.equal(player.isPlayerSilent(), true);
  elements['player-volume-up'].dispatchEvent(new Event('click'));
  await flush();
  shows(1, 'compact volume raised from zero');
  assert.equal(player.isPlayerSilent(), false);
  elements['player-mute'].dispatchEvent(new Event('click'));
  await flush();
  assert.equal(player.isPlayerSilent(), true);
  elements['player-mute'].dispatchEvent(new Event('click'));
  await flush();
  assert.equal(player.isPlayerSilent(), false);
  video.volume = 0;
  await flush();
  shows(0, 'native video volume at zero');
  video.volume = 0.8;
  await flush();
  shows(80, 'native video volume restored');
  assert.deepEqual(silenceChanges.splice(0), [true, false, true, false, true, false]);

  // 1. Sleep in 1 minute; the fade starts 10 s before the end.
  choose('1');
  t.mock.timers.tick(50_000);
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(audio.dataset.preFadeVol, '0.8');
  assert.ok(Math.abs(audio.volume - 0.64) < 1e-9, `fading: ${audio.volume}`);
  shows(80, 'the fade is not the user\'s volume');
  key('Home');
  await flush();
  shows(0, 'Home changes the saved level during the fade');
  assert.equal(player.isPlayerSilent(), false, 'the active video is still at the fade level');
  assert.deepEqual(silenceChanges, [], 'ordinary fade steps and changing the saved level emit nothing');

  video.volume = 0;
  await flush();
  assert.ok(audio.volume > 0, 'the inactive audio element still has volume');
  assert.equal(player.isPlayerSilent(), true);
  video.volume = 0.003;
  await flush();
  shows(0, 'native volume during the fade leaves the saved level alone');
  assert.equal(player.isPlayerSilent(), false, 'any positive volume on the active video is audible');
  video.volume = 0.25;
  await flush();
  assert.deepEqual(silenceChanges.splice(0), [true, false], 'only crossing effective zero changes silence');

  // The user sets the saved level to 50 while it fades.
  player.setVolume(50);
  await flush();
  shows(50, 'set during the fade');
  assert.equal(audio.dataset.preFadeVol, '0.5');
  assert.equal(video.dataset.preFadeVol, '0.5');
  // The fade keeps the live volume going down.
  t.mock.timers.tick(2_000);
  await flush();
  assert.ok(audio.volume < 0.64);
  shows(50, 'still fading');
  // Cancelled: the user's 50 comes back everywhere, not the 80 it started at.
  choose('0');
  await flush();
  assert.equal(audio.dataset.preFadeVol, undefined);
  assert.equal(audio.volume, 0.5);
  assert.equal(video.volume, 0.5);
  shows(50, 'after the cancel');

  // 2. The video's own mute button while it fades: the player's mute follows.
  choose('1');
  t.mock.timers.tick(55_000);
  await flush();
  assert.ok(video.dataset.preFadeVol);
  video.muted = true;
  await flush();
  assert.equal(elements['player-mute'].getAttribute('aria-pressed'), 'true');
  assert.equal(elements['player-mute'].dataset.silent, 'true');
  assert.equal(audio.muted, true);
  video.muted = false;
  await flush();
  assert.equal(elements['player-mute'].getAttribute('aria-pressed'), 'false');
  assert.equal(audio.muted, false);
  shows(50, 'mute during the fade');
  choose('0');
  await flush();
  shows(50, 'second cancel');
  assert.deepEqual(silenceChanges.splice(0), [true, false], 'native mute and unmute reach shared listeners');

  // 3. A fade that runs to its end: playback stops, the volume comes back,
  // and the store and the saved volume are as they were.
  assert.equal(video.paused, false);
  choose('1');
  t.mock.timers.tick(50_000); // the fade begins
  t.mock.timers.tick(10_000); // and runs out
  await flush();
  assert.equal(select.value, '0');
  assert.equal(video.paused, true);
  assert.equal(audio.dataset.preFadeVol, undefined);
  assert.equal(audio.volume, 0.5);
  assert.equal(video.volume, 0.5);
  shows(50, 'after the fade ran out');
  assert.deepEqual(silenceChanges, [], 'the volume is restored at fade completion');
  assert.equal(elements['player-mute'].getAttribute('aria-pressed'), 'false');
});
