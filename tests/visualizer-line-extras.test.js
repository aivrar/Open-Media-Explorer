import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LINE_MAX_SEGMENTS, LINE_QUALITY, createLineGlowLines, lineStatsNow,
} from '../src/visualizer/line-host.js';
import * as lineHost from '../src/visualizer/line-host.js';
import { PROCESSOR_USE_LEVELS, processorExtras } from '../src/lib/processor-budget.js';

/* The line scenes' segment limit: High's own at every Processor use level
   (none of the five offered was cut at 12000 on the test machine, so no
   level raises it), and the counts the measuring page reads. No GPU. */

function drawer(quality) {
  const made = [];
  const fake = () => ({
    GlowLines: {
      NATIVE_PALETTES: ['a'],
      BACKGROUNDS: ['b'],
      create: () => ({
        init() {}, cleanup() {}, getSegments: () => 0, hasResources: () => false,
        render: (gl, segs, count) => made.push(count),
      }),
    },
  });
  const lines = createLineGlowLines({ Renderer: { getCanvas: () => ({}), bindFramebuffer() {} }, sceneQuality: () => quality.now }, fake);
  return { lines, made, one: lines.create() };
}

test('the segment limit: each quality its own, never over High\'s, and the counts kept', () => {
  const quality = { now: 'high' };
  const { lines, made, one } = drawer(quality);
  const segs = new Float32Array(6);
  one.render(null, segs, 50000, {});
  assert.equal(made.at(-1), LINE_MAX_SEGMENTS);
  assert.equal(LINE_MAX_SEGMENTS, LINE_QUALITY.high.segments);
  one.render(null, segs, 9000, {});
  assert.equal(made.at(-1), 9000, 'under it: all of it');
  quality.now = 'medium';
  one.render(null, segs, 50000, {});
  assert.equal(made.at(-1), LINE_QUALITY.medium.segments);
  quality.now = 'very_high';
  one.render(null, segs, 50000, {});
  assert.equal(made.at(-1), LINE_MAX_SEGMENTS, 'nothing above High\'s limit');
  assert.deepEqual(lineStatsNow(), { frames: 4, segments: LINE_MAX_SEGMENTS, cut: 3 });
  assert.equal(lineStatsNow(), lines.stats, 'the stats of the line scene made last');
});

test('no level raises the segment limit', () => {
  assert.equal('setLineSegmentsAboveHigh' in lineHost, false);
  for (const level of PROCESSOR_USE_LEVELS) {
    for (const released of [false, true]) assert.equal('lineSegments' in processorExtras(level, released), false, level);
  }
});
