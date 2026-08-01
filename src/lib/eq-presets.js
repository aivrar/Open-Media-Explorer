import { cloneEqCurve, normalizeEqCurve } from './eq-store.js';

function preset(id, name, preamp, bands) {
  const curve = normalizeEqCurve({ preamp, bands, presetId: id, bypassed: false });
  Object.freeze(curve.bands);
  return Object.freeze({ id, name, curve: Object.freeze(curve) });
}

export const BUILT_IN_EQ_PRESETS = Object.freeze([
  preset('flat', 'Flat', 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  preset('bass-boost', 'Bass Boost', -6, [6, 5, 4, 2, 0, -1, -2, -2, -1, 0]),
  preset('treble-boost', 'Treble Boost', -6, [0, -1, -2, -1, 0, 1, 3, 4, 5, 6]),
  preset('vocal', 'Vocal', -5, [-3, -2, -1, 1, 3, 5, 4, 1, -1, -2]),
  preset('spoken-word', 'Spoken Word', -5, [-6, -5, -3, 0, 3, 5, 4, 1, -2, -4]),
  preset('rock', 'Rock', -5, [4, 3, 0, -2, -1, 2, 5, 4, 2, 1]),
  preset('classical', 'Classical', -4, [3, 2, 1, 0, -1, -1, 0, 2, 3, 4]),
  preset('jazz', 'Jazz', -4, [4, 3, 1, 2, -1, -1, 1, 3, 4, 3]),
  preset('electronic', 'Electronic', -6, [6, 4, 1, -2, -1, 2, 4, 5, 4, 3]),
  preset('night', 'Night', -4, [4, 3, 1, 0, -1, -1, 0, 1, 2, 1]),
]);

const BUILT_INS_BY_ID = new Map(BUILT_IN_EQ_PRESETS.map((entry) => [entry.id, entry]));

export function getBuiltInEqPreset(id) {
  const entry = BUILT_INS_BY_ID.get(String(id || ''));
  return entry ? cloneEqCurve(entry.curve) : null;
}

export function isBuiltInEqPreset(id) { return BUILT_INS_BY_ID.has(String(id || '')); }

export function customEqPresetId(key) { return `custom:${String(key || '')}`; }

export function customEqPresetKey(presetId) {
  const value = String(presetId || '');
  return value.startsWith('custom:') ? value.slice(7) : '';
}

export function createCustomEqPresetKey(randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  let token = '';
  try { token = typeof randomUuid === 'function' ? randomUuid() : ''; } catch (_) {}
  token = String(token || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96);
  if (!token) {
    token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return `preset-${token}`;
}

export function snapshotEqPreset(curve, presetId, { preserveBypass = true } = {}) {
  const normalized = normalizeEqCurve(curve);
  return normalizeEqCurve({
    ...normalized,
    presetId: String(presetId || 'manual'),
    bypassed: preserveBypass ? normalized.bypassed : false,
  });
}
