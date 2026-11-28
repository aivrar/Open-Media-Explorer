import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAbout } from '../src/modes/about.js';
import { FakeNodeEl } from './helpers/visualizer-fakes.js';

test('About describes Surprise me on Now Playing and adding folders on Computer', () => {
  const host = new FakeNodeEl();
  renderAbout(host);
  const intro = host.innerHTML.match(/<h2>What this is<\/h2>\s*<p>([\s\S]*?)<\/p>/)[1]
    .replace(/\s+/g, ' ');
  assert.match(intro, /save favorites, spin the Tuner/);
  assert.match(intro, /Surprise me on Now Playing/);
  assert.match(intro, /Computer tab to add folders of music and videos/);
  assert.doesNotMatch(intro, /\b(?:Grid|Discovery)\b/);
});
