export const EQ_VERSION = 1;
export const EQ_STORAGE_KEY = 'worldmedia.eq.v1';
export const EQ_BAND_COUNT = 10;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_PREAMP_MIN_DB = -12;
export const EQ_PREAMP_MAX_DB = 6;

function clampDb(value, minimum = EQ_MIN_DB, maximum = EQ_MAX_DB) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(minimum, Math.min(maximum, number));
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function isSafeCustomPresetKey(key) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key)
    && !Object.prototype.hasOwnProperty.call(Object.prototype, key);
}

export function normalizeEqCurve(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const bands = Array.from({ length: EQ_BAND_COUNT }, (_, index) => clampDb(source.bands?.[index]));
  const presetId = typeof source.presetId === 'string' && source.presetId.trim()
    ? source.presetId.trim().slice(0, 128)
    : 'flat';
  return {
    ...source,
    preamp: clampDb(source.preamp, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB),
    bands,
    presetId,
    bypassed: source.bypassed === true,
  };
}

export function freshEqState() {
  return {
    version: EQ_VERSION,
    global: normalizeEqCurve(null),
    favorites: {},
    customPresets: {},
  };
}

export function normalizeEqState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const version = Number.isInteger(source.version) && source.version > 0 ? source.version : EQ_VERSION;
  const favorites = {};
  if (source.favorites && typeof source.favorites === 'object' && !Array.isArray(source.favorites)) {
    for (const [itemId, curve] of Object.entries(source.favorites)) {
      if (itemId && itemId.length <= 512 && curve && typeof curve === 'object') {
        defineOwn(favorites, itemId, normalizeEqCurve(curve));
      }
    }
  }
  const customPresets = {};
  if (source.customPresets && typeof source.customPresets === 'object' && !Array.isArray(source.customPresets)) {
    for (const [presetId, preset] of Object.entries(source.customPresets)) {
      if (!isSafeCustomPresetKey(presetId) || !preset || typeof preset !== 'object') continue;
      defineOwn(customPresets, presetId, {
        ...normalizeEqCurve(preset),
        name: typeof preset.name === 'string' && preset.name.trim()
          ? preset.name.trim().slice(0, 80)
          : 'Custom preset',
      });
    }
  }
  return {
    ...source,
    version,
    global: normalizeEqCurve(source.global),
    favorites,
    customPresets,
  };
}

export function cloneEqCurve(value) {
  const curve = normalizeEqCurve(value);
  return { ...curve, bands: [...curve.bands] };
}

export function getEffectiveEq(eqState, itemId, favorited = false) {
  const state = normalizeEqState(eqState);
  if (favorited && itemId && state.favorites[itemId]) return cloneEqCurve(state.favorites[itemId]);
  return cloneEqCurve(state.global);
}

export function addFavoriteEq(eqState, itemId, effectiveCurve = null) {
  const state = normalizeEqState(eqState);
  if (!itemId) return state;
  return {
    ...state,
    favorites: {
      ...state.favorites,
      // This helper represents the non-favorite -> favorite transition. Always
      // replace an orphaned legacy curve with what the listener currently hears.
      [itemId]: cloneEqCurve(effectiveCurve || state.global),
    },
  };
}

export function removeFavoriteEq(eqState, itemId) {
  const state = normalizeEqState(eqState);
  if (!itemId || !state.favorites[itemId]) return state;
  const favorites = { ...state.favorites };
  delete favorites[itemId];
  return { ...state, favorites };
}

export function setScopedEq(eqState, itemId, favorited, curve) {
  const state = normalizeEqState(eqState);
  const normalized = cloneEqCurve(curve);
  if (favorited && itemId) {
    return { ...state, favorites: { ...state.favorites, [itemId]: normalized } };
  }
  return { ...state, global: normalized };
}

export function setCustomEqPreset(eqState, presetId, name, curve) {
  const state = normalizeEqState(eqState);
  const key = typeof presetId === 'string' ? presetId.trim() : '';
  if (!isSafeCustomPresetKey(key)) return state;
  const safeName = typeof name === 'string' && name.trim()
    ? name.trim().slice(0, 80)
    : 'Custom preset';
  return {
    ...state,
    customPresets: {
      ...state.customPresets,
      [key]: { ...cloneEqCurve(curve), name: safeName },
    },
  };
}

export function removeCustomEqPreset(eqState, presetId) {
  const state = normalizeEqState(eqState);
  const key = typeof presetId === 'string' ? presetId.trim() : '';
  if (!key || !Object.hasOwn(state.customPresets, key)) return state;
  const customPresets = { ...state.customPresets };
  delete customPresets[key];
  return { ...state, customPresets };
}

function resolveStorage(storage) {
  return storage || globalThis.localStorage;
}

export function loadEqState(storage) {
  try {
    const raw = resolveStorage(storage)?.getItem(EQ_STORAGE_KEY);
    return raw ? normalizeEqState(JSON.parse(raw)) : freshEqState();
  } catch (_) {
    return freshEqState();
  }
}

export function saveEqState(eqState, storage) {
  const normalized = normalizeEqState(eqState);
  try { resolveStorage(storage)?.setItem(EQ_STORAGE_KEY, JSON.stringify(normalized)); } catch (_) {}
  return normalized;
}

export function persistFavoriteEq(itemId, effectiveCurve = null, storage) {
  return saveEqState(addFavoriteEq(loadEqState(storage), itemId, effectiveCurve), storage);
}

export function deleteFavoriteEq(itemId, storage) {
  return saveEqState(removeFavoriteEq(loadEqState(storage), itemId), storage);
}

export function clearEqState(storage) {
  try { resolveStorage(storage)?.removeItem(EQ_STORAGE_KEY); } catch (_) {}
}
