import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { betterStationStreams, trustedOtherStreams } from '../src/adapters/radio-browser.js';
import {
  CHECK_LOOKUP_MS, VERIFY_AFTER_MS, cancelScheduledCheck, resumeCheck, scheduleCheck, verifyStation,
} from '../src/lib/best-stream-auto.js';
import { connectMediaRelay, streamCandidatesForItem } from '../src/lib/media-failover.js';
import { canFindOtherStreams, matchOtherStreams, underOwnName } from '../src/lib/other-streams.js';
import { bindSongStar } from '../src/lib/song-star.js';
import { START_FAILOVER_MS, createStartWatch, untriedStreams } from '../src/lib/start-failover.js';
import { HLS_STARTUP_BUFFER_TIMEOUT_MS } from '../src/lib/hls-recovery.js';
import {
  FAILED_RETRY_MS, LOOKUP_FAILED_VERIFY_RETRY_MS, VERIFY_REASONS, storedVerification,
} from '../src/lib/stream-verify.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const T = 1_800_000_000_000;
const AUTO = { bestStreamMode: 'auto' };

function withStorage(fn) {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  return Promise.resolve().then(() => fn(values)).finally(() => { globalThis.localStorage = previous; });
}

function station(overrides = {}) {
  return {
    id: 'radio-browser:own', title: 'Jazz FM', source: 'radio-browser', type: 'radio',
    stream_url: 'https://stream.jazzfm.example/128.mp3', stream_kind: 'audio', capture_headers: {},
    source_url: 'https://www.jazzfm.example/', country: 'GB',
    _extra: { stationuuid: 'own', bitrate: 128, codec: 'MP3' },
    ...overrides,
  };
}

/** The copy lists and the Tuner make of a favorite the user renamed
 *  (favorite-names.js withFavoriteName). */
const renamed = (item = station(), name = 'My evening music') => ({
  ...item, title: name, originalTitle: item.title, __favoriteName: true,
});

let entries = 0;
function directoryEntry(url, bitrate) {
  entries += 1;
  return {
    id: `radio-browser:t${entries}`, title: 'Jazz FM', source: 'radio-browser', type: 'radio',
    stream_url: url, stream_kind: 'audio', source_url: 'https://jazzfm.example/', country: 'GB',
    _extra: {
      stationuuid: `t${entries}`, bitrate, codec: 'MP3', clickcount: 40,
      health: { lastCheckOk: true, sslError: false, votes: 12, changedAt: T - 90 * DAY },
    },
  };
}

const facts = (overrides = {}) => ({
  ok: true, content_type: 'audio/mpeg', bitrate: 128, name: 'Jazz FM', url: 'https://www.jazzfm.example',
  title: 'Miles Davis - So What', audio_bytes: 64 * 1024, final_scheme: 'https', final_host: 'stream.jazzfm.example',
  ...overrides,
});

/* ============ 1. A renamed favorite keeps its own name for lookups ============ */

test('a renamed favorite is searched, matched and checked under the station\'s own name', async () => {
  const item = renamed();
  assert.equal(underOwnName(item).title, 'Jazz FM');
  assert.equal(underOwnName(station()).title, 'Jazz FM', 'a station without a name of its own is unchanged');
  assert.equal(underOwnName(underOwnName(item)).title, 'Jazz FM');
  assert.equal(canFindOtherStreams(renamed(station(), '!!')), true, 'a name with no letters does not hide Other streams');
  const good = directoryEntry('https://hq.jazzfm.example/320.mp3', 320);
  // Other streams (picked by hand): the name match is made on the own name.
  assert.equal(matchOtherStreams(item, [good]).total, 1);
  let searched = null;
  // The hand-picked list's search starts from the own name as well.
  const adapterSource = await read('src/adapters/radio-browser.js');
  assert.match(adapterSource, /export async function findOtherStreams\(item, opts = \{\}\) \{\s*item = underOwnName\(item\);/);
  // The trusted entries for Auto, and its lookup's search query.
  assert.deepEqual(trustedOtherStreams(item, [good]).map((stream) => stream.stream_url), [good.stream_url]);
  await withStorage(async () => {
    const streams = await betterStationStreams(item, {
      searchImpl: async (asked) => { searched = asked.title; return [good]; }, now: () => T,
    });
    assert.equal(searched, 'Jazz FM');
    assert.deepEqual(streams.map((stream) => stream.url), [good.stream_url]);
  });
  // The check compares station names with the own name, not the user's.
  await withStorage(async () => {
    const adapter = {
      betterStationStreams: (asked) => betterStationStreams(asked, { searchImpl: async () => [good], now: () => T }),
    };
    const probe = async () => ({ own: facts(), alt: facts({ bitrate: 320, final_host: 'hq.jazzfm.example' }) });
    const result = await verifyStation(item, { adapter, probe, now: () => T });
    assert.deepEqual(result, { ok: false, pending: true }, 'a first match, as for the station under its own name');
  });
});

test('the player-bar star refuses the station\'s own name as a song, for a renamed favorite too', () => {
  const button = {
    hidden: false, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {}, removeEventListener() {},
  };
  const item = renamed();
  let title = 'Jazz FM';
  const star = bindSongStar({
    button,
    starred: { starredFor: () => null, toggle() {}, onChange: () => () => {} },
    getNowPlaying: () => ({ itemId: item.id, title }),
    getCurrentItem: () => item,
  });
  assert.equal(star.song(), null, 'the original name is not a song');
  title = 'My evening music';
  assert.equal(star.song(), null, 'nor is the name the user gave it');
  title = 'Miles Davis - So What';
  assert.deepEqual(star.song(), {
    title, station: 'My evening music', stationId: item.id, source: 'radio-browser',
  }, 'a song is starred under the name the user knows the station by');
});

/* ============ 2. Pause with the check's timer pending ============ */

test('a pause with the check\'s timer pending clears it with a plain call (no "Illegal invocation"); a resume plans it again', async () => {
  await withStorage(async () => {
    const pending = new Map();
    let next = 0;
    // Like a browser's timers: they throw when called as a method of
    // another object.
    function setTimer(fn, ms) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      next += 1;
      pending.set(next, [fn, ms]);
      return next;
    }
    function clear(handle) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      pending.delete(handle);
    }
    let clock = T;
    const item = station();
    const options = {
      settings: AUTO, current: () => item, nowPlaying: () => ({ itemId: item.id, title: 'Miles Davis - So What' }),
      setTimer, clear, now: () => clock, run: async () => null,
    };
    assert.equal(scheduleCheck(item, options), true);
    assert.equal(pending.size, 1);
    clock += 30_000; // paused at 30 s, the 45 s timer still pending
    assert.doesNotThrow(() => cancelScheduledCheck());
    assert.equal(pending.size, 0);
    // Playing again: a new wait of VERIFY_AFTER_MS from the resume.
    assert.equal(resumeCheck(item, options), true);
    assert.deepEqual([...pending.values()].map(([, ms]) => ms), [VERIFY_AFTER_MS]);
    // More `playing` events (after buffering) do not restart the wait.
    assert.equal(resumeCheck(item, options), false);
    assert.equal(pending.size, 1);
    cancelScheduledCheck();
  });
  const player = await read('src/lib/player.js');
  const onPlaying = player.slice(player.indexOf('const onPlaying = owned('), player.indexOf('const pausedNow = () =>'));
  assert.match(onPlaying, /resumeCheck\(currentItem, \{ settings: getState\(\)\.settings, current: \(\) => currentItem, nowPlaying: getNowPlaying \}\)/);
  // The player's own wiring is tested in tests/review-fixes-7.test.js.
  const auto = await read('src/lib/best-stream-auto.js');
  assert.doesNotMatch(auto, /ending\.clear\(/, 'never called as a method of the session');
});

/* ============ 3. A lookup that fails is not "no other entry" ============ */

test('a lookup that times out, fails or is cut short is a failure tried again after 30 minutes, not "no candidate" for a day', async () => {
  for (const searchImpl of [
    async () => { throw new Error('directory down'); },
    (_, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  ]) {
    await withStorage(async () => {
      const adapter = {
        betterStationStreams: (asked, opts) => betterStationStreams(asked, { ...opts, timeoutMs: 5, searchImpl, now: () => T }),
      };
      let probed = 0;
      const result = await verifyStation(station(), { adapter, probe: async () => { probed += 1; }, now: () => T });
      assert.deepEqual(result, { ok: false, reason: 'lookupFailed' });
      assert.equal(probed, 0);
      assert.deepEqual(storedVerification('own', T + LOOKUP_FAILED_VERIFY_RETRY_MS - 1), { ok: false, reason: 'lookupFailed' });
      assert.equal(storedVerification('own', T + LOOKUP_FAILED_VERIFY_RETRY_MS), null, 'checked again after 30 minutes');
      assert.ok(LOOKUP_FAILED_VERIFY_RETRY_MS < FAILED_RETRY_MS);
      // Within the 30 minutes the stored failed lookup is a failure too.
      const again = await verifyStation(station(), { adapter, probe: async () => {}, now: () => T + 60_000 });
      assert.equal(again.reason, 'lookupFailed');
    });
  }
  assert.match(VERIFY_REASONS.lookupFailed, /could not be verified/i);
  // The background check gives the search more time than a lookup before playing would.
  let asked = null;
  await withStorage(async () => {
    await verifyStation(station(), {
      adapter: { betterStationStreams: async (_item, opts) => { asked = opts; return []; } }, probe: async () => {}, now: () => T,
    });
  });
  assert.equal(asked.timeoutMs, CHECK_LOOKUP_MS);
  // A cancelled request keeps the directory mirror (no new mirror search).
  const adapterSource = await read('src/adapters/radio-browser.js');
  assert.match(adapterSource, /lastError = err;\s*(?:\/\/[^\n]*\n\s*){3}if \(opts\.signal\?\.aborted\) \{\s*if \(mirrorTooSlow\(askedAt\)\) invalidateBase\(\);\s*throw err;\s*\}\s*if \(attempt === 0\)/);
});

/* ============ 4. A stream that connects but never plays ============ */

function tvItem() {
  return {
    id: 'iptv-org:aathavan', title: 'Aathavan TV', source: 'iptv-org', type: 'tv',
    stream_url: 'https://a.example/576.m3u8', stream_kind: 'hls', capture_headers: {},
    _extra: {
      quality: '576p',
      streamCandidates: [
        { url: 'https://b.example/720.m3u8', kind: 'hls', quality: '720p' },
        { url: 'https://c.example/360.m3u8', kind: 'hls', quality: '360p' },
      ],
    },
  };
}

test('the start watch: a stream that never plays releases the untried streams, at the latest after the start time limit', () => {
  assert.equal(START_FAILOVER_MS, HLS_STARTUP_BUFFER_TIMEOUT_MS, 'the player\'s start time limit for a live stream');
  const timers = new Map();
  let next = 0;
  const calls = [];
  const watch = createStartWatch({
    onNext: (item, tried, token) => calls.push({ id: item.id, tried, token }),
    setTimer: (fn, ms) => { next += 1; timers.set(next, [fn, ms]); return next; },
    clearTimer: (handle) => timers.delete(handle),
  });
  const item = tvItem();
  const order = streamCandidatesForItem(item, { preferBest: true }).map((stream) => stream.url);
  // The first stream connected and did not play: the player gave up on it.
  watch.arm(7, item, [order[0]]);
  assert.deepEqual([...timers.values()].map(([, ms]) => ms), [START_FAILOVER_MS]);
  assert.equal(watch.failed(6), false, 'not for an older start');
  assert.equal(watch.failed(7), true);
  assert.deepEqual(calls, [{ id: item.id, tried: [order[0]], token: 7 }]);
  assert.equal(timers.size, 0);
  assert.equal(watch.failed(7), false, 'once');
  // Silent: nothing reported, the time limit releases them.
  watch.arm(8, item, order.slice(0, 2));
  [...timers.values()][0][0]();
  assert.deepEqual(calls.at(-1).tried, order.slice(0, 2));
  // Played (or paused, stopped, another station): nothing more.
  watch.arm(9, item, [order[0]]);
  watch.end();
  assert.equal(timers.size, 0);
  assert.equal(watch.failed(9), false);
  assert.equal(calls.length, 2);
  // The untried streams keep the order a start tries them in.
  assert.deepEqual(untriedStreams(item, { tried: [order[0]] }).map((stream) => stream.url), order.slice(1));
  assert.deepEqual(untriedStreams(item, { tried: order }), []);
});

test('the next start leaves out the streams that connected without playing and tries the rest in order, two at a time', async () => {
  const item = tvItem();
  const order = streamCandidatesForItem(item, { preferBest: true }).map((stream) => stream.url);
  const registered = [];
  const relay = await connectMediaRelay(item, {
    preferBest: true, skipUrls: [order[0]], headStartMs: 0,
    registerImpl: async (candidate) => { registered.push(candidate.stream_url); return { media_id: `m${registered.length}`, relay_url: '/api/v1/media/x' }; },
    probeImpl: async () => true,
    expireImpl: async () => {},
  });
  assert.ok(relay.media_id);
  assert.deepEqual(registered.slice().sort(), order.slice(1).sort());
  assert.ok(!registered.includes(order[0]));
});

test('the player wires the start watch for Listed, Auto and saved backups', async () => {
  const player = await read('src/lib/player.js');
  // Arm after connecting if a station still has an untried stream.
  assert.match(player, /if \(!partPlayback && \(addresses\.ordered \|\| preferBest\) && !reconnectingCurrentItem\(\) && streamAddressesCurrent\(\)\) \{\s*const tried = addresses\.ordered \? attempted : [^;]+;\s*if \(untriedStreams\(item, \{ addresses, extraStreams, tried \}\)\.length\) startWatch\.arm\(myToken, item, tried\);/);
  // The player's failures before a stream played release the next streams.
  assert.match(player, /if \(!shouldReconnect\(\)\) \{\s*\/\/[^\n]*\n\s*if \(startWatch\.failed\(playToken\)\) return;/);
  assert.equal((player.match(/e\?\.name === 'NotAllowedError' \|\| !startWatch\.failed\(token\)/g) || []).length, 2);
  // Its first `playing`, and its position moving after it, go to the watch:
  // a `playing` alone does not lift the start time limit.
  assert.match(player, /const onPlaying = owned\(\(\) => \{[^}]*setMediaPriority\(true\);\s*\/\/[^\n]*\n\s*startWatch\.playing\(playToken\);/);
  assert.match(player, /playSession\.progressed \+= step;\s*\/\/[^\n]*\n\s*startWatch\.moved\(playToken\);/);
  assert.equal((player.match(/startWatch\.moved\(/g) || []).length, 1, 'only forward, credited movement');
  // Played a second, paused, stopped, or another start: the watch ends.
  assert.match(player, /playSession\.played = true;\s*startWatch\.end\(\);/);
  assert.match(player, /function pauseFromUser\(\) \{\s*(?:playbackActions\+\+;\s*)?startWatch\.end\(\);/);
  assert.match(player, /export function stop\(\) \{\s*cancelReconnect\(\);[^}]*startWatch\.end\(\);/);
  assert.match(player, /const myToken = \+\+playToken;\s*startWatch\.end\(\);/);
  assert.match(player, /await startPlayback\(item, \{ skipStreams: tried \}\);/);
  // Connection failover (as in v0.1.11): every start goes through it, in
  // all three modes (preferBest is false with the setting off).
  assert.match(player, /connectMediaRelay\(relayItem, \{\s*signal: connectionController\.signal, preferBest, extraStreams, skipUrls: skipStreams, addresses,\s*onAttempt: addresses\.ordered \? \(url\) => attempted\.add\(url\) : undefined,/);
  const off = streamCandidatesForItem(tvItem(), { preferBest: false }).map((stream) => stream.url);
  assert.deepEqual(off, ['https://a.example/576.m3u8', 'https://b.example/720.m3u8', 'https://c.example/360.m3u8']);
  // Off: a first stream that fails to connect still hands over to the next.
  const tried = [];
  await connectMediaRelay(tvItem(), {
    preferBest: false,
    registerImpl: async (candidate) => {
      tried.push(candidate.stream_url);
      if (candidate.stream_url === off[0]) throw new Error('refused');
      return { media_id: 'm', relay_url: '/api/v1/media/x' };
    },
    probeImpl: async () => true,
    expireImpl: async () => {},
  });
  assert.ok(tried.includes(off[1]));
});

/* ============ 5. Auto: one quiet line in the details panel ============ */

test('Auto: the details panel line says what the check knows, in Auto only, and follows changes without polling', async () => {
  const { BEST_STREAM_STATUS_TEXT, bestStreamStatusText, createBestStreamStatus } = await import('../src/modes/library/other-streams.js');
  const { storeVerification } = await import('../src/lib/stream-verify.js');
  await withStorage(async () => {
    const item = station();
    const text = (settings = AUTO, extra = {}) => bestStreamStatusText(item, { settings, now: T + 1, ...extra });
    // Nothing in Listed or Off, nor for a station that is not from Radio Browser.
    assert.equal(text({ bestStreamMode: 'listed' }), null);
    assert.equal(text({ bestStreamMode: 'off' }), null);
    assert.equal(bestStreamStatusText({ ...item, source: 'playlist', id: 'playlist:x' }, { settings: AUTO }), null);
    assert.equal(text(), '', 'nothing known yet and no check planned: the line keeps its place, empty');
    assert.equal(text(AUTO, { checking: true }), BEST_STREAM_STATUS_TEXT.checking);
    assert.equal(BEST_STREAM_STATUS_TEXT.checking, 'Better stream: checking...');
    storeVerification('own', { alt: { url: 'https://hq.jazzfm.example/320.mp3', bitrate: 320, codec: 'MP3' }, pending: true, song: 'x' }, T);
    assert.equal(text(), 'Better stream: one match so far, checking again later');
    for (const [reason, shown] of [
      ['noCandidate', 'Better stream: none found'],
      ['notBetter', 'Better stream: none found'],
      ['noTitles', 'Better stream: could not be verified (this station sends no song titles)'],
      ['differentTitle', 'Better stream: could not be verified'],
      ['lookupFailed', 'Better stream: could not be verified'],
      ['failed', 'Better stream: could not be verified'],
    ]) {
      storeVerification('own', { reason }, T);
      assert.equal(text(), shown, reason);
    }
    storeVerification('own', { alt: { url: 'https://hq.jazzfm.example/320.mp3', bitrate: 320, codec: 'MP3' } }, T);
    assert.equal(text(), 'Better stream: 320 kbps MP3, verified. It is used from the next start.');

    // The component: role=status, written only when the text changes, kept up
    // to date by the check's own events and the player's (a verified stream
    // that starts while the panel is open).
    // The component reads the clock itself.
    storeVerification('own', { reason: 'noCandidate' }, Date.now());
    const listeners = { auto: null, bus: new Map() };
    let playing = null;
    let checking = false;
    const previous = globalThis.document;
    class Node extends EventTarget {
      constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.writes = 0; this._text = ''; this.hidden = false; }
      get textContent() { return this._text; }
      set textContent(value) { this.writes += 1; this._text = value; }
      setAttribute(name, value) { this.attrs[name] = String(value); }
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
      remove() { const list = this.parentNode?.children; if (list) list.splice(list.indexOf(this), 1); this.parentNode = null; }
    }
    globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (value) => Object.assign(new Node('#text'), { _text: value }) };
    try {
      const status = createBestStreamStatus(item, {
        settings: () => AUTO,
        verified: () => playing,
        checking: () => checking,
        onAutoChange: (fn) => { listeners.auto = fn; return () => { listeners.auto = null; }; },
        on: (event, fn) => { listeners.bus.set(event, fn); return () => listeners.bus.delete(event); },
      });
      const line = status.node.children[0];
      assert.equal(line.attrs.role, 'status');
      assert.equal(line.textContent, 'Better stream: none found');
      const writes = line.writes;
      listeners.auto();
      assert.equal(line.writes, writes, 'the same text is not written again');
      // A verified stream starts while the panel is open (the player's media-relay event).
      playing = { itemId: item.id, url: 'https://hq.jazzfm.example/320.mp3', bitrate: 320, codec: 'MP3' };
      listeners.bus.get('media-relay')();
      assert.equal(line.textContent, 'Better stream: 320 kbps MP3, verified');
      assert.equal(status.node.children.filter((node) => node.tagName === 'BUTTON').length, 1, 'with the way back');
      playing = null;
      listeners.bus.get('media-relay')();
      assert.equal(status.node.children.filter((node) => node.tagName === 'BUTTON').length, 0);
      status.destroy();
      assert.equal(listeners.auto, null);
      assert.equal(listeners.bus.size, 0);
      // Listed or Off: no line at all.
      assert.equal(createBestStreamStatus(item, { settings: () => ({ bestStreamMode: 'listed' }), onAutoChange: () => () => {}, on: () => () => {} }), null);
    } finally {
      globalThis.document = previous;
    }
  });
  const css = await read('src/styles/library.css');
  assert.match(css, /\.detail-best-stream \{[^}]*min-height: 26px;/, 'its place is kept, with room for the button');
  const detail = await read('src/modes/library/detail.js');
  assert.ok(detail.indexOf('detailBestStream = createBestStreamStatus(item);') > detail.indexOf("ui.detailPanel.appendChild(meta);"), 'under the stream facts');
});

test('Auto announces its changes: a check planned, ended or finished', async () => {
  const { onBestStreamChange, checkPlannedFor } = await import('../src/lib/best-stream-auto.js');
  await withStorage(async () => {
    let calls = 0;
    const stop = onBestStreamChange(() => { calls += 1; });
    const item = station();
    scheduleCheck(item, {
      settings: AUTO, current: () => item, nowPlaying: () => null,
      setTimer: () => 1, clear: () => {}, now: () => T,
    });
    assert.equal(calls, 1);
    assert.equal(checkPlannedFor(item.id), true);
    cancelScheduledCheck();
    assert.equal(calls, 2);
    assert.equal(checkPlannedFor(item.id), false);
    stop();
  });
});

/* ============ 6, 7. Settings buttons and disabled boxes ============ */

test('Settings: buttons keep one line and their size; disabled boxes are grayed in both themes', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /\.modal\[aria-labelledby="settings-title"\] \.btn \{ white-space: nowrap; flex-shrink: 0; \}/);
  assert.match(css, /\.modal\[aria-labelledby="settings-title"\] :is\(input, select, \.btn\):disabled \{ opacity: \.52; cursor: not-allowed; \}/);
  // Every button in the dialog is a .btn (or the close icon), so the rule reaches them all.
  const settings = await read('src/lib/settings.js');
  const buttons = settings.match(/<button class="[^"]*"/g) || [];
  assert.ok(buttons.length >= 10);
  for (const button of buttons) assert.match(button, /class="(btn\b[^"]*|icon-btn)"/, button);
});

/* ============ 8. The processor limit from 2% ============ */

test('the processor limit goes down to 2% in whole percent; the presets stay; one plain sentence about graphics cards', async () => {
  const budget = await import('../src/lib/processor-budget.js');
  const { PROCESSOR_USE_HINT } = await import('../src/lib/settings.js');
  assert.equal(budget.PROCESSOR_LIMIT_MIN, 2);
  assert.equal(budget.PROCESSOR_LIMIT_MAX, 80);
  assert.deepEqual(budget.PROCESSOR_LIMIT_PRESETS, { light: 25, balanced: 40, high: 60 });
  assert.equal(budget.normalizeProcessorLimit(2), 2);
  assert.equal(budget.normalizeProcessorLimit(0), 2);
  const sentence = 'With a graphics card the Visualizer usually needs only a small share of the processor, '
    + 'so the limit matters most on computers without one or with few cores.';
  assert.ok(PROCESSOR_USE_HINT.endsWith(sentence));
  const about = (await read('src/modes/about.js')).replace(/\s+/g, ' ');
  assert.ok(about.includes(sentence));
  const wiki = (await read('docs/wiki/02-using-the-application.md')).replace(/\s+/g, ' ');
  assert.ok(wiki.includes('you can set it from 2% to 80%.'));
  assert.ok(!wiki.includes('10% to 80%'));
});

/* ============ 10. Live lists refresh only while shown ============ */

test('a live list refreshes only while it is shown, at most every 5 minutes for media.ccc.de; hidden, its timer stops', async () => {
  const { createSnapshotManager } = await import('../src/modes/library/snapshots.js');
  const timers = new Map();
  let next = 0;
  let clock = T;
  let visible = true;
  let requests = 0;
  const manager = createSnapshotManager({
    scheduler: { enqueue: ({ task, signal }) => task({ signal }) },
    loadAdapter: async () => ({
      refreshSnapshot: async () => { requests += 1; return { items: [], snapshotId: 'x', refreshAfterMs: 5 * 60 * 1000 }; },
    }),
    store: { snapshotIdsBySource: new Map(), items: [], byId: new Map() },
    now: () => clock,
    setTimer: (fn, ms) => { next += 1; timers.set(next, [fn, ms]); return next; },
    clearTimer: (handle) => timers.delete(handle),
    isVisible: () => visible,
  });
  await manager.refresh('media-ccc').catch(() => {});
  assert.equal(requests, 1);
  assert.deepEqual([...timers.values()].map(([, ms]) => ms), [5 * 60 * 1000]);
  // Another view: the timer stops; nothing is read while hidden.
  visible = false;
  manager.syncVisibility();
  assert.equal(timers.size, 0);
  clock += 20 * 60 * 1000;
  assert.equal(requests, 1);
  // Shown again, long after it was due: read once now, then on its timer.
  visible = true;
  manager.syncVisibility();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests, 2);
  assert.equal(timers.size, 1);
  // A timer that fires while hidden does nothing (it waits for the next show).
  visible = false;
  [...timers.values()][0][0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests, 2);
  manager.destroy();
  const ccc = await read('src/adapters/media-ccc.js');
  assert.match(ccc, /const LIVE_REFRESH_AFTER_MS = 5 \* 60 \* 1000;/);
  const chain = await read('src/modes/library/chain.js');
  assert.match(chain, /isVisible: \(sourceId\) => snapshotVisible\(sourceId\)/);
  assert.match(chain, /globalThis\.document\?\.visibilityState !== 'hidden'\s*&& effectiveStatusSources\(\)\.includes\(sourceId\)/);
  const sidebar = await read('src/modes/library/sidebar.js');
  assert.match(sidebar, /syncSnapshotVisibility\(\);/);
});
