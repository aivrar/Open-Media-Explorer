import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../src/lib/state.js';
import { favoriteStations } from '../src/modes/tuner.js';
import { chooseLibraryStartTab } from '../src/modes/library/index.js';
import { view } from '../src/modes/library/state.js';

function fav(id, type, extra = {}) {
  return { id, type, title: id, source: 'radio-browser', country: 'US', ...extra };
}

test('Tuner favorites list keeps saved order, matches the band, and dedupes', () => {
  const favorites = [
    fav('z100', 'radio'), fav('cnn', 'tv'), fav('kiis', 'radio'),
    fav('z100', 'radio'), fav('book', 'audio'), null, {},
  ];
  assert.deepEqual(favoriteStations(favorites, { band: 'radio' }).map((s) => s.id), ['z100', 'kiis']);
  assert.deepEqual(favoriteStations(favorites, { band: 'tv' }).map((s) => s.id), ['cnn']);
  assert.deepEqual(favoriteStations([], { band: 'radio' }), []);
  assert.deepEqual(favoriteStations(undefined, { band: 'radio' }), []);
});

test('Tuner favorites respect the country picker and the explicit-content setting', () => {
  const favorites = [
    fav('us', 'radio'), fav('fr', 'radio', { country: 'fr' }),
    fav('nsfw', 'radio', { content_rating: 'explicit' }),
  ];
  assert.deepEqual(favoriteStations(favorites, { band: 'radio', country: 'FR' }).map((s) => s.id), ['fr']);
  assert.deepEqual(favoriteStations(favorites, { band: 'radio' }).map((s) => s.id), ['us', 'fr']);
  assert.deepEqual(
    favoriteStations(favorites, { band: 'radio', settings: { showExplicitContent: true } }).map((s) => s.id),
    ['us', 'fr', 'nsfw'],
  );
});

test('the remembered Tuner favorites choice is a strict boolean setting', () => {
  assert.equal(normalizeSettings({}).tunerFavoritesOnly, false);
  assert.equal(normalizeSettings({ tunerFavoritesOnly: 'true' }).tunerFavoritesOnly, false);
  assert.equal(normalizeSettings({ tunerFavoritesOnly: true }).tunerFavoritesOnly, true);
  // The launch screen default is unchanged.
  assert.equal(normalizeSettings({}).defaultMode, 'library');
});

test('Library opens on Favorites once per session, only when there are favorites', () => {
  const before = { source: view.activeSource, type: view.filters.type };
  try {
    view.activeSource = 'all';
    chooseLibraryStartTab(3);
    assert.equal(view.activeSource, 'favorites');
    // Later visits keep the user's own choice.
    view.activeSource = 'all';
    chooseLibraryStartTab(3);
    assert.equal(view.activeSource, 'all');
  } finally {
    view.activeSource = before.source;
    view.filters.type = before.type;
  }
});

test('technical source details are off by default and only enabled by an exact true', () => {
  assert.equal(normalizeSettings({}).showTechnicalDetails, false);
  assert.equal(normalizeSettings({ showTechnicalDetails: 1 }).showTechnicalDetails, false);
  assert.equal(normalizeSettings({ showTechnicalDetails: true }).showTechnicalDetails, true);
});
