import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  getSourceColor, getSourceLabel, isRetiredSource, loadAdapter, RETIRED_SOURCE_MESSAGE, SOURCE_IDS, SOURCES,
} from '../src/lib/sources.js';
import { getState, normalizeFavoriteItem, normalizeSettings } from '../src/lib/state.js';
import { resolveFailureMessage } from '../src/lib/resolve-message.js';
import { artworkNeedsResolution, resolveArtworkRelay } from '../src/lib/artwork.js';
import { resolveItemArtwork } from '../src/modes/library/thumbnails.js';
import { itemPassesFilters } from '../src/modes/library/filter.js';
import { view } from '../src/modes/library/state.js';

// Library of Congress was removed: loc.gov now answers apps only with a
// browser check, and the app does not try to get around that.
const RETIRED = 'library-of-congress';
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const savedItem = (extra = {}) => ({
  id: `${RETIRED}:fixture-audio-1`,
  title: 'A saved recording',
  description: '',
  source: RETIRED,
  type: 'audio',
  stream_kind: 'audio',
  stream_url: 'https://media.example.test/recording.mp3',
  delivery: 'on-demand',
  thumbnail: '',
  country: '',
  language: '',
  license: 'Unknown',
  source_url: 'https://catalog.example.test/item/fixture-audio-1/',
  tags: [],
  ...extra,
});

test('a saved switch for the removed source is dropped quietly', () => {
  const settings = normalizeSettings({
    enabledSources: { [RETIRED]: false, nasa: false, 'future-source': true },
  });
  assert.equal(Object.hasOwn(settings.enabledSources, RETIRED), false);
  assert.equal(settings.enabledSources.nasa, false, 'other saved switches are kept');
  assert.equal(settings.enabledSources['future-source'], true, 'unknown future ids are still kept');
  assert.equal(Object.hasOwn(normalizeSettings({}).enabledSources, RETIRED), false);
});

test('items saved from the removed source still list in Favorites and My Playlists', () => {
  const state = getState();
  const previousSettings = state.settings;
  const previousSource = view.activeSource;
  try {
    // An old profile had the source switched off; that switch no longer hides anything.
    state.settings = normalizeSettings({ enabledSources: { [RETIRED]: false } });
    const item = normalizeFavoriteItem(savedItem());
    assert.ok(item, 'the saved item survives normalisation');
    assert.equal(item.source, RETIRED);
    for (const personal of ['favorites', 'playlists']) {
      view.activeSource = personal;
      assert.equal(itemPassesFilters(item), true, `${personal} still lists the item`);
    }
  } finally {
    state.settings = previousSettings;
    view.activeSource = previousSource;
  }
});

test('the removed source keeps a readable label and the neutral colour', () => {
  assert.equal(isRetiredSource(RETIRED), true);
  assert.equal(isRetiredSource('nasa'), false);
  assert.equal(getSourceLabel(RETIRED), 'Library of Congress');
  assert.equal(getSourceColor(RETIRED), 'var(--text-mute)');
  assert.equal(getSourceLabel('no-such-source'), 'no-such-source', 'other unknown ids are unchanged');
});

test('playing an item that needs the removed adapter fails with one plain line', async () => {
  const error = await loadAdapter(RETIRED).then(() => null, (failure) => failure);
  assert.ok(error, 'no adapter is loaded for the removed source');
  assert.equal(error.code, 'SOURCE_RETIRED');
  // Short enough for the player bar's meta line at 1024 px (about 143 px).
  assert.equal(RETIRED_SOURCE_MESSAGE, 'Source no longer available.');
  assert.equal(resolveFailureMessage(error), RETIRED_SOURCE_MESSAGE);

  // The player shows that line for an item that needs resolving, and treats a
  // failed candidate refresh as harmless when the item has its own stream URL.
  const player = await read('src/lib/player.js');
  assert.match(player, /const mod = await loadAdapter\(item\.source\);[\s\S]*?catch \(err\) \{[\s\S]*?resolveMessage = resolveFailureMessage\(err\);/);
  assert.match(player, /showBrokenState\(resolveMessage \|\| 'No stream URL'\)/);
  assert.match(player, /refreshStreamCandidates[\s\S]*?catch \(error\) \{\s*if \(error\?\.name === 'AbortError'\) throw error;\s*\/\/ The saved URL is still worth one bounded attempt\./);
});

test('no list of sources shows the removed one', async () => {
  assert.equal(SOURCE_IDS.includes(RETIRED), false);
  assert.equal(SOURCES.some((source) => source.id === RETIRED), false);
  // Sidebar, Settings, About, Discovery, Grid and Tuner all build their lists
  // from the registry.
  const users = {
    'src/modes/library/sidebar.js': /SOURCES\.map/,
    'src/lib/settings.js': /SOURCES\.map/,
    'src/modes/about.js': /SOURCES\.map/,
    'src/modes/discovery.js': /SOURCES\.filter/,
    'src/modes/grid.js': /SOURCES\.filter/,
    'src/modes/tuner.js': /SOURCES\.filter/,
  };
  for (const [path, pattern] of Object.entries(users)) assert.match(await read(path), pattern, path);

  // No other source file names it, and its adapter is gone.
  const pending = ['src'];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') pending.push(path);
      } else if (/\.(js|html)$/.test(entry.name) && path !== 'src/lib/sources.js') {
        assert.doesNotMatch(await read(path), /library-of-congress|Library of Congress/, path);
      }
    }
  }
});

test('artwork for the removed source: carried artwork is still shown, nothing is looked up', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let adapterLoads = 0;
  const loadAdapterImpl = async () => { adapterLoads++; throw new Error('should not load'); };
  const registered = [];
  const registerAssetImpl = async ({ url, sourceId, itemId }) => {
    registered.push({ url, sourceId, itemId });
    return { relay_url: `/api/v1/assets/retired_artwork_${String(registered.length).padStart(4, '0')}` };
  };
  const opts = { loadAdapterImpl, registerAssetImpl };

  // An external thumbnail or a saved artwork URL is registered like any other.
  const withThumb = savedItem({ thumbnail: 'https://img.example.test/cover.jpg' });
  assert.equal(artworkNeedsResolution(withThumb), true);
  await resolveItemArtwork(withThumb, opts);
  assert.equal(withThumb.thumbnail, '/api/v1/assets/retired_artwork_0001');
  const withSaved = savedItem({ id: `${RETIRED}:fixture-audio-2`, _extra: { artworkUrl: 'https://img.example.test/saved.jpg' } });
  await resolveArtworkRelay(withSaved, opts);
  assert.equal(withSaved.thumbnail, '/api/v1/assets/retired_artwork_0002');
  assert.deepEqual(registered.map((entry) => [entry.url, entry.sourceId]), [
    ['https://img.example.test/cover.jpg', RETIRED],
    ['https://img.example.test/saved.jpg', RETIRED],
  ]);

  // An item already showing relay artwork keeps it.
  const relayed = savedItem({ id: `${RETIRED}:fixture-audio-3`, thumbnail: '/api/v1/assets/saved_artwork_0001' });
  assert.equal(artworkNeedsResolution(relayed), false);
  await resolveItemArtwork(relayed, opts);
  assert.equal(relayed.thumbnail, '/api/v1/assets/saved_artwork_0001');

  // No artwork at all: the initials tile, no adapter, no log, and no retry.
  const bare = savedItem({ id: `${RETIRED}:fixture-audio-4`, _extra: { needsArtwork: true } });
  await resolveItemArtwork(bare, opts);
  assert.equal(bare.thumbnail, '');
  assert.equal(artworkNeedsResolution(bare), false, 'checked once, not again');
  await resolveItemArtwork(bare, opts);

  assert.equal(adapterLoads, 0, 'no adapter is loaded for the removed source');
  assert.equal(registered.length, 2);
  assert.equal(warn.mock.callCount(), 0, 'no "thumbnail hydrate failed" line');
});