import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlaybackState } from '../src/lib/player-state.js';

test('playback ownership is element-specific and generation-specific', () => {
  const state = createPlaybackState();
  const audio = { id: 'audio' };
  const video = { id: 'video' };

  const audioGeneration = state.activate(audio);
  assert.equal(state.activeElement, audio);
  assert.equal(state.owns(audio, audioGeneration), true);

  const videoGeneration = state.activate(video);
  assert.ok(videoGeneration > audioGeneration);
  assert.equal(state.owns(audio, audioGeneration), false);
  assert.equal(state.owns(video, videoGeneration), true);

  const invalidatedGeneration = state.invalidate();
  assert.ok(invalidatedGeneration > videoGeneration);
  assert.equal(state.activeElement, null);
  assert.equal(state.owns(video, videoGeneration), false);
});

test('playback ownership rejects missing active elements', () => {
  const state = createPlaybackState();
  assert.throws(() => state.activate(null), /active media element is required/);
});
