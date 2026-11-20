import test from 'node:test';
import assert from 'node:assert/strict';

import { shuffleCostFor } from '../src/lib/processor-budget.js';
import { normalizeSettings } from '../src/lib/state.js';
import { DEFAULT_VISUALIZER_SHUFFLE_COST, VISUALIZER_SHUFFLE_COSTS } from '../src/lib/visualizer-settings.js';
import { costFilterMax, createShuffle, seededRandom } from '../src/visualizer/shuffle.js';
import { SCENES, sceneById } from '../src/visualizer/scenes.js';

test('the default cost filter stays at medium on Light and widens to all at Balanced and High', () => {
  assert.equal(DEFAULT_VISUALIZER_SHUFFLE_COST, 'medium');
  assert.equal(shuffleCostFor('medium', { level: 'light' }), 'medium');
  assert.equal(shuffleCostFor('medium', {}), 'medium', 'no level: as Light');
  assert.equal(shuffleCostFor('medium', { level: 'nonsense' }), 'medium');
  assert.equal(shuffleCostFor('medium', { level: 'balanced' }), 'all');
  assert.equal(shuffleCostFor('medium', { level: 'high' }), 'all');
});

test('a cost filter picked by hand is kept at every level', () => {
  for (const level of ['light', 'balanced', 'high']) {
    for (const cost of VISUALIZER_SHUFFLE_COSTS) {
      assert.equal(shuffleCostFor(cost, { level, picked: true }), cost, `${level} ${cost}`);
    }
    assert.equal(shuffleCostFor('light', { level }), 'light', 'not the default: kept');
  }
});

test('the picked flag is a setting, off by default, kept only when true', () => {
  assert.equal(normalizeSettings({}).visualizerShuffleCostPicked, false);
  assert.equal(normalizeSettings({ visualizerShuffleCostPicked: true }).visualizerShuffleCostPicked, true);
  assert.equal(normalizeSettings({ visualizerShuffleCostPicked: 'yes' }).visualizerShuffleCostPicked, false);
});

test('at Balanced the shuffle may pick heavy scenes; at Light it may not', () => {
  const shuffle = createShuffle({ scenes: SCENES, random: seededRandom(3) });
  const heavy = (level) => shuffle.poolOf({ pool: 'all', costMax: costFilterMax(shuffleCostFor('medium', { level })) })
    .filter((id) => sceneById(id).cost === 'heavy');
  assert.deepEqual(heavy('light'), []);
  assert.ok(heavy('balanced').length > 0);
});
