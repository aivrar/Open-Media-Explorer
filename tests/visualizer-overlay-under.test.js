import test from 'node:test';
import assert from 'node:assert/strict';

import { OVERLAY_IDS, overlayRow, overlaysDrawnFor } from '../src/visualizer/overlay-catalog.js';
import { sceneById } from '../src/visualizer/scenes.js';

// Measured under Mirror (Kaleidoscope), with Swirl at Strong and alone at
// Strong: these stepped by 0.10 and more with their light copied round the
// picture.
const NOT_UNDER = Object.freeze(['cinematic', 'fireworks', 'lasers', 'lightning', 'spectrum', 'spotlights']);

test('overlays that may not go under the effects: Cinematic, and Fireworks, Lasers, Lightning, Spectrum and Stage Lights', () => {
  assert.deepEqual(OVERLAY_IDS.filter((id) => overlayRow(id).under === false).sort(), [...NOT_UNDER].sort());
  const starfield = sceneById('starfield');
  for (const id of ['fireworks', 'lasers', 'lightning', 'spectrum', 'spotlights']) {
    for (const mode of overlayRow(id).blends) {
      const [drawn] = overlaysDrawnFor(starfield, [{ id, blend: { mode, under: true, mask: 'none', tint: false, bend: false } }]);
      assert.equal(drawn.blend.under, false, `${id} ${mode}`);
      assert.equal(drawn.blend.mode, mode, `${id} keeps ${mode} over the effects`);
    }
  }
  for (const id of ['bokeh', 'hexgrid', 'tri_grid', 'starburst', 'color_strobe']) {
    const [drawn] = overlaysDrawnFor(starfield, [{ id, blend: { mode: 'screen', under: true, mask: 'none', tint: false, bend: false } }]);
    assert.equal(drawn.blend.under, true, `${id} may still go under`);
  }
});

test('Voronoi Cells does not get Mirror (its Kaleidoscope mode alone stepped by 0.102 there)', () => {
  const voronoi = sceneById('voronoi');
  assert.deepEqual([...voronoi.fxLeftOut], ['mirror']);
  assert.equal(voronoi.fxCalm, false);
});
