/**
 * Favorites categories: lists the user makes ("Rock", "Talk") and puts saved
 * favorites into. A favorite is in at most one category, or in none.
 *
 * Stored apart from the favorites list, under its own key:
 *   { version: 1, groups: [{ id, name }], assign: { favoriteId: groupId } }
 * The favorites list itself is never changed here. persistFavoriteMetadata
 * (state.js) rewrites a saved favorite from the playing item, so a category
 * field on the favorite would be lost; an older build would also drop it.
 *
 * Reading never throws: missing, corrupt or unknown data simply means "no
 * categories" and never gets in the way of favorites. Data saved by a newer
 * layout (a higher version) is shown as no categories and left untouched.
 * Every action that changes something saves once and sends one
 * 'favorite-groups-change' event. Assignments for favorites that are no
 * longer saved are dropped when the favorites change.
 */

import { emit, getState, STORAGE_KEYS, subscribe } from './state.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { reportPersistenceFailure, clearPersistenceFailure } from './persistence-notice.js';

export const FAVORITE_GROUPS_VERSION = 1;
export const MAX_FAVORITE_GROUPS = 50;
export const MAX_GROUP_NAME_LENGTH = 40;
export const FAVORITE_GROUPS_EVENT = 'favorite-groups-change';
/** The Library filter value for favorites that are in no category. Never a
 *  valid category id (ids have no colon). */
export const UNCATEGORIZED = ':none';

const GROUP_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FAVORITE_ID_LENGTH = 4096;
// Invisible characters that would make two names look alike or turn text
// around (zero-width, direction marks and overrides, byte-order mark).
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const EMPTY = Object.freeze({ groups: Object.freeze([]), assign: new Map(), locked: false });
let cache = { raw: null, doc: EMPTY };

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function readRaw() {
  try {
    const raw = storage()?.getItem(STORAGE_KEYS.favoriteGroups);
    return typeof raw === 'string' ? raw : null;
  } catch (_) { return null; }
}

/** A category name as it is saved: control and invisible characters removed,
 *  runs of spaces made one, no spaces at either end. */
export function cleanGroupName(value) {
  if (typeof value !== 'string') return '';
  let text = value;
  try { text = text.normalize('NFC'); } catch (_) { /* keep as typed */ }
  return text.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

function nameKey(name) { return name.toLowerCase(); }
function nameLength(name) { return [...name].length; }

function parseDocument(raw) {
  if (raw == null) return EMPTY;
  let value;
  try { value = JSON.parse(raw); } catch (_) { return EMPTY; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
  if (value.version !== FAVORITE_GROUPS_VERSION) {
    // A later layout: show nothing, and never write over it.
    const newer = Number.isInteger(value.version) && value.version > FAVORITE_GROUPS_VERSION;
    return newer ? { groups: [], assign: new Map(), locked: true } : EMPTY;
  }
  const groups = [];
  const ids = new Set();
  const names = new Set();
  for (const entry of Array.isArray(value.groups) ? value.groups : []) {
    if (groups.length >= MAX_FAVORITE_GROUPS) break;
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = cleanGroupName(entry.name);
    if (!GROUP_ID.test(id) || ids.has(id)) continue;
    if (!name || nameLength(name) > MAX_GROUP_NAME_LENGTH || names.has(nameKey(name))) continue;
    ids.add(id);
    names.add(nameKey(name));
    groups.push(Object.freeze({ id, name }));
  }
  const assign = new Map();
  const stored = value.assign;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [favoriteId, groupId] of Object.entries(stored)) {
      if (!favoriteId || favoriteId.length > MAX_FAVORITE_ID_LENGTH) continue;
      if (typeof groupId === 'string' && ids.has(groupId)) assign.set(favoriteId, groupId);
    }
  }
  return { groups: Object.freeze(groups), assign, locked: false };
}

/** The saved categories, read again only when the stored text changed. */
function current() {
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, doc: parseDocument(raw) };
  return cache.doc;
}

/** The categories in the order they were made: [{ id, name }]. */
export function getFavoriteGroups() {
  return current().groups.map(({ id, name }) => ({ id, name }));
}

/** The id of the category a favorite is in, or ''. */
export function favoriteGroupOf(favoriteId) {
  return current().assign.get(favoriteId) || '';
}

/** One consistent view for a pass over many favorites (a filter, the counts):
 *  the store is read once instead of once per favorite. */
export function favoriteGroupsSnapshot() {
  const doc = current();
  const names = new Map(doc.groups.map((group) => [group.id, group.name]));
  return {
    groups: doc.groups.map(({ id, name }) => ({ id, name })),
    groupOf: (favoriteId) => doc.assign.get(favoriteId) || '',
    nameOf: (groupId) => names.get(groupId) || '',
    has: (groupId) => names.has(groupId),
    locked: doc.locked,
  };
}

/** How many saved favorites each category holds, and how many are in none. */
export function favoriteGroupCounts(favorites = getState().favorites) {
  const doc = current();
  const counts = new Map(doc.groups.map((group) => [group.id, 0]));
  let none = 0;
  const seen = new Set();
  for (const favorite of Array.isArray(favorites) ? favorites : []) {
    const id = favorite?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const groupId = doc.assign.get(id);
    if (groupId && counts.has(groupId)) counts.set(groupId, counts.get(groupId) + 1);
    else none += 1;
  }
  return { counts, none };
}

/** Check a proposed name. Returns { ok, name, error } with a plain message. */
export function checkGroupName(value, { exceptId = '' } = {}) {
  const name = cleanGroupName(value);
  if (!name) return { ok: false, name, error: 'Type a name for the category.' };
  const length = nameLength(name);
  if (length > MAX_GROUP_NAME_LENGTH) {
    return { ok: false, name, error: `Use ${MAX_GROUP_NAME_LENGTH} characters or fewer (this name has ${length}).` };
  }
  const same = current().groups.find((group) => group.id !== exceptId && nameKey(group.name) === nameKey(name));
  if (same) return { ok: false, name, error: `There is already a category called "${same.name}".` };
  return { ok: true, name, error: '' };
}

function lockedResult() {
  return {
    ok: false,
    error: 'Your categories were saved by a newer version of World Media, so they cannot be changed here.',
  };
}

function newGroupId(taken) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
    if (!taken.has(id)) return id;
  }
  let counter = taken.size + 1;
  while (taken.has(`g${counter}`)) counter += 1;
  return `g${counter}`;
}

/** Save the given categories and assignments, dropping assignments for
 *  favorites that are no longer saved. One write and one event. */
function commit(groups, assign, detail) {
  const target = storage();
  if (!target || typeof target.setItem !== 'function') {
    return { ok: false, error: 'Categories could not be saved because saved data is not available.' };
  }
  const saved = new Set(getState().favorites.map((favorite) => favorite?.id).filter(Boolean));
  const ids = new Set(groups.map((group) => group.id));
  const kept = new Map([...assign].filter(([favoriteId, groupId]) => saved.has(favoriteId) && ids.has(groupId)));
  let raw = null;
  try {
    if (groups.length === 0) {
      target.removeItem?.(STORAGE_KEYS.favoriteGroups);
    } else {
      raw = JSON.stringify({
        version: FAVORITE_GROUPS_VERSION,
        groups: groups.map(({ id, name }) => ({ id, name })),
        assign: Object.fromEntries(kept),
      });
      target.setItem(STORAGE_KEYS.favoriteGroups, raw);
    }
  } catch (error) {
    console.warn('Could not save favorites categories:', error);
    reportPersistenceFailure('favorite-groups', 'Favorites categories could not be saved. Your favorites are unchanged. Check available disk space and retry.');
    return { ok: false, error: 'Categories could not be saved. Your favorites are unchanged.' };
  }
  clearPersistenceFailure('favorite-groups');
  cache = { raw, doc: raw == null ? EMPTY : parseDocument(raw) };
  scheduleProfileHandoff();
  emit(FAVORITE_GROUPS_EVENT, detail);
  return { ok: true, error: '' };
}

function savedFavorite(favoriteId) {
  return Boolean(favoriteId) && getState().favorites.some((favorite) => favorite?.id === favoriteId);
}

/** Make a category. With `assign`, also put that favorite in it (one save). */
export function createFavoriteGroup(value, { assign = '' } = {}) {
  const doc = current();
  if (doc.locked) return lockedResult();
  if (doc.groups.length >= MAX_FAVORITE_GROUPS) {
    return { ok: false, error: `You can have up to ${MAX_FAVORITE_GROUPS} categories. Delete one to make room.` };
  }
  const check = checkGroupName(value);
  if (!check.ok) return { ok: false, error: check.error };
  const group = { id: newGroupId(new Set(doc.groups.map((entry) => entry.id))), name: check.name };
  const assignments = new Map(doc.assign);
  if (assign && savedFavorite(assign)) assignments.set(assign, group.id);
  const result = commit([...doc.groups, group], assignments, { action: 'create', groupId: group.id });
  return result.ok ? { ...result, group: { ...group } } : result;
}

export function renameFavoriteGroup(groupId, value) {
  const doc = current();
  if (doc.locked) return lockedResult();
  const found = doc.groups.find((group) => group.id === groupId);
  if (!found) return { ok: false, error: 'That category no longer exists.' };
  const check = checkGroupName(value, { exceptId: groupId });
  if (!check.ok) return { ok: false, error: check.error };
  if (check.name === found.name) return { ok: true, error: '', changed: false };
  const groups = doc.groups.map((group) => (group.id === groupId ? { id: group.id, name: check.name } : group));
  return commit(groups, doc.assign, { action: 'rename', groupId });
}

/** Delete a category. Its favorites stay saved, in no category. */
export function deleteFavoriteGroup(groupId) {
  const doc = current();
  if (doc.locked) return lockedResult();
  if (!doc.groups.some((group) => group.id === groupId)) return { ok: false, error: 'That category no longer exists.' };
  const assignments = new Map([...doc.assign].filter(([, assigned]) => assigned !== groupId));
  return commit(doc.groups.filter((group) => group.id !== groupId), assignments, { action: 'delete', groupId });
}

/** Put a favorite in a category, or in none with '' (or null). */
export function assignFavoriteToGroup(favoriteId, groupId = '') {
  const doc = current();
  if (doc.locked) return lockedResult();
  if (!savedFavorite(favoriteId)) return { ok: false, error: 'Only saved favorites can be put in a category.' };
  const target = groupId || '';
  if (target && !doc.groups.some((group) => group.id === target)) return { ok: false, error: 'That category no longer exists.' };
  if ((doc.assign.get(favoriteId) || '') === target) return { ok: true, error: '', changed: false };
  const assignments = new Map(doc.assign);
  if (target) assignments.set(favoriteId, target);
  else assignments.delete(favoriteId);
  return commit(doc.groups, assignments, { action: 'assign', favoriteId, groupId: target });
}

/** The stored categories text with favorites given new ids: `ids` maps an
 *  old favorite id to its new id. Only the assignments change; everything
 *  else is kept as stored. Missing, unreadable or newer-layout data comes
 *  back unchanged (null stays null). Used by favorite-migration.js, which
 *  saves it together with the favorites list. */
export function favoriteGroupsTextWithNewIds(raw, ids) {
  if (raw == null) return raw;
  let value;
  try { value = JSON.parse(raw); } catch (_) { return raw; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== FAVORITE_GROUPS_VERSION) return raw;
  const stored = value.assign;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return raw;
  let changed = false;
  const assign = Object.create(null);
  for (const [favoriteId, groupId] of Object.entries(stored)) {
    const next = ids.get(favoriteId);
    if (next && !Object.hasOwn(stored, next)) { assign[next] = groupId; changed = true; }
    else if (!Object.hasOwn(assign, favoriteId)) assign[favoriteId] = groupId;
  }
  return changed ? JSON.stringify({ ...value, assign }) : raw;
}

/** Drop assignments for favorites that are no longer saved. Saves only when
 *  there is something to drop. Returns true when it saved. */
export function pruneFavoriteGroups() {
  const doc = current();
  if (doc.locked || doc.assign.size === 0) return false;
  const saved = new Set(getState().favorites.map((favorite) => favorite?.id).filter(Boolean));
  if ([...doc.assign.keys()].every((favoriteId) => saved.has(favoriteId))) return false;
  return commit(doc.groups, doc.assign, { action: 'prune' }).ok;
}

// Removing a favorite (or clearing them all) drops its category assignment.
subscribe('favorites-change', () => { pruneFavoriteGroups(); });
