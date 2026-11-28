import { computerFileSubtitle, computerMoveDestinations, rankedComputerEntries } from '../../lib/computer-catalog.js';
import { getComputerLibrary } from '../../lib/computer-library.js';
import { makeComputerItem, playComputerEntries, reportMissingComputerFile, reportOfflineComputerFolder } from '../../lib/computer-play.js';
import { isComputerItem } from '../../lib/item-model.js';
import { playItem } from '../../lib/player.js';
import { filterItems } from './filter.js';
import { isPersonalSource } from './personal.js';
import { view } from './state.js';

const EMPTY = [];
const LIMIT = 200;
const entriesById = new WeakMap();
const foldersById = new WeakMap();

function indexFor(cache, list) {
  if (!cache.has(list)) cache.set(list, new Map(list.map((entry) => [entry.id, entry])));
  return cache.get(list);
}

function approvedFolders(snapshot) {
  return indexFor(foldersById, snapshot.folders);
}

function fileAvailable(entry, folders, missing) {
  return entry && !missing.has(entry.id) && (!entry.folder
    || (folders.has(entry.folder) && folders.get(entry.folder).available !== false));
}

/** Read the live row and distinguish an unknown catalog from a known missing file. */
export function computerFileState(item, snapshot = getComputerLibrary()) {
  const id = item._extra?.computer?.id || item.id.slice('computer:'.length);
  const entry = indexFor(entriesById, snapshot.items).get(id);
  const folders = approvedFolders(snapshot);
  const offline = Boolean(entry?.folder && folders.get(entry.folder)?.available === false);
  const available = fileAvailable(entry, folders, snapshot.missingFiles);
  return {
    entry: available ? entry : null,
    offline,
    missing: !offline && (snapshot.missingFiles.has(id) || (snapshot.loaded && !available)),
  };
}

function subtitleForEntry(entry, folders) {
  return computerFileSubtitle(entry) || (entry.kind === 'video' && folders.get(entry.folder)
    ?.path?.split(/[\\/]/u).filter(Boolean).at(-1)) || '';
}

export function movedComputerDetail(itemId, snapshot = getComputerLibrary()) {
  if (!snapshot.moved?.length || !itemId?.startsWith('computer:')) return null;
  const id = itemId.slice('computer:'.length);
  const entries = indexFor(entriesById, snapshot.items);
  if (entries.has(id)) return null;
  const entry = entries.get(computerMoveDestinations(snapshot.moved).get(id));
  return entry ? makeComputerItem(entry) : null;
}

export function computerCardSubtitle(item) {
  if (item.__computerOffline) return 'Not connected';
  if (item.__computerMissing) return 'Not found';
  const { artist, album } = item._extra?.computer || {};
  return item.__computerSubtitle || [artist, album].filter(Boolean).join(' - ');
}

/** Old stars have no saved cover flag. Resolve it against the shared snapshot. */
export function computerItemForView(item, snapshot = getComputerLibrary()) {
  const { entry, missing, offline } = computerFileState(item, snapshot);
  if (!entry && !missing && !offline) return item;
  const computer = item._extra?.computer;
  return {
    ...item,
    __computerMissing: missing,
    __computerOffline: offline,
    __computerSubtitle: entry ? subtitleForEntry(entry, approvedFolders(snapshot)) : '',
    _extra: { ...item._extra, computer: {
      ...computer,
      hasCover: entry ? Boolean(entry.art || entry.has_cover) : computer?.hasCover,
      unreadable: missing || offline || Boolean(entry?.error),
    } },
  };
}

/** One bounded result per query and catalog revision, outside the provider pool. */
export function createComputerSearch(find = rankedComputerEntries) {
  const cache = new WeakMap();
  return (queryText, snapshot) => {
    const query = queryText.trim();
    const { items, folders, missingFiles, generation, revision, loaded } = snapshot;
    if (!query || !loaded || !folders.length || !items.length) return EMPTY;
    const previous = cache.get(items);
    if (query === previous?.query && revision === previous.revision && generation === previous.generation
        && folders === previous.folders && missingFiles === previous.missingFiles) return previous.hits;

    const approved = approvedFolders(snapshot);
    const entries = find(items, query, LIMIT, (entry) => fileAvailable(entry, approved, missingFiles));
    const hits = entries.length ? entries.map((entry) => Object.assign(makeComputerItem(entry), {
      __query: query, __computerSubtitle: subtitleForEntry(entry, approved),
    })) : EMPTY;
    cache.set(items, { query, revision, generation, folders, missingFiles, hits });
    return hits;
  };
}

const search = createComputerSearch();

export function updateComputerHits(snapshot = getComputerLibrary(), findHits = search) {
  const hits = findHits(view.query || '', snapshot);
  if (hits === view.computerHits) return false;
  view.computerHits = hits;
  return true;
}

export function isMissingComputerItem(item) {
  if (!isComputerItem(item)) return false;
  const { missing, offline } = computerFileState(item);
  return missing || offline;
}

/** Walk the filtered view from the current row, wrapping once. */
export function nextPlayableLibraryItem(items, currentId) {
  const start = items.findIndex((item) => item.id === currentId);
  for (let offset = 1; offset <= items.length; offset++) {
    const item = items[(start + offset) % items.length];
    if (item.__contentHidden !== true && !isMissingComputerItem(item)) return item;
  }
}

export async function playLibraryItem(item) {
  if (!isComputerItem(item)) return playItem(item);
  const { entry, missing, offline } = computerFileState(item);
  if (offline) {
    reportOfflineComputerFolder();
    return;
  }
  if (missing) {
    reportMissingComputerFile();
    return;
  }
  if (!isPersonalSource() && entry) {
    const entries = filterItems(view.computerHits)
      .map((hit) => computerFileState(hit).entry).filter(Boolean);
    const index = entries.indexOf(entry);
    if (index >= 0) return playComputerEntries(entries, index);
  }
  if (entry) return playComputerEntries([entry], 0);
  return playItem(item);
}
