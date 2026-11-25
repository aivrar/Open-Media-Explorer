import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSSFADE_MS, CROSSFADE_SLOW_MS, CROSSFADE_STRETCH_MS, CROSSFADE_STRETCH_POLL_MS, createTransition,
} from '../src/visualizer/transition.js';
import { DENSITY_LAB_IDS, DENSITY_READY_MEAN } from '../src/visualizer/accumulating-scenes.js';
import {
  createDensityRenderer, densityPictureCount, densityShownMean, sampledMean,
} from '../src/visualizer/density-host.js';
import { createClockHarness } from './helpers/signal-harness.js';

/* The cross-fade into a density lab: stretched until the lab's picture is
   there (its mean brightness as shown reaches DENSITY_READY_MEAN) or
   CROSSFADE_STRETCH_MS, then the rest at the normal pace. Fake clocks. */

function build({ animate = true, enabled = true, charge = true } = {}) {
  const h = createClockHarness();
  const canvas = { width: 8, height: 8, style: {} };
  const animations = [];
  const fade = {
    hidden: true, width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage() {}, globalAlpha: 1, fillStyle: '' }),
    ...(animate ? {
      animate: (frames, options) => {
        const animation = { frames, options, at: h.io.clock(), cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation);
        return animation;
      },
    } : {}),
  };
  const transition = createTransition({
    canvas, fade, setTimer: h.io.setTimer, clearTimer: h.io.clearTimer, clock: h.io.clock,
    brightness: () => 1, enabled: () => enabled, drawOld: () => true, charge: () => charge,
  });
  /** The snapshot's opacity at the clock now, from the animations made. */
  const opacity = () => {
    const last = animations.at(-1);
    if (!last || fade.hidden) return 0;
    const t = Math.min(1, (h.io.clock() - last.at) / last.options.duration);
    return last.frames[0].opacity + (last.frames[1].opacity - last.frames[0].opacity) * t;
  };
  return { h, fade, transition, animations, opacity };
}

test('stretched: no picture, the snapshot fades over CROSSFADE_STRETCH_MS and is gone at its end', () => {
  const { h, transition, animations, fade } = build();
  let asks = 0;
  assert.equal(transition.begin({ ready: () => { asks += 1; return false; } }), 0);
  assert.equal(transition.stretching, true);
  assert.equal(animations[0].options.duration, CROSSFADE_STRETCH_MS);
  h.run(CROSSFADE_STRETCH_MS - 1);
  assert.equal(transition.phase, 'fading');
  assert.ok(asks >= CROSSFADE_STRETCH_MS / CROSSFADE_STRETCH_POLL_MS - 2, String(asks));
  h.run(2);
  assert.equal(transition.phase, 'idle');
  assert.equal(fade.hidden, true);
  assert.equal(transition.stretching, false);
  const before = asks;
  h.run(1000);
  assert.equal(asks, before, 'no asking after the end');
});

test('stretched: once the picture is there, the rest at the normal pace, never a jump, never under CROSSFADE_MS in all', () => {
  for (const readyAt of [100, 1000, 3000]) {
    const { h, transition, animations, opacity } = build();
    transition.begin({ ready: () => h.io.clock() >= readyAt });
    let last = 1;
    let biggest = 0;
    let end = null;
    for (let t = 0; t <= CROSSFADE_STRETCH_MS + 100; t += 10) {
      h.run(10);
      const now = opacity();
      biggest = Math.max(biggest, last - now);
      assert.ok(now <= last + 1e-9, `${readyAt}: only down`);
      last = now;
      if (end === null && transition.phase === 'idle') end = h.io.clock();
    }
    assert.equal(animations.length, 2, `${readyAt}: one change of pace`);
    assert.ok(Math.abs(animations[1].frames[0].opacity - (1 - animations[1].at / CROSSFADE_STRETCH_MS)) < 0.01, `${readyAt}: from where it was`);
    // At the normal pace or slower: no more than 10 ms of a CROSSFADE_MS fade each 10 ms.
    assert.ok(biggest <= 10 / CROSSFADE_MS + 0.02, `${readyAt}: ${biggest}`);
    assert.ok(end >= CROSSFADE_MS, `${readyAt}: ${end} in all`);
    assert.ok(end <= readyAt + CROSSFADE_STRETCH_POLL_MS + CROSSFADE_MS + 20, `${readyAt}: ends soon after the picture is there (${end})`);
    assert.deepEqual(transition.stats.readyAfter.length, 1);
  }
});

test('stretched: a change asked for meanwhile ends the stretch, waits the rest at the normal pace; finishNow stops asking', () => {
  const a = build();
  a.transition.begin({ ready: () => false });
  a.h.run(1000);
  const wait = a.transition.begin();
  assert.ok(wait > 0 && wait <= CROSSFADE_MS, String(wait));
  assert.equal(a.transition.stretching, false);
  a.h.run(wait + 1);
  assert.equal(a.transition.phase, 'idle');
  assert.equal(a.transition.begin(), 0, 'the next change goes ahead');
  // Leaving: ended at once, nothing more asked.
  const b = build();
  let asks = 0;
  b.transition.begin({ ready: () => { asks += 1; return false; } });
  b.h.run(500);
  b.transition.finishNow();
  const seen = asks;
  b.h.run(5000);
  assert.equal(asks, seen);
  assert.equal(b.transition.phase, 'idle');
  assert.equal(b.fade.hidden, true);
});

test('stretched only as a cross-fade: not with reduced motion or a still picture (a cut), nor a dip; the slow pace kept', () => {
  const cut = build({ enabled: false });
  assert.equal(cut.transition.begin({ ready: () => false }), 0);
  assert.equal(cut.transition.stretching, false);
  assert.equal(cut.transition.stats.cuts, 1);
  const dip = build({ animate: false });
  assert.ok(dip.transition.begin({ ready: () => false }) > 0);
  assert.equal(dip.transition.stretching, false);
  assert.equal(dip.transition.stats.dips, 1);
  const slow = build({ charge: false });
  slow.transition.begin({ ready: () => slow.h.io.clock() >= 200 });
  assert.equal(slow.animations[0].options.duration, CROSSFADE_STRETCH_MS);
  slow.h.run(5000);
  assert.ok(slow.animations[1].options.duration >= CROSSFADE_SLOW_MS * 0.9, 'the slow pace');
  const plain = build();
  plain.transition.begin();
  assert.equal(plain.animations[0].options.duration, CROSSFADE_MS, 'other scenes: as before');
  assert.equal(plain.transition.stretching, false);
});

test('the density picture shown: its sampled mean brightness times how far it has faded in, only for a picture made after the change began', () => {
  const view = new Uint8Array(4 * 100);
  for (let i = 0; i < 100; i += 1) view.set(i < 50 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  assert.ok(Math.abs(sampledMean(view) - 0.5) < 1e-9);
  assert.equal(sampledMean(new Uint8Array(0)), 0);
  const after = densityPictureCount();
  assert.equal(densityShownMean(after), 0, 'none made yet');
  const picture = createDensityRenderer({ Renderer: {} }, { startWorker: () => null }).create();
  assert.equal(densityPictureCount(), after + 1);
  assert.equal(densityShownMean(after), 0, 'nothing received');
  picture.front.has = true;
  picture.front.mean = 0.4;
  picture.mix = 0.25;
  assert.ok(Math.abs(densityShownMean(after) - 0.1) < 1e-9);
  assert.equal(densityShownMean(after + 1), 0, 'a picture made before does not count');
});

test('the tab stretches the fade into the density labs only, judged by DENSITY_READY_MEAN', () => {
  assert.deepEqual([...DENSITY_LAB_IDS], ['attractor_density_lab', 'buddhabrot_lab', 'flam3_density_lab']);
  assert.equal(DENSITY_READY_MEAN, 0.05);
  const tab = readFileSync(new URL('../src/visualizer/index.js', import.meta.url), 'utf8');
  assert.match(tab, /transition\.begin\(\{ \.\.\.densityFadeFor\(id\), dissolve \}\)/);
  assert.match(tab, /if \(!DENSITY_LAB_IDS\.includes\(id\)\) return \{\};/);
  assert.match(tab, /return \{ ready: \(\) => densityShownMean\(after\) >= DENSITY_READY_MEAN \};/);
});
