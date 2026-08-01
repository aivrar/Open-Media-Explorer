import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EQ_FILTER_Q,
  EQ_FILTER_TYPES,
  EQ_FREQUENCIES,
  AudioEngine,
  computeEqResponseDb,
  dbToGain,
} from '../src/lib/audio-engine.js';

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  setValueAtTime(value, time) { this.value = value; this.events.push(['value', value, time]); }
  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.events.push(['target', value, time, constant]);
  }
}

class FakeNode {
  constructor(kind) { this.kind = kind; this.outputs = []; this.disconnects = 0; }
  connect(target) { this.outputs.push(target); return target; }
  disconnect() { this.disconnects++; }
}

class FakeContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 1.25;
    this.sampleRate = 48000;
    this.destination = new FakeNode('destination');
    this.gains = [];
    this.filters = [];
    this.sources = [];
    this.sourceElements = new Set();
    this.compressor = null;
    this.analyser = null;
  }
  createGain() {
    const node = new FakeNode('gain');
    node.gain = new FakeParam(1);
    this.gains.push(node);
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode('biquad');
    node.frequency = new FakeParam();
    node.Q = new FakeParam();
    node.gain = new FakeParam();
    this.filters.push(node);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode('compressor');
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[name] = new FakeParam();
    this.compressor = node;
    return node;
  }
  createAnalyser() {
    const node = new FakeNode('analyser');
    node.fftSize = 0;
    node.smoothingTimeConstant = 0;
    node.sampleValue = 0;
    node.getFloatTimeDomainData = (data) => data.fill(node.sampleValue);
    this.analyser = node;
    return node;
  }
  createMediaElementSource(element) {
    if (this.sourceElements.has(element)) throw new Error('duplicate media source');
    this.sourceElements.add(element);
    const node = new FakeNode('source');
    node.element = element;
    this.sources.push(node);
    return node;
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

const media = (id) => ({ id, paused: false, ended: false });

test('one context builds the approved EQ topology and one source per media element', async () => {
  const context = new FakeContext();
  const statuses = [];
  const engine = new AudioEngine({ contextFactory: () => context, onStatus: (status) => statuses.push(status) });
  const audio = media('audio');
  const video = media('video');
  const curve = { preamp: -3, bands: [6, 5, 4, 3, 2, 1, 0, -1, -2, -3] };

  const first = await engine.attachElement(audio, { curve });
  const repeated = await engine.attachElement(audio, { curve });
  const second = await engine.attachElement(video, { curve });

  assert.equal(first.sourceCreated, true);
  assert.equal(repeated.sourceCreated, false);
  assert.equal(second.sourceCreated, true);
  assert.equal(context.sources.length, 2);
  assert.equal(engine.getStatus().sourceCount, 2);
  assert.equal(context.filters.length, 10);
  assert.deepEqual(context.filters.map((filter) => filter.type), EQ_FILTER_TYPES);
  assert.deepEqual(context.filters.map((filter) => filter.frequency.value), EQ_FREQUENCIES);
  assert.deepEqual(context.filters.map((filter) => filter.Q.value), [1, ...Array(8).fill(EQ_FILTER_Q), 1]);

  const { input, dry, preamp, bands, compressor, wet, analyser } = engine.graph;
  assert.deepEqual(input.outputs, [dry, preamp]);
  assert.equal(preamp.outputs[0], bands[0]);
  for (let index = 0; index < bands.length - 1; index++) {
    assert.equal(bands[index].outputs[0], bands[index + 1]);
  }
  assert.equal(bands.at(-1).outputs[0], compressor);
  assert.equal(compressor.outputs[0], wet);
  assert.deepEqual(dry.outputs, [analyser]);
  assert.deepEqual(wet.outputs, [analyser]);
  assert.deepEqual(analyser.outputs, [context.destination]);
  assert.ok(context.sources.every((source) => source.outputs.length === 1 && source.outputs[0] === input));
  assert.equal(compressor.threshold.value, -3);
  assert.equal(compressor.ratio.value, 20);
  assert.equal(analyser.fftSize, 2048);
  assert.equal(statuses.at(-1).state, 'ready');
});

test('curve updates are smoothed and true bypass retains the wet curve', async () => {
  const context = new FakeContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  await engine.attachElement(media('audio'));
  const curve = { preamp: -4, bands: [8, 6, 4, 2, 0, -2, -4, -6, -8, -10] };
  engine.applyCurve(curve);

  assert.equal(engine.graph.preamp.gain.events.at(-1)[0], 'target');
  assert.ok(Math.abs(engine.graph.preamp.gain.value - dbToGain(-4)) < 1e-9);
  assert.deepEqual(engine.graph.bands.map((filter) => filter.gain.value), curve.bands);
  engine.setBypassed(true);
  assert.equal(engine.graph.dry.gain.value, 1);
  assert.equal(engine.graph.wet.gain.value, 0);
  assert.deepEqual(engine.getStatus().curve.bands, curve.bands);
  engine.setBypassed(false);
  assert.equal(engine.graph.dry.gain.value, 0);
  assert.equal(engine.graph.wet.gain.value, 1);
});

test('local response measurements are flat, frequency-selective, bounded, and bypassable', () => {
  const probes = [31, 62, 125, 1000, 4000, 8000, 16000];
  const flat = [...computeEqResponseDb({ preamp: 0, bands: Array(10).fill(0) }, probes)];
  assert.ok(flat.every((value) => Math.abs(value) < 0.001));

  const bass = [...computeEqResponseDb({ preamp: 0, bands: [12, 8, 4, 0, 0, 0, 0, 0, 0, 0] }, probes)];
  // A shelf is at half its requested dB gain at its corner frequency; the
  // neighboring 62/125 Hz bands add further selective lift here.
  assert.ok(bass[0] > 6, `expected bass boost at 31 Hz, got ${bass[0]}`);
  assert.ok(Math.abs(bass.at(-1)) < 0.5, `expected little 16 kHz change, got ${bass.at(-1)}`);

  const vocal = [...computeEqResponseDb({ preamp: -2, bands: [0, 0, 0, 0, 0, 12, 0, 0, 0, 0] }, probes)];
  assert.ok(vocal[3] > 8, `expected 1 kHz boost, got ${vocal[3]}`);
  const bypassed = [...computeEqResponseDb({ preamp: 6, bands: Array(10).fill(12), bypassed: true }, probes)];
  assert.deepEqual(bypassed, Array(probes.length).fill(0));
});

test('analyser verification distinguishes signal, cancellation, and sustained silence', async () => {
  const context = new FakeContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  const element = media('audio');
  await engine.attachElement(element);
  context.analyser.sampleValue = 0.02;
  assert.equal(await engine.verifySignal(element, { attempts: 1 }), true);
  context.state = 'suspended';
  assert.equal(await engine.verifySignal(element, { attempts: 1 }), true);
  assert.equal(context.state, 'running');
  assert.equal(await engine.verifySignal(element, { attempts: 1, isCurrent: () => false }), null);
  element.muted = true;
  context.analyser.sampleValue = 0;
  assert.equal(await engine.verifySignal(element, { attempts: 1 }), null);
  element.muted = false;
  context.analyser.sampleValue = 0;
  assert.equal(await engine.verifySignal(element, { attempts: 2, intervalMs: 0, sleepImpl: async () => {} }), false);
  assert.equal(engine.getStatus().state, 'ready');
  assert.equal(engine.getStatus().reason, '');
});

test('unavailable Web Audio leaves an unattached media element safe for direct playback', async () => {
  const error = new Error('unsupported');
  error.code = 'AUDIO_CONTEXT_UNAVAILABLE';
  const engine = new AudioEngine({ contextFactory: () => { throw error; } });
  const element = media('audio');
  const result = await engine.attachElement(element);
  assert.equal(result.processed, false);
  assert.equal(result.attached, false);
  assert.equal(engine.isAttached(element), false);
  assert.equal(engine.getStatus().state, 'unavailable');
});

test('context creation stays lazy and rapid curve/source churn remains bounded and duplicate-free', async () => {
  const context = new FakeContext();
  let factoryCalls = 0;
  const engine = new AudioEngine({ contextFactory: () => { factoryCalls++; return context; } });
  for (let index = 0; index < 100; index++) {
    engine.applyCurve({ preamp: -index, bands: Array(10).fill(index) });
  }
  assert.equal(factoryCalls, 0, 'curve persistence alone must not start Web Audio');

  const audio = media('audio');
  const video = media('video');
  await Promise.all([
    engine.attachElement(audio), engine.attachElement(audio), engine.attachElement(video),
  ]);
  const started = performance.now();
  for (let index = 0; index < 5000; index++) {
    engine.applyCurve({
      preamp: (index % 19) - 12,
      bands: Array.from({ length: 10 }, (_, band) => ((index + band) % 25) - 12),
    });
  }
  const elapsed = performance.now() - started;
  assert.equal(factoryCalls, 1);
  assert.equal(context.sources.length, 2);
  assert.equal(engine.getStatus().sourceCount, 2);
  assert.ok(elapsed < 1000, `5000 smoothed curve updates took ${elapsed.toFixed(1)} ms`);
});
