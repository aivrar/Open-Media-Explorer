/**
 * The Visualizer tab's content: a canvas that fills the tab, a few small
 * buttons over it that fade away when the mouse rests (hud.js: previous and
 * next scene, shuffle, favourite star, settings), and a collapsible side panel
 * with everything else (the scene list with search, badges and a favourites
 * filter - scene-list.js -, the scene's look, shuffle settings, picture
 * quality, frame rate, brightness, "show measured fps", and the
 * photosensitivity notice again). The panel's state is remembered.
 *
 * The first time the tab is opened, a photosensitivity notice comes before
 * anything is loaded or moves (notice.js): until it is accepted nothing is
 * scheduled at all. Shown again from the panel, it pauses the picture behind
 * it the same way. A scene the computer cannot keep up with is
 * drawn at a lower quality and then frame rate until it can (step-down.js),
 * with a note saying so; the saved settings stay as chosen.
 *
 * Every visible change of picture (scene or look, by hand, from the settings
 * or from the shuffle) goes through transition.js: a cross-fade, or a dip to
 * black and back where the browser cannot cross-fade, one at a time (changes
 * asked for meanwhile wait, the latest wins), each charged to the flash
 * limiter's budget (slower when it is full). Never a hard cut, except with
 * reduced motion, while hidden or paused.
 *
 * Shuffle (shuffle.js) changes scene every few bars of the music, prepares
 * the next scene ahead so the change is instant, waits rather than show a
 * blank, and changes only when the flash limiter has room. The music's mood
 * (mood.js) biases the shuffle and the strength of the reaction.
 *
 * Post effects (off by default): Psychedelia's FX passes over the scene
 * (fx-chain.js; bypassed entirely while none are on), chosen by hand from the
 * panel's list or by the FX shuffle (fx-shuffle.js) with the scene or every
 * few bars, with the global beat reactions (fx-reactions.js) as their last
 * pass. Their library is a chunk of its own, loaded the first time effects
 * are switched on. Changes of effects are changes of picture like any other
 * (transition.js). The step-down takes effects off before it lowers quality.
 *
 * Overlays (off by default): Psychedelia's Canvas 2D overlays and our own
 * patterns (overlay-catalog.js), drawn on a canvas over the picture
 * (overlay-layer.js; the compositor lays it on top, no graphics pass), chosen
 * by hand or by the overlay shuffle (overlay-shuffle.js) with each scene. One
 * of them may be blended in (a blend mode, under the effects, masked or tinted
 * by the scene): only then is its canvas uploaded and blended by fx-chain.js.
 * Their hits pass the flash limiter (overlay-layer.js createFlashGate). The
 * step-down takes overlays off after effects, before it lowers quality.
 *
 * Loaded only when the tab is first opened (modes/visualizer.js imports
 * visualizer/visualizer.js dynamically, so it is a separate bundle chunk);
 * each scene is a further chunk of its own, fetched when it is chosen or
 * prepared ahead. mountVisualizer() returns destroy(), which stops every
 * timer and frame, abandons a scene still loading or compiling, drops the
 * sound subscription, removes every listener and gives the WebGL context back.
 *
 * The scenes move with the music through Psychedelia's Beat Reactor
 * (reactor.js), fed from the app's shared sound signal; every value they get
 * passes the flash limiter (flash-limiter.js). A developer strip with those
 * values can be shown with Ctrl+Shift+D (the `visualizerDebug` setting); it
 * is off by default and costs nothing while off.
 */

import { createVisualizerLoop, LOOP_MODES } from './loop.js';
import { createSceneRenderer, createWebglContext, sceneDefaults } from './scene-renderer.js';
import { createSceneSwitcher, SWITCH_STATES } from './scene-switcher.js';
import { createSceneList } from './scene-list.js';
import { createReactorBridge } from './reactor.js';
import { createFlashLedger } from './flash-limiter.js';
import {
  DEFAULT_SCENE, SCENES, orderedScenes, sceneCaps, sceneMaxPixels, stepScene,
} from './scenes.js';
import { createStepDown, STEP_DOWN_NOTE } from './step-down.js';
import {
  currentLook, lookOverrides, sceneLooks, startLook, withLook,
} from './looks.js';
import { deviceSizeFromEntry, drawingSize } from './size.js';
import { createHud } from './hud.js';
import { createNotice, NOTICE } from './notice.js';
import { createTransition } from './transition.js';
import {
  costFilterMax, createShuffle, createShuffleTimer, lighterCost, seededRandom, shuffleCostCap,
} from './shuffle.js';
import { createMoodTracker } from './mood.js';
import {
  favouriteCombos, favouriteEntries, favouriteKey, favouriteLooks, favouriteToRecall, favouritesAsDrawn, isFavourite,
  withFavourite,
} from './favourites.js';
import {
  OVERLAY_BEND_OFFERED, OVERLAY_BLEND_LABELS, OVERLAY_COST_BUDGET, OVERLAY_COST_UNITS, OVERLAY_IDS, OVERLAY_LIVELY_BLENDS,
  OVERLAY_MASKS, OVERLAY_MASK_LABELS, OVERLAY_MAX, OVERLAY_MAX_BY_QUALITY, OVERLAY_SHUFFLE_COST_MAX, PLAIN_BLEND, isBlendIn, normalizeBlend,
  overlayOrder, overlayRow, overlayToken, overlaysDrawnFor, overlaysKey, parseOverlayToken,
} from './overlay-catalog.js';
import { createFlashGate, createOverlayLayer } from './overlay-layer.js';
import { createOverlayShuffle } from './overlay-shuffle.js';
import {
  FX_CALM_MAX, FX_COST_UNITS, FX_LIVELY, fxCalmIds, fxCatalog, fxDrawnFor, fxOrder,
} from './fx-catalog.js';
import { createFxChain } from './fx-chain.js';
import {
  FX_BUDGETS, FX_COST_BUDGET, FX_MAX_ACTIVE, FX_MAX_BY_QUALITY, createFxShuffle,
} from './fx-shuffle.js';
import { createGlobalReactions } from './fx-reactions.js';
import {
  VISUALIZER_BRIGHTNESS_MAX, VISUALIZER_BRIGHTNESS_MIN, VISUALIZER_BRIGHTNESS_STEP, VISUALIZER_FRAME_RATES,
  VISUALIZER_FX_INTENSITIES, VISUALIZER_FX_TIMINGS, VISUALIZER_PRESETS, VISUALIZER_QUALITIES, VISUALIZER_SHUFFLE_BARS,
  normalizeVisualizerBrightness, normalizeVisualizerExtras, normalizeVisualizerFps, normalizeVisualizerLooks,
  normalizeVisualizerQuality, normalizeVisualizerScene, visualizerPreset,
} from '../lib/visualizer-settings.js';

export const MESSAGES = Object.freeze({
  noWebgl: 'The visualizer needs WebGL graphics, which are not available on this computer right now.',
  noScene: 'This picture could not be prepared on this computer.',
  sceneFailed: 'That scene could not be shown on this computer, so the previous one stays.',
  lost: 'The graphics driver was reset. The picture comes back by itself when it is ready.',
  stillMotion: 'Windows is set to reduce animations, so the picture stays still.',
});

/** The small note at the bottom right. "Preparing" shows only when a scene
 *  takes longer than PREPARING_DELAY_MS to load and compile (the scene before
 *  it keeps moving meanwhile), so a quick switch does not blink it; at once
 *  where the compile will block the page (no parallel compile). */
export const NOTES = Object.freeze({
  preparing: 'Preparing scene...',
  lowered: STEP_DOWN_NOTE,
  fewerFx: 'Fewer effects to keep this scene smooth',
  fewerOverlays: 'Fewer overlays to keep this scene smooth',
  fewerBoth: 'Fewer effects and overlays to keep this scene smooth',
});
export const PREPARING_DELAY_MS = 200;

/** How long a change of picture cross-fades (ms; transition.js). */
export { CROSSFADE_MS, CROSSFADE_SLOW_MS } from './transition.js';

/** The frame-rate readout's words. A number is shown only while frames are
 *  drawn and counted in the current state; "--" while the first second of a
 *  state is counted. */
export const READOUT = Object.freeze({
  noSound: 'no sound playing',
  rest: 'Still picture, no sound playing',
  notDrawing: 'Not drawing, window not in view',
});

/** The look buttons' marks: single angle quotation marks (written as
 *  escapes; source files stay ASCII). */
const PREVIOUS_MARK = String.fromCharCode(0x2039);
const NEXT_MARK = String.fromCharCode(0x203a);
const CLOSE_MARK = String.fromCharCode(0x00d7);

/** How often the developer strip's text is rewritten (ms). */
export const DEBUG_INTERVAL_MS = 250;

/** Shuffle choices as the panel names them. */
export const SHUFFLE_CHOICES = Object.freeze([
  ['off', 'Off'], ['all', 'All scenes'], ['favourites', 'Favourites only'],
]);
/** Said under the Shuffle choice when "Favourites only" has nothing to
 *  shuffle (the shuffle is then not running, and the button says so). */
export const SHUFFLE_TEXT = Object.freeze({
  noFavourites: 'No favourites yet. Star a scene to use this.',
  noneFit: 'None of your favourites is in the Scenes choice below.',
});
export const SHUFFLE_COST_CHOICES = Object.freeze([
  ['light', 'Light only'], ['medium', 'Light and medium'], ['all', 'All, heavy too'],
]);
/** Post effect choices as the panel names them. */
export const FX_INTENSITY_CHOICES = Object.freeze(VISUALIZER_FX_INTENSITIES.map((id) => [id, id[0].toUpperCase() + id.slice(1)]));
export const FX_TIMING_CHOICES = Object.freeze(VISUALIZER_FX_TIMINGS.map((value) => [value, value === 'scene' ? 'With the scene' : `Every ${value} bars`]));
/** The FX shuffle's dwell when it counts bars (s): sooner and later than this
 *  it does not change. */
export const FX_MIN_DWELL_S = 6;
export const FX_MAX_DWELL_S = 90;
export const FX_TEXT = Object.freeze({
  loading: 'Loading effects...',
  failed: 'The effects could not be loaded.',
  none: 'Effects: none now',
  /** A calm scene (scenes.js fxCalm) and one with none (fxNone). */
  calmHere: 'Greyed effects are not shown with this scene: it would flicker.',
  notHere: 'Not shown with this scene: it would flicker',
  noneHere: 'No effects are shown with this scene: it would flicker.',
  /** Effects whose programs did not compile on this computer. */
  failed1: (names) => `Could not be drawn on this computer: ${names}.`,
  failedOne: 'Could not be drawn on this computer',
  cap: (count) => `At most ${count} at once`,
});
export const OVERLAY_TEXT = Object.freeze({
  loading: 'Loading overlays...',
  failed: 'The overlays could not be loaded.',
  /** Overlays that could not be drawn on this computer. */
  failed1: (names) => `Could not be drawn on this computer: ${names}.`,
  failedOne: 'Could not be drawn on this computer',
  none: 'Overlays: none now',
  noneHere: 'Overlays are drawn plain on top with this scene: blending them in would flicker.',
  calmHere: 'Greyed blends are not used with this scene: they would flicker.',
  oneBlend: 'One overlay at a time can be blended in.',
  cap: (count) => `At most ${count} at once`,
  blend: 'Blend',
  under: 'Under the effects',
  mask: 'Show',
  tint: 'Scene colours',
  bend: 'Bend the scene',
});
/** How many scenes back previous can go with shuffle on. */
const TRAIL_MAX = 50;

/** What a still picture is drawn with (before the notice is accepted). */
const STILL_STATE = Object.freeze({
  time: 4,
  dt: 0,
  audio: Object.freeze({
    bass: 0, mid: 0, high: 0, level: 0,
  }),
  beat: Object.freeze({
    kick: 0, snare: 0, hat: 0, clock: 0,
  }),
  speed: 1,
  zoom: 1,
  sources: null,
  live: false,
  still: true,
});

export function fpsText(status) {
  if (status.mode === LOOP_MODES.rest) return READOUT.rest;
  if (status.mode !== LOOP_MODES.live && status.mode !== LOOP_MODES.idle) return '';
  if (status.throttled) return READOUT.notDrawing;
  const rate = Number.isFinite(status.fps) ? `${status.fps} fps` : '-- fps';
  return status.mode === LOOP_MODES.idle ? `${rate}, ${READOUT.noSound}` : rate;
}

const two = (value) => (Number(value) || 0).toFixed(2);

/** The developer strip's line, from the reactor bridge's snapshot. */
export function debugText(snap) {
  // The tempo heard, then the beat clock the scene is given (after the
  // limiter's pace cap), in beats a second.
  const tempo = snap.bpm > 0 ? `${Math.round(snap.bpm)} bpm (${Math.round(snap.confidence * 100)}%)` : 'no tempo';
  const clock = Number.isFinite(snap.clock) ? `  |  clock ${two(snap.clock)}/s` : '';
  const mood = snap.mood ? `  |  ${snap.mood}` : '';
  return `bass ${two(snap.bass)}  mid ${two(snap.mid)}  treble ${two(snap.treble)}`
    + `  |  kick ${two(snap.kick)}  snare ${two(snap.snare)}  hat ${two(snap.hat)}`
    + `  |  ${tempo}${clock}  |  held ${snap.held}${mood}${snap.active ? '' : '  |  no sound'}`;
}

/** The flash budget's rolling second for the life of the page: closing and
 *  opening the tab again does not start a fresh one (flash-limiter.js). */
const PAGE_FLASH_LEDGER = createFlashLedger();

/** Ctrl+Shift+D: the developer strip on or off. */
export function isDebugKey(event) {
  return Boolean(event && event.ctrlKey && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'd');
}

/**
 * @param {HTMLElement} root  the element to fill (emptied on destroy)
 * @param {object} deps
 * @param {{ subscribe(fn, opts): () => void }} deps.signal  the shared sound signal
 * @param {() => object} deps.getSettings
 * @param {(partial: object) => void} deps.saveSettings
 * @param {(fn: (settings: object) => void) => () => void} deps.subscribeSettings
 * @param {() => number} [deps.random]  the shuffle's random source (seeded in tests)
 * @param {object} [deps.flashLedger]  the flash budget's window (the page's; a
 *        test gives its own)
 */
export function mountVisualizer(root, {
  signal,
  getSettings,
  saveSettings,
  subscribeSettings,
  win = globalThis.window,
  doc = globalThis.document,
  createContext = createWebglContext,
  createRenderer = createSceneRenderer,
  scenes = SCENES,
  loopOptions = {},
  random = null,
  loadFxLibrary = () => import('./vendor/psychedelia/engine/post-fx-library.js'),
  loadOverlays = () => import('./vendor/psychedelia/engine/overlays.js'),
  flashLedger = PAGE_FLASH_LEDGER,
} = {}) {
  const cleanups = [];
  const listen = (target, name, fn, options) => {
    target.addEventListener(name, fn, options);
    cleanups.push(() => target.removeEventListener(name, fn, options));
  };
  const clock = loopOptions.clock || (() => globalThis.performance?.now?.() ?? Date.now());
  const setTimer = loopOptions.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = loopOptions.clearTimer || ((handle) => clearTimeout(handle));
  const initial = getSettings?.() || {};
  const extras = normalizeVisualizerExtras(initial);
  let destroyed = false;
  let quality = normalizeVisualizerQuality(initial.visualizerQuality);
  let fps = normalizeVisualizerFps(initial.visualizerFps);
  let brightness = normalizeVisualizerBrightness(initial.visualizerBrightness);
  let sceneAsked = normalizeVisualizerScene(initial.visualizerScene);
  let looks = normalizeVisualizerLooks(initial.visualizerLooks);
  let showFps = initial.visualizerShowFps === true;
  let debug = initial.visualizerDebug === true;
  let panelOpen = extras.visualizerPanelOpen;
  let shuffleOn = extras.visualizerShuffle;
  let shufflePool = extras.visualizerShufflePool;
  let shuffleCost = extras.visualizerShuffleCost;
  let shuffleBars = extras.visualizerShuffleBars;
  let favourites = extras.visualizerFavourites;
  let noticeSeen = extras.visualizerNoticeSeen;
  let fxOn = extras.visualizerFx;
  let fxShuffleOn = extras.visualizerFxShuffle;
  let fxIntensity = extras.visualizerFxIntensity;
  let fxTiming = extras.visualizerFxTiming;
  let fxFlash = extras.visualizerFxFlash;
  let fxSet = extras.visualizerFxSet;
  let overlaysOn = extras.visualizerOverlays;
  let overlayShuffleOn = extras.visualizerOverlayShuffle;
  let overlaySet = extras.visualizerOverlaySet; // saved tokens
  let overlayLayer = null; // made the first time an overlay is drawn
  let overlayCombo = null; // the set made now: { key, ids, items: [{ id, blend, values }] }
  // The overlays chosen ([{ id, blend }]): the latest choice, made or still
  // waiting for the picture; the panel's ticks and blend rows show it, and
  // every choice by hand starts from it (as fxChosen for effects).
  let overlayChosen = [];
  let overlayDrawn = []; // as the scene draws them: [{ id, blend, values }]
  // What syncOverlays last gave the layer, values included (overlayStateOf).
  let overlayDrawnState = '';
  // The chosen ones the scene drawn now allows, before the step-down's cap:
  // what a favourite saves (overlayDrawn may be shorter).
  let overlayUncapped = [];
  let overlayScene = null; // the scene the overlays were last chosen for
  let overlayProvided = false; // the chain has the blend sheet (a blend-in was drawn)
  let started = false; // the picture moves (the notice was accepted, not shown again)
  let everStarted = false; // it has moved in this visit (a scene was asked for)
  let transition = null; // transition.js, once there is a renderer
  let deviceWidth = 0;
  let deviceHeight = 0;
  let lost = false;
  // Nothing is drawn before the drawing buffer has the tab's size (a draw
  // into the canvas's default 300 x 150 buffer would only be cleared again).
  // Without a ResizeObserver there is nothing to wait for.
  const observing = typeof win?.ResizeObserver === 'function';
  let sized = !observing;

  const el = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const entryOf = (id) => scenes.find((scene) => scene.id === id) || null;
  const sceneName = (id) => entryOf(id)?.name || id;
  // Favourites as read: each one's effects as its scene draws them (a calm
  // scene leaves lively ones out), so the star matches what is drawn and
  // can always take a favourite off again. Stored so when that changed it.
  const favouritesDrawn = (list) => favouritesAsDrawn(
    list,
    (id, fx) => fxDrawnFor(entryOf(id), fx),
    (id, overlays) => overlaysDrawnFor(entryOf(id), overlays),
  );
  {
    const drawn = favouritesDrawn(favourites);
    if (JSON.stringify(drawn) !== JSON.stringify(favourites)) {
      favourites = drawn;
      saveSettings?.({ visualizerFavourites: favourites });
    }
  }
  const knownIds = scenes.map((scene) => scene.id);
  // The list's order (by category, then name); previous and next follow it.
  const ordered = orderedScenes(scenes);

  root.classList.add('viz-root');
  const stage = el('div', 'viz-stage');
  const canvas = el('canvas', 'viz-canvas', { role: 'img', 'aria-label': 'Visualizer picture' });
  // The outgoing scene's last picture during a cross-fade (empty otherwise).
  const fade = el('canvas', 'viz-fade', { 'aria-hidden': 'true' });
  fade.hidden = true;
  fade.width = 0;
  fade.height = 0;
  // The overlays drawn plain on top (overlay-layer.js top sheet): empty and
  // hidden until one is on.
  const overlayCanvas = el('canvas', 'viz-overlay', { 'aria-hidden': 'true' });
  overlayCanvas.hidden = true;
  overlayCanvas.width = 0;
  overlayCanvas.height = 0;
  const message = el('p', 'viz-message', { role: 'status' });
  message.hidden = true;
  const readout = el('span', 'viz-fps', { 'aria-hidden': 'true' });

  /* ---- The buttons over the picture ---- */
  const hud = createHud({
    doc, stage, listen, setTimer, clearTimer, clock,
  });
  cleanups.push(() => hud.destroy());
  const prev = hud.buttons.prev;
  const next = hud.buttons.next;

  /* ---- The side panel ---- */
  const panel = el('div', 'viz-panel', { id: 'viz-panel', role: 'region', 'aria-label': 'Visualizer settings' });
  const panelHead = el('div', 'viz-panel-head');
  const panelClose = el('button', 'viz-btn viz-panel-close', { type: 'button', 'aria-label': 'Close settings', title: 'Close settings' }, CLOSE_MARK);
  panelHead.append(el('h2', 'viz-panel-title', {}, 'Visualizer'), panelClose);
  const section = (label) => {
    const node = el('div', 'viz-section', { role: 'group', 'aria-label': label });
    node.append(el('div', 'viz-section-title', { 'aria-hidden': 'true' }, label));
    return node;
  };
  // Scene: the list (a searchable panel opening in place).
  const sceneSection = section('Scene');
  const sceneList = createSceneList({
    doc, scenes: ordered, onPick: (id, how) => chooseScene(id, how), listen: (...args) => listen(...args),
  });
  const sceneGroup = el('div', 'viz-group viz-scene-group');
  sceneGroup.append(sceneList.button, sceneList.panel);
  // Look: the scene's ready-made colour schemes (looks.js); hidden when it
  // has none.
  const lookGroup = el('div', 'viz-group viz-look-group', { role: 'group', 'aria-label': 'Look' });
  const lookPrev = el('button', 'viz-btn viz-look-prev', { type: 'button', 'aria-label': 'Previous look', title: 'Previous look' }, PREVIOUS_MARK);
  const lookName = el('span', 'viz-look-name', { 'aria-live': 'polite' });
  const lookNext = el('button', 'viz-btn viz-look-next', { type: 'button', 'aria-label': 'Next look', title: 'Next look' }, NEXT_MARK);
  lookGroup.append(el('span', 'viz-label', { 'aria-hidden': 'true' }, 'Look'), lookPrev, lookName, lookNext);
  lookGroup.hidden = true;
  sceneSection.append(sceneGroup, lookGroup);
  // Shuffle.
  const shuffleSection = section('Shuffle');
  const selectField = (label, className, choices) => {
    const field = el('label', 'viz-field');
    const select = el('select', `viz-select ${className}`, { 'aria-label': label });
    for (const [value, text] of choices) select.append(Object.assign(el('option', '', {}, text), { value: String(value) }));
    field.append(el('span', 'viz-label', {}, label), select);
    return { field, select };
  };
  const shuffleMode = selectField('Shuffle', 'viz-shuffle-mode', SHUFFLE_CHOICES);
  const shuffleCostField = selectField('Scenes', 'viz-shuffle-cost', SHUFFLE_COST_CHOICES);
  const shuffleBarsField = selectField('Change every', 'viz-shuffle-bars', VISUALIZER_SHUFFLE_BARS.map((bars) => [bars, `${bars} bars`]));
  const moodLine = el('p', 'viz-mood', { 'aria-live': 'polite' });
  // Why "Favourites only" is not running (SHUFFLE_TEXT); empty otherwise.
  const shuffleNote = el('p', 'viz-mood viz-shuffle-note', { 'aria-live': 'polite' });
  shuffleSection.append(shuffleMode.field, shuffleNote, shuffleCostField.field, shuffleBarsField.field, moodLine);
  // Post effects.
  const fxSection = section('Effects');
  const checkField = (label, className) => {
    const field = el('label', 'viz-minor');
    const box = el('input', className, { type: 'checkbox' });
    field.append(box, el('span', '', {}, label));
    return { field, box };
  };
  const fxMaster = checkField('Effects on', 'viz-fx-on');
  const fxShuffleField = checkField('Shuffle effects', 'viz-fx-shuffle');
  const fxNow = el('button', 'viz-btn viz-fx-now', { type: 'button' }, 'New effects now');
  const fxTimingField = selectField('Change effects', 'viz-fx-timing', FX_TIMING_CHOICES);
  const fxIntensityField = selectField('Strength', 'viz-fx-intensity', FX_INTENSITY_CHOICES);
  const fxFlashField = checkField('Beat flash (limited)', 'viz-fx-flash');
  const fxLine = el('p', 'viz-fx-line', { 'aria-live': 'polite' });
  fxLine.hidden = true;
  const fxNote = el('p', 'viz-fx-note', { 'aria-live': 'polite' });
  fxNote.hidden = true;
  // One switch per effect: filled in when the library has loaded.
  const fxListEl = el('div', 'viz-fx-list', { role: 'group', 'aria-label': 'Effects by hand' });
  const fxBoxes = new Map(); // id -> checkbox
  const fxFields = new Map(); // id -> its label
  fxSection.append(fxMaster.field, fxShuffleField.field, fxNow, fxTimingField.field, fxIntensityField.field, fxFlashField.field, fxLine, fxNote, fxListEl);
  // Overlays: a section that folds (its title is a button).
  const ovSection = el('div', 'viz-section viz-ov-section', { role: 'group', 'aria-label': 'Overlays' });
  const ovHead = el('button', 'viz-section-title viz-ov-head', {
    type: 'button', 'aria-expanded': 'false', 'aria-controls': 'viz-ov-body',
  }, 'Overlays');
  const ovBody = el('div', 'viz-ov-body', { id: 'viz-ov-body' });
  const ovMaster = checkField('Overlays on', 'viz-ov-on');
  const ovShuffleField = checkField('Shuffle overlays', 'viz-ov-shuffle');
  const ovNow = el('button', 'viz-btn viz-ov-now', { type: 'button' }, 'New overlays now');
  const ovLine = el('p', 'viz-fx-line viz-ov-line', { 'aria-live': 'polite' });
  ovLine.hidden = true;
  const ovNote = el('p', 'viz-fx-note viz-ov-note', { 'aria-live': 'polite' });
  ovNote.hidden = true;
  // How each chosen overlay is blended in (one row per chosen overlay).
  const ovBlendEl = el('div', 'viz-ov-blends', { role: 'group', 'aria-label': 'How overlays blend in' });
  const ovRows = [];
  for (let index = 0; index < OVERLAY_MAX; index += 1) {
    // A group named by its overlay; each control's name says which overlay
    // it is for too (a screen reader moving from control to control).
    const name = el('span', 'viz-ov-name', { id: `viz-ov-name-${index}` });
    const row = el('div', 'viz-ov-row', { role: 'group', 'aria-labelledby': `viz-ov-name-${index}` });
    const mode = selectField(OVERLAY_TEXT.blend, 'viz-ov-mode', []);
    mode.field.classList.add('viz-ov-mode-field'); // beside the name (its label read, not shown)
    const under = checkField(OVERLAY_TEXT.under, 'viz-ov-under');
    const mask = selectField(OVERLAY_TEXT.mask, 'viz-ov-mask', OVERLAY_MASKS.map((id) => [id, OVERLAY_MASK_LABELS[id]]));
    const tint = checkField(OVERLAY_TEXT.tint, 'viz-ov-tint');
    const bend = checkField(OVERLAY_TEXT.bend, 'viz-ov-bend');
    bend.field.hidden = !OVERLAY_BEND_OFFERED;
    row.append(name, mode.field, mask.field, under.field, tint.field, bend.field);
    row.hidden = true;
    ovBlendEl.append(row);
    ovRows.push({
      row, name, mode: mode.select, under: under.box, mask: mask.select, tint: tint.box, bend: bend.box, id: null, modes: '',
    });
  }
  const ovListEl = el('div', 'viz-fx-list viz-ov-list', { role: 'group', 'aria-label': 'Overlays by hand' });
  const ovBoxes = new Map(); // id -> checkbox
  const ovFields = new Map(); // id -> its label
  for (const id of OVERLAY_IDS) {
    const row = overlayRow(id);
    const field = el('label', 'viz-fx-item viz-ov-item', { title: `${row.category}, ${row.cost}${row.source === 'ours' ? ', ours' : ''}` });
    const box = el('input', 'viz-fx-box viz-ov-box', { type: 'checkbox', 'data-overlay': id });
    field.append(box, el('span', '', {}, row.label));
    ovListEl.append(field);
    ovBoxes.set(id, box);
    ovFields.set(id, field);
  }
  ovBody.append(ovMaster.field, ovShuffleField.field, ovNow, ovLine, ovNote, ovBlendEl, ovListEl);
  ovSection.append(ovHead, ovBody);
  let ovOpen = overlaysOn; // folded unless overlays are on (this visit only)
  // Picture: quality, frame rate, brightness.
  const pictureSection = section('Picture');
  const qualityField = el('label', 'viz-field');
  const qualitySelect = el('select', 'viz-select viz-quality', { 'aria-label': 'Picture quality', title: 'Picture sharpness' });
  for (const id of VISUALIZER_QUALITIES) qualitySelect.append(Object.assign(el('option', '', {}, VISUALIZER_PRESETS[id].label), { value: id }));
  qualityField.append(el('span', 'viz-label', {}, 'Quality'), qualitySelect);
  const rateField = el('div', 'viz-field', { role: 'group', 'aria-label': 'Frame rate' });
  const rateButtons = el('div', 'viz-segments');
  const fpsButtons = VISUALIZER_FRAME_RATES.map((rate) => el('button', 'viz-seg', {
    type: 'button', 'data-fps': String(rate), 'aria-pressed': 'false', 'aria-label': `${rate} frames a second`,
  }, String(rate)));
  rateButtons.append(...fpsButtons);
  rateField.append(el('span', 'viz-label', { 'aria-hidden': 'true' }, 'Frame rate'), rateButtons);
  const brightField = el('label', 'viz-field viz-bright-field');
  const brightSlider = el('input', 'viz-brightness', {
    type: 'range',
    min: String(VISUALIZER_BRIGHTNESS_MIN),
    max: String(VISUALIZER_BRIGHTNESS_MAX),
    step: String(VISUALIZER_BRIGHTNESS_STEP),
    'aria-label': 'Brightness',
  });
  const brightValue = el('span', 'viz-bright-value', { 'aria-hidden': 'true' });
  brightField.append(el('span', 'viz-label', {}, 'Brightness'), brightSlider, brightValue);
  // The measured frame rate: a minor switch (its readout is over the picture).
  const fpsField = el('label', 'viz-minor');
  const fpsToggle = el('input', 'viz-fps-toggle', { type: 'checkbox', 'aria-label': 'Show measured frames a second' });
  fpsField.append(fpsToggle, el('span', '', {}, 'Show measured fps'));
  pictureSection.append(qualityField, rateField, brightField, fpsField);
  const noticeLine = el('button', 'viz-link viz-notice-again', { type: 'button' }, NOTICE.again);
  panel.append(panelHead, sceneSection, shuffleSection, fxSection, ovSection, pictureSection, noticeLine);
  panel.hidden = true;

  // The note: "Preparing scene..." or the step-down's note.
  const note = el('p', 'viz-note', { role: 'status', 'aria-live': 'polite' });
  note.hidden = true;

  /* ---- The photosensitivity notice ---- */
  const notice = createNotice({
    doc,
    listen,
    onContinue: () => acceptNotice(),
    onNotNow: () => declineNotice(),
    // While it is open, nothing else of the visualizer can be reached.
    setInert: (on) => { for (const node of [canvas, readout, note, hud.element, panel]) node.inert = on; },
  });

  stage.append(canvas, fade, overlayCanvas, message, readout, note, hud.element, panel, notice.element, notice.startBox);
  root.append(stage);

  const say = (text) => {
    message.textContent = text || '';
    message.hidden = !text;
  };

  /* ---- Step-down and the note ---- */
  // The heaviest class the shuffle may pick after the step-down lowered the
  // picture (null: no cap). Cleared with the step-down by a choice by hand.
  let costCap = null;
  // The scene the picture is sized for (its own pixel budget, scenes.js
  // SCENE_MAX_PIXELS): set as each scene is installed.
  let sizedScene = null;
  const stepDown = createStepDown({
    quality,
    fps,
    // Post effects go before quality (fx-chain.js), then overlays. Counted
    // as drawn (one that failed here takes no slot); the choice stays whole:
    // the cap only shortens what is drawn (syncFx, syncOverlays).
    fxInUse: () => fxDrawnCount,
    overlaysInUse: () => overlayDrawn.length,
    onStep: (to) => {
      if (fxDrawnCount > to.fx || overlayDrawn.length > to.overlays) {
        redrawUnderCaps();
        showNote();
        return;
      }
      const cost = entryOf(switcher?.current)?.cost;
      // A scene picked ahead that is now too heavy is let go (poolChanged).
      if (cost) setCostCap(costCap ? lighterCost(costCap, shuffleCostCap(cost)) : shuffleCostCap(cost));
      applyStepDown();
    },
  });
  let preparing = false;
  let preparingTimer = 0;
  function showNote() {
    let text = '';
    if (preparing) text = NOTES.preparing;
    // Only for a notch taken while this scene shows: a scene that starts at
    // what it needed before says nothing again (step-down.js stepped).
    else if (!stepDown.stepped) text = '';
    else if (stepDown.level > 0) text = NOTES.lowered;
    else {
      // What is held back now: effects, overlays, or both (overlays go
      // after effects, which stay held back).
      const fewerFx = stepDown.fx !== Number.POSITIVE_INFINITY;
      const fewerOverlays = stepDown.overlays !== Number.POSITIVE_INFINITY;
      if (fewerFx && fewerOverlays) text = NOTES.fewerBoth;
      else if (fewerFx) text = NOTES.fewerFx;
      else if (fewerOverlays) text = NOTES.fewerOverlays;
    }
    if (note.textContent !== text) note.textContent = text;
    note.hidden = !text;
  }
  function startPreparing() {
    if (preparingTimer) clearTimer(preparingTimer);
    preparingTimer = 0;
    if (isHidden()) return; // nobody to tell
    if (renderer?.compileBlocks) {
      // The compile will block the page (scene-renderer.js
      // BLOCKING_COMPILE_DELAY_MS): the note now, before it starts.
      preparing = true;
      showNote();
      return;
    }
    preparingTimer = setTimer(() => {
      preparingTimer = 0;
      preparing = true;
      showNote();
    }, PREPARING_DELAY_MS);
  }
  function stopPreparing() {
    if (preparingTimer) clearTimer(preparingTimer);
    preparingTimer = 0;
    preparing = false;
    showNote();
  }
  cleanups.push(() => { if (preparingTimer) clearTimer(preparingTimer); preparingTimer = 0; });

  function showQuality() { qualitySelect.value = quality; }
  function showFpsChoice() {
    for (const button of fpsButtons) {
      button.setAttribute('aria-pressed', button.getAttribute('data-fps') === String(fps) ? 'true' : 'false');
    }
  }
  /** Brightness is the canvas's opacity over the black backing: the
   *  compositor applies it, nothing is redrawn, so it reaches a still
   *  picture at once and costs nothing per frame. */
  function showBrightness(value = brightness) {
    // (During a dip the transition owns the opacity; it ends on brightness.)
    if (!transition?.ownsOpacity) canvas.style.opacity = value >= VISUALIZER_BRIGHTNESS_MAX ? '' : String(value / 100);
    overlayLayer?.setBrightness(value >= VISUALIZER_BRIGHTNESS_MAX ? 1 : value / 100);
    brightSlider.value = String(value);
    brightSlider.setAttribute('aria-valuetext', `${value} percent`);
    brightValue.textContent = `${value}%`;
  }
  function showReadoutChoice() {
    fpsToggle.checked = showFps;
    readout.hidden = !showFps;
  }
  // The shuffle's pool can be asked once the shuffle and the switcher exist.
  let shuffleBuilt = false;
  function showShuffleChoice() {
    shuffleMode.select.value = shuffleOn ? shufflePool : 'off';
    shuffleCostField.select.value = shuffleCost;
    shuffleBarsField.select.value = String(shuffleBars);
    if (shuffleBuilt) showShuffleRunning();
    else hud.setShuffle(shuffleOn);
  }
  /** Why the shuffle chosen has nothing to shuffle ('' when it has). */
  function shuffleIdleText() {
    if (!shuffleOn || shufflePool !== 'favourites') return '';
    if (!favouriteEntries(favourites).length) return SHUFFLE_TEXT.noFavourites;
    return shuffle.poolOf(fillPoolContext()).length ? '' : SHUFFLE_TEXT.noneFit;
  }
  /** The button shows the shuffle running only when it has scenes to show;
   *  the panel says why not. */
  function showShuffleRunning() {
    const idle = shuffleIdleText();
    if (shuffleNote.textContent !== idle) shuffleNote.textContent = idle;
    hud.setShuffle(shuffleOn && !idle);
  }
  function showPanel() {
    panel.hidden = !panelOpen;
    root.classList[panelOpen ? 'add' : 'remove']('viz-panel-open');
    hud.setPanel(panelOpen);
    if (!panelOpen) sceneList.close();
  }
  showQuality();
  showFpsChoice();
  showBrightness();
  showReadoutChoice();
  showShuffleChoice();
  showFxChoice();
  showOverlayChoice();
  showPanel();
  sceneList.setCurrent(entryOf(sceneAsked) ? sceneAsked : DEFAULT_SCENE);
  sceneList.setFavourites(favouriteEntries(favourites).map((entry) => entry.scene));

  let lastReadout = '';
  let lastMode = null;
  let lastThrottled = false;
  function onStatus(status) {
    // The step-down measures one spell of live, shown frames at a time.
    if (status.mode !== lastMode || status.throttled !== lastThrottled) {
      lastMode = status.mode;
      lastThrottled = status.throttled;
      stepDown.restart();
    }
    if (status.mode === LOOP_MODES.still) say(MESSAGES.stillMotion);
    else if (!lost && message.textContent === MESSAGES.stillMotion) say('');
    const text = fpsText(status);
    if (text !== lastReadout) {
      lastReadout = text;
      readout.textContent = text;
    }
  }

  // The graphics context. Without one there is nothing else to start.
  let renderer = null;
  const made = createContext(canvas);
  if (!made) {
    say(MESSAGES.noWebgl);
    hud.element.hidden = true;
  } else {
    try {
      renderer = createRenderer({ canvas, gl: made.gl, mode: made.mode, capsFor: sceneCaps });
    } catch (error) {
      console.error('visualizer scene failed:', error);
      try { made.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
      say(MESSAGES.noScene);
      hud.element.hidden = true;
    }
  }

  /* ---- Post effects (fx-chain.js): nothing made until some are on ---- */
  // Trigger firings are charged to the flash budget's rolling second (the
  // bridge is made below; firings come only once frames are drawn). A link
  // finishing or failing later updates what the tab shows as drawn.
  const fxChain = renderer && made ? createFxChain({
    gl: made.gl,
    mode: made.mode,
    charge: () => (bridge ? bridge.charge() : true),
    onChange: () => { if (!destroyed) fxDrawnChanged(); },
  }) : null;
  const reactions = createGlobalReactions();
  let fxItems = null; // the catalog, once the library has loaded
  let fxById = new Map();
  let fxShuffle = null;
  let fxLoading = null;
  let fxFailed = false;
  let fxCombo = null; // the combination made now (shuffle, by hand, favourite)
  // The effects chosen: the latest choice, made or still waiting for the
  // picture (a change waits for the flash budget or a fade in progress).
  // The panel's ticks show it, and every choice by hand starts from it;
  // what is drawn may lag behind it, never rewrite it.
  // One rule orders the choices: the latest made wins. A change waiting is
  // replaced by a later one (changeFx), and dropped when one is made at once
  // (applyFx: a scene's own effects), so it never overwrites a newer one.
  // The bar timer waits while a change waits (fxStep).
  let fxChosen = [];
  let fxDrawn = []; // its ids drawn now: the scene allows them (fxDrawnFor) and their programs are ready
  let fxFailedIds = []; // its ids whose programs failed
  // What syncFx last gave the chain: the pass ids, how many of them count
  // (not failed), and the chosen ones the step-down's cap left out (kept in
  // the choice and in a favourite of it; drawn again when the cap goes).
  let fxPassIds = '';
  let fxDrawnCount = 0;
  let fxCapped = [];
  let fxScene = null; // the scene the effects were last chosen for
  let fxCalmSet = null; // the effects a calm scene may get (scenes.js fxCalm)
  const fxTimer = createShuffleTimer({
    bars: fxTiming === 'scene' ? 8 : fxTiming, minDwell: FX_MIN_DWELL_S, maxDwell: FX_MAX_DWELL_S,
  });
  const fxStats = {
    changes: 0, waitedBudget: 0, byHand: 0, trimmed: 0, favourites: 0,
    /** Effect programs held now: the chain's, up to FX_PROGRAM_CACHE others, and any linking. */
    get programs() { return fxChain ? fxChain.stats.programs : 0; },
    get linking() { return fxChain ? fxChain.linking : 0; },
  };
  cleanups.push(() => fxChain?.destroy());

  /** The scene, through the FX chain when effects are on (else straight to
   *  the screen: the chain is bypassed). */
  let reactionsAt = Number.NaN;
  let overlayAt = Number.NaN; // the frame the overlays were last drawn for
  let overlayClock = Number.NaN; // their real time then (s)
  function drawFrame(state) {
    if (!renderer) return false;
    // The overlays move once a frame (not again for the old scene under a
    // cross-fade), in real time, and only while the picture moves.
    if (overlayLayer?.on && !state.still && state.time !== overlayAt) {
      overlayAt = state.time;
      const now = clock() / 1000;
      const dt = Number.isFinite(overlayClock) ? now - overlayClock : 0;
      overlayClock = now;
      overlayLayer.render(now, dt, state.sources);
    }
    if (fxChain && !fxChain.active && fxChain.holding) fxChain.release();
    const target = fxChain?.active && !lost ? fxChain.begin(renderer.width, renderer.height) : null;
    if (!target) return renderer.draw(state);
    // Flash and pump are slew-limited per second: a frame drawn twice (the
    // old scene under a cross-fade) moves them once.
    const fresh = state.time !== reactionsAt;
    reactionsAt = state.time;
    fxChain.setReactions(reactions.step(state.sources, fxIntensity, fxFlash, fresh ? state.dt : 0));
    const drawn = renderer.draw(state, target);
    if (drawn) fxChain.finish(state);
    return drawn;
  }

  /* ---- Developer strip (off unless asked for; never touched while off) ---- */
  const bridge = renderer ? createReactorBridge({ EffectRegistry: renderer.engine?.EffectRegistry || null, ledger: flashLedger }) : null;
  const mood = createMoodTracker();
  let debugEl = null;
  let debugDue = 0;
  const snapshot = () => ({ ...bridge.snapshot(), mood: mood.mood });
  function showDebug() {
    if (debug && !debugEl) {
      debugEl = el('div', 'viz-debug', { 'aria-hidden': 'true' });
      stage.append(debugEl);
    }
    if (debugEl) {
      debugEl.hidden = !debug;
      debugDue = 0;
      if (debug) debugEl.textContent = debugText(snapshot());
    }
  }
  function tickDebug() {
    const now = clock();
    if (now < debugDue) return;
    debugDue = now + DEBUG_INTERVAL_MS;
    debugEl.textContent = debugText(snapshot());
  }

  /* ---- Shuffle state ---- */
  const shuffle = createShuffle({ scenes, random: random || seededRandom(Math.floor(clock() * 1000) ^ 0x5eed) });
  const shuffleTimer = createShuffleTimer({ bars: shuffleBars });
  // The looks the shuffle chose (this visit only; a look chosen by hand is
  // saved as before and takes over), and the scenes it still has to choose a
  // look for (when their definition arrives).
  const shuffleLooks = new Map();
  const lookToPick = new Set();
  // A favourite picked by hand from the scene list's favourites, waiting for
  // its scene to be shown (chooseScene, recallFavourite).
  let recall = null;
  let nextPick = null; // the scene being prepared ahead
  // Nothing new to show: the pool is the scene showing, at the only look it
  // may have (one favourite). Picked again only when the pool changes.
  let nothingNew = false;
  // The pick prepared ahead is the scene showing, at its look: only its
  // effects change (a favourite of it starred with other effects).
  let fxOnlyPick = false;
  // The pool had nothing to pick: not asked again until it changes.
  let poolEmpty = false;
  const poolContext = {
    current: null, pool: 'all', favourites: [], costMax: 'heavy', mood: 'steady',
  };
  // Scenes shown, for previous / next while shuffle is on.
  let trail = [];
  let trailAt = -1;
  let walkingTrail = false;
  let shownMood = null;
  const shuffleStats = {
    changes: 0, waitedNotReady: 0, waitedBudget: 0, notPrepared: 0, dropped: 0, nothingNew: 0, fxOnly: 0,
  };
  // What the mood reads each frame (one object, filled in again).
  const sound = {
    kick: 0, snare: 0, hat: 0, level: 0, confidence: 0, bpm: 0,
  };

  function lookFor(id, def) {
    if (lookToPick.has(id)) {
      lookToPick.delete(id);
      const numbers = sceneLooks(def).map((look) => look.number);
      const allowed = shufflePool === 'favourites' ? favouriteLooks(favourites, id) : null;
      const pick = numbers.length > 1 ? shuffle.look(id, numbers, allowed) : null;
      if (pick === null) shuffleLooks.delete(id);
      else shuffleLooks.set(id, pick);
    }
    return shuffleLooks.has(id) ? shuffleLooks.get(id) : looks[id];
  }

  function showMood() {
    const name = started ? mood.mood : '';
    if (name === shownMood) return; // nothing built per frame
    shownMood = name;
    moodLine.textContent = name ? `Music: ${name}` : '';
  }

  /* ---- The frame loop ---- */
  let lastState = null;
  const loop = renderer
    ? createVisualizerLoop({
      signal,
      doc,
      win,
      fps: stepDown.fps,
      // Every tick of the sound loop, drawn or only heard, also teaches the
      // step-down the display's frame cadence, and steps the mood and shuffle.
      react: (state, source, nowSec, dt) => {
        stepDown.tick(nowSec * 1000);
        bridge.react(state, source, nowSec, dt);
        if (source && loop?.mode === LOOP_MODES.live) liveStep(nowSec);
      },
      onStatus,
      draw: (state) => {
        if (!sized) return false;
        lastState = state;
        const drawn = drawFrame(state);
        if (debug && debugEl) tickDebug();
        // Frame intervals only: nothing is read back from the GPU.
        // Not while another scene is being prepared: the one being drawn is
        // on its way out.
        if (drawn && state.live && !switcher?.busy) stepDown.frame(clock());
        return drawn;
      },
      ...loopOptions,
    })
    : null;

  /** One frame of sound: the mood, and the shuffle's clock. Called only
   *  while live and drawn (the loop calls nothing while hidden or throttled,
   *  so the shuffle's clock does not move then). Allocates nothing. */
  function liveStep(nowSec) {
    const music = bridge.music();
    const heard = bridge.reactor;
    sound.kick = heard.getSource('kick');
    sound.snare = heard.getSource('snare');
    sound.hat = heard.getSource('hat');
    sound.level = heard.getSource('level');
    sound.confidence = music.confidence;
    sound.bpm = music.bpm;
    mood.step(nowSec, sound);
    bridge.setStrength(mood.strength);
    showMood();
    fxStep(nowSec, music);
    if (!shuffleOn || !started || lost || !switcher?.current) return;
    if (!nextPick) chooseNext();
    if (!shuffleTimer.step(nowSec, music.beats, music.confidence)) return;
    if (!nextPick || switcher.busy || transition.busy) return;
    if (fxOnlyPick) {
      const id = nextPick;
      nextPick = null;
      fxOnlyPick = false;
      if (id === switcher.current && eligible(id)) showFavouriteFx(id);
      return;
    }
    // Picked while the scene now showing was still coming in: it is that
    // scene, nothing to change; picked again (perhaps its effects only).
    if (nextPick === switcher.current) { nextPick = null; return; }
    if (!switcher.staged(nextPick)) {
      // Not ready yet: wait (the scene showing stays), never a blank. One
      // that could not be prepared is let go; another is picked next frame.
      if (switcher.stagedId !== nextPick) {
        lookToPick.delete(nextPick);
        nextPick = null;
        shuffleStats.notPrepared += 1;
      }
      shuffleStats.waitedNotReady += 1;
      return;
    }
    // The change is one large change of light: only when the flash budget
    // has room (transition.js charges it).
    if (!bridge.limiter.room(nowSec)) { shuffleStats.waitedBudget += 1; return; }
    // Still allowed (favourites, mode, cost and step-down may have changed)?
    if (!eligible(nextPick)) { forgetNext(); return; }
    const id = nextPick;
    nextPick = null;
    shuffleStats.changes += 1;
    showScene(id);
  }

  /** The pool's rules now (one object, filled in again). */
  function fillPoolContext() {
    poolContext.current = switcher?.current || null;
    poolContext.pool = shufflePool;
    poolContext.favourites = favouriteEntries(favourites);
    poolContext.costMax = shuffleCostMax();
    poolContext.mood = mood.mood;
    return poolContext;
  }

  /** Scene `id` may be shuffled to now. */
  function eligible(id) {
    return Boolean(shuffleOn && id && shuffle.poolOf(fillPoolContext()).includes(id));
  }

  /** Something the pool depends on changed (favourites, mode, cost filter,
   *  step-down cap): the pick prepared ahead is checked again. */
  function poolChanged() {
    poolEmpty = false;
    nothingNew = false;
    if (shuffleBuilt) showShuffleRunning();
    if (nextPick && !eligible(nextPick)) {
      shuffleStats.dropped += 1;
      forgetNext();
    }
  }

  /** The heaviest cost class the shuffle may pick now. */
  function shuffleCostMax() {
    const chosen = costFilterMax(shuffleCost);
    return costCap ? lighterCost(chosen, costCap) : chosen;
  }

  /** Pick the shuffle's next scene and prepare it ahead. */
  function chooseNext() {
    if (poolEmpty || nothingNew) return;
    const id = shuffle.next(fillPoolContext());
    if (!id) { poolEmpty = true; return; }
    // The only scene there is, already showing at its only allowed look:
    // nothing to prepare, install or charge; or only other effects (a
    // favourite starred with them), changed when the timer says, the scene
    // staying as it is.
    if (id === switcher?.current && onlyAsShown(id)) {
      if (!favouriteFxToShow(id).length) { nothingNew = true; shuffleStats.nothingNew += 1; return; }
      fxOnlyPick = true;
      nextPick = id;
      return;
    }
    fxOnlyPick = false;
    lookToPick.add(id);
    nextPick = id;
    switcher.preload(id);
  }

  /** Scene `id` (showing) is the whole pool, and no other look of it may
   *  come: it has at most one, or the favourites allow only the one shown. */
  function onlyAsShown(id) {
    if (shuffle.poolOf(fillPoolContext()).length !== 1) return false;
    const count = renderer?.definition ? sceneLooks(renderer.definition).length : 0;
    if (count < 2) return true;
    if (shufflePool !== 'favourites') return false;
    const allowed = favouriteLooks(favourites, id);
    const shown = lookState()?.index ?? null;
    return allowed.length > 0 && allowed.every((look) => look === shown);
  }

  /** The favourites' combinations (effects and overlays) for scene `id`
   *  (showing) at the look shown that differ from what is drawn now (each as
   *  the scene draws it; only the parts that are on count). */
  function favouriteFxToShow(id) {
    const fxCounts = fxOn && fxReady();
    if (shufflePool !== 'favourites' || (!fxCounts && !overlaysOn)) return [];
    const entry = entryOf(id);
    const look = lookState()?.index ?? null;
    const keyOf = (fx, overlays) => `${fxCounts ? fxDrawnFor(entry, fx).slice().sort().join('+') : ''}/${overlaysOn ? overlaysKey(overlaysDrawnFor(entry, overlays)) : ''}`;
    const now = keyOf(fxChosen, overlayChosen);
    return favouriteCombos(favourites, id, look).filter((combo) => keyOf(combo.fx, combo.overlays) !== now);
  }
  /** The timer's change when only the effects change: one of the
   *  favourite's sets, under the usual change of picture (transition.js: a
   *  fast one is charged; with the budget full it is slow and not charged). */
  function showFavouriteFx(id) {
    const sets = favouriteFxToShow(id);
    if (!sets.length) return;
    const pick = sets[Math.floor((random || Math.random)() * sets.length)];
    shuffleStats.fxOnly += 1;
    fxStats.favourites += 1;
    fxTimer.restart();
    shuffleTimer.restart();
    if (fxOn && fxReady()) changeFx(comboFor(pick.fx, { fresh: true }));
    if (overlaysOn) changeOverlays(overlayComboFor(pick.overlays, { fresh: true }));
  }

  /** A pick waiting to be shown is dropped (the pool or its rules changed). */
  function forgetNext() {
    if (nextPick) lookToPick.delete(nextPick);
    fxOnlyPick = false;
    nextPick = null;
    switcher?.dropStage();
  }

  /* ---- Scenes ---- */
  const switcher = renderer
    ? createSceneSwitcher({
      renderer,
      scenes,
      // Only the scene's own link table, through the link rule (reactor.js).
      linksFor: (def) => bridge.linksFor(def, entryOf(def?.name)),
      // Its `defaults`, with the look chosen for it on top.
      overridesFor: (entry, def) => lookOverrides(entry, def, lookFor(entry.id, def)),
      // The change of picture: now (0), or in that many ms (one in progress).
      beforeInstall: () => transition.begin(),
      timers: { setTimer: loopOptions.setTimer, clearTimer: loopOptions.clearTimer, clock: loopOptions.clock },
      onChange: ({ state, id, current }) => {
        if (destroyed) return;
        if (state === SWITCH_STATES.loading) {
          startPreparing();
        } else if (state === SWITCH_STATES.ready) {
          // The step-down is the scene's (step-down.js): the chosen quality and
          // frame rate, or what this scene needed earlier this visit; measured
          // afresh after its warm-up. Under the change's fade.
          // Its own pixel budget too, if it has one (or the last scene had).
          const wasPixels = sceneMaxPixels(sizedScene, stepDown.quality);
          const levelChanged = stepDown.newScene(id);
          sizedScene = id;
          if (levelChanged || wasPixels !== sceneMaxPixels(id, stepDown.quality)) applySize();
          if (levelChanged) loop?.setFps(stepDown.fps);
          transition.applied();
          // The chosen effects and overlays, as this scene allows them, from
          // its first frame.
          syncFx();
          syncOverlays();
          // A new scene: feedback effects start again from it; its effects
          // (with the scene, or a favourite's) change under the same fade.
          fxChain?.resetHistory();
          stopPreparing();
          // A scene that wraps the beat clock, or an effect that fires on it,
          // gets part of the pulse budget for it.
          updateClockShown();
          // Its cap on the time surge (scenes.js maxSpeed), if it has one.
          bridge.setSpeedCap(entryOf(id)?.maxSpeed);
          sceneList.setCurrent(id);
          showLook();
          // A favourite picked by hand for this scene comes first; the
          // shuffle's choices below then have nothing to make for it.
          const asked = recall;
          recall = null;
          recallFavourite(asked, id);
          // (syncFx and syncOverlays above drew the choice under this
          // scene's own caps, if it needed fewer before: the choice is whole.)
          fxForScene(id);
          overlaysForScene(id);
          showFx(); // what this scene draws, and what it leaves out
          showOverlays();
          showStar();
          noteShown(id);
          canvas.setAttribute('aria-label', `${sceneName(id)}, a moving picture`);
          if (message.textContent === MESSAGES.sceneFailed || message.textContent === MESSAGES.noScene) say('');
          if (!started) drawStill();
          redrawIfHeld();
        } else if (state === SWITCH_STATES.failed) {
          stopPreparing();
          if (current) {
            sceneList.setCurrent(current);
            say(MESSAGES.sceneFailed);
          } else if (id === DEFAULT_SCENE) {
            say(MESSAGES.noScene);
          }
        }
      },
    })
    : null;
  shuffleBuilt = true;
  showShuffleRunning();

  /** A scene now shown: the shuffle's memory and the previous / next trail. */
  function noteShown(id) {
    shuffle.shown(id);
    if (walkingTrail) { walkingTrail = false; return; }
    if (trail[trailAt] === id) return;
    trail = trail.slice(0, trailAt + 1);
    trail.push(id);
    if (trail.length > TRAIL_MAX) trail = trail.slice(-TRAIL_MAX);
    trailAt = trail.length - 1;
  }

  /** A held or still picture is drawn again at once (a moving one shows a
   *  change on its next frame). */
  function redrawIfHeld() {
    if (!started) { drawStill(); return; }
    if (loop && (loop.mode === LOOP_MODES.still || loop.mode === LOOP_MODES.rest)) loop.redraw();
  }

  /** Paused (or never started): the picture drawn once, the same frame as
   *  last shown when there is one; nothing scheduled. */
  function drawStill() {
    if (!renderer || !sized || lost || started) return;
    drawFrame(lastState || STILL_STATE);
  }

  const isHidden = () => doc?.visibilityState === 'hidden' || doc?.hidden === true;

  /* ---- Changes of picture (transition.js) ---- */
  if (renderer) {
    transition = createTransition({
      canvas,
      fade,
      setTimer,
      clearTimer,
      clock,
      brightness: () => (brightness >= VISUALIZER_BRIGHTNESS_MAX ? 1 : brightness / 100),
      // Only over a moving, seen picture that has something to change from.
      enabled: () => Boolean(started && !isHidden() && sized && !lost && loop
        && loop.mode !== LOOP_MODES.still && renderer?.definition),
      drawOld: () => Boolean(drawFrame(lastState || STILL_STATE)),
      charge: () => !bridge || bridge.limiter.transition(clock() / 1000),
    });
    cleanups.push(() => transition.finishNow());
  }
  // Changes of look or effects waiting for the picture (per kind, the latest
  // one wins; all that wait are made under one fade).
  const pendingChanges = new Map();
  let changeTimer = 0;
  function guardedChange(apply, kind = 'look') {
    pendingChanges.set(kind, apply);
    if (!changeTimer) tryChange();
  }
  function tryChange() {
    changeTimer = 0;
    // A 'caps' change that something since made moot (a scene's own sync,
    // a change made at once) begins no transition and charges nothing.
    if (pendingChanges.has('caps') && !destroyed && !capsDiffer()) pendingChanges.delete('caps');
    if (!pendingChanges.size || destroyed) return;
    const wait = transition.begin();
    if (wait > 0) { changeTimer = setTimer(tryChange, wait); return; }
    const changes = [...pendingChanges.values()];
    pendingChanges.clear();
    for (const apply of changes) apply();
    transition.applied();
  }
  /** A waiting change is made now, without a fade (hidden, paused). */
  function flushChange() {
    if (changeTimer) clearTimer(changeTimer);
    changeTimer = 0;
    if (pendingChanges.size) tryChange();
  }
  cleanups.push(() => { if (changeTimer) clearTimer(changeTimer); changeTimer = 0; pendingChanges.clear(); });

  /* ---- Looks ---- */
  /** The scene being drawn: its looks offered, the number of the one it
   *  starts with, the number of the one shown (index) and its place in the
   *  list (at). */
  function lookState() {
    const def = renderer?.definition;
    const id = switcher?.current;
    if (!def || !id) return null;
    const list = sceneLooks(def);
    if (list.length < 2) return null;
    const start = startLook(list, sceneDefaults(def, entryOf(id)?.defaults || null));
    const saved = shuffleLooks.has(id) ? shuffleLooks.get(id) : looks[id];
    const index = currentLook(list, saved, start);
    return { id, def, list, start, index, at: Math.max(0, list.findIndex((look) => look.number === index)) };
  }
  function showLook() {
    const current = lookState();
    lookGroup.hidden = !current;
    if (!current) return;
    const name = current.list[current.at].name;
    lookName.textContent = name;
    lookGroup.setAttribute('aria-label', `Look: ${name}`);
  }
  /** The values to set for the look chosen now for the scene being drawn
   *  (only what differs from what is drawn), or null. */
  function lookValues() {
    const current = lookState();
    if (!current) return null;
    const start = sceneDefaults(current.def, entryOf(current.id)?.defaults || null);
    const target = {};
    // Every value any look sets: from this look, or back to the start.
    for (const look of current.list) for (const name of Object.keys(look.values)) target[name] = start[name];
    Object.assign(target, current.list[current.at].values);
    // Only what differs from what is drawn now (so an unchanged compiled-in
    // param does not force a new compile).
    const now = renderer.values || {};
    const values = {};
    for (const [name, value] of Object.entries(target)) if (now[name] !== value) values[name] = value;
    return Object.keys(values).length ? values : null;
  }
  /** Show the look now chosen for the scene being drawn, through a
   *  transition like a change of scene: a change of uniforms when it can be
   *  (no new compile), else the scene is prepared again (the switcher then
   *  asks for the transition). */
  function showLookValues() {
    const values = lookValues();
    if (!values) return;
    const def = renderer.definition;
    const fixed = new Set(def?.specialize || []);
    if (Object.keys(values).some((name) => fixed.has(name))) {
      switcher.request(switcher.current, { reload: true });
      return;
    }
    guardedChange(() => {
      const latest = lookValues(); // the latest look asked for wins
      if (!latest) return;
      if (renderer.setValues(latest)) redrawIfHeld();
      else switcher.request(switcher.current, { reload: true });
    });
  }
  function stepLook(step) {
    const current = lookState();
    if (!current) return;
    const count = current.list.length;
    const index = current.list[(((current.at + step) % count) + count) % count].number;
    shuffleLooks.delete(current.id); // chosen by hand: saved, and it counts
    looks = withLook(looks, current.id, index, current.start, knownIds);
    showLookValues();
    showLook();
    showStar();
    saveSettings?.({ visualizerLooks: looks });
  }
  /** Looks changed in the settings (another window, or a reset). */
  function followLooks(nextLooks) {
    const before = lookState();
    looks = nextLooks;
    const after = lookState();
    if (before && after && after.index !== before.index) showLookValues();
    showLook();
    showStar();
  }

  /* ---- Favourites ---- */
  /** The scene, look, effects and overlays shown now, as a favourite:
   *  { scene, look, fx, overlays } or null. */
  function shownFavourite() {
    const id = switcher?.current;
    if (!id) return null;
    const current = lookState();
    // Only what is drawn: on a calm scene, not the effects it leaves out;
    // the overlays with the blend-in they are drawn with.
    return {
      scene: id,
      look: current ? current.index : null,
      // What was chosen, though: not shortened by the step-down's cap.
      fx: fxOn ? (fxCapped.length && fxCombo ? fxCombo.ids.filter((fx) => fxDrawn.includes(fx) || fxCapped.includes(fx)) : fxDrawn.slice()) : [],
      overlays: overlaysOn ? overlayUncapped.map((item) => ({ id: item.id, blend: item.blend })) : [],
    };
  }
  function showStar() {
    // What is shown changed (scene, look, effects, overlays, favourites): the
    // shuffle looks again whether a favourite differs from it.
    nothingNew = false;
    const shown = shownFavourite();
    hud.setStar(Boolean(shown && isFavourite(favourites, shown.scene, shown.look, shown.fx, shown.overlays)), Boolean(shown));
  }
  function toggleStar() {
    const shown = shownFavourite();
    if (!shown) return;
    const on = !isFavourite(favourites, shown.scene, shown.look, shown.fx, shown.overlays);
    favourites = withFavourite(favourites, shown.scene, shown.look, on, knownIds, shown.fx, shown.overlays);
    showFavourites();
    poolChanged();
    saveSettings?.({ visualizerFavourites: favourites });
  }
  function showFavourites() {
    sceneList.setFavourites(favouriteEntries(favourites).map((entry) => entry.scene));
    showStar();
  }

  /* ---- Post effects ---- */
  /** Most effects in the choice: the quality chosen (choosing a lower one by
   *  hand trims the choice, trimFx). */
  function fxMaxNow() {
    return Math.min(FX_MAX_ACTIVE, FX_MAX_BY_QUALITY[quality] ?? FX_MAX_ACTIVE);
  }
  /** Most effects drawn now: the quality drawn (the step-down's), under the
   *  step-down's cap. Only what is drawn is shortened (syncFx). */
  function fxDrawMax() {
    return Math.min(FX_MAX_ACTIVE, FX_MAX_BY_QUALITY[stepDown.quality] ?? FX_MAX_ACTIVE, stepDown.fx);
  }
  const fxCostBudget = () => FX_COST_BUDGET[stepDown.quality] ?? FX_COST_BUDGET.medium;
  const fxReady = () => Boolean(fxShuffle && fxChain);

  /** The effects' settings as the panel shows them. */
  function showFxChoice() {
    fxMaster.box.checked = fxOn;
    fxShuffleField.box.checked = fxShuffleOn;
    fxTimingField.select.value = String(fxTiming);
    fxIntensityField.select.value = fxIntensity;
    fxFlashField.box.checked = fxFlash;
    for (const node of [fxShuffleField.box, fxTimingField.select, fxIntensityField.select, fxFlashField.box]) node.disabled = !fxOn;
    fxNow.disabled = !fxOn;
  }
  /** What is on now: the line and the list's switches. */
  function showFx() {
    const ids = fxChosen;
    const drawn = fxOn ? fxDrawn : [];
    let text = '';
    if (fxOn) {
      if (fxFailed) text = FX_TEXT.failed;
      else if (!fxItems) text = FX_TEXT.loading;
      else text = drawn.length ? `Effects: ${drawn.map((id) => fxById.get(id)?.label || id).join(', ')}` : FX_TEXT.none;
    }
    if (fxLine.textContent !== text) fxLine.textContent = text;
    fxLine.hidden = !text;
    // The scene drawn now may not allow some (scenes.js fxCalm, fxNone): they
    // stay chosen, look unavailable, and come back on a scene that allows them.
    const entry = entryOf(switcher?.current);
    const failed = fxOn ? fxFailedIds : [];
    const sceneNote = fxOn && fxItems ? (entry?.fxNone ? FX_TEXT.noneHere : (entry?.fxCalm ? FX_TEXT.calmHere : '')) : '';
    const failedNote = failed.length ? FX_TEXT.failed1(failed.map((id) => fxById?.get(id)?.label || id).join(', ')) : '';
    const note = [sceneNote, failedNote].filter(Boolean).join(' ');
    if (fxNote.textContent !== note) fxNote.textContent = note;
    fxNote.hidden = !note;
    const most = fxMaxNow();
    // An effect that failed here holds no slot: the cap counts the others.
    const usable = ids.filter((id) => !failed.includes(id)).length;
    for (const [id, box] of fxBoxes) {
      const broken = failed.includes(id);
      const on = ids.includes(id) && !broken;
      box.checked = on;
      box.disabled = !fxOn || !fxItems || broken || (!on && usable >= most);
      // Left out by the step-down's cap: still chosen, not drawn here now.
      const unavailable = broken || (fxOn && on && fxCapped.includes(id))
        || (Boolean(sceneNote) && (Boolean(entry?.fxNone) || FX_LIVELY.has(id) || (on && !fxDrawnFor(entry, ids).includes(id))));
      box.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
      const field = fxFields.get(id);
      if (field) {
        if (unavailable) field.classList.add('viz-fx-unavailable'); else field.classList.remove('viz-fx-unavailable');
        const fx = fxById.get(id);
        field.title = broken ? FX_TEXT.failedOne : (unavailable ? FX_TEXT.notHere : `${fx.category}, ${fx.cost}`);
      }
    }
    fxListEl.title = FX_TEXT.cap(most);
  }

  /** The library's chunk, loaded once (the first time effects are on). */
  function ensureFx() {
    if (fxShuffle || fxLoading || !fxChain || fxFailed) return fxLoading;
    fxLoading = Promise.resolve()
      .then(() => loadFxLibrary())
      .then((module) => {
        fxLoading = null;
        if (destroyed) return;
        const { PostFxLibrary } = module.default({});
        fxItems = fxCatalog(PostFxLibrary);
        fxById = new Map(fxItems.map((fx) => [fx.id, fx]));
        fxCalmSet = fxCalmIds(fxItems);
        fxShuffle = createFxShuffle({ catalog: fxItems, random: random || seededRandom(Math.floor(clock() * 1000) ^ 0xf00d) });
        for (const fx of fxItems) {
          const field = el('label', 'viz-fx-item', { title: `${fx.category}, ${fx.cost}` });
          const box = el('input', 'viz-fx-box', { type: 'checkbox', 'data-fx': fx.id });
          field.append(box, el('span', '', {}, fx.label));
          fxListEl.append(field);
          fxBoxes.set(fx.id, box);
          fxFields.set(fx.id, field);
          listen(box, 'change', () => toggleFx(fx.id, box.checked));
        }
        if (fxOn && started) startFx();
        showFx();
      })
      .catch((error) => {
        fxLoading = null;
        fxFailed = true;
        console.error('visualizer: effects failed to load:', error);
        showFx();
      });
    showFx();
    return fxLoading;
  }

  /** Effects `ids` with values and links; those already on keep theirs
   *  (unless `fresh`). At most fxMaxNow() of them, the links under the
   *  intensity's count (kept ones first). */
  function comboFor(ids, { fresh = false } = {}) {
    const chosen = fxOrder(fxItems, ids).slice(0, fxMaxNow());
    const combo = fxShuffle.build(chosen, fxIntensity);
    const kept = new Set();
    if (!fresh && fxCombo) {
      for (const item of combo.fx) {
        const old = fxCombo.fx.find((other) => other.id === item.id);
        if (old) { item.values = old.values; item.links = old.links; kept.add(item.id); }
      }
    }
    let room = FX_BUDGETS[fxIntensity].links;
    const byKept = [...combo.fx].sort((a, b) => Number(kept.has(b.id)) - Number(kept.has(a.id)));
    for (const item of byKept) {
      item.links = item.links.slice(0, Math.max(0, room));
      room -= item.links.length;
    }
    combo.links = combo.fx.flatMap((item) => item.links);
    return combo;
  }
  /** A calm scene (scenes.js fxCalm: its own steps of light are already
   *  near the limit) draws no effect that enlarges them, and at most two;
   *  one marked fxNone draws none (fx-catalog.js fxDrawnFor, applied in
   *  syncFx whatever chose them). The shuffle chooses within that. */
  function rollFx() {
    const entry = entryOf(fxScene || switcher?.current);
    return fxShuffle.next({
      intensity: fxIntensity,
      mood: mood.mood,
      maxCount: entry?.fxNone ? 0 : (entry?.fxCalm ? Math.min(FX_CALM_MAX, fxMaxNow()) : fxMaxNow()),
      costBudget: fxCostBudget(),
      costMax: shuffleCostMax(),
      allowed: entry?.fxCalm ? fxCalmSet : null,
    });
  }
  /** Shuffled effects that scene `id` would not all draw. */
  // (A fresh calm set suits it better than what is left; on a scene that
  // draws none they are kept for the next one.)
  // Judged on the latest choice (fxChosen: a change still waiting included),
  // not on what is drawn now.
  const tooLivelyFor = (id) => fxChosen.length > 0 && !entryOf(id)?.fxNone
    && fxDrawnFor(entryOf(id), fxChosen).length !== fxChosen.length;
  /** The pulse budget's share for the beat clock: the scene shows it, or an
   *  effect fires on it (fx-chain.js usesClock). */
  function updateClockShown() {
    bridge?.setClockShown(Boolean(renderer?.readsBeatClock));
    bridge?.setTriggersOn(Boolean(fxChain?.usesClock) || overlayDrawn.some((item) => overlayRow(item.id)?.flash === 'trigger'));
  }
  /** What the chain draws now (ready programs only), and what failed. */
  function readDrawn() {
    fxDrawn = fxChain ? fxChain.drawnIds : [];
    fxFailedIds = fxChain ? fxChain.failedIds : [];
    updateClockShown();
  }
  /** A link finished or failed after the effects were set. */
  function fxDrawnChanged() {
    if (fxChain) {
      // One that failed while linking left the chain at once (that needs no
      // guard) and holds no slot: counted afresh on every link done or
      // failed. One the cap held back taking its place is a new change of
      // picture: through the transition (redrawUnderCaps).
      fxDrawnCount = fxCountOf(fxPassIds);
      redrawUnderCaps();
    }
    readDrawn();
    showFx();
    showStar();
    if (!lost) redrawIfHeld();
  }
  /** The passes for the chosen effects: those the scene drawn now allows,
   *  at most fxDrawMax() of them that have not failed here (the heaviest left
   *  out first). { passes, ids, failed, capped }: `passes` keeps the failed
   *  ones too (the chain knows them so), `failed` those known when planned. */
  function fxPlan() {
    const chosen = fxOn && fxCombo ? fxCombo : null;
    const allowed = chosen ? fxDrawnFor(entryOf(switcher?.current), chosen.ids) : [];
    const items = chosen ? chosen.fx.filter((item) => allowed.includes(item.id) && fxById?.has(item.id)) : [];
    const failed = fxChain ? fxChain.failedIds : [];
    const usable = items.filter((item) => !failed.includes(item.id));
    const most = Math.max(0, fxDrawMax());
    const keep = usable.length > most
      ? new Set([...usable].sort((a, b) => FX_COST_UNITS[fxById.get(a.id).cost] - FX_COST_UNITS[fxById.get(b.id).cost]).slice(0, most))
      : new Set(usable);
    const passes = items.filter((item) => keep.has(item) || failed.includes(item.id)).map((item) => ({ ...item, fx: fxById.get(item.id) }));
    return {
      passes,
      ids: passes.map((pass) => pass.id).join('+'),
      failed,
      capped: usable.filter((item) => !keep.has(item)).map((item) => item.id),
    };
  }
  /** How many of the passes `ids` ('a+b') count toward the cap: those that
   *  have not failed here (still linking ones count: they are on their way). */
  function fxCountOf(ids) {
    const failed = fxChain ? fxChain.failedIds : [];
    return ids ? ids.split('+').filter((id) => !failed.includes(id)).length : 0;
  }
  /** The chain draws the chosen effects the scene drawn now allows, under
   *  the caps (fxPlan). The one place passes are set: nothing reaches the
   *  picture past fxDrawnFor. */
  function syncFx() {
    if (!fxChain) return;
    let plan = fxPlan();
    fxChain.setPasses(plan.passes);
    // One kept that turned out to have failed here (known only once asked
    // for) holds no slot: planned again until no kept one newly failed. Each
    // round learns at least one failure, so at most one round per effect.
    const newlyFailed = () => plan.passes.some((pass) => !plan.failed.includes(pass.id) && fxChain.failedIds.includes(pass.id));
    for (let round = 0; round < plan.passes.length + plan.capped.length && newlyFailed(); round += 1) {
      plan = fxPlan();
      fxChain.setPasses(plan.passes);
    }
    fxPassIds = plan.ids;
    fxDrawnCount = fxCountOf(fxPassIds);
    fxCapped = plan.capped;
    readDrawn();
  }
  /** The ids of `combo` this build has (none when effects are off). */
  function knownFx(combo) { return combo && fxOn ? combo.fx.filter((item) => fxById.has(item.id)) : []; }
  /** Make `combo` (null: none) now; drawn from the next frame, as the scene
   *  allows. A change still waiting is dropped: this one is the latest. */
  function applyFx(combo) {
    if (!fxChain) return;
    pendingChanges.delete('fx');
    const known = knownFx(combo);
    fxCombo = known.length ? { ...combo, ids: known.map((item) => item.id), fx: known } : null;
    fxChosen = fxCombo ? fxCombo.ids.slice() : [];
    if (combo) fxShuffle?.shown(fxCombo || { ids: [] });
    syncFx();
    fxStats.changes += 1;
    showFx();
    showStar();
    redrawIfHeld();
  }
  /** A change of effects to `combo` (null: none), through the transition
   *  (charged to the flash budget; the latest asked for wins). It is the
   *  choice from now on (fxChosen, the panel's ticks), made or not yet. */
  function changeFx(combo) {
    fxChosen = knownFx(combo).map((item) => item.id);
    showFx();
    guardedChange(() => { if (fxReady()) applyFx(fxOn ? combo : null); }, 'fx');
  }
  /** Effects for the start: the shuffle's, or the ones chosen by hand. */
  function startFx() {
    if (!fxReady() || !fxOn) return;
    fxTimer.restart();
    fxScene = switcher?.current || null;
    changeFx(fxShuffleOn ? rollFx() : comboFor(fxSet, { fresh: true }));
  }
  /** "New effects now", and the bar timer's change. */
  function newFx() {
    if (!fxReady() || !fxOn) return;
    fxTimer.restart();
    changeFx(rollFx());
  }
  /** A scene was shown: in favourites shuffle, one of the effect sets starred
   *  with it; else, with "with the scene" timing, new shuffled ones. Made at
   *  once: the scene's own change of picture covers it. */
  function fxForScene(id) {
    if (!fxReady() || !fxOn || id === fxScene) return;
    fxScene = id;
    if (shuffleOn && shufflePool === 'favourites') {
      const look = lookState()?.index ?? null;
      // Every combination starred with it, "no effects" too (a saved
      // choice); its overlays come with it.
      const sets = favouriteCombos(favourites, id, look);
      if (sets.length) {
        const pick = sets[Math.floor((random || Math.random)() * sets.length)];
        fxStats.favourites += 1;
        fxTimer.restart();
        applyFx(comboFor(pick.fx, { fresh: true }));
        if (overlaysOn) {
          overlayScene = id;
          applyOverlays(overlayComboFor(pick.overlays, { fresh: true }));
        }
        return;
      }
    }
    // New ones with the scene, and also when a calm scene comes in under
    // shuffled effects too lively for it (whatever the timing).
    if (fxShuffleOn && (fxTiming === 'scene' || tooLivelyFor(id))) {
      fxTimer.restart();
      applyFx(rollFx());
    }
  }
  /** One frame of sound: the bar timer (it rests with no sound: not stepped). */
  function fxStep(nowSec, music) {
    if (!fxOn || !fxShuffleOn || fxTiming === 'scene' || !fxReady() || !started || lost) return;
    if (!fxTimer.step(nowSec, music.beats, music.confidence)) return;
    if (transition.busy || pendingChanges.has('fx')) return;
    if (!bridge.limiter.room(nowSec)) { fxStats.waitedBudget += 1; return; }
    newFx();
  }
  /** Fewer effects allowed in the choice (a lower quality chosen by hand):
   *  the heaviest go first. (The step-down only shortens what is drawn.) */
  function trimFx() {
    if (!fxChosen.length || !fxReady()) return;
    const most = fxMaxNow();
    if (fxChosen.length <= most) return;
    const keep = [...fxChosen]
      .sort((a, b) => FX_COST_UNITS[fxById.get(a).cost] - FX_COST_UNITS[fxById.get(b).cost])
      .slice(0, most);
    fxStats.trimmed += 1;
    changeFx(comboFor(keep));
  }
  /** One effect switched on or off by hand (remembered as the hand set). */
  function toggleFx(id, on) {
    if (!fxReady() || !fxOn) { showFx(); return; }
    // From the choice as it stands (a change still waiting included), not
    // from what is drawn: ticks made in quick succession all count. An
    // effect that failed here leaves the choice with the next tick (it held
    // no slot; its box cannot be un-ticked).
    const ids = fxChosen.filter((other) => other !== id && !fxFailedIds.includes(other));
    if (on) {
      if (ids.length >= fxMaxNow()) { showFx(); return; }
      ids.push(id);
    }
    fxSet = fxOrder(fxItems, ids);
    fxStats.byHand += 1;
    changeFx(comboFor(fxSet));
    saveSettings?.({ visualizerFxSet: fxSet });
  }
  function setFxOn(on, { save = true } = {}) {
    if (on === fxOn) return;
    fxOn = on;
    showFxChoice();
    if (on) {
      if (fxReady()) { if (started) startFx(); } else if (started) ensureFx();
    } else {
      fxScene = null;
      if (fxChain?.active || fxChosen.length) changeFx(null);
    }
    showFx();
    if (save) saveSettings?.({ visualizerFx: fxOn });
  }

  /* ---- Overlays (overlay-layer.js): nothing made until one is on ---- */
  const overlayShuffle = createOverlayShuffle({ random: random || seededRandom(Math.floor(clock() * 1000) ^ 0x0ae1) });
  const overlayStats = { changes: 0, byHand: 0, trimmed: 0, favourites: 0 };
  cleanups.push(() => {
    fxChain?.setOverlay(null);
    overlayLayer?.destroy();
    overlayLayer = null;
  });

  /** Most overlays in the choice: the quality chosen (choosing a lower one
   *  by hand trims the choice, trimOverlays). */
  function overlayMaxNow() {
    return Math.min(OVERLAY_MAX, OVERLAY_MAX_BY_QUALITY[quality] ?? OVERLAY_MAX);
  }
  /** Most overlays drawn now: the quality drawn (the step-down's), under the
   *  step-down's cap. Only what is drawn is shortened (syncOverlays). */
  function overlayDrawMax() {
    return Math.min(OVERLAY_MAX, OVERLAY_MAX_BY_QUALITY[stepDown.quality] ?? OVERLAY_MAX, stepDown.overlays);
  }
  const chosenOf = (list) => overlayOrder(list).map((item) => ({ id: item.id, blend: normalizeBlend(item.blend) }));
  /** Overlays that cannot be drawn on this computer (overlay-layer.js failedIds). */
  function overlayFailedIds() { return overlayLayer ? overlayLayer.failedIds : []; }

  function ensureOverlayLayer() {
    if (overlayLayer || destroyed) return overlayLayer;
    const gate = createFlashGate({
      reactor: () => bridge?.reactor || null,
      charge: () => (bridge ? bridge.charge() : true),
      sources: () => lastState?.sources || null,
    });
    overlayLayer = createOverlayLayer({
      topCanvas: overlayCanvas,
      makeCanvas: () => doc.createElement('canvas'),
      loadModule: loadOverlays,
      gate,
      onError: (error) => {
        console.error('visualizer: overlays:', error);
        // After the frame (it may come from inside the layer's render): the
        // ones that cannot be drawn leave the drawn set and its slots at once
        // (no guard needed); one the cap held back taking a slot is a new
        // change of picture, through the transition (redrawUnderCaps).
        Promise.resolve().then(() => {
          if (destroyed) return;
          syncOverlays({ noNew: true });
          redrawUnderCaps();
          showOverlays();
        });
      },
      onReady: () => { if (!destroyed) { showOverlays(); redrawIfHeld(); } },
    });
    if (renderer) overlayLayer.resize(renderer.width, renderer.height, stepDown.quality);
    overlayLayer.setBrightness(brightness >= VISUALIZER_BRIGHTNESS_MAX ? 1 : brightness / 100);
    return overlayLayer;
  }

  /** The chosen overlays as the scene drawn now allows them
   *  (overlaysDrawnFor), with their values: `allowed`, and `drawn`, at most
   *  overlayDrawMax() of them (the heaviest left out first). */
  function overlayPlan() {
    const entry = entryOf(switcher?.current);
    // One that could not be drawn here holds no slot (overlayFailedIds).
    const failed = overlayFailedIds();
    const made = overlaysOn && overlayCombo ? overlayCombo.items.filter((item) => !failed.includes(item.id)) : [];
    const values = new Map(made.map((item) => [item.id, item.values]));
    const allowed = overlaysDrawnFor(entry, made).map((item) => ({ ...item, values: values.get(item.id) || {} }));
    const most = Math.max(0, overlayDrawMax());
    if (allowed.length <= most) return { allowed, drawn: allowed };
    const keep = new Set([...allowed]
      .sort((a, b) => OVERLAY_COST_UNITS[overlayRow(a.id).cost] - OVERLAY_COST_UNITS[overlayRow(b.id).cost])
      .slice(0, most));
    return { allowed, drawn: allowed.filter((item) => keep.has(item)) };
  }
  /** What the layer draws, values included: the same overlays with other
   *  values are another drawing (overlaysKey alone is their identity). */
  const overlayStateOf = (drawn) => `${overlaysKey(drawn)}#${JSON.stringify(drawn.map((item) => item.values))}`;
  /** The layer draws the chosen overlays as the scene drawn now allows them,
   *  under the caps (overlayPlan). The one place the layer is set: nothing
   *  reaches the picture past that rule. */
  function syncOverlays({ now = false, noNew = false } = {}) {
    const entry = entryOf(switcher?.current);
    const plan = overlayPlan();
    const { allowed } = plan;
    // noNew: only what is drawn already may stay (one failed leaving); one
    // coming in waits for the transition.
    const drawn = noNew ? plan.drawn.filter((item) => overlayDrawn.some((other) => other.id === item.id)) : plan.drawn;
    overlayUncapped = allowed;
    // The blend-in on the picture now, if the scene drawn now does not allow
    // it as it is (a calm or fxNone scene came in), goes at once: it is not
    // blended over this scene even for the fade out.
    const shownBlend = overlayLayer?.blendSheet;
    if (shownBlend) {
      const asShown = { id: shownBlend.id, blend: shownBlend.blend };
      const allowed = overlaysDrawnFor(entry, [asShown])[0];
      if (!allowed || overlayToken(allowed) !== overlayToken(asShown)) overlayLayer.dropBlend();
    }
    // No blend-in on the picture: its texture goes now, effects on or not.
    if (fxChain && !overlayLayer?.blendSheet) fxChain.freeOverlay();
    const state = overlayStateOf(drawn);
    if (state === overlayDrawnState && (drawn.length || !overlayLayer?.on)) return;
    overlayDrawnState = state;
    overlayDrawn = drawn;
    if (drawn.length) ensureOverlayLayer();
    if (overlayLayer) {
      // Without motion (paused, hidden) there is no fade to run.
      overlayLayer.set(drawn, { now: now || !started || isHidden() });
      if (!drawn.length && (now || !started || isHidden())) overlayLayer.free();
      if (fxChain && !overlayLayer.blendSheet) fxChain.freeOverlay();
    }
    // The chain gets the blend sheet the first time one is blended in (its
    // program compiles then); until then plain overlays cost it nothing.
    if (fxChain && overlayLayer && !overlayProvided && drawn.some((item) => isBlendIn(item.blend))) {
      overlayProvided = true;
      const layer = overlayLayer;
      fxChain.setOverlay(() => layer.blendSheet);
    }
    updateClockShown();
  }

  /** The overlays' settings as the panel shows them. */
  function showOverlayChoice() {
    ovMaster.box.checked = overlaysOn;
    ovShuffleField.box.checked = overlayShuffleOn;
    ovShuffleField.box.disabled = !overlaysOn;
    ovNow.disabled = !overlaysOn;
    ovHead.setAttribute('aria-expanded', ovOpen ? 'true' : 'false');
    ovBody.hidden = !ovOpen;
  }
  /** What is on now: the line, the note, the blend rows and the switches. */
  function showOverlays() {
    const entry = entryOf(switcher?.current);
    const drawnIds = overlaysOn ? overlayDrawn.map((item) => item.id) : [];
    let text = '';
    const failed = overlaysOn ? overlayFailedIds() : [];
    if (overlaysOn) {
      if (overlayLayer?.loading) text = OVERLAY_TEXT.loading;
      else {
        text = drawnIds.length
          ? `Overlays: ${overlayDrawn.map((item) => overlayRow(item.id).label + (isBlendIn(item.blend) ? ` (${OVERLAY_BLEND_LABELS[item.blend.mode]})` : '')).join(', ')}`
          : OVERLAY_TEXT.none;
      }
    }
    if (ovLine.textContent !== text) ovLine.textContent = text;
    ovLine.hidden = !text;
    const sceneNote = overlaysOn && overlayChosen.length ? (entry?.fxNone ? OVERLAY_TEXT.noneHere : (entry?.fxCalm ? OVERLAY_TEXT.calmHere : '')) : '';
    const failedChosen = overlayChosen.filter((item) => failed.includes(item.id)).map((item) => overlayRow(item.id).label);
    const failedNote = failedChosen.length ? OVERLAY_TEXT.failed1(failedChosen.join(', ')) : '';
    const note = [sceneNote, failedNote, overlaysOn && overlayChosen.length > 1 ? OVERLAY_TEXT.oneBlend : ''].filter(Boolean).join(' ');
    if (ovNote.textContent !== note) ovNote.textContent = note;
    ovNote.hidden = !note;
    const most = overlayMaxNow();
    const chosenIds = overlayChosen.map((item) => item.id);
    // One that could not be drawn here holds no slot: the cap counts the others.
    const usable = chosenIds.filter((id) => !failed.includes(id)).length;
    for (const [id, box] of ovBoxes) {
      const brokenHere = failed.includes(id);
      const on = chosenIds.includes(id) && !brokenHere;
      box.checked = on;
      box.disabled = !overlaysOn || brokenHere || (!on && usable >= most);
      const field = ovFields.get(id);
      const unavailable = brokenHere || (overlaysOn && on && !drawnIds.includes(id) && Boolean(switcher?.current));
      box.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
      if (unavailable) field.classList.add('viz-fx-unavailable'); else field.classList.remove('viz-fx-unavailable');
      const row = overlayRow(id);
      field.title = brokenHere ? OVERLAY_TEXT.failedOne : `${row.category}, ${row.cost}${row.source === 'ours' ? ', ours' : ''}`;
    }
    ovListEl.title = OVERLAY_TEXT.cap(most);
    // One row per chosen overlay: its blend-in (the choice, not the drawn
    // one; what this scene leaves out is greyed).
    for (let index = 0; index < ovRows.length; index += 1) {
      const row = ovRows[index];
      const item = overlaysOn ? overlayChosen[index] : null;
      row.row.hidden = !item;
      if (!item) { row.id = null; continue; }
      const def = overlayRow(item.id);
      if (row.id !== item.id) {
        row.id = item.id;
        row.name.textContent = def.label;
        row.mode.setAttribute('aria-label', `${OVERLAY_TEXT.blend}: ${def.label}`);
        row.mask.setAttribute('aria-label', `${OVERLAY_TEXT.mask}: ${def.label}`);
        row.under.setAttribute('aria-label', `${OVERLAY_TEXT.under}: ${def.label}`);
        row.tint.setAttribute('aria-label', `${OVERLAY_TEXT.tint}: ${def.label}`);
        row.bend.setAttribute('aria-label', `${OVERLAY_TEXT.bend}: ${def.label}`);
        row.mode.replaceChildren(...def.blends.map((mode) => Object.assign(el('option', '', {}, OVERLAY_BLEND_LABELS[mode]), { value: mode })));
      }
      const plainOnly = Boolean(entry?.fxNone) || def.blends.length < 2;
      row.mode.value = item.blend.mode;
      row.mode.disabled = plainOnly;
      for (const option of row.mode.children || []) {
        option.disabled = Boolean(entry?.fxCalm) && OVERLAY_LIVELY_BLENDS.has(option.value);
      }
      row.under.checked = item.blend.under;
      row.under.disabled = !def.under || Boolean(entry?.fxNone) || !fxChain;
      row.mask.value = item.blend.mask;
      row.mask.disabled = plainOnly || Boolean(entry?.fxCalm);
      row.tint.checked = item.blend.tint;
      row.tint.disabled = plainOnly;
      row.bend.checked = item.blend.bend;
      row.bend.disabled = plainOnly || Boolean(entry?.fxCalm);
    }
  }

  /** Overlays `list` ([{ id, blend }]) with settings; those already on keep
   *  theirs (unless `fresh`). At most overlayMaxNow(), one blended in. */
  function overlayComboFor(list, { fresh = false } = {}) {
    const items = (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string' ? parseOverlayToken(item) : item)).filter(Boolean);
    const combo = overlayShuffle.build(chosenOf(items).slice(0, overlayMaxNow()));
    if (!fresh && overlayCombo) {
      for (const item of combo.items) {
        const old = overlayCombo.items.find((other) => other.id === item.id);
        if (old) item.values = old.values;
      }
    }
    return combo;
  }
  function rollOverlays() {
    const entry = entryOf(overlayScene || switcher?.current);
    return overlayShuffle.next({
      maxCount: overlayMaxNow(),
      costBudget: OVERLAY_COST_BUDGET[stepDown.quality] ?? OVERLAY_COST_BUDGET.medium,
      // The scene shuffle's cost filter, and no heavy overlay on Low.
      costMax: lighterCost(shuffleCostMax(), OVERLAY_SHUFFLE_COST_MAX[stepDown.quality] ?? 'heavy'),
      entry,
      blendIns: Boolean(fxChain),
      bend: OVERLAY_BEND_OFFERED,
      allowed: overlayFailedIds().length ? new Set(OVERLAY_IDS.filter((id) => !overlayFailedIds().includes(id))) : null,
    });
  }
  /** Make `combo` (null: none) now; drawn from the next frame, as the scene
   *  allows. A change still waiting is dropped: this one is the latest. */
  function applyOverlays(combo) {
    pendingChanges.delete('overlay');
    overlayCombo = overlaysOn && combo?.items?.length ? combo : null;
    overlayChosen = overlayCombo ? chosenOf(overlayCombo.items) : [];
    if (combo) overlayShuffle.shown(overlayCombo || { items: [] });
    syncOverlays();
    overlayStats.changes += 1;
    showOverlays();
    showStar();
    redrawIfHeld();
  }
  /** A change of overlays to `combo` (null: none), through the transition
   *  (charged to the flash budget; the latest asked for wins). It is the
   *  choice from now on (overlayChosen), made or not yet. */
  function changeOverlays(combo) {
    overlayChosen = overlaysOn && combo ? chosenOf(combo.items) : [];
    showOverlays();
    guardedChange(() => applyOverlays(overlaysOn ? combo : null), 'overlay');
  }
  /** Overlays for the start: the shuffle's, or the ones chosen by hand. */
  function startOverlays() {
    if (!overlaysOn) return;
    overlayScene = switcher?.current || null;
    changeOverlays(overlayShuffleOn ? rollOverlays() : overlayComboFor(overlaySet, { fresh: true }));
  }
  /** "New overlays now". */
  function newOverlays() {
    if (!overlaysOn) return;
    changeOverlays(rollOverlays());
  }
  /** A scene was shown: in favourites shuffle, the overlays starred with it
   *  (when its effects did not already bring them); else, shuffled, new ones
   *  with each scene. Made at once: the scene's own change covers it. */
  function overlaysForScene(id) {
    if (!overlaysOn || !started || id === overlayScene) return;
    overlayScene = id;
    if (shuffleOn && shufflePool === 'favourites') {
      const look = lookState()?.index ?? null;
      const sets = favouriteCombos(favourites, id, look);
      if (sets.length) {
        const pick = sets[Math.floor((random || Math.random)() * sets.length)];
        overlayStats.favourites += 1;
        applyOverlays(overlayComboFor(pick.overlays, { fresh: true }));
        return;
      }
    }
    if (overlayShuffleOn) applyOverlays(rollOverlays());
  }
  /** Fewer overlays allowed in the choice (a lower quality chosen by hand):
   *  the heaviest go first. (The step-down only shortens what is drawn.) */
  function trimOverlays() {
    const most = overlayMaxNow();
    const failed = overlayFailedIds();
    const usable = overlayChosen.filter((item) => !failed.includes(item.id));
    if (usable.length <= most) return;
    const keep = [...usable]
      .sort((a, b) => OVERLAY_COST_UNITS[overlayRow(a.id).cost] - OVERLAY_COST_UNITS[overlayRow(b.id).cost])
      .slice(0, most);
    overlayStats.trimmed += 1;
    changeOverlays(overlayComboFor(keep));
  }
  /** The hand set saved (tokens), and made. */
  function chooseOverlays(list) {
    const failed = overlayFailedIds();
    overlaySet = chosenOf(list).filter((item) => !failed.includes(item.id)).map(overlayToken);
    overlayStats.byHand += 1;
    changeOverlays(overlayComboFor(overlaySet));
    saveSettings?.({ visualizerOverlaySet: overlaySet });
  }
  /** One overlay switched on or off by hand. */
  function toggleOverlay(id, on) {
    if (!overlaysOn) { showOverlays(); return; }
    // From the choice as it stands (a change still waiting included).
    // One that could not be drawn here leaves the choice with the next tick.
    const failed = overlayFailedIds();
    const list = overlayChosen.filter((item) => item.id !== id && !failed.includes(item.id));
    if (on) {
      if (failed.includes(id)) { showOverlays(); return; }
      if (list.length >= overlayMaxNow()) { showOverlays(); return; }
      list.push({ id, blend: { ...PLAIN_BLEND } });
    }
    chooseOverlays(list);
  }
  /** A blend row changed: overlay `id` blended in as `blend`. Only one is
   *  blended in at a time: the others go back to plain on top. */
  function setOverlayBlend(id, blend) {
    if (!overlaysOn) return;
    const next = normalizeBlend(blend);
    const list = overlayChosen.map((item) => {
      if (item.id === id) return { id, blend: next };
      return { id: item.id, blend: isBlendIn(next) ? { ...PLAIN_BLEND } : item.blend };
    });
    chooseOverlays(list);
  }
  function setOverlaysOn(on, { save = true } = {}) {
    if (on === overlaysOn) return;
    overlaysOn = on;
    if (on) ovOpen = true;
    showOverlayChoice();
    if (on) {
      if (started) startOverlays();
    } else {
      overlayScene = null;
      if (overlayCombo || overlayChosen.length || overlayLayer?.on) changeOverlays(null);
    }
    showOverlays();
    if (save) saveSettings?.({ visualizerOverlays: overlaysOn });
  }

  /** What is drawn again from the whole choice, under the caps now (a notch
   *  taken, a quality chosen, a scene's own caps). Through the transition
   *  when it changes (charged to the flash budget, as any change of effects
   *  or overlays); a change of the choice waiting re-derives it anyway. */
  function redrawUnderCaps() {
    // Already as drawn: a 'caps' change still waiting (asked for while a
    // change was in progress) has nothing left to make, and goes.
    if (!capsDiffer()) { pendingChanges.delete('caps'); return; }
    guardedChange(() => {
      syncFx();
      syncOverlays();
      showFx();
      showOverlays();
      showStar();
      redrawIfHeld();
    }, 'caps');
  }
  /** The caps now would draw other effects or overlays than are drawn. */
  function capsDiffer() {
    if (fxChain && fxPlan().ids !== fxPassIds) return true;
    return overlayStateOf(overlayPlan().drawn) !== overlayDrawnState;
  }
  /** Draw with the step-down's quality and frame rate now. */
  function applyStepDown() {
    applySize();
    loop?.setFps(stepDown.fps);
    trimFx();
    trimOverlays();
    redrawUnderCaps();
    showFx();
    showOverlays();
    showNote();
  }
  function setCostCap(next) {
    if (next === costCap) return;
    costCap = next;
    poolChanged();
  }

  /** Show scene `id` (shuffle, or previous / next through its trail). The
   *  transition charges the flash budget; when it is full a change by hand
   *  still happens, more slowly. */
  function showScene(id) {
    sceneAsked = normalizeVisualizerScene(id);
    shuffleTimer.restart();
    if (nextPick === sceneAsked) nextPick = null;
    if (started) switcher?.request(sceneAsked);
    saveSettings?.({ visualizerScene: sceneAsked });
  }

  /** Show scene `id` (remembered by the caller in the settings). Before the
   *  picture moves (the notice, or paused) it is only remembered: nothing
   *  is loaded or compiled until then. */
  function askScene(id) {
    sceneAsked = normalizeVisualizerScene(id);
    if (!started) return;
    // The shuffle may pick heavier scenes again. The step-down is the
    // scene's own, set when it is installed (stepDown.newScene).
    setCostCap(null);
    stepDown.restart();
    shuffleTimer.restart();
    if (nextPick === sceneAsked) nextPick = null;
    switcher?.request(sceneAsked);
  }
  /** A scene picked by hand. `favourite`: picked from the scene list's
   *  favourites, so it comes with a favourite of it (favourites.js
   *  favouriteToRecall: its look, effects and overlays, the next one each
   *  time it is picked again), whatever the shuffle; the same for effects
   *  and overlays (recallFavourite). Not saved as the hand sets: as in
   *  favourites shuffle, what was starred is shown, not chosen anew. */
  function chooseScene(id, { favourite = false } = {}) {
    if (!id) return;
    const sceneId = normalizeVisualizerScene(id);
    const showing = started && switcher?.current === sceneId;
    const shown = favourite && showing ? shownFavourite() : null;
    const entry = favourite
      ? favouriteToRecall(favourites, sceneId, shown && favouriteKey(shown.scene, shown.look, shown.fx, shown.overlays))
      : null;
    if (entry?.look != null) shuffleLooks.set(sceneId, entry.look); // shown, not saved
    else shuffleLooks.delete(sceneId); // its own look, chosen by hand
    // Another scene: made when it is shown (the "ready" in the switcher's
    // onChange); this one: in place, after the request (which would drop a
    // look's new compile asked for before it).
    recall = entry && !showing ? entry : null;
    askScene(id);
    if (entry && showing) recallFavourite(entry, sceneId, { inPlace: true });
    saveSettings?.({ visualizerScene: sceneAsked });
  }
  /** Favourite `entry` picked by hand (chooseScene), for scene `id` now
   *  shown: its effects and overlays, each when that part is on. With a new
   *  scene they are made at once (its own change of picture covers them, as
   *  in favourites shuffle); in place, through the transition. */
  function recallFavourite(entry, id, { inPlace = false } = {}) {
    if (!entry || entry.scene !== id) return false;
    if (inPlace) {
      showLookValues();
      showLook();
    }
    if (fxOn && fxReady()) {
      fxScene = id;
      fxTimer.restart();
      fxStats.favourites += 1;
      const combo = comboFor(entry.fx, { fresh: true });
      if (inPlace) changeFx(combo);
      else applyFx(combo);
    }
    if (overlaysOn && started) {
      overlayScene = id;
      overlayStats.favourites += 1;
      const combo = overlayComboFor(entry.overlays, { fresh: true });
      if (inPlace) changeOverlays(combo);
      else applyOverlays(combo);
    }
    showStar();
    return true;
  }
  /** Previous / next: through the list in order, or with shuffle on, back
   *  and forth through the scenes shuffle has shown (next past the end is
   *  the next shuffled scene). */
  function stepButton(step) {
    if (!started) return; // (the buttons are hidden then)
    if (!shuffleOn) {
      chooseScene(stepScene(sceneAsked, step, ordered));
      return;
    }
    const at = trailAt + step;
    if (at >= 0 && at < trail.length) {
      trailAt = at;
      walkingTrail = true;
      showScene(trail[at]);
      return;
    }
    if (step < 0) return; // nothing before the first
    if (nextPick && !eligible(nextPick)) forgetNext();
    if (!nextPick) chooseNext();
    if (nextPick) {
      const id = nextPick;
      const fxOnly = fxOnlyPick;
      nextPick = null;
      fxOnlyPick = false;
      if (fxOnly) showFavouriteFx(id);
      else showScene(id);
    }
  }

  /* ---- Shuffle settings ---- */
  function setShuffle(on, pool = shufflePool, { save = true } = {}) {
    const changed = on !== shuffleOn || pool !== shufflePool;
    shuffleOn = on;
    shufflePool = pool;
    showShuffleChoice();
    if (changed) {
      forgetNext();
      poolEmpty = false;
      nothingNew = false;
      shuffleTimer.restart();
    }
    if (save) saveSettings?.({ visualizerShuffle: shuffleOn, visualizerShufflePool: shufflePool });
  }

  /* ---- Panel ---- */
  function setPanelOpen(open, { focus = false, save = true } = {}) {
    if (open === panelOpen) {
      if (focus) focusPanel(open);
      return;
    }
    panelOpen = open;
    showPanel();
    if (focus) focusPanel(open);
    if (save) saveSettings?.({ visualizerPanelOpen: panelOpen });
  }
  function focusPanel(open) {
    try { (open ? panelClose : hud.buttons.panel).focus?.(); } catch (_) {}
  }

  /* ---- Notice, pause and start ---- */
  /** The picture moves: the buttons, the loop, and the scene asked for. */
  function startMotion() {
    if (started || !loop) return;
    started = true;
    everStarted = true;
    notice.hide();
    hud.setActive(true);
    loop.start();
    if (switcher.wanted !== sceneAsked || !switcher.current) askScene(sceneAsked);
    // Effects: their library is loaded the first time they are on.
    if (fxOn) {
      if (!fxReady()) ensureFx();
      else if (!fxCombo && !pendingChanges.has('fx')) startFx();
    }
    if (overlaysOn && !overlayCombo && !pendingChanges.has('overlay')) startOverlays();
    showMood();
  }
  /** Everything behind the notice stops: no motion, no shuffle, no change
   *  of picture, nothing on its way in; the last frame stays. */
  function pauseMotion() {
    if (!started) return;
    started = false;
    loop.stop();
    hud.setActive(false);
    forgetNext();
    // A scene still loading or compiling is dropped (asked again on Continue).
    if (switcher.busy && switcher.current) switcher.request(switcher.current);
    // A cross-fade in view runs to its end: cut short it would be a step.
    transition.finishNow({ keepFade: true });
    flushChange();
    stopPreparing();
    showMood();
  }
  function acceptNotice() {
    notice.hide();
    if (!noticeSeen) {
      noticeSeen = true;
      saveSettings?.({ visualizerNoticeSeen: true });
    }
    startMotion();
  }
  /** "Not now": the picture stays still (or, the first time, the empty
   *  placeholder), with a button to start. */
  function declineNotice() {
    pauseMotion();
    notice.showStart();
  }
  /** The panel's line: the notice again, everything behind it paused. */
  function showNoticeAgain() {
    pauseMotion();
    notice.show();
  }
  /** The window hidden: nothing scheduled for it, whatever is running ends. */
  function onVisibility() {
    if (!isHidden()) {
      if (started) hud.wake();
      if (started && switcher?.busy) startPreparing();
      return;
    }
    hud.sleep();
    transition?.finishNow();
    flushChange();
    if (preparingTimer) clearTimer(preparingTimer);
    preparingTimer = 0;
  }

  function applySize() {
    if (!renderer || lost) return;
    const preset = visualizerPreset(stepDown.quality);
    // A scene with its own, smaller pixel budget (scenes.js SCENE_MAX_PIXELS).
    const most = sceneMaxPixels(sizedScene, stepDown.quality);
    const budget = most ? { ...preset, maxPixels: Math.min(Number(preset.maxPixels) || most, most) } : preset;
    const size = drawingSize(deviceWidth, deviceHeight, budget, renderer.limits);
    if (!size.width) return;
    const changed = renderer.resize(size.width, size.height);
    // A lower quality also lowers the heaviest scenes' own detail (scenes.js SCENE_QUALITY_CAPS).
    renderer.setQuality?.(stepDown.quality);
    overlayLayer?.resize(renderer.width, renderer.height, stepDown.quality);
    const first = !sized;
    sized = true;
    if (!started) {
      if (changed || first) drawStill();
      return;
    }
    if (changed || first) loop?.redraw();
  }

  /** The tab's size now, read from the layout, so the first picture is drawn
   *  at the right size before the ResizeObserver's first report. */
  function measureNow() {
    try {
      const rect = stage.getBoundingClientRect?.();
      if (!rect) return;
      const size = deviceSizeFromEntry({ contentRect: rect }, win?.devicePixelRatio);
      if (size.width > 0 && size.height > 0) {
        deviceWidth = size.width;
        deviceHeight = size.height;
      }
    } catch (_) {}
  }

  function applySettings(settings) {
    const nextQuality = normalizeVisualizerQuality(settings?.visualizerQuality);
    const nextFps = normalizeVisualizerFps(settings?.visualizerFps);
    if (nextQuality !== quality || nextFps !== fps) {
      quality = nextQuality;
      fps = nextFps;
      showQuality();
      showFpsChoice();
      stepDown.choose(quality, fps);
      setCostCap(null);
      applyStepDown();
    }
    const nextBrightness = normalizeVisualizerBrightness(settings?.visualizerBrightness);
    if (nextBrightness !== brightness) {
      brightness = nextBrightness;
      showBrightness();
    }
    showFps = settings?.visualizerShowFps === true;
    showReadoutChoice();
    const nextDebug = settings?.visualizerDebug === true;
    if (nextDebug !== debug) {
      debug = nextDebug;
      showDebug();
    }
    const more = normalizeVisualizerExtras(settings);
    if (more.visualizerShuffle !== shuffleOn || more.visualizerShufflePool !== shufflePool) {
      setShuffle(more.visualizerShuffle, more.visualizerShufflePool, { save: false });
    }
    if (more.visualizerShuffleCost !== shuffleCost) {
      shuffleCost = more.visualizerShuffleCost;
      poolChanged();
    }
    if (more.visualizerShuffleBars !== shuffleBars) {
      shuffleBars = more.visualizerShuffleBars;
      shuffleTimer.setBars(shuffleBars);
    }
    showShuffleChoice();
    const moreFavourites = favouritesDrawn(more.visualizerFavourites);
    if (JSON.stringify(moreFavourites) !== JSON.stringify(favourites)) {
      favourites = moreFavourites;
      showFavourites();
      poolChanged();
    }
    if (more.visualizerFxShuffle !== fxShuffleOn) {
      fxShuffleOn = more.visualizerFxShuffle;
      fxTimer.restart();
    }
    if (more.visualizerFxTiming !== fxTiming) {
      fxTiming = more.visualizerFxTiming;
      if (fxTiming !== 'scene') fxTimer.setBars(fxTiming);
      fxTimer.restart();
    }
    if (more.visualizerFxIntensity !== fxIntensity) fxIntensity = more.visualizerFxIntensity;
    fxFlash = more.visualizerFxFlash;
    fxSet = more.visualizerFxSet;
    if (more.visualizerFx !== fxOn) setFxOn(more.visualizerFx, { save: false });
    showFxChoice();
    overlayShuffleOn = more.visualizerOverlayShuffle;
    overlaySet = more.visualizerOverlaySet;
    if (more.visualizerOverlays !== overlaysOn) setOverlaysOn(more.visualizerOverlays, { save: false });
    showOverlayChoice();
    if (more.visualizerPanelOpen !== panelOpen) setPanelOpen(more.visualizerPanelOpen, { save: false });
    if (more.visualizerNoticeSeen && !noticeSeen) {
      noticeSeen = true;
      if (!everStarted && renderer) acceptNotice();
    }
    const nextScene = normalizeVisualizerScene(settings?.visualizerScene);
    if (nextScene !== sceneAsked) askScene(nextScene);
    const nextLooks = normalizeVisualizerLooks(settings?.visualizerLooks);
    if (JSON.stringify(nextLooks) !== JSON.stringify(looks)) followLooks(nextLooks);
  }

  if (renderer) {
    measureNow();
    applySize();
    // Follow the tab's size, shape and the screen's pixel ratio.
    if (observing) {
      const observer = new win.ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const size = deviceSizeFromEntry(entry, win.devicePixelRatio);
        deviceWidth = size.width;
        deviceHeight = size.height;
        applySize();
      });
      try {
        observer.observe(stage, { box: 'device-pixel-content-box' });
      } catch (_) {
        observer.observe(stage);
      }
      cleanups.push(() => observer.disconnect());
    }

    listen(canvas, 'webglcontextlost', (event) => {
      event.preventDefault(); // ask for the context back
      lost = true;
      transition.finishNow();
      if (nextPick) lookToPick.delete(nextPick);
      nextPick = null;
      switcher.suspend();
      renderer.contextLost(); // programs still linking went with the context
      fxChain?.contextLost(); // and the effects' framebuffers and programs
      if (fxChain) fxDrawnChanged(); // nothing draws until they are back
      loop.setSuspended(true);
      say(MESSAGES.lost);
    });
    listen(canvas, 'webglcontextrestored', () => {
      if (destroyed) return;
      // The scene is compiled again like any change of scene (not blocking;
      // "Preparing scene..." if it is slow), and if it cannot be, Plasma.
      // Whatever happens, the loop runs again.
      try {
        renderer.restore();
        fxChain?.restore(); // made again on the next frame; feedback starts afresh
        if (fxChain) fxDrawnChanged(); // what draws now (programs compile again)
        say('');
      } catch (error) {
        console.error('visualizer restore failed:', error);
        say(MESSAGES.noScene);
      }
      lost = false;
      switcher.resume({ restored: true });
      applySize();
      loop.setSuspended(false);
    });

    listen(prev, 'click', () => stepButton(-1));
    listen(next, 'click', () => stepButton(1));
    listen(hud.buttons.shuffle, 'click', () => setShuffle(!shuffleOn));
    listen(hud.buttons.star, 'click', () => toggleStar());
    listen(hud.buttons.panel, 'click', () => setPanelOpen(!panelOpen, { focus: true }));
    listen(panelClose, 'click', () => setPanelOpen(false, { focus: true }));
    // Escape in the panel (not taken by the scene list first) closes it.
    listen(panel, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault?.();
      setPanelOpen(false, { focus: true });
    });
    listen(lookPrev, 'click', () => stepLook(-1));
    listen(lookNext, 'click', () => stepLook(1));
    listen(shuffleMode.select, 'change', () => {
      const value = shuffleMode.select.value;
      if (value === 'off') setShuffle(false);
      else setShuffle(true, value === 'favourites' ? 'favourites' : 'all');
    });
    listen(shuffleCostField.select, 'change', () => {
      shuffleCost = normalizeVisualizerExtras({ visualizerShuffleCost: shuffleCostField.select.value }).visualizerShuffleCost;
      poolChanged();
      saveSettings?.({ visualizerShuffleCost: shuffleCost });
    });
    listen(fxMaster.box, 'change', () => setFxOn(fxMaster.box.checked));
    listen(fxShuffleField.box, 'change', () => {
      fxShuffleOn = fxShuffleField.box.checked;
      fxTimer.restart();
      if (fxShuffleOn && fxOn && fxReady() && !fxChosen.length) newFx();
      saveSettings?.({ visualizerFxShuffle: fxShuffleOn });
    });
    listen(fxNow, 'click', () => newFx());
    listen(ovHead, 'click', () => { ovOpen = !ovOpen; showOverlayChoice(); });
    listen(ovMaster.box, 'change', () => setOverlaysOn(ovMaster.box.checked));
    listen(ovShuffleField.box, 'change', () => {
      overlayShuffleOn = ovShuffleField.box.checked;
      if (overlayShuffleOn && overlaysOn && !overlayChosen.length) newOverlays();
      saveSettings?.({ visualizerOverlayShuffle: overlayShuffleOn });
    });
    listen(ovNow, 'click', () => newOverlays());
    for (const [id, box] of ovBoxes) listen(box, 'change', () => toggleOverlay(id, box.checked));
    for (const row of ovRows) {
      const changed = () => {
        if (!row.id) return;
        setOverlayBlend(row.id, {
          mode: row.mode.value, under: row.under.checked, mask: row.mask.value, tint: row.tint.checked, bend: row.bend.checked,
        });
      };
      for (const node of [row.mode, row.mask]) listen(node, 'change', changed);
      for (const node of [row.under, row.tint, row.bend]) listen(node, 'change', changed);
    }
    listen(fxTimingField.select, 'change', () => {
      fxTiming = normalizeVisualizerExtras({ visualizerFxTiming: fxTimingField.select.value }).visualizerFxTiming;
      if (fxTiming !== 'scene') fxTimer.setBars(fxTiming);
      fxTimer.restart();
      saveSettings?.({ visualizerFxTiming: fxTiming });
    });
    listen(fxIntensityField.select, 'change', () => {
      fxIntensity = normalizeVisualizerExtras({ visualizerFxIntensity: fxIntensityField.select.value }).visualizerFxIntensity;
      // The budget changed: new effects now (or the hand set drawn again).
      if (fxOn && fxReady()) {
        if (fxShuffleOn) newFx();
        else changeFx(comboFor(fxSet, { fresh: true }));
      }
      saveSettings?.({ visualizerFxIntensity: fxIntensity });
    });
    listen(fxFlashField.box, 'change', () => {
      fxFlash = fxFlashField.box.checked;
      saveSettings?.({ visualizerFxFlash: fxFlash });
    });
    listen(shuffleBarsField.select, 'change', () => {
      shuffleBars = normalizeVisualizerExtras({ visualizerShuffleBars: shuffleBarsField.select.value }).visualizerShuffleBars;
      shuffleTimer.setBars(shuffleBars);
      saveSettings?.({ visualizerShuffleBars: shuffleBars });
    });
    // A quality or frame rate picked by hand takes effect at once and clears
    // the step-down, even when it is the one already chosen.
    listen(qualitySelect, 'change', () => {
      quality = normalizeVisualizerQuality(qualitySelect.value);
      stepDown.choose(quality, fps);
      setCostCap(null);
      applyStepDown();
      saveSettings?.({ visualizerQuality: quality });
    });
    for (const button of fpsButtons) {
      listen(button, 'click', () => {
        fps = normalizeVisualizerFps(button.getAttribute('data-fps'));
        showFpsChoice();
        stepDown.choose(quality, fps);
        setCostCap(null);
        applyStepDown();
        saveSettings?.({ visualizerFps: fps });
      });
    }
    // While dragging: shown at once, saved when let go.
    listen(brightSlider, 'input', () => showBrightness(normalizeVisualizerBrightness(brightSlider.value)));
    listen(brightSlider, 'change', () => {
      brightness = normalizeVisualizerBrightness(brightSlider.value);
      showBrightness();
      saveSettings?.({ visualizerBrightness: brightness });
    });
    listen(fpsToggle, 'change', () => saveSettings?.({ visualizerShowFps: fpsToggle.checked }));
    listen(noticeLine, 'click', () => showNoticeAgain());
    if (doc?.addEventListener) {
      listen(doc, 'visibilitychange', onVisibility);
      listen(doc, 'keydown', (event) => {
        if (!isDebugKey(event)) return;
        event.preventDefault?.();
        debug = !debug;
        showDebug();
        saveSettings?.({ visualizerDebug: debug });
      });
    }
    if (typeof subscribeSettings === 'function') cleanups.push(subscribeSettings(applySettings));
    showDebug();
    // Accepted before: the buttons, the scene and the loop start. If not,
    // only the notice over an empty placeholder: nothing loaded, compiled,
    // armed or scheduled until Continue.
    if (noticeSeen) startMotion();
    else notice.show();
  }

  return {
    get loop() { return loop; },
    get renderer() { return renderer; },
    get switcher() { return switcher; },
    get bridge() { return bridge; },
    get debugStrip() { return debugEl; },
    stepDown,
    sceneList,
    hud,
    notice,
    mood,
    shuffle,
    shuffleTimer,
    get shuffleStats() { return shuffleStats; },
    get nextPick() { return nextPick; },
    get trail() { return trail.slice(); },
    get started() { return started; },
    get looks() { return looks; },
    get favourites() { return favourites; },
    get costCap() { return costCap; },
    get fading() { return transition?.phase === 'fading'; },
    get transition() { return transition; },
    /** Post effects: the chain, the shuffle (once loaded), what is on. */
    fx: {
      get chain() { return fxChain; },
      get shuffle() { return fxShuffle; },
      get catalog() { return fxItems; },
      get combo() { return fxCombo; },
      /** The ids drawn now (the combination as the scene allows it). */
      get drawn() { return fxDrawn; },
      /** How many count toward the step-down's cap, and the chosen ones it
       *  holds back (fxPlan). */
      get drawnCount() { return fxDrawnCount; },
      get capped() { return fxCapped; },
      get failedIds() { return fxFailedIds; },
      get note() { return fxNote; },
      get loading() { return fxLoading; },
      get maxNow() { return fxMaxNow(); },
      get on() { return fxOn; },
      reactions,
      boxes: fxBoxes,
      timer: fxTimer,
      stats: fxStats,
    },
    /** Overlays: the layer (once made), the shuffle, what is chosen and drawn. */
    overlays: {
      get layer() { return overlayLayer; },
      get shuffle() { return overlayShuffle; },
      get combo() { return overlayCombo; },
      get chosen() { return overlayChosen; },
      get drawn() { return overlayDrawn; },
      get on() { return overlaysOn; },
      get maxNow() { return overlayMaxNow(); },
      get note() { return ovNote; },
      boxes: ovBoxes,
      fields: ovFields,
      rows: ovRows,
      stats: overlayStats,
    },
    canvas,
    overlayCanvas,
    fade,
    message,
    note,
    panel,
    controls: {
      bar: panel,
      panel,
      panelClose,
      hud: hud.element,
      sceneButton: sceneList.button,
      sceneSearch: sceneList.search,
      sceneOptions: sceneList.list,
      favouritesOnly: sceneList.favouritesOnly,
      prev,
      next,
      shuffleButton: hud.buttons.shuffle,
      star: hud.buttons.star,
      panelButton: hud.buttons.panel,
      lookGroup,
      lookPrev,
      lookNext,
      lookName,
      shuffleMode: shuffleMode.select,
      shuffleNote,
      shuffleCost: shuffleCostField.select,
      shuffleBars: shuffleBarsField.select,
      moodLine,
      fxToggle: fxMaster.box,
      fxShuffle: fxShuffleField.box,
      fxNow,
      fxTiming: fxTimingField.select,
      fxIntensity: fxIntensityField.select,
      fxFlash: fxFlashField.box,
      fxLine,
      fxList: fxListEl,
      overlaysHead: ovHead,
      overlaysBody: ovBody,
      overlaysToggle: ovMaster.box,
      overlaysShuffle: ovShuffleField.box,
      overlaysNow: ovNow,
      overlaysLine: ovLine,
      overlaysList: ovListEl,
      noticeLine,
      qualitySelect,
      fpsButtons,
      brightSlider,
      brightValue,
      fpsToggle,
      readout,
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      switcher?.destroy();
      loop?.destroy();
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_) {}
      }
      // After the listeners are gone, so losing the context on purpose is
      // not taken for a driver reset.
      renderer?.destroy();
      renderer = null;
      canvas.width = 0;
      canvas.height = 0;
      overlayCanvas.width = 0;
      overlayCanvas.height = 0;
      root.replaceChildren();
      root.classList.remove('viz-root');
      root.classList.remove('viz-panel-open');
    },
  };
}
