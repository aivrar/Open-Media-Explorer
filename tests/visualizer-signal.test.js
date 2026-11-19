import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAX_DT, createAudioSignal, nextSubscriberDue, subscriberDue,
} from '../src/lib/audio-signal.js';
import { METER_FPS } from '../src/lib/player-meter.js';
import { createClockHarness, fakeAnalyser, fakeVisibilityDoc } from './helpers/signal-harness.js';

/* Slice 0 of the visualizer: the shared sound signal learns per-subscriber
   pacing (a 60 fps visual must not make the 15 fps meter run at 60), an
   opt-in float dB spectrum, a version that moves when the item or element
   changes and a tapVersion that moves when the tap is made again. Everything
   the meter relied on stays as it was. */

const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`,
);

function signalHarness({ node = fakeAnalyser(), playing = true, key = 'a' } = {}) {
  const clock = createClockHarness();
  const vis = fakeVisibilityDoc();
  const source = {
    playing,
    node,
    key,
    releases: 0,
    isPlaying() { return this.playing; },
    isAudible() { return true; },
    getAnalyser() { return this.node; },
    release() { this.releases += 1; },
    getSourceKey() { return this.key; },
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...clock.io });
  return { ...clock, signal, source, vis };
}

test('pacing helpers: due within half a frame, own schedule kept, a late subscriber starts afresh', () => {
  assert.equal(subscriberDue(Number.NaN, 0, 8), true, 'never served: due at once');
  assert.equal(subscriberDue(100, 92, 8), true, 'a refresh slightly early still counts');
  assert.equal(subscriberDue(100, 91, 8), false);
  assert.equal(nextSubscriberDue(Number.NaN, 50, 66.7), 50 + 66.7);
  assert.equal(nextSubscriberDue(100, 110, 66.7), 166.7, 'a little late: the schedule holds (no drift)');
  assert.equal(nextSubscriberDue(100, 98, 66.7), 166.7, 'a little early: same');
  assert.equal(nextSubscriberDue(100, 900, 66.7), 966.7, 'far behind: no burst to catch up');
});

test('a 60 fps subscriber leaves the meter at 15 a second with its own dt; one read per tick is shared', () => {
  const h = signalHarness();
  const meter = [];
  const visual = [];
  h.signal.subscribe((frame) => meter.push(frame.dt), { fps: METER_FPS });
  h.run(1000);
  near(meter.length, METER_FPS, 1, 'meter alone');
  const offVisual = h.signal.subscribe((frame) => visual.push(frame.dt), { fps: 60 });
  const meterBefore = meter.length;
  const reads = h.signal.stats.reads;
  h.run(2000);
  near(h.signal.stats.reads - reads, 120, 3, 'the loop reads at the fastest rate');
  near(visual.length, 120, 3, 'the visual gets 60 a second');
  near(meter.length - meterBefore, 2 * METER_FPS, 1, 'the meter still gets 15 a second');
  // Each consumer sees its own time step, so meter smoothing is unchanged.
  for (const dt of meter.slice(meterBefore + 1)) near(dt, 1 / METER_FPS, 1 / 60 + 1e-6, 'meter dt');
  for (const dt of visual.slice(1)) near(dt, 1 / 60, 1 / 120, 'visual dt');
  assert.equal(visual[0], 0, 'a new subscriber starts with dt 0');
  // One read per tick, never one per subscriber.
  assert.equal(h.signal.stats.reads, h.signal.stats.frames);
  assert.equal(h.counts.maxPending, 1, 'never a timer and a frame at once');
  // At a 144 Hz display it is the same.
  const meter144 = meter.length;
  h.run(1000, 1000 / 144);
  near(meter.length - meter144, METER_FPS, 1, 'meter at 144 Hz');
  // The visual leaves: the loop drops back to the meter rate.
  offVisual();
  const after = h.signal.stats.reads;
  h.run(1000);
  near(h.signal.stats.reads - after, METER_FPS, 1, 'back to 15 reads a second');
  // A minimised window (1 frame a second): both get each throttled frame,
  // dt capped, no pile-up.
  h.signal.subscribe((frame) => visual.push(frame.dt), { fps: 60 });
  const m = meter.length;
  const v = visual.length;
  h.run(5000, 1000);
  near(meter.length - m, 5, 1, 'meter throttled');
  near(visual.length - v, 5, 1, 'visual throttled');
  assert.equal(meter.at(-1), MAX_DT);
  assert.equal(h.counts.maxPending, 1);
});

test('a resting frame and the one "no sound" frame still reach every subscriber at once', () => {
  const h = signalHarness();
  const seenA = [];
  const seenB = [];
  h.signal.subscribe((frame) => seenA.push(frame.running), { fps: 1 });
  h.signal.subscribe((frame) => seenB.push(frame.running), { fps: 60 });
  h.run(200);
  assert.equal(seenA.length, 1, 'the 1 fps subscriber had its first frame only');
  h.source.playing = false;
  h.signal.refresh();
  assert.equal(seenA.at(-1), false, 'the slow subscriber gets the resting frame at once');
  assert.equal(seenB.at(-1), false);
  assert.equal(h.pending(), 0);
  // No readable tap: the inactive frame goes to both, then only the probe runs.
  h.source.node = null;
  h.source.playing = true;
  const a = seenA.length;
  h.signal.refresh();
  h.run(20);
  assert.equal(seenA.length, a + 1);
  assert.equal(h.signal.frame.active, false);
});

test('the float dB spectrum is read only while a due subscriber asked for it', () => {
  const node = fakeAnalyser({ db: -42.5 });
  const h = signalHarness({ node });
  h.signal.subscribe(() => {}, { fps: 60 });
  h.run(1000);
  assert.equal(node.floatCalls, 0, 'nobody asked: never read');
  assert.equal(h.signal.frame.spectrumDb, null);
  // A slow subscriber asks for it: read only on its ticks (15 a second), not 60.
  const got = [];
  const off = h.signal.subscribe((frame) => got.push(frame.spectrumDb), { fps: 15, floatSpectrum: true });
  h.run(1000);
  near(node.floatCalls, 15, 1, 'float reads at the asking subscriber rate');
  assert.equal(h.signal.stats.floatReads, node.floatCalls);
  const db = h.signal.frame.spectrumDb;
  assert.ok(db instanceof Float32Array);
  assert.equal(db.length, 1024);
  assert.ok(got.every((array) => array === db), 'one reused array');
  assert.ok(db.every((value) => value === -42.5), 'absolute dB, not clipped to the byte range');
  // Pause: the resting frame carries silence.
  h.source.playing = false;
  h.signal.refresh();
  assert.ok(db.every((value) => value === Number.NEGATIVE_INFINITY));
  // The last asker leaves: the array is dropped and reads stop.
  h.source.playing = true;
  h.signal.refresh();
  off();
  assert.equal(h.signal.frame.spectrumDb, null);
  const calls = node.floatCalls;
  h.run(1000);
  assert.equal(node.floatCalls, calls);
  // An analyser without getFloatFrequencyData gives silence, not an error.
  const bare = fakeAnalyser();
  delete bare.getFloatFrequencyData;
  const b = signalHarness({ node: bare });
  b.signal.subscribe(() => {}, { floatSpectrum: true });
  b.run(100);
  assert.equal(b.signal.frame.active, true);
  assert.ok(b.signal.frame.spectrumDb.every((value) => value === Number.NEGATIVE_INFINITY));
});

test('version moves only with the item or element; tapVersion moves when the tap is made again', () => {
  const node = fakeAnalyser();
  const h = signalHarness({ node, key: '1:1' });
  assert.equal(h.signal.version, 0, 'nothing read yet');
  assert.equal(h.signal.tapVersion, 0);
  const versions = [];
  h.signal.subscribe((frame) => versions.push([frame.version, frame.tapVersion]), { fps: 30 });
  h.run(500);
  assert.equal(h.signal.version, 1, 'the first read');
  assert.equal(h.signal.tapVersion, 1);
  assert.ok(versions.every(([v, t]) => v === 1 && t === 1), 'steady while the same source plays');
  // A new item or a new element: the key changes, the tap may stay.
  h.source.key = '2:1';
  h.run(100);
  assert.equal(h.signal.version, 2);
  assert.equal(h.signal.tapVersion, 1);
  h.source.key = '2:2';
  h.run(100);
  assert.equal(h.signal.version, 3);
  // Pause and resume: the engine releases the tap and makes a new one. Same
  // item, so a beat detector keeps its tempo (version stays); tapVersion says
  // there was a gap.
  h.source.playing = false;
  h.signal.refresh();
  h.source.node = fakeAnalyser();
  h.source.playing = true;
  h.signal.refresh();
  h.run(100);
  assert.equal(h.signal.version, 3, 'a pause does not move version');
  assert.equal(h.signal.tapVersion, 2, 'the new tap does move tapVersion');
  assert.equal(h.signal.frame.version, 3);
  assert.equal(h.signal.frame.tapVersion, 2);
  // A hidden window does the same.
  h.vis.setVisible(false);
  h.source.node = fakeAnalyser();
  h.vis.setVisible(true);
  h.run(100);
  assert.equal(h.signal.version, 3, 'a hidden window does not move version');
  assert.equal(h.signal.tapVersion, 3);
  // No readable tap for a while (suspended context), then the same tap back.
  const tapNode = h.source.node;
  h.source.node = null;
  h.run(300);
  h.source.node = tapNode;
  h.run(600);
  assert.equal(h.signal.frame.active, true);
  assert.equal(h.signal.version, 3);
  assert.equal(h.signal.tapVersion, 3, 'the same node again is no new tap');
  // A source without getSourceKey: version 1 from the first read and never
  // again; only tapVersion follows the node.
  const plain = createClockHarness();
  let current = fakeAnalyser();
  const signal = createAudioSignal({
    source: { isPlaying: () => true, getAnalyser: () => current }, doc: null, ...plain.io,
  });
  signal.subscribe(() => {});
  plain.run(100);
  assert.equal(signal.version, 1);
  assert.equal(signal.tapVersion, 1);
  current = fakeAnalyser();
  plain.run(100);
  assert.equal(signal.version, 1);
  assert.equal(signal.tapVersion, 2);
});

test('a subscriber re-subscribed by another during dispatch is never skipped and keeps a true dt', () => {
  const h = signalHarness();
  const seen = [];
  const b = (frame) => seen.push(frame.dt);
  // A runs first in each pass and re-subscribes B (same options) every time,
  // after markDue() has already marked B and moved its schedule on.
  h.signal.subscribe(() => { h.signal.subscribe(b, { fps: 15 }); }, { fps: 60 });
  h.signal.subscribe(b, { fps: 15 });
  h.run(2000);
  near(seen.length, 30, 1, 'B still gets 15 a second');
  assert.equal(seen[0], 0, 'its first frame has dt 0');
  for (const dt of seen.slice(1)) near(dt, 1 / 15, 1 / 60 + 1e-6, 'B dt is its own frame step');
  // With a new rate the replacement still gets the frame it was due.
  let rate = 15;
  const c = [];
  const h2 = signalHarness();
  const listener = (frame) => c.push(frame.dt);
  h2.signal.subscribe(() => { rate = rate === 15 ? 20 : 15; h2.signal.subscribe(listener, { fps: rate }); }, { fps: 60 });
  h2.signal.subscribe(listener, { fps: 15 });
  h2.run(2000);
  assert.ok(c.length >= 28, `alternating rates still deliver (${c.length})`);
  assert.ok(c.slice(1).every((dt) => dt > 1 / 25 && dt < 1 / 10), 'every dt covers one of its frames');
});

test('a float spectrum subscriber gets an array of -Infinity even when the first frame has no tap', () => {
  const h = signalHarness({ node: null });
  const got = [];
  h.signal.subscribe((frame) => {
    const db = frame.spectrumDb;
    got.push(db instanceof Float32Array && db.length === frame.spectrum.length
      && db.every((value) => value === Number.NEGATIVE_INFINITY));
  }, { floatSpectrum: true });
  h.run(100);
  assert.equal(h.signal.frame.active, false);
  assert.deepEqual(got, [true], 'the one inactive frame carries an array of -Infinity, not null');
  // Without an asker it stays null, as documented.
  const plain = signalHarness({ node: null });
  const nulls = [];
  plain.signal.subscribe((frame) => nulls.push(frame.spectrumDb));
  plain.run(100);
  assert.deepEqual(nulls, [null]);
});

test('subscribing again changes the rate in place; the old unsubscribe then does nothing', () => {
  const h = signalHarness();
  const seen = [];
  const listener = () => seen.push(h.now);
  const oldOff = h.signal.subscribe(listener, { fps: 15 });
  h.run(1000);
  near(seen.length, 15, 1, 'at 15');
  const off = h.signal.subscribe(listener, { fps: 60 });
  assert.equal(h.signal.subscriberCount, 1, 'still one subscriber');
  const before = seen.length;
  h.run(1000);
  near(seen.length - before, 60, 2, 'now at 60');
  oldOff();
  assert.equal(h.signal.subscriberCount, 1, 'the stale unsubscribe is inert');
  off();
  assert.equal(h.signal.subscriberCount, 0);
  assert.equal(h.pending(), 0);
  assert.equal(h.vis.count(), 0, 'no visibility listener left');
});

test('the player gives the signal a source key that follows items and elements', async () => {
  const player = await readFile(new URL('../src/lib/player.js', import.meta.url), 'utf8');
  assert.match(player, /getSourceKey: \(\) => `\$\{playToken\}:\$\{playback\.generation\}`/);
});
