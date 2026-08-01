import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeMediaElement, createPlayerDom } from './helpers/fake-dom.js';

test('frontend media double emits deterministic playback lifecycle events', async () => {
  const media = new FakeMediaElement('audio-el');
  const events = [];
  for (const name of ['play', 'playing', 'pause', 'emptied']) {
    media.addEventListener(name, () => events.push(name));
  }

  await media.play();
  media.pause();
  media.load();

  assert.equal(media.paused, true);
  assert.deepEqual(events, ['play', 'playing', 'pause', 'emptied']);
});

test('frontend player DOM fixture exposes every baseline control', () => {
  const { elements, document } = createPlayerDom();
  for (const id of [
    'player-bar', 'audio-el', 'video-el', 'player-play', 'icon-play',
    'icon-pause', 'player-stop', 'player-seek', 'player-volume', 'player-fav',
    'player-capture', 'player-capture-secondary', 'player-capture-status',
    'player-capture-progress', 'player-capture-announcement', 'player-eq',
  ]) {
    assert.equal(document.getElementById(id), elements[id]);
  }
  assert.equal(elements['icon-pause'].hidden, true);
  assert.equal(elements['player-seek'].disabled, true);
});
