import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { betterStationStreams, trustedOtherStreams } from '../src/adapters/radio-browser.js';
import {
  VERIFY_AFTER_MS, afterStart, cancelScheduledCheck, scheduleCheck, verifiedStreamFor, verifyStation,
} from '../src/lib/best-stream-auto.js';
import { applyStreamCandidate, streamCandidatesForItem } from '../src/lib/media-failover.js';
import { registerMedia } from '../src/lib/capture-client.js';
import { SHARED_HOST_SUFFIXES, sameStreamSite } from '../src/lib/other-streams.js';
import { PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import { clearCache } from '../src/lib/state.js';
import {
  ESTABLISHED_MIN_DAYS, FAILED_RETRY_MS, MAX_PROBES_PER_WEEK, MAX_VERIFIED_STATIONS, MIN_MATCH_GAP_MS,
  OWN_STREAM_KEY, STREAM_VERIFY_KEY, VERIFIED_MAX_AGE_MS, VERIFY_REASONS, keepOwnStream, keepsOwnStream,
  probesThisWeek, sameText, songKey, sourceVeto, storeVerification, storedVerification, streamVeto, verifiedLabel,
} from '../src/lib/stream-verify.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const T = 1_800_000_000_000;
const AUTO = { bestStreamMode: 'auto' };
const LISTED = { bestStreamMode: 'listed' };

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

const own = { url: 'https://stream.jazzfm.example/128.mp3', kind: 'audio', bitrate: 128, codec: 'MP3', title: 'Jazz FM' };
const HEALTHY = { lastCheckOk: true, sslError: false, votes: 12, clicks: 40, changedAt: T - 90 * DAY };
const alt = (overrides = {}) => ({
  url: 'https://hq.jazzfm.example/320.mp3', kind: 'audio', headers: {}, bitrate: 320, codec: 'MP3',
  ...HEALTHY, ...overrides,
});

const SONG_A = 'Miles Davis - So What';
const SONG_B = 'John Coltrane - Naima';
// What the local server's probe says about a stream that plays.
const facts = (overrides = {}) => ({
  ok: true, content_type: 'audio/mpeg', bitrate: 128, name: 'Jazz FM', url: 'https://www.jazzfm.example',
  title: SONG_A, audio_bytes: 64 * 1024, final_scheme: 'https', final_host: 'stream.jazzfm.example', ...overrides,
});
const ownFacts = facts();
const altFacts = (overrides = {}) => facts({ bitrate: 320, final_host: 'hq.jazzfm.example', ...overrides });
const pair = (title = SONG_A, extra = {}) => ({ own: facts({ title }), alt: altFacts({ title, ...extra }) });

// A directory entry of the same station as the search finds it.
let entries = 0;
function directoryEntry(url, bitrate, codec = 'MP3', health = {}, overrides = {}) {
  entries += 1;
  return {
    id: `radio-browser:e${entries}`, title: 'Jazz FM', source: 'radio-browser', type: 'radio',
    stream_url: url, stream_kind: 'audio', source_url: 'https://jazzfm.example/', country: 'GB',
    _extra: {
      stationuuid: `e${entries}`, bitrate, codec, clickcount: 40,
      health: { lastCheckOk: true, sslError: false, votes: 12, changedAt: T - 90 * DAY, ...health },
    },
    ...overrides,
  };
}

function directory(list) {
  const calls = [];
  return {
    calls,
    betterStationStreams: (item) => betterStationStreams(item, {
      searchImpl: async () => { calls.push(item.id); return list; }, now: () => T,
    }),
  };
}
const GOOD = () => directory([directoryEntry('https://hq.jazzfm.example/320.mp3', 320)]);

function prober(answers) {
  const calls = [];
  const list = Array.isArray(answers) ? [...answers] : null;
  const probe = async (ownUrl, altUrl, options) => {
    calls.push({ urls: [ownUrl, altUrl], options });
    const answer = list ? list.shift() : answers;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, probe };
}

/* ============ Source checks ============ */

test('source checks: each one on its own keeps an entry out', () => {
  assert.equal(sourceVeto(own, alt(), T), null);
  const cases = {
    missing: [own, null],
    kind: [own, alt({ kind: 'hls' })],
    downgrade: [own, alt({ url: 'http://hq.jazzfm.example/320.mp3' })],
    health: [own, alt({ lastCheckOk: false })],
    tls: [own, alt({ sslError: true })],
    new: [own, alt({ changedAt: T - (ESTABLISHED_MIN_DAYS - 1) * DAY })],
    unknown: [own, alt({ votes: 0, clicks: 3 })],
    'not-better': [own, alt({ bitrate: 128 })],
  };
  for (const [veto, [ownStream, other]] of Object.entries(cases)) {
    assert.equal(sourceVeto(ownStream, other, T), veto, veto);
  }
  // Missing directory data counts as failed, never as passed.
  assert.equal(sourceVeto(own, alt({ lastCheckOk: undefined }), T), 'health');
  assert.equal(sourceVeto(own, alt({ sslError: undefined }), T), 'tls');
  assert.equal(sourceVeto(own, alt({ changedAt: 0 }), T), 'new');
  assert.equal(sourceVeto({ ...own, url: 'http://stream.jazzfm.example/128.mp3' }, alt(), T), null);
  assert.equal(sourceVeto({ ...own, kind: 'hls' }, alt(), T), 'kind');
});

test('both country codes must be given and equal; shared hosting needs the very same host', () => {
  const item = station();
  const same = directoryEntry('https://hq.jazzfm.example/320.mp3', 320);
  const noCountry = directoryEntry('https://s4.jazzfm.example/192.mp3', 192, 'MP3', {}, { country: '' });
  assert.deepEqual(trustedOtherStreams(item, [same, noCountry]).map((s) => s.stream_url), [same.stream_url]);
  assert.deepEqual(trustedOtherStreams(station({ country: '' }), [same]), [], 'the station gives none');
  // github.io and the like prove nothing about the owner.
  assert.ok(SHARED_HOST_SUFFIXES.includes('github.io') && SHARED_HOST_SUFFIXES.length <= 30);
  assert.equal(sameStreamSite('https://jazz.github.io/a.mp3', 'https://evil.github.io/a.mp3'), false);
  assert.equal(sameStreamSite('https://jazz.github.io/a.mp3', 'https://jazz.github.io/b.mp3'), true);
  assert.equal(sameStreamSite('https://a.b.cloudfront.net/x', 'https://c.cloudfront.net/x'), false);
  assert.equal(sameStreamSite('https://s1.jazzfm.example/x', 'https://s2.jazzfm.example/y'), true);
  const pages = station({ stream_url: 'https://jazz.github.io/128.mp3' });
  const neighbour = directoryEntry('https://evil.github.io/320.mp3', 320);
  assert.deepEqual(trustedOtherStreams(pages, [neighbour]), []);
});

/* ============ Stream checks ============ */

test('stream checks: each one on its own vetoes the switch', () => {
  assert.equal(streamVeto(own, alt(), ownFacts, altFacts()), null);
  const cases = [
    ['notAudio', ownFacts, altFacts({ ok: false })],
    ['notAudio', facts({ content_type: 'text/html' }), altFacts()],
    ['notAudio', ownFacts, altFacts({ audio_bytes: 100 })],
    ['leftHttps', facts({ final_scheme: 'http' }), altFacts()],
    ['leftHttps', ownFacts, altFacts({ final_scheme: 'http' })],
    ['leftHttps', ownFacts, altFacts({ final_host: 'cdn.other.example' })],
    ['leftHttps', ownFacts, altFacts({ final_scheme: '' })],
    ['unknownFormat', facts({ bitrate: 0 }), altFacts()],
    ['unknownFormat', facts({ content_type: 'audio/x-unknown' }), altFacts()],
    ['unknownFormat', ownFacts, altFacts({ bitrate: 0 })],
    ['notAsListed', ownFacts, altFacts({ content_type: 'audio/aac' })],
    ['notAsListed', ownFacts, altFacts({ bitrate: 256 })],
    ['notBetter', facts({ bitrate: 320 }), altFacts()],
    ['differentName', ownFacts, altFacts({ name: 'Jazz FM Lounge' })],
    ['differentName', ownFacts, altFacts({ name: '' })],
    ['differentName', ownFacts, altFacts({ url: 'https://other.example/' })],
    ['noTitles', facts({ title: '' }), altFacts()],
    ['noTitles', ownFacts, altFacts({ title: '' })],
    ['differentTitle', ownFacts, altFacts({ title: SONG_B })],
  ];
  for (const [veto, ownSide, altSide] of cases) assert.equal(streamVeto(own, alt(), ownSide, altSide), veto, veto);
  // The own bitrate comes from its own response, never from the directory.
  assert.equal(streamVeto({ ...own, bitrate: 128 }, alt(), facts({ bitrate: 0 }), altFacts()), 'unknownFormat');
  // An http station may stay on http; spelling differences do not count.
  assert.equal(streamVeto({ ...own, url: 'http://stream.jazzfm.example/128.mp3' }, alt(), facts({ final_scheme: 'http' }), altFacts()), null);
  assert.equal(streamVeto(own, alt(), ownFacts, altFacts({ name: 'JAZZ  FM!', title: 'miles davis \u2013 so what' })), null);
  assert.equal(sameText('', ''), false, 'two empty texts are no evidence');
  assert.equal(streamVeto(own, alt(), undefined, altFacts()), 'notAudio');
});

test('only a title shaped like a song counts: adverts, idents and the station name do not', () => {
  assert.equal(songKey(SONG_A), 'miles davis so what');
  for (const title of [
    'Advertisement', 'Werbung', 'Jingle', 'Station ID', 'News', 'Live', ' - ', 'Unknown - Unknown',
    'Jazz FM - Live', 'Jazz FM', 'Advert - Commercial', 'A - B', 'Miles Davis', 'Smooth Network - jingle',
  ]) {
    assert.equal(songKey(title, ['Jazz FM']), '', title);
  }
  // The same advert on both streams is no evidence of the same programme.
  assert.equal(streamVeto(own, alt(), facts({ title: 'Advertisement' }), altFacts({ title: 'Advertisement' })), 'noTitles');
  assert.equal(streamVeto(own, alt(), facts({ title: 'Jazz FM - Jingle' }), altFacts({ title: 'Jazz FM - Jingle' })), 'noTitles');
});

/* ============ Two matches on different songs ============ */

test('one match alone never verifies; a second on another song a few minutes later does', async () => {
  await withStorage(async () => {
    const check = prober([pair(SONG_A), pair(SONG_A), pair(SONG_B)]);
    const first = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T });
    assert.deepEqual(first, { ok: false, pending: true });
    assert.equal(verifiedStreamFor(station(), AUTO, T + DAY), null, 'pending is not verified');
    // The same song again (later) is still only one song.
    const again = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T + MIN_MATCH_GAP_MS });
    assert.deepEqual(again, { ok: false, pending: true });
    assert.equal(verifiedStreamFor(station(), AUTO, T + MIN_MATCH_GAP_MS), null);
    assert.equal(probesThisWeek('own', T + MIN_MATCH_GAP_MS), MAX_PROBES_PER_WEEK);
    // The weekly limit: no third probe.
    const third = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T + 2 * MIN_MATCH_GAP_MS });
    assert.equal(third, null);
    assert.equal(check.calls.length, 2);
  });
  await withStorage(async () => {
    const check = prober([pair(SONG_A), pair(SONG_B)]);
    await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T });
    const soon = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T + 60_000 });
    assert.deepEqual(soon, { ok: false, pending: true }, 'too soon after the first');
  });
  await withStorage(async () => {
    const check = prober([pair(SONG_A), pair(SONG_B)]);
    await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T });
    const second = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T + MIN_MATCH_GAP_MS });
    assert.equal(second.ok, true);
    const offered = verifiedStreamFor(station(), AUTO, T + DAY);
    assert.equal(offered.url, 'https://hq.jazzfm.example/320.mp3');
    assert.equal(offered.requireHttps, true);
    assert.equal(verifiedLabel(offered), 'Better stream: 320 kbps MP3, verified');
  });
});

test('the same advert on two unrelated channels never verifies', async () => {
  await withStorage(async () => {
    const advert = { own: facts({ title: 'Advertisement' }), alt: altFacts({ title: 'Advertisement' }) };
    const check = prober([advert, advert]);
    const first = await verifyStation(station(), { adapter: GOOD(), probe: check.probe, now: () => T });
    assert.deepEqual(first, { ok: false, reason: 'noTitles' });
    assert.equal(verifiedStreamFor(station(), AUTO, T + DAY + 1), null);
  });
});

test('a station without song titles is never switched: the check is not even run', async () => {
  await withStorage(async () => {
    const timers = [];
    const runs = [];
    const item = station();
    assert.equal(scheduleCheck(item, {
      settings: AUTO, current: () => item, nowPlaying: () => null,
      setTimer: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clear: () => {},
      run: async (it) => { runs.push(it); }, now: () => T,
    }), true);
    assert.equal(timers[0][1], VERIFY_AFTER_MS);
    timers[0][0]();
    assert.equal(runs.length, 0);
    assert.deepEqual(storedVerification('own', T), { ok: false, reason: 'noTitles' });
    assert.match(VERIFY_REASONS.noTitles, /could not be verified/i);
    cancelScheduledCheck();
  });
});

test('Listed streams and Off: no lookup, no probe, nothing scheduled or offered', async () => {
  await withStorage(async () => {
    storeVerification('own', { alt: alt() }, T);
    for (const settings of [LISTED, { bestStreamMode: 'off' }, {}]) {
      const timers = [];
      assert.equal(scheduleCheck(station(), {
        settings, current: () => station(), nowPlaying: () => ({ itemId: 'radio-browser:own', title: SONG_A }),
        setTimer: (fn) => { timers.push(fn); return 1; }, clear: () => {}, now: () => T,
      }), false);
      assert.equal(timers.length, 0);
      assert.equal(verifiedStreamFor(station(), settings, T), null);
    }
    assert.equal(verifiedStreamFor({ ...station(), source: 'playlist', id: 'playlist:x' }, AUTO, T), null);
  });
  const player = await read('src/lib/player.js');
  assert.doesNotMatch(player, /betterStationStreams|probeStreams/);
});

/* ============ The whole check ============ */

test('a hostile copy of the station is never probed or used', async () => {
  await withStorage(async () => {
    const hostile = directoryEntry('https://evil.example.net/jazz-320.mp3', 320);
    const lookalike = directoryEntry('https://hq.jazzfm.example.evil.net/320.mp3', 320);
    const check = prober(pair());
    const result = await verifyStation(station(), { adapter: directory([hostile, lookalike]), probe: check.probe, now: () => T });
    assert.deepEqual(result, { ok: false, reason: 'noCandidate' });
    assert.equal(check.calls.length, 0);
  });
  await withStorage(async () => {
    const other = prober({ own: ownFacts, alt: altFacts({ name: 'Smooth Jazz 24', title: SONG_B }) });
    const second = await verifyStation(station(), { adapter: GOOD(), probe: other.probe, now: () => T });
    assert.deepEqual(second, { ok: false, reason: 'differentName' });
  });
  await withStorage(async () => {
    // A redirect away from https, or off the station's site, fails.
    const away = prober(pair(SONG_A, { final_scheme: 'http' }));
    assert.deepEqual(await verifyStation(station(), { adapter: GOOD(), probe: away.probe, now: () => T }),
      { ok: false, reason: 'leftHttps' });
  });
});

test('entries the directory marks as unhealthy, new or unknown are not probed', async () => {
  for (const health of [{ lastCheckOk: false }, { sslError: true }, { changedAt: T - DAY }, { votes: 0 }]) {
    await withStorage(async () => {
      const item = directoryEntry('https://hq.jazzfm.example/320.mp3', 320, 'MP3', health);
      if (health.votes === 0) item._extra.clickcount = 0;
      const check = prober(pair());
      const result = await verifyStation(station(), { adapter: directory([item]), probe: check.probe, now: () => T });
      assert.equal(result.reason, 'noCandidate', JSON.stringify(health));
      assert.equal(check.calls.length, 0);
    });
  }
});

test('a check that fails is remembered as failed and the station keeps its own stream', async () => {
  await withStorage(async () => {
    const result = await verifyStation(station(), { adapter: GOOD(), probe: prober(new Error('busy')).probe, now: () => T });
    assert.deepEqual(result, { ok: false, reason: 'failed' });
    assert.equal(verifiedStreamFor(station(), AUTO, T), null);
    assert.deepEqual(storedVerification('own', T + FAILED_RETRY_MS - 1), { ok: false, reason: 'failed' });
    assert.equal(storedVerification('own', T + FAILED_RETRY_MS), null, 'checked again after a day');
  });
});

/* ============ The playback session ============ */

test('pause, stop or another station abort a check on its way; its result is dropped', async () => {
  await withStorage(async (values) => {
    const timers = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const probe = async (_own, _alt, options) => {
      await gate;
      return { ...pair(), signal: options.signal };
    };
    const runs = [];
    const item = station();
    scheduleCheck(item, {
      settings: AUTO, current: () => item, nowPlaying: () => ({ itemId: item.id, title: SONG_A }),
      setTimer: (fn) => { timers.push(fn); return timers.length; }, clear: () => {}, now: () => T,
      run: (it, options) => { const p = verifyStation(it, { ...options, adapter: GOOD(), probe }); runs.push({ p, options }); return p; },
    });
    timers[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(runs.length, 1);
    // The player pauses (or stops, or plays another station).
    cancelScheduledCheck();
    assert.equal(runs[0].options.signal.aborted, true, 'the request to the local server is aborted');
    release();
    assert.equal(await runs[0].p, null);
    const stations = JSON.parse(values.get(STREAM_VERIFY_KEY) || '{"stations":{}}').stations;
    assert.equal(stations.own?.pending, undefined, 'nothing remembered for an ended session');
    assert.equal(storedVerification('own', T), null);
  });
  const player = await read('src/lib/player.js');
  assert.match(player, /const pausedNow = \(\) => \{\s*\/\/[^\n]*\n\s*cancelScheduledCheck\(\);/);
  const auto = await read('src/lib/best-stream-auto.js');
  assert.match(auto, /addEventListener\('pagehide', cancelScheduledCheck\)/);
});

test('the check waits for the station to play a while; a first match plans a second in the same session', async () => {
  await withStorage(async () => {
    const pending = new Map();
    let next = 0;
    const setTimer = (fn, ms) => { next += 1; pending.set(next, [fn, ms]); return next; };
    const clear = (id) => pending.delete(id);
    const runs = [];
    let playing = station();
    const options = {
      settings: AUTO, current: () => playing, setTimer, clear, now: () => T,
      nowPlaying: () => ({ itemId: playing.id, title: SONG_A }),
      run: async (item) => { runs.push(item.id); storeVerification('own', { alt: alt(), pending: true, song: 'x' }, T); return { pending: true }; },
    };
    scheduleCheck(station(), options);
    assert.equal(pending.size, 1);
    cancelScheduledCheck();
    assert.equal(pending.size, 0, 'a stop or another station clears it');
    scheduleCheck(station(), options);
    playing = { ...station(), id: 'radio-browser:other' };
    [...pending.values()][0][0]();
    assert.deepEqual(runs, [], 'not for a station that no longer plays');
    playing = station();
    scheduleCheck(station(), options);
    [...pending.values()].at(-1)[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(runs, ['radio-browser:own']);
    const [, wait] = [...pending.values()].at(-1);
    assert.equal(wait, MIN_MATCH_GAP_MS, 'the second check, a few minutes on');
    cancelScheduledCheck();
  });
});

/* ============ Expiry, bounds and Clear cache ============ */

test('a verified entry counts for a week; the store is bounded; Clear cache empties it', async () => {
  await withStorage(async (values) => {
    storeVerification('own', { alt: alt() }, T);
    assert.equal(verifiedStreamFor(station(), AUTO, T + VERIFIED_MAX_AGE_MS - 1).url, alt().url);
    assert.equal(verifiedStreamFor(station(), AUTO, T + VERIFIED_MAX_AGE_MS), null);
    assert.equal(storedVerification('own', T - 1), null);
    for (let index = 0; index < MAX_VERIFIED_STATIONS + 25; index += 1) storeVerification(`s${index}`, { reason: 'noTitles' }, T);
    const kept = JSON.parse(values.get(STREAM_VERIFY_KEY)).stations;
    assert.equal(Object.keys(kept).length, MAX_VERIFIED_STATIONS);
    assert.ok(kept[`s${MAX_VERIFIED_STATIONS + 24}`] && !kept.s0, 'the oldest go first');
    keepOwnStream('kept', { handoff: () => {} });
    clearCache();
    assert.equal(values.has(STREAM_VERIFY_KEY), false);
    assert.equal(keepsOwnStream('kept'), true, 'the choice of the user is not a cache');
  });
});

/* ============ Reverting ============ */

test('a verified stream that does not play gets the failed-check cooldown, so it is not checked again at once', async () => {
  await withStorage(async () => {
    storeVerification('own', { alt: alt() }, T);
    const item = station({ id: 'radio-browser:own-a' });
    const offered = verifiedStreamFor(item, AUTO, T);
    applyStreamCandidate(item, { url: item.stream_url, kind: 'audio', headers: {} });
    assert.equal(afterStart(item, offered, T), false);
    assert.deepEqual(storedVerification('own', T + 1), { ok: false, reason: 'failed' });
    assert.equal(verifiedStreamFor(item, AUTO, T + 1), null);
    const timers = [];
    assert.equal(scheduleCheck(station(), {
      settings: AUTO, current: () => station(), nowPlaying: () => ({ itemId: 'radio-browser:own', title: SONG_A }),
      setTimer: (fn) => { timers.push(fn); return 1; }, clear: () => {}, now: () => T + 1,
    }), false, 'no new check in the same session');
    assert.equal(timers.length, 0);
    // When it plays, it stays.
    storeVerification('own', { alt: alt() }, T);
    const second = station({ id: 'radio-browser:own-b' });
    applyStreamCandidate(second, verifiedStreamFor(second, AUTO, T));
    assert.equal(afterStart(second, verifiedStreamFor(second, AUTO, T), T), true);
    assert.equal(storedVerification('own', T).ok, true);
  });
});

test('a verified https stream is registered with https required, so a redirect to http fails at play time', async () => {
  const verified = { url: 'https://hq.jazzfm.example/320.mp3', kind: 'audio', headers: {}, bitrate: 320, codec: 'MP3', requireHttps: true };
  const candidates = streamCandidatesForItem(station(), { preferBest: true, extraStreams: [verified] });
  assert.equal(candidates.find((c) => c.url === verified.url).requireHttps, true);
  assert.equal(candidates.find((c) => c.url === station().stream_url).requireHttps, undefined);
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/session')) {
      return new Response(JSON.stringify({ ok: true, data: { token: 't' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, data: { media_id: 'm' } }), { headers: { 'Content-Type': 'application/json' } });
  };
  await registerMedia({ ...station(), stream_url: verified.url, require_https: true }, { fetchImpl }).catch(() => {});
  await registerMedia(station(), { fetchImpl }).catch(() => {});
  assert.equal(bodies[0]?.require_https, true);
  assert.equal('require_https' in (bodies[1] || {}), false, 'other streams register as before');
});

test("\"Use the station's own stream\" is remembered for good, handed to the profile, and stops checks", async () => {
  await withStorage(async () => {
    storeVerification('own', { alt: alt() }, T);
    let handoffs = 0;
    keepOwnStream('own', { handoff: () => { handoffs += 1; } });
    assert.equal(handoffs, 1, 'the profile handoff is scheduled after the write');
    assert.equal(keepsOwnStream('own'), true);
    assert.equal(storedVerification('own', T), null);
    assert.equal(verifiedStreamFor(station(), AUTO, T), null);
    const timers = [];
    assert.equal(scheduleCheck(station(), {
      settings: AUTO, current: () => station(), nowPlaying: () => ({ itemId: 'radio-browser:own', title: SONG_A }),
      setTimer: (fn) => { timers.push(fn); return 1; }, clear: () => {}, now: () => T,
    }), false);
    assert.equal(timers.length, 0);
  });
  const verify = await read('src/lib/stream-verify.js');
  assert.match(verify, /keepOwnStream\(stationId, \{ handoff = scheduleProfileHandoff \} = \{\}\)/);
  assert.ok(PROFILE_STORAGE_KEYS.includes(OWN_STREAM_KEY));
  assert.ok(!PROFILE_STORAGE_KEYS.includes(STREAM_VERIFY_KEY), 'the check results are a cache');
  const runtime = await read('worldmedia_runtime.py');
  assert.match(runtime, /"worldmedia\.ownstream\.v1",/);
  const detail = await read('src/modes/library/detail.js');
  assert.match(detail, /detailBestStream = createBestStreamStatus\(item\);/);
});
