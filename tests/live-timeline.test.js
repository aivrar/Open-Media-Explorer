import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom, FakeElement } from './helpers/fake-dom.js';
import { LIVE_GROWTH, hasSeekableLength, mediaTimeline, trackLengthGrowth } from '../src/lib/player.js';
import Hls from '../src/vendor/hls.js';
import { createDashPlayback } from '../src/lib/dash-player.js';
import { playClock } from '../src/lib/play-clock.js';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

test.after(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

const LIVE = { live: true, seekable: false };
const RECORDING = { live: false, seekable: true };

/** The track after lengths reported at the given times: [[seconds, ms], ...]. */
function grownThrough(reports) {
  return reports.reduce((track, [length, at]) => trackLengthGrowth(track, length, at), null);
}

test('an item listed as on demand is never live, whatever hls.js or dash.js report', () => {
  assert.deepEqual(mediaTimeline({ duration: 3906, delivery: 'on-demand', type: 'video', hlsLive: true }), RECORDING);
  assert.deepEqual(mediaTimeline({ duration: 2710, delivery: 'on-demand', type: 'audio', dashLive: true }), RECORDING);
  assert.deepEqual(mediaTimeline({ duration: 1800, delivery: 'on-demand', type: 'tv', durationGrowing: true }), RECORDING);
});

test('an item listed as live and played by hls.js or dash.js is live from the start until they say it is a complete recording', () => {
  // While hls.js and dash.js have not said yet: no seek bar at any moment.
  assert.deepEqual(mediaTimeline({ duration: Number.NaN, delivery: 'live', type: 'tv' }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 149.8, delivery: 'live', type: 'tv' }), LIVE);
  // A radio or TV station without a delivery listed is listed as live too.
  assert.deepEqual(mediaTimeline({ duration: 600, delivery: 'unknown', type: 'radio' }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 7200, delivery: 'live', type: 'tv', hlsLive: true }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 7200, delivery: 'live', type: 'tv', dashLive: true }), LIVE);
  // Their word that it is complete gives it a seek bar.
  assert.deepEqual(mediaTimeline({ duration: 5400, delivery: 'live', type: 'tv', hlsLive: false }), RECORDING);
  assert.deepEqual(mediaTimeline({ duration: 4000, delivery: 'live', type: 'tv', dashLive: false }), RECORDING);
});

test('an item listed as live and played directly is live while its length is unknown, endless or growing, and a recording with a set length', () => {
  const direct = { delivery: 'live', type: 'radio', direct: true };
  assert.deepEqual(mediaTimeline({ ...direct, duration: Number.NaN }), LIVE);
  assert.deepEqual(mediaTimeline({ ...direct, duration: Infinity }), LIVE);
  assert.deepEqual(mediaTimeline({ ...direct, duration: 167, durationGrowing: true }), LIVE);
  // A playlist entry listed as a station that points at an MP3.
  assert.deepEqual(mediaTimeline({ ...direct, duration: 245.3 }), RECORDING);
  assert.deepEqual(mediaTimeline({ ...direct, type: 'tv', duration: 3600 }), RECORDING);
});

test('an item listed neither way follows hls.js and dash.js, an endless length, or a length that keeps growing', () => {
  assert.deepEqual(mediaTimeline({ duration: 149.8, type: 'video', hlsLive: true }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 4000, type: 'video', dashLive: true }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 4000, type: 'video', hlsLive: false, durationGrowing: true }), RECORDING);
  assert.deepEqual(mediaTimeline({ duration: Infinity, type: 'audio' }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 167, type: 'video', durationGrowing: true }), LIVE);
  assert.deepEqual(mediaTimeline({ duration: 125, type: 'video' }), RECORDING);
  assert.deepEqual(mediaTimeline({ duration: Number.NaN, type: 'video' }), { live: false, seekable: false });
  assert.equal(hasSeekableLength(125), true);
});

test('a length counts as growing only after three separate updates over 10 s that keep pace with the clock', () => {
  assert.deepEqual(LIVE_GROWTH, { steps: 3, spanMs: 10_000, minStepSeconds: 0.5, minPace: 0.5, maxPace: 2 });
  // A file corrected upward once by 5 s, or twice, is not growing.
  assert.equal(grownThrough([[300, 0], [305, 2_000]]).growing, false);
  assert.equal(grownThrough([[300, 0], [305, 2_000], [309, 30_000]]).growing, false);
  // A live list whose end moves on with each 6 s segment is.
  assert.equal(grownThrough([[30, 0], [36, 6_000], [42, 12_000]]).growing, false, 'two steps are not enough');
  assert.equal(grownThrough([[30, 0], [36, 6_000], [42, 12_000], [48, 18_000]]).growing, true);
  // Three quick corrections within a few seconds: not over 10 s.
  assert.equal(grownThrough([[30, 0], [36, 1_000], [42, 2_000], [48, 3_000]]).growing, false);
  // Growth far beyond the time that passed (an estimate refined while a
  // file downloads), or far below it: not keeping pace.
  assert.equal(grownThrough([[100, 0], [400, 5_000], [800, 10_000], [1200, 15_000]]).growing, false);
  assert.equal(grownThrough([[100, 0], [101, 10_000], [102, 20_000], [103, 30_000]]).growing, false);
  // Changes below half a second are not steps; a shorter length starts again.
  assert.equal(grownThrough([[30, 0], [30.2, 6_000], [30.4, 12_000], [30.6, 18_000]]).growing, false);
  assert.equal(grownThrough([[30, 0], [36, 6_000], [20, 7_000], [26, 13_000], [32, 19_000]]).growing, false);
  // Once growing, it stays so for that start; unknown lengths change nothing.
  const growing = grownThrough([[30, 0], [36, 6_000], [42, 12_000], [48, 18_000]]);
  assert.equal(trackLengthGrowth(growing, 48, 19_000).growing, true);
  assert.equal(trackLengthGrowth(null, Number.NaN, 0), null);
});

test('the DASH session tells whether dash.js plays a live stream, and nothing while it cannot tell', async () => {
  let dynamic = true;
  let ready = false;
  const player = {
    initialize() {},
    on() {},
    off() {},
    destroy() {},
    isDynamic() {
      if (!ready) throw new Error('not initialized');
      return dynamic;
    },
  };
  const library = { MediaPlayer: Object.assign(() => ({ create: () => player }), { events: { ERROR: 'error' } }) };
  const session = await createDashPlayback({}, '/api/v1/media/dash_test_token_1234567890', { library });
  assert.equal(session.isLive(), null);
  ready = true;
  assert.equal(session.isLive(), true);
  dynamic = false;
  assert.equal(session.isLive(), false);
});

function apiResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** An item listed neither way: no delivery, and an address without a file
 *  name ending (one ending ".mp4" would be taken as on demand). */
function item(id, overrides) {
  return {
    id, title: id, source: 'internet-archive', type: 'video', delivery: 'unknown', stream_kind: 'video',
    stream_url: `https://media.example/play/${id.replace(/\W/g, '-')}`, thumbnail: '', country: '', language: '',
    ...overrides,
  };
}

test('in the player bar: live radio never shows a seek bar, a playlist MP3 listed as a station gets one, growing streams stay live, a corrected file keeps it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: 1_795_228_000_000 });
  const { elements, document } = createPlayerDom();
  const pictureSlot = document.register(new FakeElement('player-picture-slot'));
  pictureSlot.setAttribute('inert', '');
  for (const id of [
    'picture-panel', 'picture-scope', 'picture-scope-channel', 'picture-fit', 'picture-session-note',
    'picture-feedback', 'picture-brightness', 'picture-contrast', 'picture-saturation', 'picture-hue', 'picture-reset',
  ]) document.register(new FakeElement(id));
  globalThis.document = document;
  globalThis.window = {};
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return apiResponse(200, { ok: true, data: { token: 'timeline-session' }, error: null });
    if (path === '/api/v1/media/register' && options.method === 'POST') {
      return apiResponse(201, {
        ok: true,
        data: { media_id: 'timeline_media_1234567890', relay_url: '/api/v1/media/timeline_media_1234567890' },
        error: null,
      });
    }
    if (String(path).endsWith('/expire')) return apiResponse(202, { ok: true, data: { state: 'expired' }, error: null });
    if (options.headers?.Range && String(path).startsWith('/api/v1/media/')) {
      return new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const player = await import(`../src/lib/player.js?timeline=${Date.now()}`);
  player.initPlayer();
  const video = elements['video-el'];
  const seekShown = () => !elements['player-seek'].classList.contains('is-no-length');
  const nativeTimelineHidden = () => video.classList.contains('is-live-video');
  const report = (length, position) => {
    video.duration = length;
    if (position !== undefined) video.currentTime = position;
    video.emit('durationchange');
    video.emit('timeupdate');
  };

  // Live radio: no length, never a seek bar, the time played.
  const radio = item('radio-browser:timeline-radio', { source: 'radio-browser', type: 'radio', delivery: 'live', stream_kind: 'audio' });
  await player.playItem(radio);
  const audio = elements['audio-el'];
  assert.equal(seekShown(), false, 'live from the start');
  assert.equal(nativeTimelineHidden(), false, 'live audio leaves the video class unset');
  assert.equal(pictureSlot.hasAttribute('inert'), true, 'audio keeps Picture out of the focus order');
  audio.duration = Infinity;
  audio.currentTime = 4000;
  audio.emit('durationchange');
  audio.emit('timeupdate');
  assert.equal(seekShown(), false);
  assert.equal(elements['player-dur'].classList.contains('is-no-length'), true);
  assert.equal(elements['player-seek'].disabled, true);
  const played = playClock.played(radio.id);
  const shownSeconds = played == null ? 0 : Math.floor(played / 1000);
  assert.equal(elements['player-time'].textContent, `0:${String(shownSeconds).padStart(2, '0')}`, 'the time played');

  // A playlist entry listed as a live station that points at an MP3: once
  // its length is known it is a recording, with its seek bar, and it moves.
  const entry = item('playlist:timeline-entry', {
    source: 'playlist', type: 'radio', delivery: 'live', stream_kind: 'audio',
    stream_url: 'https://media.example/shows/episode-12.mp3',
  });
  audio.duration = Number.NaN; // a new source: the length is not known yet
  await player.playItem(entry);
  assert.equal(seekShown(), false, 'no seek bar before the length is known');
  audio.duration = 245.3;
  audio.currentTime = 10;
  audio.emit('durationchange');
  audio.emit('timeupdate');
  assert.equal(seekShown(), true);
  assert.equal(elements['player-seek'].disabled, false);
  assert.equal(elements['player-seek'].max, '245');
  assert.equal(elements['player-dur'].textContent, '4:05');
  assert.equal(elements['player-time'].textContent, '0:10');
  elements['player-seek'].value = '120';
  elements['player-seek'].dispatchEvent(new Event('input'));
  assert.equal(audio.currentTime, 120, 'moved along');
  elements['player-seek'].dispatchEvent(new Event('change'));

  // A live TV channel played directly whose length keeps growing: live once
  // that is known, and it stays so with every later length.
  const channel = item('iptv-org:timeline-tv', { source: 'iptv-org', type: 'tv', delivery: 'live' });
  await player.playItem(channel);
  assert.equal(nativeTimelineHidden(), true, 'live TV starts without native seeking');
  assert.equal(pictureSlot.hasAttribute('inert'), false);
  report(30, 1795228000); // the channel's own clock: a position no listener means
  for (let step = 1; step <= 3; step += 1) {
    t.mock.timers.tick(6_000);
    report(30 + 6 * step);
  }
  assert.equal(seekShown(), false, 'growing: live');
  assert.equal(nativeTimelineHidden(), true);
  t.mock.timers.tick(6_000);
  report(54);
  t.mock.timers.tick(60_000);
  report(54);
  assert.equal(seekShown(), false, 'stays live');
  assert.notEqual(elements['player-time'].textContent, '498674:13:20');

  // A channel listed as live that plays a finite video file gets its seek controls back.
  video.duration = Number.NaN;
  await player.playItem({ ...channel, id: 'iptv-org:finite-tv' });
  assert.equal(nativeTimelineHidden(), true);
  report(150, 8);
  assert.equal(nativeTimelineHidden(), false);
  assert.equal(seekShown(), true);

  // A file listed neither way, its length corrected upward once by 5 s.
  await player.playItem(item('internet-archive:timeline-file', {}));
  report(300, 65);
  t.mock.timers.tick(2_000);
  report(305);
  assert.equal(seekShown(), true);
  assert.equal(elements['player-time'].textContent, '1:05');
  assert.equal(elements['player-dur'].textContent, '5:05');

  // A stream listed neither way whose length keeps growing with the clock.
  await player.playItem(item('internet-archive:timeline-stream', { stream_kind: 'video' }));
  report(30, 20);
  for (let step = 1; step <= 2; step += 1) {
    t.mock.timers.tick(6_000);
    report(30 + 6 * step);
    assert.equal(seekShown(), true, `step ${step}: not yet`);
  }
  t.mock.timers.tick(6_000);
  report(48);
  assert.equal(seekShown(), false, 'growing on three updates over 18 s');

  // A film listed as on demand keeps both, its length refined.
  await player.playItem(item('internet-archive:timeline-film', { delivery: 'on-demand' }));
  report(3900, 65);
  report(3906);
  assert.equal(seekShown(), true);
  assert.equal(elements['player-dur'].textContent, '1:05:06');
  assert.equal(nativeTimelineHidden(), false);
  assert.equal(pictureSlot.hasAttribute('inert'), false, 'on-demand video can also be adjusted');
  video.duration = Number.NaN;
  await player.playItem(channel);
  assert.equal(nativeTimelineHidden(), true);

  // A native HLS event stream can end its playlist while playback continues.
  t.mock.method(Hls, 'isSupported', () => false);
  video.canPlayType = () => 'maybe';
  video.seekable = { length: 0 };
  await player.playItem({ ...channel, id: 'iptv-org:native-event', stream_kind: 'hls', _extra: { streamCandidates: [] },
    stream_url: 'https://media.example/event.m3u8' });
  assert.equal(video.paused, false);
  report(Infinity, 4);
  assert.equal(nativeTimelineHidden(), true);
  assert.equal(seekShown(), false);
  report(150, 8);
  assert.equal(seekShown(), false, 'wait for a seekable range');
  video.seekable = { length: 1 };
  report(150, 9);
  assert.equal(video.paused, false);
  assert.equal(nativeTimelineHidden(), false);
  assert.equal(seekShown(), true);
  assert.equal(elements['player-seek'].disabled, false);
  assert.equal(elements['player-time'].textContent, '0:09');
  assert.equal(elements['player-dur'].textContent, '2:30');

  player.stop();
  assert.equal(nativeTimelineHidden(), false);
  assert.equal(pictureSlot.hasAttribute('inert'), true);
});
