/**
 * The user's own station pictures: the station-images folder in the data
 * folder (worldmedia_station_images.py).
 *
 * Pictures set in the app use a key derived from the saved station ID.
 * Existing name-based pictures are bound to the saved stations that matched
 * when first scanned. Unmatched files still work by name. Only these legacy
 * assignments are saved with the profile. Picture files stay in the folder
 * and are fetched with the session token for display through object URLs.
 *
 * Matching rule (the same as normalize_station_name in Python; the shared
 * cases are in tests/fixtures/station-image-names.json): Unicode NFKC, every
 * kind of whitespace becomes a space, the characters Windows forbids in file
 * names and control characters are removed, lower case, runs of spaces become
 * one, and leading or trailing spaces and trailing dots are removed.
 *
 * A station's name may hold characters no file name can (\ / : * ? " < > |),
 * or be a name Windows reserves (CON, AUX, COM1...). So such a station also
 * matches a file in which each such character is written as "-", "_" or a
 * space, or left out, and a reserved name followed by "_" or "-" (the loose
 * rule below; STATION_IMAGES_NAME_RULE says it in Settings). The backend
 * checks file names exactly as before; only the station side gets the extra
 * spellings.
 */

import { controlRequest, getControlSession, invalidateControlSession } from './capture-client.js';
import { getState } from './state.js';
import { getPlaylistItems, loadPlaylists } from './playlists.js';
import { favoriteNamesSnapshot, withFavoriteName } from './favorite-names.js';
import { checkProfileStorageBudget, STATION_IMAGE_OWNERS_KEY } from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';

export const STATION_IMAGES_ROUTE = '/api/v1/station-images';
export const STATION_IMAGES_OPEN_ROUTE = '/api/v1/station-images/open-folder';
export const STATION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const STATION_IMAGES_HINT = 'Put a picture in this folder named exactly like the station, '
  + 'for example Radio Paradise.png. PNG, JPG, WebP or GIF, up to 2 MB each.';
// Shown with textContent (it names characters that are not plain text in HTML).
export const STATION_IMAGES_NAME_RULE = 'Capital letters do not matter. Windows does not allow '
  + '\\ / : * ? " < > | in file names: write each of them as - or _ or a space, or leave it out. '
  + 'For example Nu-Metal-Alternative.png for the station Nu-Metal/Alternative. '
  + 'A name Windows keeps for itself, such as CON or AUX, takes a _ at the end: AUX_.png.';
export const STATION_IMAGE_NO_MATCH_TEXT = 'no favorite or playlist station has this name';
// The most lines the Settings list shows; the rest are counted.
export const STATION_IMAGE_PROBLEMS_SHOWN = 10;

const SOURCE_PREFIX = 'station-image:';
const SOURCE_PATTERN = /^station-image:([0-9a-f]{32}):([0-9a-f]{1,32})$/;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const SCOPED_KEY = /^wm-station-id-[0-9a-f]{64}$/;
const STAMP_PATTERN = /^[0-9a-f]{1,32}$/;
// Longer names can never match: Windows file names are at most 255 units long.
const MAX_NAME_INPUT = 1024;
const MAX_OBJECT_URLS = 256;
const MAX_REMEMBERED_TITLES = 5000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SPACES = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const DROPPED = /[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/g;
const SPACE_RUNS = / {2,}/g;

/** The text a station's name is compared by; '' when it can never match. */
export function normalizeStationName(value) {
  if (typeof value !== 'string' || value.length > MAX_NAME_INPUT) return '';
  return value.normalize('NFKC')
    .replace(SPACES, ' ')
    .replace(DROPPED, '')
    .toLowerCase()
    .replace(SPACE_RUNS, ' ')
    .replace(/^ +| +$/g, '')
    .replace(/[. ]+$/, '');
}

/*
 * Names a file cannot hold (the "loose" rule).
 *
 * A station whose name has a character Windows forbids in file names
 * (\ / : * ? " < > |), or whose name Windows keeps for itself (CON, AUX,
 * COM1...), cannot have a file named exactly like it. Such a station matches
 * a picture whose normalized name is the station's name with each forbidden
 * character written as "-", "_" or a space, or left out (any number of them,
 * each on its own), and a reserved name with "_" or "-" after it.
 *
 * It is a lookup, not a search: every picture is filed under its name with
 * "-", "_", spaces and dots taken out (canonicalName); a station looks in one
 * place and checks the few pictures there exactly (fitsStation).
 *
 * Which picture goes to which station:
 *  1. A station whose name has no forbidden character and is not reserved
 *     uses only the picture named exactly like it (the old rule). Such a
 *     picture belongs to it: no other favorite or playlist station gets it
 *     through the loose rule.
 *  2. Among the other pictures that fit a station, it takes the first in
 *     this order: read the two names left to right; at the first place they
 *     differ, "-" comes first, then "_", then a space, then anything else
 *     (so a left-out character comes last). Rock-Pop.png before Rock_Pop.png
 *     before Rock Pop.png before RockPop.png.
 *  3. When one picture fits several stations, the stations are served in the
 *     order of their normalized names (then their names as written); a
 *     station whose first choice is taken uses its next one.
 * Settings lists what was decided for pictures that fit more than one
 * station, or a station that fits more than one picture (stationImageProblems).
 */
const FILE_NAME_FORBIDDEN = /[\\/:*?"<>|]/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9]|lpt[0-9])$/;
const SHOWN_TITLE_LENGTH = 80;

function canonicalName(text) {
  return text.replace(/[-_ .]/g, '');
}

function reservedHead(key) {
  const dot = key.indexOf('.');
  return RESERVED_NAME.test((dot < 0 ? key : key.slice(0, dot)).replace(/ +$/, ''));
}

/** The normalized filename a new picture will get on the server, or ''. */
export function stationPictureFileKey(title) {
  if (typeof title !== 'string' || title.length > MAX_NAME_INPUT) return '';
  const stem = title.normalize('NFKC').replace(SPACES, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-').replace(SPACE_RUNS, ' ').trim().replace(/[. ]+$/, '');
  if (!stem || stem.startsWith('._') || /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(stem)) return '';
  const dot = stem.indexOf('.');
  const head = dot < 0 ? stem : stem.slice(0, dot);
  const filename = reservedHead(stem.toLowerCase()) ? head + '_' + stem.slice(head.length) : stem;
  // The server tests the stem with its longest allowed extension, .webp.
  return [...filename].length <= 250 ? normalizeStationName(filename) : '';
}

/** How a station's name is matched, or null when it can never match. */
function stationName(title) {
  const exact = normalizeStationName(title);
  if (!exact) return null;
  const parts = title.normalize('NFKC').replace(SPACES, ' ').split(FILE_NAME_FORBIDDEN)
    .map((part) => part.replace(DROPPED, '').toLowerCase());
  const reserved = reservedHead(exact);
  return { exact, parts, reserved, loose: parts.length > 1 || reserved, canon: canonicalName(parts.join('')) };
}

/** True when writing each forbidden character of the station's name (its
 *  `parts`) as "", "-", "_" or " " can give exactly `target` once
 *  normalized. Walks the name once, keeping the few places in `target` it
 *  can have reached (at most two per character of target), so the cost does
 *  not grow with the number of forbidden characters' combinations. */
function spells(parts, target) {
  // state: `${position in target}|${last character written was a space}`
  let states = new Set(['0|1']);
  const step = (from, char) => {
    const next = new Set();
    for (const state of from) {
      const bar = state.indexOf('|');
      const at = Number(state.slice(0, bar));
      const spaced = state.slice(bar + 1) === '1';
      if (char === ' ' && spaced) { next.add(state); continue; }
      if (at < target.length) {
        if (target[at] === char) next.add(`${at + 1}|${char === ' ' ? 1 : 0}`);
      } else if (char === ' ' || char === '.') {
        // Past the end of the target: only what normalizing trims may follow.
        next.add(`${at}|${char === ' ' ? 1 : 0}`);
      }
    }
    return next;
  };
  parts.forEach((part, place) => {
    if (place > 0) {
      const joined = new Set(states);
      for (const mark of ['-', '_', ' ']) for (const state of step(states, mark)) joined.add(state);
      states = joined;
    }
    for (const char of part) {
      states = step(states, char);
      if (states.size === 0) return;
    }
  });
  for (const state of states) if (Number(state.slice(0, state.indexOf('|'))) === target.length) return true;
  return false;
}

/** True when the picture named `key` fits a station by the loose rule. */
function fitsStation(info, key) {
  if (spells(info.parts, key)) return true;
  // A reserved name with "_" or "-" after it: AUX_.png for AUX.
  const dot = key.indexOf('.');
  const head = dot < 0 ? key : key.slice(0, dot);
  const mark = head.at(-1);
  if (mark !== '_' && mark !== '-') return false;
  const plain = head.slice(0, -1) + key.slice(head.length);
  return reservedHead(plain) && spells(info.parts, plain);
}

const MARK_ORDER = new Map([['-', 1], ['_', 2], [' ', 3]]);
const markRank = (char) => (char === undefined ? Number.MAX_SAFE_INTEGER : MARK_ORDER.get(char) || 4 + char.codePointAt(0));

/** Rule 2 above, as a sort order for picture names. */
function pictureOrder(a, b) {
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) return markRank(a[at]) - markRank(b[at]);
  }
  return 0;
}

function looseFits(info, owners) {
  const fits = [];
  const owned = [];
  for (const key of index.canon.get(info.canon) || []) {
    if (!fitsStation(info, key)) continue;
    (owners.has(key) ? owned : fits).push(key);
  }
  return { fits: fits.sort(pictureOrder), owned };
}

/** Which picture each station uses, for a set of station names (favorites
 *  and playlist stations). Also what Settings reports about it. */
function assignPictures(titles) {
  const stations = new Map();
  for (const title of titles) {
    if (typeof title !== 'string' || !title || stations.has(title)) continue;
    const info = stationName(title);
    if (info) stations.set(title, info);
  }
  const picks = new Map();
  const owners = new Map();
  for (const [title, info] of stations) {
    if (info.loose || SCOPED_KEY.test(info.exact) || !index.byKey.has(info.exact)) continue;
    picks.set(title, info.exact);
    if (!owners.has(info.exact)) owners.set(info.exact, title);
  }
  const takenBy = new Map();
  const alsoFits = new Map();
  const note = (key, title) => {
    if (!alsoFits.has(key)) alsoFits.set(key, new Set());
    alsoFits.get(key).add(title);
  };
  const loose = [...stations].filter(([, info]) => info.loose)
    .sort(([a, x], [b, y]) => (x.exact < y.exact ? -1 : x.exact > y.exact ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const [title, info] of loose) {
    const { fits, owned } = looseFits(info, owners);
    for (const key of owned) note(key, title);
    const chosen = fits.find((key) => !takenBy.has(key));
    for (const key of fits) if (key !== chosen) note(key, title);
    if (chosen) {
      picks.set(title, chosen);
      takenBy.set(chosen, title);
    }
  }
  return { stations, picks, owners, takenBy, alsoFits };
}

let index = {
  version: '', folder: '', loaded: false, byKey: new Map(), canon: new Map(), files: new Map(),
  rejected: [], rejectedMore: 0, hasScoped: false,
};
const failed = new Set();
const listeners = new Set();
// source -> { promise, url }, oldest first.
const objectUrls = new Map();
let loading = null;
let startupFavorites;
const stationKeys = new Map();
const pendingStationKeys = new Map();
let scopedNotificationPending = false;
let ownersDocument;

function legacyOwners(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STATION_IMAGE_OWNERS_KEY);
    if (ownersDocument && ownersDocument.raw === raw) return ownersDocument;
    const value = JSON.parse(raw || 'null');
    const owners = new Map();
    const pictures = new Map();
    const hidden = new Set(value?.version === 1 && Array.isArray(value.hidden) ? value.hidden : []);
    if (value?.version === 1 && value.owners && typeof value.owners === 'object') {
      for (const [key, ids] of Object.entries(value.owners)) {
        if (!Array.isArray(ids)) continue;
        const valid = ids.filter((id) => typeof id === 'string' && id);
        owners.set(key, new Set(valid));
        for (const id of valid) {
          if (!pictures.has(id)) pictures.set(id, []);
          pictures.get(id).push(key);
        }
      }
    }
    return (ownersDocument = { raw, owners, pictures, hidden });
  } catch (_) {
    return { owners: new Map(), pictures: new Map(), hidden: new Set() };
  }
}

function saveLegacyOwners(owners, hidden, storage) {
  const raw = JSON.stringify({
    version: 1,
    owners: Object.fromEntries([...owners].map(([key, ids]) => [key, [...ids]])),
    hidden: [...hidden],
  });
  checkProfileStorageBudget(storage, [[STATION_IMAGE_OWNERS_KEY, raw]]);
  storage.setItem(STATION_IMAGE_OWNERS_KEY, raw);
  scheduleProfileHandoff();
}

/** Bind the legacy pictures which matched a saved station at first startup. */
export function migrateLegacyStationPictures(stations, storage = globalThis.localStorage) {
  if (legacyOwners(storage).raw) return false;
  const names = stations.flatMap((item) => [item.title, item.originalTitle]);
  const { picks } = assignPictures(names);
  const owners = new Map();
  for (const item of stations) {
    if (typeof item.id !== 'string' || !item.id) continue;
    for (const title of [item.originalTitle, item.title]) {
      const key = picks.get(title);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(item.id);
    }
  }
  saveLegacyOwners(owners, new Set(), storage);
  return true;
}

/** Resolve the filename key used by the native store without blocking a render. */
export function prepareStationPictureKey(id) {
  if (typeof id !== 'string' || !id) return Promise.resolve('');
  if (stationKeys.has(id)) return Promise.resolve(stationKeys.get(id));
  if (pendingStationKeys.has(id)) return pendingStationKeys.get(id);
  if (!globalThis.crypto?.subtle) return Promise.resolve('');
  const pending = globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
    .then((bytes) => {
      const digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const key = 'wm-station-id-' + digest;
      if (stationKeys.size >= MAX_REMEMBERED_TITLES) {
        // Prefer keeping keys which identify a picture.
        let discard = stationKeys.keys().next().value;
        for (const [candidate, known] of stationKeys) {
          if (index.byKey.has(known)) continue;
          discard = candidate;
          break;
        }
        stationKeys.delete(discard);
      }
      stationKeys.set(id, key);
      if (index.byKey.has(key) && !scopedNotificationPending) {
        scopedNotificationPending = true;
        const update = () => {
          scopedNotificationPending = false;
          notify();
        };
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(update);
        else queueMicrotask(update);
      }
      return key;
    }, () => '').finally(() => pendingStationKeys.delete(id));
  pendingStationKeys.set(id, pending);
  return pending;
}

export function isScopedStationPicture(item, source) {
  const key = stationKeys.get(item?.id);
  return Boolean(key && source && index.byKey.get(key) === source);
}

/** Removing an ID picture also dismisses any legacy picture behind it for this station. */
export function hideLegacyStationPicture(item) {
  if (!legacyPictureFor(item)) return;
  const storage = globalThis.localStorage;
  const { owners, hidden } = legacyOwners(storage);
  saveLegacyOwners(owners, new Set([...hidden, item.id]), storage);
}

// The station names pictures are shared out between: favorites and playlist
// stations. Read again only when one of those lists or the picture list is
// replaced (each change makes a new array), so asking is cheap.
let titleSource = () => [getState().favorites, getPlaylistItems()];
let plan = null;
// Pictures for names that are on neither list (catalog stations), oldest first.
const otherTitles = new Map();

/** Tests: where the favorite and playlist station names come from. */
export function setStationImageTitleSource(source) {
  titleSource = typeof source === 'function' ? source : () => [];
  plan = null;
}

function currentPlan() {
  let lists;
  try { lists = Array.from(titleSource() || []); } catch (_) { lists = []; }
  if (plan && plan.index === index && plan.lists.length === lists.length
      && plan.lists.every((list, at) => list === lists[at])) return plan;
  const titles = [];
  for (const list of lists) for (const item of Array.isArray(list) ? list : []) titles.push(item?.title);
  plan = { index, lists, ...assignPictures(titles) };
  otherTitles.clear();
  return plan;
}

function pictureKeyFor(title) {
  const current = currentPlan();
  if (current.stations.has(title)) return current.picks.get(title) || '';
  let key = otherTitles.get(title);
  if (key !== undefined) return key;
  key = '';
  const info = stationName(title);
  if (info && !info.loose) key = index.byKey.has(info.exact) && !SCOPED_KEY.test(info.exact) ? info.exact : '';
  else if (info) key = looseFits(info, current.owners).fits.find((fit) => !current.takenBy.has(fit)) || '';
  // Forget the oldest one name, not all of them, when full.
  if (otherTitles.size >= MAX_REMEMBERED_TITLES) otherTitles.delete(otherTitles.keys().next().value);
  otherTitles.set(title, key);
  return key;
}

/** Called whenever the pictures that apply to items change. */
export function onStationImagesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of [...listeners]) {
    try { listener(); } catch (error) { console.error('station pictures listener threw:', error); }
  }
}

function releaseObjectUrl(source, revoke = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)) {
  const entry = objectUrls.get(source);
  if (!entry) return;
  objectUrls.delete(source);
  if (entry.url) {
    try { revoke?.(entry.url); } catch (_) { /* already gone */ }
  }
  entry.released = true;
}

/** Take in the backend's list. Returns true when the pictures changed.
 *  `retryFailed` (a fresh load: startup or Refresh) forgets which pictures
 *  failed to load, so a picture that failed once for a passing reason is
 *  tried again even when the list names it unchanged. */
export function applyStationImageList(data, { retryFailed = false, legacyStations } = {}) {
  const byKey = new Map();
  const canon = new Map();
  const files = new Map();
  for (const entry of Array.isArray(data?.images) ? data.images : []) {
    const key = entry?.key;
    if (typeof key !== 'string' || !key || key.length > MAX_NAME_INPUT || byKey.has(key)) continue;
    if (!ID_PATTERN.test(String(entry.id)) || !STAMP_PATTERN.test(String(entry.v))) continue;
    byKey.set(key, `${SOURCE_PREFIX}${entry.id}:${entry.v}`);
    if (!SCOPED_KEY.test(key)) {
      const filed = canonicalName(key);
      if (!canon.has(filed)) canon.set(filed, []);
      canon.get(filed).push(key);
    }
    if (typeof entry.file === 'string' && entry.file) files.set(key, entry.file.slice(0, 160));
  }
  const rejected = (Array.isArray(data?.rejected) ? data.rejected : [])
    .filter((entry) => typeof entry?.file === 'string' && entry.file && typeof entry.text === 'string' && entry.text)
    .slice(0, 50)
    .map((entry) => ({ file: entry.file.slice(0, 160), text: entry.text.slice(0, 120) }));
  let changed = byKey.size !== index.byKey.size
    || [...byKey].some(([key, source]) => index.byKey.get(key) !== source);
  index = {
    version: typeof data?.version === 'string' ? data.version.slice(0, 64) : '',
    folder: typeof data?.folder === 'string' ? data.folder : '',
    loaded: true,
    byKey,
    canon,
    files,
    rejected,
    rejectedMore: count(data?.rejected_more),
    hasScoped: [...byKey.keys()].some((key) => SCOPED_KEY.test(key)),
  };
  if (legacyStations) {
    try {
      changed = migrateLegacyStationPictures(legacyStations) || changed;
    } catch (error) {
      console.warn('Could not save legacy station picture assignments:', error);
    }
  }
  const current = new Set(byKey.values());
  for (const source of [...objectUrls.keys()]) if (!current.has(source)) releaseObjectUrl(source);
  for (const source of [...failed]) {
    if (current.has(source) && !retryFailed) continue;
    failed.delete(source);
    // Items that had gone back to their own artwork take the picture again.
    if (current.has(source)) changed = true;
  }
  if (changed) notify();
  return changed;
}

/** What the last list said, for Settings. */
export function stationImagesSnapshot() {
  return { loaded: index.loaded, folder: index.folder, version: index.version, count: index.byKey.size };
}

/** The user's picture for an item ('station-image:<id>:<stamp>'), or ''.
 *  Costs nothing when there are no pictures. */
export function stationImageSourceFor(item) {
  if (index.byKey.size === 0 || !item || typeof item !== 'object' || item.__contentHidden === true) return '';
  if (index.hasScoped) {
    const key = stationKeys.get(item.id);
    if (!key) void prepareStationPictureKey(item.id);
    const source = usablePicture(key);
    if (source) return source;
  }
  return legacyPictureFor(item);
}

function legacyPictureFor(item) {
  const { owners, pictures, hidden } = legacyOwners();
  if (hidden.has(item.id)) return '';
  const own = item.__favoriteName === true ? item.originalTitle : '';
  const keys = [own, item.title].filter((title) => typeof title === 'string' && title).map(pictureKeyFor);
  const bound = pictures.get(item.id) || [];
  for (const key of [
    ...keys.filter((key) => owners.get(key)?.has(item.id)),
    ...bound,
    ...keys.filter((key) => !owners.has(key)),
  ]) {
    const source = usablePicture(key);
    if (source) return source;
  }
  return '';
}

function usablePicture(key) {
  const source = index.byKey.get(key);
  return source && !failed.has(source) ? source : '';
}

function shownTitle(title) {
  const text = title.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return text.length > SHOWN_TITLE_LENGTH ? `${text.slice(0, SHOWN_TITLE_LENGTH - 3)}...` : text;
}

function listOfNames(titles) {
  const names = [...titles].map(shownTitle);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}

/** What the Settings list shows, from the last list the backend sent (no new
 *  scan): files that are not used and why; pictures that fit more than one
 *  station ("used for A; also fits B") or that lost to a better fitting one
 *  ("not used: A uses B.png"); then, when `titles` is given (the names of the
 *  favorites and playlist stations), pictures none of them is named like.
 *  Without `titles` the favorites and playlist stations known now are used
 *  for the first two kinds. At most `limit` lines; `more` counts the rest. */
export function stationImageProblems({ titles = null, limit = STATION_IMAGE_PROBLEMS_SHOWN } = {}) {
  const lines = index.rejected.map((entry) => ({ ...entry }));
  const more = index.rejectedMore;
  if (index.byKey.size > 0) {
    const current = titles ? assignPictures(titles) : currentPlan();
    const fileOf = (key) => index.files.get(key) || key;
    for (const [key, others] of [...current.alsoFits].sort(([a], [b]) => pictureOrder(a, b))) {
      const user = current.owners.get(key) || current.takenBy.get(key);
      if (user) {
        lines.push({ file: fileOf(key), text: `used for ${shownTitle(user)}; also fits ${listOfNames(others)}` });
        continue;
      }
      for (const title of others) {
        const used = current.picks.get(title);
        if (used) lines.push({ file: fileOf(key), text: `not used: ${shownTitle(title)} uses ${fileOf(used)}` });
      }
    }
    if (titles) {
      const used = new Set([...current.picks.values()]);
      for (const [key, file] of index.files) {
        if (!SCOPED_KEY.test(key) && !used.has(key) && !current.alsoFits.has(key)) {
          lines.push({ file, text: STATION_IMAGE_NO_MATCH_TEXT });
        }
      }
    }
  }
  const shown = lines.slice(0, Math.max(0, limit));
  return { lines: shown, more: more + lines.length - shown.length };
}

export function isStationImageSource(value) {
  return typeof value === 'string' && SOURCE_PATTERN.test(value);
}

/** A picture that would not load: its items go back to their own artwork
 *  until the list is loaded again (Refresh) or the file is replaced. */
export function markStationImageFailed(source) {
  if (!isStationImageSource(source) || failed.has(source)) return;
  failed.add(source);
  releaseObjectUrl(source);
  notify();
}

/** The object URL of a picture already fetched, or ''. */
export function peekStationImageUrl(source) {
  return objectUrls.get(source)?.url || '';
}

function requestError(message, status = 0, code = 'STATION_IMAGE_FAILED') {
  const error = new Error(message);
  error.name = 'StationImageError';
  error.status = status;
  error.code = code;
  return error;
}

function abortError(reason) {
  if (reason?.name === 'AbortError') return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'The station picture is no longer wanted.');
  error.name = 'AbortError';
  return error;
}

async function fetchStationImage(source, { fetchImpl = globalThis.fetch, sleep, signal } = {}) {
  const id = SOURCE_PATTERN.exec(source)[1];
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Stopped (nobody waits for it any more): no further request or retry.
  const check = () => { if (signal?.aborted) throw abortError(signal.reason); };
  for (let attempt = 0; ; attempt += 1) {
    check();
    const session = await getControlSession({ fetchImpl });
    check();
    const response = await fetchImpl(`${STATION_IMAGES_ROUTE}/${id}`, {
      method: 'GET',
      headers: { 'X-WorldMedia-Token': session.token },
      credentials: 'same-origin',
      // Always ask again: a replaced file keeps its address, and the ETag
      // makes an unchanged one cheap.
      cache: 'no-cache',
      ...(signal ? { signal } : {}),
    });
    check();
    if (response.ok) {
      const type = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) throw requestError('The station picture is not an image.', response.status);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > STATION_IMAGE_MAX_BYTES) {
        throw requestError('The station picture is too large.', response.status);
      }
      const blob = await response.blob();
      if (!blob || blob.size <= 0 || blob.size > STATION_IMAGE_MAX_BYTES) {
        throw requestError('The station picture is empty or too large.', response.status);
      }
      return blob.type === type ? blob : new Blob([blob], { type });
    }
    if (response.status === 403) {
      try {
        const payload = await response.json();
        if (payload?.error?.code === 'INVALID_TOKEN') invalidateControlSession(session.token);
      } catch (_) { /* A refusal without a token error leaves the session alone. */ }
    }
    try { await response.body?.cancel?.(); } catch (_) { /* nothing to read */ }
    // A new session after a restart, or a briefly busy server, gets one more try.
    const retry = (response.status === 403 && attempt === 0)
      || ((response.status === 429 || response.status === 503) && attempt < 2);
    if (!retry) throw requestError('The station picture could not be loaded.', response.status);
    await wait(150 * (attempt + 1));
  }
}

/** The caller's own view of a shared fetch. With `signal`, the caller can
 *  stop waiting: it is answered with an AbortError at once and a late result
 *  is never handed to it. When every caller that asked has stopped (and none
 *  asked without a signal, like the player bar), the fetch itself stops too,
 *  with no further retry, and is forgotten so a later request starts fresh. */
function waitForEntry(source, entry, signal) {
  if (!signal) {
    entry.held = true;
    return entry.promise;
  }
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  if (entry.url) return entry.promise;
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return false;
      settled = true;
      entry.waiters -= 1;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (!entry.held && entry.waiters <= 0 && !entry.url) {
        entry.controller.abort();
        if (objectUrls.get(source) === entry) objectUrls.delete(source);
      }
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then((url) => { if (leave()) resolve(url); }, (error) => { if (leave()) reject(error); });
  });
}

/** An object URL for a picture, fetched once and shared by every view.
 *  `options.signal` lets a caller stop waiting (see waitForEntry). */
export function stationImageUrl(source, options = {}) {
  if (!isStationImageSource(source)) return Promise.reject(requestError('Not a station picture.'));
  const { signal, ...fetchOptions } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  const cached = objectUrls.get(source);
  if (cached) {
    objectUrls.delete(source);
    objectUrls.set(source, cached);
    return waitForEntry(source, cached, signal);
  }
  const createUrl = fetchOptions.createUrl || globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const controller = new AbortController();
  const entry = { url: '', promise: null, released: false, held: false, waiters: 0, controller };
  entry.promise = fetchStationImage(source, { ...fetchOptions, signal: controller.signal }).then((blob) => {
    // Stopped while the bytes arrived: no object URL is made for nobody.
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    const url = createUrl(blob);
    entry.url = url;
    if (entry.released) {
      // Dropped while it was on its way: whoever asked still gets it, briefly.
      setTimeout(() => { try { globalThis.URL?.revokeObjectURL?.(url); } catch (_) {} }, 60_000);
    }
    return url;
  }, (error) => {
    if (objectUrls.get(source) === entry) objectUrls.delete(source);
    throw error;
  });
  // A fetch stopped because nobody waits for it has nobody to tell.
  entry.promise.catch(() => {});
  objectUrls.set(source, entry);
  while (objectUrls.size > MAX_OBJECT_URLS) releaseObjectUrl(objectUrls.keys().next().value);
  return waitForEntry(source, entry, signal);
}

export function initializeStationImages(options) {
  const { names } = favoriteNamesSnapshot();
  startupFavorites = legacyOwners().raw ? null
    : getState().favorites.map((item) => withFavoriteName(item, names));
  return loadStationImages(options);
}

/** Ask the backend for the list (it scans the folder) and take it in. */
export function loadStationImages({ request = controlRequest, afterCurrent = false } = {}) {
  if (loading) {
    // A write may have finished after the active scan took its snapshot.
    if (afterCurrent) return loading.catch(() => {}).then(() => loadStationImages({ request }));
    return loading;
  }
  const favorites = startupFavorites;
  const legacyStations = favorites && !legacyOwners().raw
    ? loadPlaylists(request).then((lists) => [...favorites, ...lists.flatMap(({ items }) => items)]).catch(() => null)
    : null;
  loading = Promise.all([Promise.resolve().then(() => request(STATION_IMAGES_ROUTE)), legacyStations])
    .then(([data, stations]) => {
      applyStationImageList(data, { retryFailed: true, legacyStations: data?.problem ? null : stations });
      if (legacyOwners().raw) startupFavorites = null;
      return data;
    })
    .finally(() => { loading = null; });
  return loading;
}

export function openStationImagesFolder({ request = controlRequest } = {}) {
  return request(STATION_IMAGES_OPEN_ROUTE, { method: 'POST', body: {} });
}

function count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/** One plain line, e.g. "12 pictures found. 1 ignored: too large." */
export function stationImagesStatusText(data) {
  if (typeof data?.problem === 'string' && data.problem.trim()) return data.problem.trim();
  if (data?.exists === false) return 'There is no station-images folder yet. Open folder makes it.';
  const found = count(data?.found);
  let text = found ? `${found} ${found === 1 ? 'picture' : 'pictures'} found.` : 'No pictures found.';
  const ignored = count(data?.ignored);
  if (ignored) {
    const reasons = (Array.isArray(data.ignored_reasons) ? data.ignored_reasons : [])
      .filter((reason) => typeof reason?.text === 'string' && reason.text && count(reason.count));
    const detail = reasons.length === 1
      ? reasons[0].text
      : reasons.map((reason) => `${count(reason.count)} ${reason.text}`).join(', ');
    text += ` ${ignored} ignored${detail ? `: ${detail}` : ''}.`;
  }
  return text;
}

function failureReason(error, fallback) {
  const reason = typeof error?.message === 'string' ? error.message.trim() : '';
  return reason || fallback;
}

/** Wire the Station images block in Settings. All text is plain text. */
export function bindStationImageControls({
  path, status, openButton, refreshButton, rule = null, problems = null, knownTitles = null,
  createElement = (tag) => globalThis.document.createElement(tag),
  load = loadStationImages, openFolder = openStationImagesFolder, isDisposed = () => false,
}) {
  function show(text, state) {
    status.textContent = text;
    status.dataset.state = state;
  }
  function showFolder(folder) {
    if (typeof folder === 'string' && folder) path.textContent = folder;
  }
  // The short list of pictures that are not used, from what the last scan
  // found. Plain text only.
  function showProblems() {
    if (!problems) return;
    let titles = null;
    try { titles = knownTitles?.() || null; } catch (_) { titles = null; }
    const { lines, more } = stationImageProblems({ titles });
    const rows = lines.map(({ file, text }) => {
      const row = createElement('li');
      row.textContent = `${file}: ${text}`;
      return row;
    });
    if (more > 0) {
      const row = createElement('li');
      row.textContent = `and ${more} more`;
      rows.push(row);
    }
    if (rows.length === 0) {
      problems.replaceChildren();
      problems.hidden = true;
      return;
    }
    const heading = createElement('span');
    heading.textContent = 'Pictures to check:';
    const list = createElement('ul');
    list.replaceChildren(...rows);
    problems.replaceChildren(heading, list);
    problems.hidden = false;
  }

  if (rule) rule.textContent = STATION_IMAGES_NAME_RULE;
  const known = stationImagesSnapshot();
  if (known.folder) {
    showFolder(known.folder);
    showProblems();
  } else {
    path.textContent = 'Checking\u2026';
    void Promise.resolve().then(() => load()).then((data) => {
      if (isDisposed()) return;
      showFolder(data?.folder);
      showProblems();
    }).catch(() => {
      if (!isDisposed() && !stationImagesSnapshot().folder) path.textContent = 'Unavailable';
    });
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    show('Checking the folder\u2026', 'checking');
    try {
      const data = await load();
      if (isDisposed()) return;
      showFolder(data?.folder);
      show(stationImagesStatusText(data), data?.problem ? 'error' : 'ready');
      showProblems();
    } catch (error) {
      if (isDisposed()) return;
      show(`The folder could not be checked: ${failureReason(error, 'it is not available.')}`, 'error');
    } finally {
      refreshing = false;
      if (!isDisposed()) refreshButton.disabled = false;
    }
  }

  async function open() {
    openButton.disabled = true;
    try {
      const data = await openFolder();
      if (isDisposed()) return;
      showFolder(data?.path);
    } catch (error) {
      if (isDisposed()) return;
      show(`The folder could not be opened: ${failureReason(error, 'it is not available.')}`, 'error');
    } finally {
      if (!isDisposed()) openButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => { void refresh(); });
  openButton.addEventListener('click', () => { void open(); });
  return { refresh, open };
}
