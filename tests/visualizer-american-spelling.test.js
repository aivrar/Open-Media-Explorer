import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAudioSignal } from '../src/lib/audio-signal.js';
import { normalizeSettings } from '../src/lib/state.js';
import { VISUALIZER_SHUFFLE_POOLS, normalizeVisualizerExtras } from '../src/lib/visualizer-settings.js';
import loadOverlays from '../src/visualizer/vendor/psychedelia/engine/overlays.js';
import loadPostFx from '../src/visualizer/vendor/psychedelia/engine/post-fx-library.js';
import loadPalettes from '../src/visualizer/vendor/psychedelia/engine/palettes.js';
import { fxCatalog } from '../src/visualizer/fx-catalog.js';
import {
  OVERLAY_BLEND_LABELS, OVERLAY_EXTRA_BLENDS, OVERLAY_TABLE, parseOverlayToken,
} from '../src/visualizer/overlay-catalog.js';
import { SCENES } from '../src/visualizer/scenes.js';
import { seededRandom } from '../src/visualizer/shuffle.js';
import { FAVOURITES_FILTER_TITLE } from '../src/visualizer/scene-list.js';
import { NOTICE } from '../src/visualizer/notice.js';
import { createFlashLedger } from '../src/visualizer/flash-limiter.js';
import { AMERICAN_SPELLING, americanText } from '../src/visualizer/spelling.js';
import { CREDIT_TEXT, PIECE_LABELS } from '../src/modes/about-credits.js';
import {
  FX_TEXT, NOTES, OVERLAY_TEXT, SHUFFLE_CHOICES, SHUFFLE_TEXT, mountVisualizer,
} from '../src/visualizer/index.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import {
  FakeGL, FakeNodeEl, fakeDocWithElements, fakeMotion, fakeResizeObserverWin, settle,
} from './helpers/visualizer-fakes.js';

/* The Visualizer's text is in American spelling, as the rest of the app is.
   The British spellings checked (any case, as part of a word):
   colour, favourite, centre, grey, licence. Saved values, setting keys, ids
   and exported names keep their spelling. */

const BRITISH = Object.freeze(['colour', 'favourite', 'centre', 'grey', 'licence']);
const BRITISH_RE = new RegExp(BRITISH.join('|'), 'i');

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** Every string in a value (objects, arrays and functions called with a sample). */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') {
    try { strings(value('X', 'Y'), out); } catch (_) {}
  } else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

function assertAmerican(list, where) {
  for (const text of list) assert.doesNotMatch(String(text), BRITISH_RE, `${where}: "${text}"`);
}

test('American spelling: the tab\'s labels, notes, hints and notice', () => {
  assertAmerican(strings(SHUFFLE_CHOICES.map(([, label]) => label)), 'shuffle choices');
  assertAmerican(strings(SHUFFLE_TEXT), 'shuffle notes');
  assertAmerican(strings(FX_TEXT), 'effect notes');
  assertAmerican(strings(OVERLAY_TEXT), 'overlay notes');
  assertAmerican(strings(NOTES), 'notes');
  assertAmerican(strings(NOTICE), 'notice');
  assertAmerican([FAVOURITES_FILTER_TITLE], 'favorites filter');
  assertAmerican(Object.values(OVERLAY_BLEND_LABELS), 'blend labels');
  for (const [id, row] of Object.entries(OVERLAY_TABLE)) {
    assertAmerican([row.label, row.category, ...(row.styles || [])].filter(Boolean), `overlay ${id}`);
  }
  assertAmerican(SCENES.map((scene) => scene.name), 'scene names');
  assertAmerican(SCENES.map((scene) => scene.category || ''), 'scene groups');
  assert.equal(NOTICE.start, 'Start the Visualizer', 'the tab\'s name as written elsewhere');
});

test('American spelling: effect names and groups from Psychedelia are shown in it (Watercolor, Acid Colors, Color)', () => {
  const palettes = loadPalettes({}).PsyPalettes;
  const catalog = fxCatalog(loadPostFx({ PsyPalettes: palettes }).PostFxLibrary, palettes);
  assert.ok(catalog.length > 30);
  assertAmerican(catalog.map((fx) => fx.label), 'effect names');
  assertAmerican(catalog.map((fx) => fx.category), 'effect groups');
  const byId = new Map(catalog.map((fx) => [fx.id, fx]));
  assert.equal(byId.get('watercolour').label, 'Watercolor', 'the id keeps its spelling');
  assert.ok(catalog.some((fx) => fx.category === 'Color'));
  // Psychedelia's overlays keep their own names; ours are in the table above.
  assert.ok(loadOverlays({}).Overlays.getDefs().length > 0);
});

test('americanText: whole words, the case kept; other words and empty values left alone', () => {
  assert.equal(americanText('Stormy Grey'), 'Stormy Gray');
  assert.equal(americanText('Ink Colours'), 'Ink Colors');
  assert.equal(americanText('COLOUR by Depth'), 'COLOR by Depth');
  assert.equal(americanText('from the centre, greyed'), 'from the center, grayed');
  assert.equal(americanText('Watercolour'), 'Watercolor');
  assert.equal(americanText('Colourful'), 'Colourful', 'not part of a longer word');
  assert.equal(americanText('Neon Night'), 'Neon Night');
  assert.equal(americanText(''), '');
  assert.equal(americanText(null), null);
  for (const [british, american] of AMERICAN_SPELLING) {
    assert.equal(americanText(british), american);
    assert.doesNotMatch(american, BRITISH_RE);
  }
  for (const word of BRITISH) assert.ok(AMERICAN_SPELLING.some(([british]) => british === word), `${word} is turned`);
});

test('American spelling: Visualizer credits on the About page', () => {
  assertAmerican(strings(CREDIT_TEXT), 'credit text');
  assertAmerican(Object.values(PIECE_LABELS), 'piece names');
});

test('American spelling: every text, name, hint and placeholder in the mounted tab, its effects and overlays listed', async () => {
  const h = createClockHarness();
  const vis = fakeDocWithElements({ width: 1280, height: 720 });
  const node = fakeAnalyser({ level: 60, db: -60 });
  const source = {
    playing: false, isPlaying() { return this.playing; }, isAudible: () => true, getAnalyser() { return this.playing ? node : null; }, getVolume: () => 1, release() {},
  };
  const signal = createAudioSignal({ source, doc: vis.doc, ...h.io });
  const gl = new FakeGL();
  const listeners = new Set();
  let current = normalizeSettings({ visualizerNoticeSeen: true });
  const root = new FakeNodeEl('div');
  const session = mountVisualizer(root, {
    signal,
    getSettings: () => current,
    saveSettings: (partial) => { current = normalizeSettings({ ...current, ...partial }); for (const fn of listeners) fn(current); },
    subscribeSettings: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    win: fakeResizeObserverWin(fakeMotion(false)),
    doc: vis.doc,
    createContext: () => ({ gl, mode: 'webgl2' }),
    loopOptions: h.io,
    flashLedger: createFlashLedger(),
    random: seededRandom(3),
    loadFxLibrary: async () => import('../src/visualizer/vendor/psychedelia/engine/post-fx-library.js'),
    loadOverlays: async () => ({ default: loadOverlays }),
  });
  const until = async (done, label) => {
    for (let round = 0; round < 300 && !done(); round += 1) { await settle(done, 20); h.run(30); }
    assert.ok(done(), label);
  };
  await until(() => Boolean(session.switcher.current), 'first scene');
  const { controls } = session;
  for (const box of [controls.fxToggle, controls.overlaysToggle]) {
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  }
  await until(() => session.fx.boxes.size > 30 && session.overlays.fields.size > 10, 'effects and overlays listed');
  // The favorites line, as Favorites only with nothing starred shows it.
  controls.shuffleMode.value = 'favourites';
  controls.shuffleMode.dispatchEvent(new Event('change'));
  await settle(() => false, 5);
  assert.equal(current.visualizerShufflePool, 'favourites', 'the saved value keeps its spelling');

  const seen = [];
  for (const el of [root, ...root.descendants()]) {
    seen.push(el.textContent || '');
    for (const name of ['aria-label', 'title', 'placeholder', 'aria-description']) {
      const value = el.getAttribute?.(name);
      if (value) seen.push(value);
    }
    if (el.title) seen.push(el.title);
  }
  assert.ok(seen.some((text) => /Favorites only/.test(text)), 'the shuffle choice is among the texts read');
  assert.ok(seen.some((text) => /Watercolor/.test(text)), 'the effect names are among the texts read');
  assertAmerican(seen, 'the tab');
  session.destroy();
});

test('stored keys and values keep their spelling: the pool value "favourites", visualizerFavourites, the blend key and the effect id', () => {
  assert.deepEqual([...VISUALIZER_SHUFFLE_POOLS], ['all', 'favourites']);
  assert.deepEqual(SHUFFLE_CHOICES.map(([value]) => value), ['off', 'all', 'favourites']);
  assert.ok('visualizerFavourites' in normalizeVisualizerExtras({}));
  assert.deepEqual(normalizeVisualizerExtras({ visualizerFavourites: ['plasma'] }).visualizerFavourites, ['plasma']);
  assert.ok('colour' in OVERLAY_BLEND_LABELS, 'the blend key');
  assert.ok(SCENES.some((scene) => scene.id === 'domain_colouring'), 'the scene id');
  const settingsSource = read('src/lib/visualizer-settings.js');
  assert.match(settingsSource, /VISUALIZER_SHUFFLE_POOLS = Object\.freeze\(\['all', 'favourites'\]\)/);
  // The held colour blend keeps its key; a saved overlay token reads as before.
  assert.ok(OVERLAY_EXTRA_BLENDS.includes('colour'));
  assert.equal(parseOverlayToken('rings~s').blend.mode, 'screen');
});
