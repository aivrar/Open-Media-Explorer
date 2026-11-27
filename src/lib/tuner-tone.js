import { EQ_FREQUENCIES } from './audio-engine.js';
import { isEqCurveActive } from './capture-view.js';
import { flushEqPersistence } from './eq-overlay.js';
import {
  EQ_MAX_DB, EQ_MIN_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB, canSaveFavoriteEq, getEffectiveEq, hasFavoriteEq,
  loadEqState, normalizeEqCurve, roundEqDb, saveEqState, setScopedEq, setStationEqPreset,
} from './eq-store.js';
import { clearPersistenceFailure, reportPersistenceFailure } from './persistence-notice.js';
import { ProfileStorageBudgetError } from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { emit, getState, isFavorite } from './state.js';

const weightsFor = (weights) => Object.freeze(EQ_FREQUENCIES.map((hz) => weights[hz] || 0));
const bandMin = Math.max(-12, EQ_MIN_DB);
const bandMax = Math.min(12, EQ_MAX_DB);
export const TUNER_TONES = Object.freeze({
  bass: Object.freeze({ name: 'Bass', min: bandMin, max: bandMax, weights: weightsFor({ 31: 1, 62: 1, 125: 0.75, 250: 0.4 }) }),
  treble: Object.freeze({ name: 'Treble', min: bandMin, max: bandMax, weights: weightsFor({ 4000: 0.4, 8000: 0.75, 16000: 1 }) }),
  loudness: Object.freeze({ name: 'Loudness', min: EQ_PREAMP_MIN_DB, max: EQ_PREAMP_MAX_DB }),
});

function clampToneValue(tone, db) {
  return Math.max(tone.min, Math.min(tone.max, roundEqDb(db)));
}

export function tunerToneValue(tone, curve) {
  if (!tone.weights) return clampToneValue(tone, curve.preamp);
  const primary = curve.bands.filter((_, index) => tone.weights[index] === 1);
  const mean = primary.reduce((sum, gain) => sum + gain, 0) / primary.length;
  return clampToneValue(tone, mean);
}

export function curveAfterToneTurn(curve, tone, requested) {
  const target = clampToneValue(tone, requested);
  const delta = target - tunerToneValue(tone, curve);
  if (!delta) return curve;
  const manual = { ...curve, presetId: 'manual' };
  if (!tone.weights) return normalizeEqCurve({ ...manual, preamp: target });
  const bands = curve.bands.map((gain, index) => {
    const weight = tone.weights[index];
    // Keep weighted fractions and avoid residue when a turn is undone.
    return weight ? Number((gain + delta * weight).toFixed(12)) : gain;
  });
  return normalizeEqCurve({ ...manual, bands });
}

function playingToneItem() {
  const { currentItem, isPlaying } = getState();
  return isPlaying ? currentItem : null;
}

export function readTunerTone() {
  const item = playingToneItem();
  const id = item?.id;
  const eq = loadEqState();
  const favorited = canSaveFavoriteEq(id, isFavorite(id));
  const curve = getEffectiveEq(eq, id, favorited);
  let scope = '';
  if (!favorited) scope = 'Adjusting the main EQ';
  else if (!Object.hasOwn(eq.assignments, id) && hasFavoriteEq(eq, id, favorited)) {
    scope = `Saved for ${item.title || 'Favorite item'}`;
  }
  return { curve, scope, stationName: favorited ? item.title || 'Favorite item' : '' };
}

export function readTunerToneCurve() {
  return readTunerTone().curve;
}

export function turnTunerTone(tone, requested) {
  // A slider or preset preview can still be waiting for the overlay's save.
  flushEqPersistence();
  const item = playingToneItem();
  const id = item?.id;
  let eq = loadEqState();
  const favorited = canSaveFavoriteEq(id, isFavorite(id));
  const curve = getEffectiveEq(eq, id, favorited);
  const next = curveAfterToneTurn(curve, tone, requested);
  if (next === curve) return false;

  if (id && Object.hasOwn(eq.assignments, id)) eq = setStationEqPreset(eq, [id]);
  // Favorites without a saved curve start with the same curve heard before the turn.
  eq = setScopedEq(eq, id, favorited, { ...next, bypassed: false });

  let failed = false;
  saveEqState(eq, undefined, (error) => {
    failed = true;
    reportPersistenceFailure('tuner-tone', error instanceof ProfileStorageBudgetError
      ? error.message : 'Equalizer settings could not be saved.');
  });
  if (failed) return false;
  clearPersistenceFailure('tuner-tone');
  scheduleProfileHandoff();
  emit('eq-change', { itemId: id, source: 'tuner-tone' });
  if (item && !isEqCurveActive(curve)) emit('eq-user-gesture', { item });
  return true;
}
