import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERLAY_BLEND_MAX_PIXELS, OVERLAY_BLEND_SCALE, OVERLAY_LINE_PARAMS, OVERLAY_SIZE_720_PARAMS, OVERLAY_SIZE_720_RELEASED,
  OVERLAY_TOP_MAX_PIXELS, overlaySizeUnit, overlaySizedParams,
} from '../src/visualizer/overlay-catalog.js';

// The tab's picture sizes in a 1920 x 1080 window (scenes.js).
const PICTURES = { low: [1003, 531], medium: [1504, 797], high: [2005, 1063] };
const sheetHeight = (quality, kind) => {
  const [w, h] = PICTURES[quality];
  const scale = kind === 'top'
    ? Math.min(1, Math.sqrt(OVERLAY_TOP_MAX_PIXELS[quality] / (w * h)))
    : Math.min(OVERLAY_BLEND_SCALE[quality], Math.sqrt(OVERLAY_BLEND_MAX_PIXELS[quality] / (w * h)));
  return Math.floor(h * scale);
};
// A setting of 1 as pixels on the screen (the tab is 1063 pixels high).
const onScreen = (quality, kind, size720) => {
  const h = PICTURES[quality][1];
  const sheet = sheetHeight(quality, kind);
  return overlaySizeUnit(sheet, h, size720) * (1063 / sheet);
};

test('overlay sizes: held, the scaling is exactly as before', () => {
  assert.equal(OVERLAY_SIZE_720_RELEASED, false);
  // The sheet's share of the picture, at most 1; 1 when a size is unknown.
  assert.equal(overlaySizeUnit(363, 531), 363 / 531);
  assert.equal(overlaySizeUnit(800, 600), 1);
  assert.equal(overlaySizeUnit(0, 531), 1);
  assert.equal(overlaySizeUnit(363, 0), 1);
  for (const id of Object.keys({ ...OVERLAY_LINE_PARAMS, ...OVERLAY_SIZE_720_PARAMS })) {
    assert.deepEqual(overlaySizedParams(id), OVERLAY_LINE_PARAMS[id] || [], id);
  }
  // A width is a different share of the screen at each quality.
  const low = onScreen('low', 'top', false);
  const high = onScreen('high', 'top', false);
  assert.ok(low > high * 1.9, `${low} ${high}`);
});

test('overlay sizes: with the switch, one unit is a 720th of the picture, never under a pixel of it', () => {
  // A 720th of the picture's height on the screen, from 720 lines up.
  for (const quality of ['medium', 'high']) {
    for (const kind of ['top', 'blend']) {
      assert.ok(Math.abs(onScreen(quality, kind, true) - 1063 / 720) < 1e-9, `${quality} ${kind}`);
    }
  }
  // Under 720 lines: one pixel of the picture, as today.
  assert.equal(overlaySizeUnit(363, 531, true), overlaySizeUnit(363, 531, false));
  // The changes listed for the re-measure (plain sheet; the blend sheet scales alike).
  const ratio = (quality) => overlaySizeUnit(sheetHeight(quality, 'top'), PICTURES[quality][1], true)
    / overlaySizeUnit(sheetHeight(quality, 'top'), PICTURES[quality][1], false);
  assert.equal(ratio('low').toFixed(2), '1.00');
  assert.equal(ratio('medium').toFixed(2), '1.11');
  assert.equal(ratio('high').toFixed(2), '1.48');
  // Particles' Size joins the scaled settings (unscaled today: x the unit).
  assert.deepEqual(overlaySizedParams('particles', true), ['particle_size']);
  assert.deepEqual(overlaySizedParams('plexus', true), OVERLAY_LINE_PARAMS.plexus);
  assert.equal(overlaySizeUnit(sheetHeight('low', 'top'), 531, true).toFixed(2), '0.68');
  assert.equal(overlaySizeUnit(sheetHeight('medium', 'top'), 797, true).toFixed(2), '0.71');
  assert.equal(overlaySizeUnit(sheetHeight('high', 'top'), 1063, true).toFixed(2), '0.96');
});

test('overlay sizes: lasers and the overlays that scale by 720 themselves are not in the list', () => {
  for (const id of ['lasers', 'laser_room', 'matrix', 'hexgrid', 'sacred']) {
    assert.deepEqual(overlaySizedParams(id, true), [], id);
  }
});
