import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeSettings } from '../src/lib/state.js';
import {
  VISUALIZER_FAVOURITES_MAX, mergedVisualizerOverlaySet, normalizeVisualizerExtras,
  normalizeVisualizerFavourites, normalizeVisualizerOverlaySet, olderReleaseReadsFavourite, olderReleaseReadsOverlay,
  visualizerFavouriteFields, visualizerFavouritesToSave, visualizerOverlaySetToSave,
} from '../src/lib/visualizer-settings.js';
import {
  favouriteEntries, favouritesAsDrawn, favouritesFromSaved, withFavourite,
} from '../src/visualizer/favourites.js';
import {
  HELD_OVERLAY_ROWS, OVERLAY_IDS, overlayRow, overlaysDrawnFor, readOverlayToken,
} from '../src/visualizer/overlay-catalog.js';
import { fxDrawnFor } from '../src/visualizer/fx-catalog.js';
import { SCENES } from '../src/visualizer/scenes.js';
// Release 0.1.12's own code (tests/fixtures/release-0.1.12).
import { normalizeSettings as normalizeSettings0112, savedSettings as savedSettings0112 } from './fixtures/release-0.1.12/lib/state-settings.js';
import { parseVisualizerFavourite as parseFavourite0112 } from './fixtures/release-0.1.12/lib/visualizer-settings.js';
import {
  favouritesAsDrawn as favouritesAsDrawn0112, withFavourite as withFavourite0112,
} from './fixtures/release-0.1.12/visualizer/favourites.js';
import {
  OVERLAY_IDS as OVERLAY_IDS_0112, overlaysDrawnFor as overlaysDrawnFor0112,
} from './fixtures/release-0.1.12/visualizer/overlay-catalog.js';

// The scene table and the effects' rules are the same in 0.1.12 as in this
// build (only the overlays and their blend-ins are newer), so both sides
// use this build's scene rows and fxDrawnFor.
const entryOf = (id) => SCENES.find((scene) => scene.id === id) || null;
const fxFor = (id, fx) => fxDrawnFor(entryOf(id), fx);
const overlaysFor = (id, overlays) => overlaysDrawnFor(entryOf(id), overlays);

/** This build's Visualizer tab opening on `settings` (index.js): the whole
 *  list from the two fields, saved when either field changes; the settings
 *  after it and the list. */
function openHere(settings) {
  const extras = normalizeVisualizerExtras(settings);
  const favourites = favouritesFromSaved(extras.visualizerFavourites, extras.visualizerFavouritesAll, fxFor, overlaysFor);
  const fields = visualizerFavouritesToSave(favourites);
  const changed = JSON.stringify(fields.visualizerFavourites) !== JSON.stringify(extras.visualizerFavourites)
    || JSON.stringify(fields.visualizerFavouritesAll) !== JSON.stringify(extras.visualizerFavouritesAll);
  return { settings: changed ? normalizeSettings({ ...settings, ...fields }) : settings, favourites };
}

/** This build's settings saved after its Visualizer tab opened: favourites
 *  `favourites` and overlay set `overlaySet` (as the tab saves them), as the
 *  text that is stored. */
function savedByThisBuild({ favourites = [], overlaySet = [], ...other } = {}) {
  const settings = normalizeSettings({ ...other, ...visualizerFavouritesToSave(favourites), ...visualizerOverlaySetToSave(overlaySet) });
  return JSON.stringify(openHere(settings).settings);
}

/** A profile with only the field every release has (no copy yet), after
 *  this build saved another setting without its Visualizer tab opening. */
function savedWithoutOpening(favourites) {
  return JSON.stringify(normalizeSettings({ visualizerFavourites: favourites, visualizerBrightness: 90 }));
}

/** A visit to 0.1.12 with the stored text: loaded, its Visualizer tab opened
 *  (index.js 461-472 there: favourites rewritten as drawn and saved when
 *  that changed them), `act(settings)` (its own saves), then another setting
 *  saved; the stored text again. */
function visit0112(stored, act = (settings) => settings) {
  let settings = normalizeSettings0112(JSON.parse(stored));
  const drawn = favouritesAsDrawn0112(settings.visualizerFavourites, fxFor, (id, overlays) => overlaysDrawnFor0112(entryOf(id), overlays));
  if (JSON.stringify(drawn) !== JSON.stringify(settings.visualizerFavourites)) {
    settings = savedSettings0112(settings, { visualizerFavourites: drawn });
  }
  settings = act(settings);
  settings = savedSettings0112(settings, { visualizerBrightness: 80 });
  return JSON.stringify(settings);
}

/** Back in this build, its Visualizer tab opened: the whole favourites
 *  list and overlay set, and the settings as saved then. */
function backHere(stored) {
  const opened = openHere(normalizeSettings(JSON.parse(stored)));
  return { settings: opened.settings, favourites: opened.favourites, overlaySet: opened.settings.visualizerOverlaySetAll };
}

const MIXED = [
  'tunnel',
  'voronoi/petals~l',
  'aurora/rings~c',
  'tunnel/ripples',
  'starfield/petals~s+orbits',
  'voronoi/petals~s',
  'plasma:2|bloom/fireflies',
  'mandelbrot:1',
  'tunnel/hexgrid~s+petals',
  'starfield/rings~lu+ripples',
];

test('the overlays release 0.1.12 has are the list this build checks against; the newer ones are the three added', () => {
  for (const id of OVERLAY_IDS_0112) assert.equal(olderReleaseReadsOverlay(id), true, id);
  const newer = OVERLAY_IDS.filter((id) => !OVERLAY_IDS_0112.includes(id));
  assert.deepEqual(newer, Object.keys(HELD_OVERLAY_ROWS));
  for (const id of newer) assert.equal(olderReleaseReadsOverlay(id), false, id);
  // Its five blend letters only.
  for (const letter of 'asmod') assert.equal(olderReleaseReadsOverlay(`petals~${letter}`), true, letter);
  for (const token of ['petals~l', 'petals~cu', 'petals~x', 'zzz', 'petals~sq']) assert.equal(olderReleaseReadsOverlay(token), false, token);
});

test('a visit to 0.1.12 and back keeps every favorite, in order, and the overlay set', () => {
  const stored = savedByThisBuild({ favourites: MIXED, overlaySet: ['petals~l', 'rings', 'ripples'] });
  const here = JSON.parse(stored);
  const whole = here.visualizerFavouritesAll;
  assert.equal(whole.length, MIXED.length, 'every favorite saved');
  // The field 0.1.12 reads holds only what it reads as it is.
  assert.ok(here.visualizerFavourites.length > 0 && here.visualizerFavourites.length < whole.length);
  for (const item of here.visualizerFavourites) {
    assert.ok(parseFavourite0112(item), `${item}: 0.1.12 reads it`);
    assert.equal(olderReleaseReadsFavourite(item), true, item);
  }
  assert.deepEqual(here.visualizerOverlaySet, ['rings']);
  assert.deepEqual(here.visualizerOverlaySetAll, ['petals~l', 'rings', 'ripples']);

  const away = visit0112(stored);
  const there = JSON.parse(away);
  assert.deepEqual(there.visualizerFavourites, here.visualizerFavourites, '0.1.12 neither drops nor rewrites one');
  assert.deepEqual(there.visualizerFavouritesAll, whole, 'the whole list kept untouched');
  assert.deepEqual(there.visualizerOverlaySet, ['rings']);
  assert.deepEqual(there.visualizerOverlaySetAll, ['petals~l', 'rings', 'ripples']);

  const back = backHere(away);
  assert.deepEqual(back.favourites, whole);
  assert.deepEqual(back.overlaySet, ['petals~l', 'rings', 'ripples']);
  // And as many times as it is done.
  const again = backHere(visit0112(JSON.stringify(back.settings)));
  assert.deepEqual(again.favourites, whole);
  assert.deepEqual(again.overlaySet, ['petals~l', 'rings', 'ripples']);
});

test('without the split, 0.1.12 deletes and rewrites favorites (what the split prevents)', () => {
  const plain = JSON.stringify({ visualizerFavourites: MIXED, visualizerOverlaySet: ['petals~l', 'rings'] });
  const there = JSON.parse(visit0112(plain));
  assert.ok(there.visualizerFavourites.length < MIXED.length);
  assert.deepEqual(there.visualizerOverlaySet, ['rings']);
});

test('a favorite deleted in 0.1.12 stays deleted; one starred there comes back after the ones before it', () => {
  const stored = savedByThisBuild({ favourites: MIXED });
  const whole = JSON.parse(stored).visualizerFavouritesAll;
  const away = visit0112(stored, (settings) => {
    let list = withFavourite0112(settings.visualizerFavourites, 'voronoi', null, false, null, null, ['petals~s']);
    list = withFavourite0112(list, 'mandelbrot', 1, false);
    list = withFavourite0112(list, 'moire', null, true);
    return savedSettings0112(settings, { visualizerFavourites: list });
  });
  const back = backHere(away);
  const expected = whole.filter((item) => item !== 'voronoi/petals~s' && item !== 'mandelbrot:1');
  expected.push('moire');
  assert.deepEqual(back.favourites, expected);
  // Starred in 0.1.12 at the start of an empty list, with newer ones only here.
  const newerOnly = savedByThisBuild({ favourites: ['tunnel/ripples', 'voronoi/petals~l'] });
  const backNewer = backHere(visit0112(newerOnly, (settings) => savedSettings0112(settings, {
    visualizerFavourites: withFavourite0112(settings.visualizerFavourites, 'moire', null, true),
  })));
  assert.deepEqual(backNewer.favourites, ['tunnel/ripples', 'voronoi/petals~l', 'moire']);
  // Deleting a newer one here, and an older one: the two fields follow.
  const list = withFavourite(whole, 'tunnel', null, false, null, null, ['ripples']);
  const next = withFavourite(list, 'tunnel', null, false);
  const saved = visualizerFavouritesToSave(next);
  assert.equal(saved.visualizerFavouritesAll.includes('tunnel/ripples'), false);
  assert.equal(saved.visualizerFavourites.includes('tunnel'), false);
  assert.deepEqual(favouritesFromSaved(saved.visualizerFavourites, saved.visualizerFavouritesAll, fxFor, overlaysFor), next);
});

test('a favorite 0.1.12 only re-spells keeps its place; two it merges come back as one, in the earlier one\'s place', () => {
  // No copy yet; a setting saved here without the Visualizer opening.
  const first = savedWithoutOpening(['plasma/petals+rings', 'voronoi/ripples']);
  assert.deepEqual(JSON.parse(first).visualizerFavourites, ['plasma/petals+rings']);
  const away = visit0112(first);
  assert.deepEqual(JSON.parse(away).visualizerFavourites, ['plasma/rings+petals'], '0.1.12 re-spelled it (the table\'s order)');
  const back = backHere(away);
  assert.deepEqual(back.favourites, ['plasma/rings+petals', 'voronoi/ripples'], 'the same place');
  assert.deepEqual(backHere(visit0112(JSON.stringify(back.settings))).favourites, ['plasma/rings+petals', 'voronoi/ripples']);
  // Two that 0.1.12's tab makes the same: one, where the earlier one was.
  const two = savedWithoutOpening(['tunnel/petals+rings', 'tunnel/ripples', 'tunnel/rings+petals', 'moire']);
  const merged = visit0112(two);
  assert.deepEqual(JSON.parse(merged).visualizerFavourites, ['tunnel/rings+petals', 'moire'], '0.1.12 merged them');
  assert.deepEqual(backHere(merged).favourites, ['tunnel/rings+petals', 'tunnel/ripples', 'moire']);
  // The merged one taken off there: neither comes back.
  const off = visit0112(two, (settings) => savedSettings0112(settings, {
    visualizerFavourites: withFavourite0112(settings.visualizerFavourites, 'tunnel', null, false, null, null, ['rings', 'petals']),
  }));
  assert.deepEqual(backHere(off).favourites, ['tunnel/ripples', 'moire']);
  // Calm scene rules re-spell too (a blend-in the scene does not allow).
  const calm = SCENES.find((entry) => entry.fxNone).id;
  const calmStored = savedWithoutOpening([`${calm}/petals~s`, 'voronoi/orbits']);
  assert.deepEqual(backHere(visit0112(calmStored)).favourites, [`${calm}/petals`, 'voronoi/orbits']);
});

test('a re-spelled favorite beside a newer one that 0.1.12 would read as the same: both kept, in order', () => {
  // 'plasma/rings+petals+ripples' is 'plasma/rings+petals' to 0.1.12 (no Ripples there).
  const stored = savedWithoutOpening(['plasma/petals+rings', 'plasma/rings+petals+ripples', 'tunnel']);
  assert.deepEqual(JSON.parse(stored).visualizerFavourites, ['plasma/petals+rings', 'tunnel']);
  const back = backHere(visit0112(stored));
  assert.deepEqual(back.favourites, ['plasma/rings+petals', 'plasma/rings+petals+ripples', 'tunnel']);
  // Taken off in 0.1.12: only the one it saw goes.
  const off = backHere(visit0112(stored, (settings) => savedSettings0112(settings, {
    visualizerFavourites: withFavourite0112(settings.visualizerFavourites, 'plasma', null, false, null, null, ['rings', 'petals']),
  })));
  assert.deepEqual(off.favourites, ['plasma/rings+petals+ripples', 'tunnel']);
});

test('one form for every favorite 0.1.12 reads: its tab and this build\'s draw each the same, on every scene', () => {
  const overlaySets = [
    'petals+rings', 'rings~s+petals~m', 'frame~m', 'cinematic~su', 'vignette~o+lasers~db', 'color_strobe~dk+matrix~ot',
    'harmonograph+bokeh~mutn+spectrum', 'plexus~au', 'hexgrid~s+sacred~d+tri_grid~o',
  ];
  let compared = 0;
  for (const entry of SCENES) {
    for (const set of overlaySets) {
      for (const fx of ['', '|bloom', '|glitch+vhs+bloom']) {
        const item = `${entry.id}${fx}/${set}`;
        if (!olderReleaseReadsFavourite(item)) continue;
        const mine = favouritesAsDrawn([item], fxFor, overlaysFor);
        const theirs = favouritesAsDrawn0112([item], fxFor, (id, overlays) => overlaysDrawnFor0112(entryOf(id), overlays));
        assert.deepEqual(mine, theirs, item);
        assert.equal(olderReleaseReadsFavourite(mine[0]), true, `${mine[0]} still read by 0.1.12`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > SCENES.length * 20, `${compared} compared`);
});

test('the fields alone (no list of scenes): the split only, nothing taken off, a newer favourite in the old field moved to the copy', () => {
  assert.deepEqual(visualizerFavouriteFields(['tunnel', 'voronoi/petals~l'], undefined), {
    visualizerFavourites: ['tunnel'], visualizerFavouritesAll: ['tunnel', 'voronoi/petals~l'],
  });
  assert.deepEqual(visualizerFavouriteFields(['moire', 'plasma/orbits'], ['tunnel', 'voronoi/petals~l']), {
    visualizerFavourites: ['moire'], visualizerFavouritesAll: ['tunnel', 'voronoi/petals~l', 'plasma/orbits'],
  });
  const fields = visualizerFavouriteFields(['moire'], ['tunnel']);
  assert.deepEqual(visualizerFavouriteFields(fields.visualizerFavourites, fields.visualizerFavouritesAll), fields, 'the same again');
});

test('a change of the overlay set in 0.1.12 wins over the copy kept beside it', () => {
  const stored = savedByThisBuild({ overlaySet: ['petals~l', 'rings', 'ripples'] });
  const changed = backHere(visit0112(stored, (settings) => savedSettings0112(settings, { visualizerOverlaySet: ['matrix', 'rings~s'] })));
  assert.deepEqual(changed.overlaySet, ['matrix', 'rings~s']);
  assert.deepEqual(changed.settings.visualizerOverlaySet, ['matrix', 'rings~s']);
  // Emptied there: empty here too.
  const emptied = backHere(visit0112(stored, (settings) => savedSettings0112(settings, { visualizerOverlaySet: [] })));
  assert.deepEqual(emptied.overlaySet, []);
  // Only newer overlays chosen: 0.1.12 sees none; unchanged there, all of them come back.
  const newer = savedByThisBuild({ overlaySet: ['petals~c', 'orbits'] });
  assert.deepEqual(JSON.parse(newer).visualizerOverlaySet, []);
  assert.deepEqual(backHere(visit0112(newer)).overlaySet, ['petals~c', 'orbits']);
  // A set saved before the copy existed (the field alone) is read as it is.
  assert.deepEqual(mergedVisualizerOverlaySet(['petals~l', 'rings'], undefined), ['petals~l', 'rings']);
  assert.deepEqual(normalizeVisualizerExtras({ visualizerOverlaySet: ['petals~l'] }).visualizerOverlaySetAll, ['petals~l']);
});

test('sizes and limits: one limit for both kinds, a star added in 0.1.12 at the limit is kept, the saved size stays small', () => {
  const newer = Array.from({ length: 64 }, (_, n) => `s${n}/ripples`);
  const older = Array.from({ length: 64 }, (_, n) => `s${n}/rings`);
  const full = newer.flatMap((item, n) => [item, older[n]]);
  assert.equal(full.length, VISUALIZER_FAVOURITES_MAX);
  const saved = visualizerFavouritesToSave([...full, 'extra']);
  assert.equal(saved.visualizerFavouritesAll.length, VISUALIZER_FAVOURITES_MAX, 'the whole list, both kinds counted');
  assert.equal(saved.visualizerFavourites.length, 64);
  // A new star here at the limit makes room in the whole list.
  const starred = withFavourite(full, 'tunnel', null, true);
  assert.equal(starred.length, VISUALIZER_FAVOURITES_MAX);
  assert.equal(starred.at(-1), 'tunnel');
  // 0.1.12 sees 64 and adds one: back here the oldest goes, the new star stays.
  const stored = JSON.stringify(normalizeSettings({ ...visualizerFavouritesToSave(full) }));
  const back = backHere(visit0112(stored, (settings) => savedSettings0112(settings, {
    visualizerFavourites: withFavourite0112(settings.visualizerFavourites, 'moire', null, true),
  })));
  assert.equal(back.favourites.length, VISUALIZER_FAVOURITES_MAX);
  assert.equal(back.favourites.at(-1), 'moire');
  assert.equal(back.favourites[0], full[1], 'the oldest went');
  // The longest favourites there can be, 128 of them: both fields together.
  const longest = Array.from({ length: VISUALIZER_FAVOURITES_MAX }, (_, n) => `${'a'.repeat(44)}${String(n).padStart(4, '0')}:63|${['b', 'c', 'd'].map((x) => x.repeat(24)).join('+')}/${['e', 'f', 'g'].map((x) => `${x.repeat(24)}~sukt`).join('+')}`);
  assert.equal(normalizeVisualizerFavourites(longest).length, VISUALIZER_FAVOURITES_MAX);
  const bytes = JSON.stringify(visualizerFavouritesToSave(longest)).length;
  assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
  // The overlay set: three at most in each field.
  const set = visualizerOverlaySetToSave(['rings', 'petals~l', 'orbits', 'matrix']);
  assert.deepEqual(set, { visualizerOverlaySet: ['rings'], visualizerOverlaySetAll: ['rings', 'petals~l', 'orbits'] });
});

test('looking forward: an unknown blend letter or overlay drops that blend-in or that overlay, never the favorite', () => {
  const saved = ['plasma/petals~x', 'tunnel/zzz~l', 'voronoi/rings~sq+petals', 'starfield/qq9'];
  const extras = normalizeVisualizerExtras({ visualizerFavourites: saved, visualizerOverlaySet: ['petals~x', 'zzz~c', 'rings~s'] });
  assert.deepEqual(extras.visualizerFavouritesAll, saved, 'every favorite kept');
  assert.deepEqual(extras.visualizerFavourites, [], 'none of them is given to 0.1.12');
  assert.deepEqual(favouriteEntries(saved).map((entry) => entry.overlays), [
    [{ id: 'petals', blend: readOverlayToken('petals').blend }],
    [readOverlayToken('zzz~l')],
    [readOverlayToken('rings'), readOverlayToken('petals')],
    [readOverlayToken('qq9')],
  ]);
  const drawn = favouritesAsDrawn(saved, fxFor, (id, overlays) => overlaysDrawnFor(entryOf(id), overlays));
  assert.deepEqual(drawn, ['plasma/petals', 'tunnel', 'voronoi/rings+petals', 'starfield']);
  // The overlay set: the same rule.
  assert.deepEqual(extras.visualizerOverlaySetAll, ['petals~x', 'zzz~c', 'rings~s']);
  const items = extras.visualizerOverlaySetAll.map((token) => readOverlayToken(token));
  assert.deepEqual(overlaysDrawnFor(entryOf('tunnel'), items).map((item) => item.id), ['rings', 'petals']);
  assert.equal(overlaysDrawnFor(entryOf('tunnel'), items).find((item) => item.id === 'petals').blend.mode, 'add');
  assert.deepEqual(normalizeVisualizerOverlaySet(['petals~', 'Petals', 'petals~toolongforit']), [], 'a broken token is still dropped');
});

test('extra glow, drift and Styles: 0.1.12 keeps them as they are, and the newer overlays have no Style', () => {
  const stored = savedByThisBuild({ visualizerOverlayGlow: true, visualizerDrift: false, visualizerOverlayStyles: { rings: 2, petals: 1 } });
  const there = JSON.parse(visit0112(stored));
  assert.equal(there.visualizerOverlayGlow, true);
  assert.equal(there.visualizerDrift, false);
  assert.deepEqual(there.visualizerOverlayStyles, { rings: 2, petals: 1 });
  for (const id of Object.keys(HELD_OVERLAY_ROWS)) assert.equal(overlayRow(id).styles, undefined, `${id} has no Style`);
});

test('the Visualizer reads the whole lists and saves both fields each time', () => {
  const index = readFileSync('src/visualizer/index.js', 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(index, /saveSettings\?\.\(\{ visualizer(Favourites|OverlaySet):/);
  // The star, and the tab opening (both fields, when either changed).
  assert.equal(index.match(/saveSettings\?\.\(visualizerFavouritesToSave\(favourites\)\)/g).length, 1);
  assert.match(index, /favourites = favouritesSaved\(extras\);\n    const fields = visualizerFavouritesToSave\(favourites\);\n/);
  assert.match(index, /saveSettings\?\.\(fields\);/);
  assert.equal(index.match(/saveSettings\?\.\(visualizerOverlaySetToSave\(overlaySet\)\)/g).length, 1);
  // Read: both fields put together the same way at the start and on a change.
  assert.match(index, /const favouritesSaved = \(settings\) => favouritesFromSaved\(\n    settings\.visualizerFavourites,\n    settings\.visualizerFavouritesAll,/);
  assert.match(index, /const moreFavourites = favouritesSaved\(more\);/);
  assert.match(index, /let overlaySet = extras\.visualizerOverlaySetAll;/);
  assert.match(index, /overlaySet = more\.visualizerOverlaySetAll;/);
});
