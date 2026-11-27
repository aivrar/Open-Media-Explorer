import { cloneEqCurve, EQ_DEFAULT_Q, normalizeEqCurve } from './eq-curve.js';
import { BUILT_IN_EQ_PRESETS, customEqPresetKey } from './eq-presets.js';
import { checkProfileStorageBudget, EQ_EXTRA_STORAGE_KEY, EQ_STORAGE_KEY } from './profile-storage.js';

export * from './eq-curve.js';

export const EQ_VERSION = 1;
export { EQ_EXTRA_STORAGE_KEY, EQ_STORAGE_KEY } from './profile-storage.js';

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function isSafeCustomPresetKey(key) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key)
    && !Object.prototype.hasOwnProperty.call(Object.prototype, key);
}

export function freshEqState() {
  return {
    version: EQ_VERSION,
    global: normalizeEqCurve(null),
    favorites: {},
    customPresets: {},
    assignments: {},
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
  const assignments = {};
  const savedAssignments = source.assignments;
  if (savedAssignments && typeof savedAssignments === 'object' && !Array.isArray(savedAssignments)) {
    for (const [itemId, presetId] of Object.entries(savedAssignments)) {
      if (!itemId || itemId.length > 512 || typeof presetId !== 'string') continue;
      const key = customEqPresetKey(presetId);
      if (builtIns.has(presetId) || (key && Object.hasOwn(customPresets, key))) {
        defineOwn(assignments, itemId, presetId);
      }
    }
  }
  return {
    ...source,
    version,
    global: normalizeEqCurve(source.global),
    favorites,
    customPresets,
    assignments,
  };
}

const builtIns = new Map(BUILT_IN_EQ_PRESETS.map((preset) => [preset.id, preset]));

export function getEqPreset(state, id) {
  const builtIn = builtIns.get(id);
  if (builtIn) return builtIn;
  const key = customEqPresetKey(id);
  if (!key || !Object.hasOwn(state.customPresets, key)) return null;
  const { name, ...curve } = state.customPresets[key];
  return { id, name, curve: { ...curve, presetId: id } };
}

export function isEqStation(item) {
  return item?.type === 'radio' || item?.type === 'tv';
}

export function canSaveFavoriteEq(itemId, favorited) {
  return Boolean(favorited && itemId && itemId.length <= 512);
}

export function hasFavoriteEq(state, itemId, favorited) {
  return canSaveFavoriteEq(itemId, favorited) && Object.hasOwn(state.favorites, itemId);
}

export function getEffectiveEq(eqState, itemId, favorited = false) {
  const state = normalizeEqState(eqState);
  if (itemId && Object.hasOwn(state.assignments, itemId)) {
    const { curve } = getEqPreset(state, state.assignments[itemId]);
    return cloneEqCurve({ ...curve, bypassed: state.global.bypassed });
  }
  return cloneEqCurve(hasFavoriteEq(state, itemId, favorited) ? state.favorites[itemId] : state.global);
}

export function setStationEqPreset(eqState, itemIds, presetId = '') {
  const state = normalizeEqState(eqState);
  if (presetId && !getEqPreset(state, presetId)) return state;
  for (const itemId of itemIds) {
    if (typeof itemId !== 'string' || !itemId || itemId.length > 512) continue;
    if (presetId) defineOwn(state.assignments, itemId, presetId);
    else delete state.assignments[itemId];
  }
  return state;
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

/** addFavoriteEq for many items with one copy of the map: each id gets the
 *  same entry addFavoriteEq(state, id, getEffectiveEq(state, id, false)) gives. */
export function addFavoritesEq(eqState, itemIds) {
  const state = normalizeEqState(eqState);
  const favorites = { ...state.favorites };
  for (const itemId of itemIds || []) {
    if (itemId) defineOwn(favorites, itemId, cloneEqCurve(state.global));
  }
  return { ...state, favorites };
}

export function removeFavoriteEq(eqState, itemId) {
  const state = normalizeEqState(eqState);
  if (!hasFavoriteEq(state, itemId, true)) return state;
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

export function setEqBypassed(eqState, itemId, favorited, bypassed) {
  const state = normalizeEqState(eqState);
  const stationCurve = !Object.hasOwn(state.assignments, itemId) && hasFavoriteEq(state, itemId, favorited);
  const base = stationCurve ? state.favorites[itemId] : state.global;
  return setScopedEq(state, itemId, stationCurve, { ...base, bypassed });
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
  return normalizeEqState({ ...state, customPresets });
}

function resolveStorage(storage) {
  return storage || globalThis.localStorage;
}

export function loadEqState(storage) {
  try {
    const target = resolveStorage(storage);
    const raw = target?.getItem(EQ_STORAGE_KEY);
    const state = normalizeEqState(raw ? JSON.parse(raw) : null);
    let extra;
    try { extra = JSON.parse(target?.getItem(EQ_EXTRA_STORAGE_KEY) || 'null'); } catch (_) {}
    if (!extra || typeof extra !== 'object') return state;
    if (Array.isArray(extra.q?.global)) state.global.q = extra.q.global;
    for (const scope of ['favorites', 'customPresets']) {
      for (const [key, q] of Object.entries(extra.q?.[scope] || {})) {
        if (Array.isArray(q) && Object.hasOwn(state[scope], key)) state[scope][key].q = q;
      }
    }
    return normalizeEqState({ ...state, assignments: extra.assignments });
  } catch (_) {
    return freshEqState();
  }
}

/** Keep advanced settings and station assignments in the extra profile. */
export function eqStorageEntries(eqState) {
  const { assignments, ...legacy } = normalizeEqState(eqState);
  const q = {};
  const { q: globalQ, ...global } = legacy.global;
  legacy.global = global;
  const changed = (values) => values.some((value, index) => value !== EQ_DEFAULT_Q[index]);
  if (changed(globalQ)) q.global = globalQ;
  for (const scope of ['favorites', 'customPresets']) {
    const widths = {};
    for (const [key, { q: values, ...curve }] of Object.entries(legacy[scope])) {
      defineOwn(legacy[scope], key, curve);
      if (changed(values)) defineOwn(widths, key, values);
    }
    if (Object.keys(widths).length) q[scope] = widths;
  }
  const hasExtra = Object.keys(assignments).length || Object.keys(q).length;
  return [
    [EQ_STORAGE_KEY, JSON.stringify(legacy)],
    [EQ_EXTRA_STORAGE_KEY, hasExtra ? JSON.stringify({ assignments, q }) : null],
  ];
}

export function saveEqState(eqState, storage, onError) {
  const normalized = normalizeEqState(eqState);
  const written = [];
  let target;
  try {
    target = resolveStorage(storage);
    if (!target) return normalized;
    const writes = eqStorageEntries(normalized);
    checkProfileStorageBudget(target, writes);
    for (const [key, value] of writes) {
      const previous = target.getItem(key);
      if (previous === value) continue;
      if (value == null) target.removeItem(key);
      else target.setItem(key, value);
      written.push([key, previous]);
    }
  } catch (error) {
    for (const [key, previous] of written.reverse()) {
      try {
        if (previous == null) target.removeItem(key);
        else target.setItem(key, previous);
      } catch (_) {}
    }
    onError?.(error);
  }
  return normalized;
}

export function persistFavoriteEq(itemId, effectiveCurve = null, storage) {
  return saveEqState(addFavoriteEq(loadEqState(storage), itemId, effectiveCurve), storage);
}

export function deleteFavoriteEq(itemId, storage) {
  return saveEqState(removeFavoriteEq(loadEqState(storage), itemId), storage);
}

export function clearEqState(storage) {
  for (const key of [EQ_STORAGE_KEY, EQ_EXTRA_STORAGE_KEY]) {
    try { resolveStorage(storage)?.removeItem(key); } catch (_) {}
  }
}
