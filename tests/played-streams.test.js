import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  MAX_PLAYED_STREAMS, PLAYED_STREAMS_KEY, clearPlayedStream, clearPlayedStreams, createPlayedStreamNote,
  forgetLoadedPlayedStreams,
  onPlayedStreamChange, playedStreamOf, rememberPlayedStream, sameStreamFacts, stationStreamLabel,
  streamFactsFromRelay, streamFactsFromHlsLevel, streamTooltipLine, compactStreamLabel, stationStreamFacts,
} from '../src/lib/played-streams.js';
import { codecFromContentType, formatStreamQuality } from '../src/lib/stream-quality.js';
import { createNowPlayingPoller } from '../src/lib/now-playing.js';
import { clearCache, getState, STORAGE_KEYS } from '../src/lib/state.js';
import { syncTunerMarks } from '../src/modes/tuner.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { renderResults, syncStreamLabels } from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const DOT = '·';

class MemoryStorage {
  constructor() { this.data = new Map(); this.writes = 0; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.writes += 1; this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

/** A fresh browser storage, put back afterwards. */
function withStorage(t, storage = new MemoryStorage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  forgetLoadedPlayedStreams();
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    forgetLoadedPlayedStreams();
  });
  return storage;
}

function withFavorites(t, list) {
  const state = getState();
  const before = state.favorites;
  state.favorites = list;
  t.after(() => { state.favorites = before; });
}

/* ============ What the relay says ============ */

test('the relay\'s content type and icy-br become a format and a bitrate', () => {
  assert.equal(codecFromContentType('audio/mpeg'), 'MP3');
  assert.equal(codecFromContentType('Audio/MPEG; charset=x'), 'MP3');
  assert.equal(codecFromContentType('audio/aacp'), 'AAC+');
  assert.equal(codecFromContentType('audio/aac'), 'AAC');
  assert.equal(codecFromContentType('application/ogg'), 'OGG');
  assert.equal(codecFromContentType('audio/flac'), 'FLAC');
  assert.equal(codecFromContentType('text/html'), '');
  assert.equal(codecFromContentType(null), '');
  assert.deepEqual(streamFactsFromRelay({ content_type: 'audio/mpeg', bitrate: 128 }), { codec: 'MP3', bitrate: 128 });
  assert.deepEqual(streamFactsFromRelay({ content_type: '', bitrate: 96 }), { codec: '', bitrate: 96 });
  assert.deepEqual(streamFactsFromRelay({ content_type: 'audio/aacp', bitrate: 0 }), { codec: 'AAC+', bitrate: 0 });
  for (const nothing of [null, undefined, [], 'audio/mpeg', { content_type: 'text/html', bitrate: 0 }, { bitrate: -5 }]) {
    assert.equal(streamFactsFromRelay(nothing), null, JSON.stringify(nothing));
  }
  assert.equal(sameStreamFacts({ codec: 'MP3', bitrate: 128 }, { codec: 'MP3', bitrate: 128 }), true);
  assert.equal(sameStreamFacts({ codec: 'MP3', bitrate: 128 }, { codec: 'MP3', bitrate: 192 }), false);
  assert.equal(sameStreamFacts(null, { codec: 'MP3', bitrate: 128 }), false);
});

test('the now-playing poll reports the stream facts once, and again only when they change', async () => {
  const replies = [
    { title: null, changed_at: null },
    { title: null, changed_at: null, stream: { content_type: 'audio/mpeg', bitrate: 128 } },
    { title: 'Song', changed_at: 1, stream: { content_type: 'audio/mpeg', bitrate: 128 } },
    { title: 'Song', changed_at: 1, stream: { content_type: 'audio/mpeg', bitrate: 192 } },
  ];
  const timers = [];
  const streams = [];
  const poller = createNowPlayingPoller({
    fetchTitle: async () => replies.shift() ?? { title: 'Song', changed_at: 1 },
    onStream: (state) => streams.push(state),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  poller.follow('relay-1', { itemId: 'playlist:0001' });
  for (let i = 0; i < 5; i += 1) {
    timers.shift()();
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(streams, [
    { itemId: 'playlist:0001', mediaId: 'relay-1', stream: { codec: 'MP3', bitrate: 128 } },
    { itemId: 'playlist:0001', mediaId: 'relay-1', stream: { codec: 'MP3', bitrate: 192 } },
  ]);
  // The song state keeps its shape.
  assert.deepEqual(Object.keys(poller.state).sort(), ['changedAt', 'itemId', 'mediaId', 'title']);
  poller.stop();
});

/* ============ Remembering ============ */

test('HLS facts round-trip without mixing a variant with listed metadata', (t) => {
  const storage = withStorage(t);
  const station = { id: 'radio:radio-hls', _extra: { codec: 'MP3', bitrate: 192 } };
  const radio = streamFactsFromHlsLevel({
    audioCodec: 'mp4a.40.2',
    attrs: { BANDWIDTH: '128000', 'AVERAGE-BANDWIDTH': '120000' },
  });
  assert.equal(rememberPlayedStream(station.id, radio), true);
  assert.equal(rememberPlayedStream(station.id, radio), false);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf(station.id), { hls: true, codec: 'AAC', bitrate: 128 });
  assert.equal(stationStreamLabel(station), `HLS ${DOT} AAC ${DOT} 128 kbps`);
  assert.equal(compactStreamLabel(stationStreamFacts(station)), 'HLS AAC 128k');

  const tv = { id: 'tv:hls' };
  const bandwidthOnly = { audioCodec: 'mp4a.40.5', attrs: { BANDWIDTH: '2400000' } };
  rememberPlayedStream(tv.id, streamFactsFromHlsLevel(bandwidthOnly, { video: true }));
  assert.equal(stationStreamLabel(tv), `HLS ${DOT} 2.4 Mbps`);
  rememberPlayedStream(tv.id, streamFactsFromHlsLevel({ ...bandwidthOnly, videoCodec: 'avc1.4d401f' }));
  forgetLoadedPlayedStreams();
  assert.equal(stationStreamLabel(tv), `HLS ${DOT} H.264 + AAC+ ${DOT} 2.4 Mbps total`);
  assert.equal(storage.writes, 3);

  assert.deepEqual(streamFactsFromHlsLevel({ bitrate: 900_000, attrs: { 'AVERAGE-BANDWIDTH': '900000' } }),
    { hls: true, codec: '', bitrate: 0 });
  assert.equal(streamFactsFromHlsLevel(null), null);
});

test('video labels show dimensions, HLS codec, declared frame rate and bandwidth when known', () => {
  const label = { hls: true, width: 1920, height: 1080, videoCodec: 'H.264', bitrate: 4200 };
  assert.equal(formatStreamQuality(label), ['HLS', '1080p', 'H.264', '4.2 Mbps'].join(' \u00b7 '));
  assert.equal(formatStreamQuality({ ...label, videoCodec: 'AV1', frameRate: 59.94 }),
    ['HLS', '1080p', '59.94 fps', 'AV1', '4.2 Mbps'].join(' \u00b7 '));
  assert.equal(formatStreamQuality({ width: 1440, height: 1080 }), '1440x1080');
});

test('first video facts and adaptive changes each require five seconds at the same observed size and level', (t) => {
  const storage = withStorage(t);
  const id = 'tv:video';
  const url = 'https://video.example/live.m3u8';
  const video = { videoWidth: 1920, videoHeight: 1080 };
  const level = { videoCodec: 'hvc1.1.6', attrs: { BANDWIDTH: '4200000', 'FRAME-RATE': '29.970' } };
  const note = createPlayedStreamNote();
  const sample = (ms, rendition = level) => note.videoProgress(id, url, video, 'hls', rendition, ms);
  note.played(id);
  sample(0);
  sample(4000);
  note.renditionChanged();
  sample(1000); // A switch between samples cleared the earlier progress.
  sample(4999);
  assert.equal(playedStreamOf(id, url), null);
  sample(1);
  forgetLoadedPlayedStreams();
  const facts = { codec: '', bitrate: 4200, hls: true, videoCodec: 'HEVC', width: 1920, height: 1080, frameRate: 29.97 };
  assert.deepEqual(playedStreamOf(id, url), facts);

  video.videoWidth = 1280;
  video.videoHeight = 720;
  const next = { videoCodec: 'av01.0.04M.08', attrs: { BANDWIDTH: '2400000' } };
  sample(1000, next);
  sample(4999, next);
  assert.deepEqual(playedStreamOf(id, url), facts);
  sample(1, next);
  assert.deepEqual(playedStreamOf(id, url),
    { codec: '', bitrate: 2400, hls: true, videoCodec: 'AV1', width: 1280, height: 720 });
  assert.equal(playedStreamOf(id, url + '?other'), null);
  assert.equal(storage.writes, 2);
  clearPlayedStreams();
  assert.equal(playedStreamOf(id, url), null);
});

test('the cache leaves out invalid non-HLS video codecs and frame rates', (t) => {
  withStorage(t);
  const id = 'tv:dash';
  const url = 'https://video.example/live.mpd';
  rememberPlayedStream(id, { width: 1920, height: 1080, videoCodec: 'unknown', frameRate: 10_000 }, url);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf(id, url), { codec: '', bitrate: 0, width: 1920, height: 1080 });
});

test('HLS addresses retain independent facts in the same bounded cache', (t) => {
  const storage = withStorage(t);
  const id = 'radio:two-addresses';
  const main = 'https://radio.example/main.m3u8';
  const backup = 'https://radio.example/backup.m3u8';
  const mainFacts = { hls: true, codec: 'AAC', bitrate: 128 };
  const backupFacts = { hls: true, codec: 'AAC', bitrate: 64 };
  rememberPlayedStream(id, mainFacts, main);
  rememberPlayedStream(id, backupFacts, backup);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf(id, main), mainFacts);
  assert.deepEqual(playedStreamOf(id, backup), backupFacts);
  assert.deepEqual(playedStreamOf(id), backupFacts);

  const note = createPlayedStreamNote();
  note.heard(id, mainFacts, main);
  note.played(id);
  assert.deepEqual(playedStreamOf(id), mainFacts);

  for (let i = 0; i < MAX_PLAYED_STREAMS - 1; i++) {
    rememberPlayedStream('other', mainFacts, 'https://radio.example/' + i + '.m3u8');
  }
  assert.equal(JSON.parse(storage.getItem(PLAYED_STREAMS_KEY)).items.length, MAX_PLAYED_STREAMS);
  assert.equal(playedStreamOf(id, backup), null);
  assert.deepEqual(playedStreamOf(id, main), mainFacts);

  rememberPlayedStream(id, backupFacts, backup);
  clearPlayedStream(id);
  forgetLoadedPlayedStreams();
  assert.equal(playedStreamOf(id, main), null);
  assert.equal(playedStreamOf(id, backup), null);
  assert.deepEqual(playedStreamOf('other'), mainFacts);
});

test('a startup HLS rendition must play five seconds to replace facts saved for its address', (t) => {
  const storage = withStorage(t);
  const id = 'radio:hls-reconnect';
  const url = 'https://radio.example/live.m3u8';
  const saved = { hls: true, codec: 'AAC', bitrate: 128 };
  const startup = { hls: true, codec: 'AAC', bitrate: 64 };
  rememberPlayedStream(id, saved, url);
  forgetLoadedPlayedStreams();
  const note = createPlayedStreamNote();
  note.begin();
  note.heard(id, startup, url);
  note.progress(1000);
  note.played(id);
  assert.deepEqual(playedStreamOf(id, url), saved);
  note.heard(id, saved, url);
  note.progress(5000);
  assert.equal(storage.writes, 1);

  note.heard(id, startup, url);
  note.progress(4999);
  assert.deepEqual(playedStreamOf(id, url), saved);
  note.progress(1);
  assert.deepEqual(playedStreamOf(id, url), startup);
});

test('a station\'s stream is kept per item, written only when it changes', (t) => {
  const storage = withStorage(t);
  const seen = [];
  t.after(onPlayedStreamChange((id) => seen.push(id)));
  assert.equal(playedStreamOf('playlist:a'), null);
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 }), true);
  assert.equal(storage.writes, 1);
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 }), false, 'the same again is not written');
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'mp3', bitrate: '128' }), false, 'cleaned, it is the same');
  assert.equal(storage.writes, 1);
  assert.deepEqual(JSON.parse(storage.getItem(PLAYED_STREAMS_KEY)), { version: 1, items: [['playlist:a', 'MP3', 128]] });
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), true);
  assert.equal(storage.writes, 2);
  // Read back by a new page.
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 320 });
  assert.deepEqual(seen, ['playlist:a', 'playlist:a']);
  for (const id of ['', null, 5, 'x'.repeat(513)]) assert.equal(rememberPlayedStream(id, { codec: 'MP3', bitrate: 1 }), false);
  for (const facts of [null, {}, { codec: '', bitrate: 0 }, { codec: 'unknown', bitrate: -1 }]) {
    assert.equal(rememberPlayedStream('playlist:b', facts), false);
  }
  assert.equal(storage.writes, 2);
});

test('a write that fails keeps nothing, so a later play tries the same values again', (t) => {
  const storage = withStorage(t);
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  const seen = [];
  t.after(onPlayedStreamChange((id) => seen.push(id)));
  const setItem = storage.setItem;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), false);
  assert.equal(rememberPlayedStream('playlist:b', { codec: 'AAC', bitrate: 64 }), false);
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 128 }, 'the saved value stays');
  assert.equal(playedStreamOf('playlist:b'), null);
  assert.deepEqual(seen, [], 'nothing changed on screen');
  // The storage works again: the same values are not taken as unchanged.
  storage.setItem = setItem;
  assert.equal(rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 320 }), true);
  assert.equal(rememberPlayedStream('playlist:b', { codec: 'AAC', bitrate: 64 }), true);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('playlist:a'), { codec: 'MP3', bitrate: 320 });
  assert.deepEqual(playedStreamOf('playlist:b'), { codec: 'AAC', bitrate: 64 });
  // No storage at all: nothing is kept as if saved.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: undefined });
  forgetLoadedPlayedStreams();
  assert.equal(rememberPlayedStream('playlist:c', { codec: 'MP3', bitrate: 128 }), false);
  assert.equal(playedStreamOf('playlist:c'), null);
});

test('the remembered streams are bounded: the oldest go first', (t) => {
  withStorage(t);
  assert.equal(MAX_PLAYED_STREAMS, 1000);
  for (let i = 0; i < MAX_PLAYED_STREAMS + 5; i += 1) rememberPlayedStream(`id-${i}`, { codec: 'MP3', bitrate: 64 + i });
  assert.equal(playedStreamOf('id-0'), null);
  assert.equal(playedStreamOf('id-4'), null);
  assert.deepEqual(playedStreamOf('id-5'), { codec: 'MP3', bitrate: 69 });
  // Changed: it is the newest now and stays.
  rememberPlayedStream('id-5', { codec: 'AAC', bitrate: 69 });
  rememberPlayedStream('id-new', { codec: 'MP3', bitrate: 128 });
  assert.deepEqual(playedStreamOf('id-5'), { codec: 'AAC', bitrate: 69 });
  assert.equal(playedStreamOf('id-6'), null);
  forgetLoadedPlayedStreams();
  assert.equal(JSON.parse(globalThis.localStorage.getItem(PLAYED_STREAMS_KEY)).items.length, MAX_PLAYED_STREAMS);
});

test('an unreadable or foreign stored value is an empty cache', (t) => {
  const storage = withStorage(t);
  for (const value of ['not json', '{"version":2,"items":[["a","MP3",128]]}', '{"version":1,"items":{}}', 'null']) {
    storage.setItem(PLAYED_STREAMS_KEY, value);
    forgetLoadedPlayedStreams();
    assert.equal(playedStreamOf('a'), null, value);
  }
  storage.setItem(PLAYED_STREAMS_KEY, JSON.stringify({ version: 1, items: [['a', 'MP3', 128], ['b', '', 0], [7, 'MP3', 1], 'c'] }));
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf('a'), { codec: 'MP3', bitrate: 128 });
  assert.equal(playedStreamOf('b'), null);
});

test('Clear cache removes them; they are no part of the profile or a backup', async (t) => {
  const storage = withStorage(t);
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  await clearCache().catch(() => {});
  assert.equal(storage.getItem(PLAYED_STREAMS_KEY), null);
  assert.equal(playedStreamOf('playlist:a'), null);
  assert.ok(!Object.values(STORAGE_KEYS).includes(PLAYED_STREAMS_KEY));
  for (const path of ['src/lib/profile-transfer.js', 'worldmedia_backup.py', 'worldmedia_runtime.py', 'worldmedia_profile.py']) {
    const text = await read(path).catch(() => '');
    assert.doesNotMatch(text, /playedstreams|played-streams/i, path);
  }
  clearPlayedStreams(); // nothing left: no error, nothing written
});

/* ============ Only a start that played ============ */

test('the relay\'s facts are remembered only once the start has played, in either order', () => {
  const kept = [];
  const note = createPlayedStreamNote({ remember: (id, facts) => { kept.push([id, facts]); return true; } });
  // Heard first, played after.
  note.begin();
  assert.equal(note.heard('a', { codec: 'MP3', bitrate: 128 }), false);
  assert.deepEqual(kept, []);
  assert.equal(note.played('a'), true);
  assert.deepEqual(kept, [['a', { codec: 'MP3', bitrate: 128 }]]);
  // Played first, heard after (and heard again with other values).
  note.begin();
  note.played('b');
  assert.equal(note.heard('b', { codec: 'AAC+', bitrate: 64 }), true);
  assert.equal(note.heard('b', { codec: 'AAC+', bitrate: 48 }), true);
  assert.deepEqual(kept.slice(1), [['b', { codec: 'AAC+', bitrate: 64 }], ['b', { codec: 'AAC+', bitrate: 48 }]]);
});

test('nothing is remembered for a start that does not play', () => {
  const kept = [];
  const note = createPlayedStreamNote({ remember: (id, facts) => { kept.push([id, facts]); return true; } });
  note.begin();
  note.heard('a', { codec: 'MP3', bitrate: 128 });
  // It failed: the next start begins, and that one plays another station.
  note.begin();
  note.played('b');
  assert.deepEqual(kept, []);
  // Heard for one station, another played: not mixed up.
  note.begin();
  note.heard('c', { codec: 'MP3', bitrate: 128 });
  note.played('d');
  assert.deepEqual(kept, []);
  // Nothing worth keeping.
  note.begin();
  note.played('e');
  assert.equal(note.heard('e', { codec: '', bitrate: 0 }), false);
  assert.equal(note.heard('e', null), false);
  assert.deepEqual(kept, []);
});

test('the player ties the facts to its start: begin with each start, played after a second of play', async () => {
  const player = await read('src/lib/player.js');
  assert.match(player, /playSession = newPlaySession\(myToken\);\s+playedStreamNote\.begin\(\);/);
  assert.match(player, /startOutcome\.played\(currentItem\?\.id\);[\s\S]{0,120}playedStreamNote\.played\(currentItem\?\.id\);/);
  assert.match(player, /onStream: \(\{ itemId, stream \}\) => \{\s+if \(itemId && itemId === currentItem\?\.id && streamAddressesCurrent\(\)\) playedStreamNote\.heard\(itemId, stream\);/);
  // No timer or request of its own: the facts come with the song poll.
  const module = await read('src/lib/played-streams.js');
  assert.doesNotMatch(module, /setTimeout|setInterval|fetch\(|controlRequest/);
});

/* ============ What is shown ============ */

test('the label: the played values, the directory\'s as before, and nothing when nothing is known', (t) => {
  withStorage(t);
  const own = { id: 'playlist:a', source: 'playlist' };
  assert.equal(stationStreamLabel(own), '', 'never played: nothing, no filler');
  rememberPlayedStream('playlist:a', { codec: 'MP3', bitrate: 128 });
  assert.equal(stationStreamLabel(own), `MP3 ${DOT} 128 kbps`);
  rememberPlayedStream('playlist:b', { codec: '', bitrate: 96 });
  assert.equal(stationStreamLabel({ id: 'playlist:b' }), '96 kbps');
  // Radio Browser: the listed values stay.
  const listed = { id: 'rb:1', _extra: { codec: 'AAC+', bitrate: 64 } };
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  rememberPlayedStream('rb:1', { codec: 'AAC+', bitrate: 64 });
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  // They disagree: the listed values stay, nothing is added.
  rememberPlayedStream('rb:1', { codec: 'AAC', bitrate: 128 });
  assert.equal(stationStreamLabel(listed), `AAC+ ${DOT} 64 kbps`);
  // The directory leaves the bitrate out and the format agrees: filled in.
  rememberPlayedStream('rb:2', { codec: 'MP3', bitrate: 128 });
  assert.equal(stationStreamLabel({ id: 'rb:2', _extra: { codec: 'MP3', bitrate: 0 } }), `MP3 ${DOT} 128 kbps`);
  rememberPlayedStream('rb:3', { codec: 'OGG', bitrate: 128 });
  assert.equal(stationStreamLabel({ id: 'rb:3', _extra: { codec: 'MP3', bitrate: 0 } }), 'MP3');
  // The directory lists nothing: the played values.
  rememberPlayedStream('rb:4', { codec: 'MP3', bitrate: 192 });
  assert.equal(stationStreamLabel({ id: 'rb:4', _extra: { stationuuid: 'x' } }), `MP3 ${DOT} 192 kbps`);
  assert.equal(streamTooltipLine(`MP3 ${DOT} 128 kbps`), `Stream: MP3 ${DOT} 128 kbps`);
  assert.equal(streamTooltipLine(''), '');
  // The Tuner card's short form, from the same parts.
  assert.deepEqual(stationStreamFacts({ id: 'rb:2', _extra: { codec: 'MP3', bitrate: 0 } }),
    { codec: 'MP3', bitrate: 128, hls: false });
  assert.equal(compactStreamLabel({ codec: 'AAC', bitrate: 128 }), 'AAC 128k');
  assert.equal(compactStreamLabel({ codec: 'AAC+', bitrate: 320 }), 'AAC+ 320k');
  assert.equal(compactStreamLabel({ codec: 'MP3', bitrate: 0 }), 'MP3');
  assert.equal(compactStreamLabel({ codec: '', bitrate: 128 }), '128k');
  assert.equal(compactStreamLabel({ hls: true, bitrate: 6221 }), 'HLS 6.22M');
  assert.equal(compactStreamLabel({ hls: true, bitrate: 600 }), 'HLS 600k');
  assert.equal(compactStreamLabel({ hls: true }), 'HLS');
  assert.equal(compactStreamLabel({}), '');
});

class Node extends FakeElement {
  constructor(id = '', tag = 'div') {
    super(id, tag);
    this.parentNode = null;
    this.html = '';
  }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.length; }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = value;
    if (value === '') for (const child of [...this.children]) this.removeChild(child);
  }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') {
      for (const node of [...child.children]) this.appendChild(node);
      return child;
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll(selector) {
    return selector === '.card' ? this.children.filter((node) => node.className?.startsWith('card')) : [];
  }
}

test('Library cards: the full stream tooltip and a separate metadata row update in place', (t) => {
  withStorage(t);
  // __contentHidden keeps these cards from asking the artwork relay for logos.
  withFavorites(t, [
    { id: 'fav:a', title: 'Alpha', type: 'radio', source: 'playlist', __contentHidden: true },
    { id: 'fav:b', title: 'Beta', type: 'tv', source: 'iptv-org', license: 'See provider terms', __contentHidden: true },
  ]);
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const before = { source: view.activeSource, filters: { ...view.personalFilters.favorites }, signature: view.renderSignature };
  const host = new Node('', 'div');
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node('', tag),
    createDocumentFragment: () => new Node('', 'fragment'),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  ui.resultsHost = host;
  ui.windowBack = null;
  ui.sentinelStatus = null;
  renderedIds.clear();
  view.activeSource = 'favorites';
  view.personalFilters.favorites = { query: '', type: '' };
  t.after(() => {
    renderedIds.clear();
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    view.activeSource = before.source;
    view.personalFilters.favorites = before.filters;
    view.renderSignature = before.signature;
  });

  rememberPlayedStream('fav:a', { codec: 'MP3', bitrate: 128 });
  renderResults();
  const [alpha, beta] = host.children;
  assert.equal(alpha.__open.getAttribute('title'), `Alpha\nStream: MP3 ${DOT} 128 kbps`);
  assert.equal(alpha.__titleNode.getAttribute('title'), `Alpha\nStream: MP3 ${DOT} 128 kbps`);
  const radioQuality = alpha.__quality;
  assert.equal(radioQuality.className, 'card-quality');
  assert.equal(radioQuality.parentNode, alpha.__meta);
  assert.equal(radioQuality.textContent, `MP3 ${DOT} 128 kbps`);
  assert.equal(beta.__quality, null);
  assert.equal(beta.__open.getAttribute('title'), 'Beta');
  const license = beta.__meta.children.find((child) => child.className === 'card-license');
  assert.equal(license.getAttribute('title'), 'See provider terms');

  rememberPlayedStream('fav:b', { hls: true, width: 1920, height: 1080, videoCodec: 'H.264', frameRate: 50, bitrate: 6221 });
  syncStreamLabels();
  assert.deepEqual(host.children, [alpha, beta]);
  const videoLabel = ['HLS', '1080p', '50 fps', 'H.264', '6.22 Mbps'].join(` ${DOT} `);
  const videoQuality = beta.__quality;
  assert.deepEqual(beta.__meta.children.slice(-2), [license, videoQuality]);
  assert.equal(videoQuality.textContent, videoLabel);
  assert.equal(videoQuality.getAttribute('title'), `Stream: ${videoLabel}`);
  assert.equal(beta.__open.getAttribute('title'), `Beta\nStream: ${videoLabel}`);
  syncStreamLabels();
  assert.equal(beta.__quality, videoQuality);

  clearPlayedStreams();
  syncStreamLabels();
  assert.equal(alpha.__quality, null);
  assert.equal(alpha.__open.getAttribute('title'), 'Alpha');
  assert.equal(radioQuality.parentNode, null);
  assert.equal(license.parentNode, beta.__meta);
});

test('Tuner radio metadata stays on the same line and updates in place', (t) => {
  withStorage(t);
  const content = new Node('', 'div');
  const pill = new Node('', 'div');
  const sourceLine = pill.appendChild(new Node('', 'small'));
  pill.__sourceLine = sourceLine;
  pill.__station = { id: 'fav:a', title: 'Alpha', source: 'playlist', type: 'radio', country: 'us' };
  pill.__saved = true;
  content.appendChild(pill);

  for (const [facts, expected] of [
    [{ codec: 'MP3', bitrate: 128 }, 'MP3 128k'],
    [{ codec: 'MP3', bitrate: 192 }, 'MP3 192k'],
    [{ codec: 'AAC+', bitrate: 0 }, 'AAC+'],
    [{ codec: '', bitrate: 128 }, '128k'],
  ]) {
    rememberPlayedStream('fav:a', facts);
    syncTunerMarks(content);
    assert.deepEqual(content.children, [pill]);
    assert.deepEqual(pill.children, [sourceLine]);
    assert.equal(sourceLine.textContent, `My Playlists ${DOT} US ${DOT} ${expected}`);
    assert.match(pill.getAttribute('title'), /\nStream: /);
  }
  assert.match(pill.getAttribute('title'), /\nStream: 128 kbps$/);
  clearPlayedStreams();
  syncTunerMarks(content);
  assert.equal(sourceLine.textContent, `My Playlists ${DOT} US`);
  assert.doesNotMatch(pill.getAttribute('title'), /Stream:/);
});

test('technical stream details use a full-width row with up to two lines', async () => {
  const [libraryCss, settings, tuner, index] = await Promise.all([
    read('src/styles/library.css'), read('src/lib/settings.js'),
    read('src/modes/tuner.js'), read('src/modes/library/index.js'),
  ]);
  assert.match(libraryCss, /:root:not\(\[data-tech-details="on"\]\) :is\(\.card-license, \.card-quality\) \{ display: none; \}/);
  assert.match(libraryCss, /\.card-body \{[^}]*grid-template-rows: 18px auto;/);
  assert.match(libraryCss, /\.card-meta \{[^}]*column-gap: 6px;/);
  assert.match(libraryCss,
    /:root\[data-tech-details="on"\] \.library-root\.is-personal-view \.card-meta:has\(> \.card-quality\) \{\s*row-gap: 0;/);
  assert.match(libraryCss,
    /:root\[data-tech-details="on"\] \.library-root\.is-personal-view \.card-body:has\(\.card-quality\) \{\s*padding-block: 6px;/);
  const quality = libraryCss.match(/\.card-quality \{([^}]*)\}/)[1];
  assert.match(quality, /grid-column: 1 \/ -1;/);
  assert.match(quality, /display: -webkit-box;\s*-webkit-box-orient: vertical;\s*-webkit-line-clamp: 2;/);
  assert.match(quality, /overflow: hidden;/);
  assert.match(quality, /line-height: 16px;/);
  assert.doesNotMatch(quality, /white-space: nowrap;|(?:^|\n)\s*(?:min-|max-)?height:/);
  assert.match(libraryCss,
    /:root\[data-tech-details="on"\] \.library-root\.is-personal-view \.card-quality \{ flex: 0 0 100%; \}/);
  assert.match(settings, /stream format and bitrate \(such as MP3 · 128 kbps\) once a station has played/);
  assert.doesNotMatch(settings, /full source badges/);
  // A change shows at once, without rebuilding the station list.
  assert.match(tuner, /subs\.push\(onPlayedStreamChange\(\(\) => \{\s*if \(getState\(\)\.mode === 'tuner'\) syncTunerMarks\(\);/);
  assert.match(index, /subs\.push\(onPlayedStreamChange\(\(\) => \{ syncStreamLabels\(\); refreshDetailQuality\(\); \}\)\);/);
});
