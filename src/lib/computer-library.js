import { clearMissingComputerArt } from './artwork.js';
import { prepareEntrySearch } from './computer-catalog.js';
import { moveComputerTrackPrefs } from './computer-track-prefs.js';
import { moveComputerResumeMarks } from './part-resume.js';
import { followComputerPlaybackMoves } from './player.js';
import { emit, getState, moveComputerStars } from './state.js';
import { hasTrackGain, sameLoudnessFile } from './computer-levelling.js';
import {
  cancelComputerScan, computerStatus, loadComputerLibrary, startComputerScan,
} from './computer-client.js';

const MOVE_LIMIT = 2_000;
const POLL_MS = 1_500;
const STATUS_UNKNOWN = 'Scan status is not available.';
const LIBRARY_INTERVAL_MS = 5_000;
const REBUILD_INTERVAL_MULTIPLIER = 20;

function equalFields(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalFields(a[key], b[key]));
}

function reuseEntries(previous, items, sameGeneration) {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  let changed = items.length !== previous.length;
  const next = items.map((entry, index) => {
    const old = byId.get(entry.id);
    const reused = old && ((sameGeneration && entry.revision != null && entry.revision === old.revision) || equalFields(old, entry)) ? old : entry;
    changed ||= reused !== previous[index];
    return reused;
  });
  return changed ? next : previous;
}

function applyDelta(previous, { items, removed }) {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  let changed = false;
  for (const id of removed || []) changed = byId.delete(id) || changed;
  for (const entry of items) {
    if (equalFields(byId.get(entry.id), entry)) continue;
    byId.set(entry.id, entry);
    changed = true;
  }
  return changed ? [...byId.values()] : previous;
}

function newFullMoves(previous, incoming) {
  // A full answer repeats the server's recent move history. Its prefix can
  // overlap the tail we've seen, including when the server trims its window.
  for (let count = Math.min(previous.length, incoming.length); count > 0; count--) {
    const start = previous.length - count;
    let index = 0;
    while (index < count && previous[start + index][0] === incoming[index][0]
        && previous[start + index][1] === incoming[index][1]) index++;
    if (index === count) return incoming.slice(count);
  }
  return incoming;
}

export function createComputerLibrary({
  computerStatus: readStatus = computerStatus,
  loadComputerLibrary: readLibrary = loadComputerLibrary,
  startComputerScan: startScan = startComputerScan,
  cancelComputerScan: cancelScan = cancelComputerScan,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  now = () => performance.now(),
} = {}) {
  let state = { generation: null, revision: null, items: [], folders: [], moved: [], missingFiles: new Set(), status: null, loaded: false, error: '' };
  const listeners = new Set();
  const errors = new Map();
  const pendingLoudness = new Map();
  let session = null;
  let preload = null;
  let firstScan = true;
  let scanRunning = false;
  let statusFailures = 0;
  let finishRefresh = null;
  let lastFetch = -Infinity;
  let lastRebuildMs = 0;

  function publish(update, moves = []) {
    if (update.items && update.items !== state.items) prepareEntrySearch(update.items);
    state = {
      ...state, ...update, error: errors.get('status') === STATUS_UNKNOWN
        ? STATUS_UNKNOWN : errors.values().next().value || '',
    };
    let starsChanged = false;
    if (moves.length) {
      moveComputerResumeMarks(moves);
      moveComputerTrackPrefs(moves);
      starsChanged = moveComputerStars(moves);
      followComputerPlaybackMoves(moves, new Map(state.items.map((entry) => [entry.id, entry])));
    }
    for (const listener of listeners) {
      try { listener(state); }
      catch (error) { console.error('Computer library listener failed:', error); }
    }
    if (starsChanged) emit('favorites-change', getState().favorites);
  }

  async function request(scope, kind, load, apply) {
    const { signal } = scope.controller;
    try {
      const data = await load({ signal });
      if (signal.aborted) return false;
      errors.delete(kind);
      apply(data);
      return true;
    } catch (error) {
      if (!signal.aborted) {
        const statusUnknown = kind === 'status' && scanRunning && ++statusFailures >= 3;
        errors.set(kind, statusUnknown ? STATUS_UNKNOWN : error?.message || 'The Computer library could not be updated.');
        publish(statusUnknown ? { status: null } : {});
      }
      return false;
    }
  }

  function missingAfterRefresh(items) {
    if (!state.missingFiles.size) return state.missingFiles;
    const stillMissing = new Set(state.missingFiles);
    for (const entry of items) stillMissing.delete(entry.id);
    return stillMissing.size === state.missingFiles.size ? state.missingFiles : stillMissing;
  }

  function withLoudness(entry, fromLibrary = false) {
    const pending = pendingLoudness.get(entry.id);
    if (!pending) return entry;
    if (!sameLoudnessFile(entry, pending.entry) || hasTrackGain(entry)) {
      if (fromLibrary) pendingLoudness.delete(entry.id);
      return entry;
    }
    return { ...entry, ...pending.fields };
  }

  function fetchLibrary(scope, full = false) {
    const final = finishRefresh;
    full ||= final !== null;
    const folderVersion = scope.folderVersion;
    const active = scope.library;
    if (active) {
      // A download started before the scan ended cannot be the final refresh.
      active.followUp ||= final !== null && final !== active.final;
      active.fullFollowUp ||= full && (!active.full || folderVersion !== active.folderVersion || active.followUp);
      return active.promise;
    }
    lastFetch = now();
    const baseRevision = full ? null : state.revision;
    const generation = state.generation;
    const statusGeneration = state.status?.generation;
    const job = { final, full: baseRevision == null, folderVersion };
    scope.library = job;
    job.promise = request(scope, 'library', (options) => readLibrary(baseRevision, { ...options, generation }), (data) => {
      if (scope.folderVersion !== folderVersion) return;
      const currentStatusGeneration = state.status?.generation;
      if (currentStatusGeneration != null && currentStatusGeneration !== statusGeneration
          && data.generation !== currentStatusGeneration) {
        job.fullFollowUp = true;
        return;
      }
      const sameGeneration = (data.generation ?? null) === state.generation;
      if (data.delta || data.unchanged) {
        if (baseRevision == null) throw new Error('The Computer library could not be updated.');
        if (!sameGeneration || baseRevision !== state.revision || job.fullFollowUp) {
          job.fullFollowUp = true;
          return;
        }
      }
      if (finishRefresh === final) finishRefresh = null;
      if (!sameGeneration || data.revision !== state.revision) clearMissingComputerArt();
      const started = now();
      let items = state.items;
      if (!data.unchanged) {
        for (const id of data.removed || []) pendingLoudness.delete(id);
        const incoming = pendingLoudness.size ? data.items.map((entry) => withLoudness(entry, true)) : data.items;
        items = data.delta ? applyDelta(items, { ...data, items: incoming })
          : reuseEntries(items, incoming, sameGeneration);
        if (!data.delta && pendingLoudness.size) {
          const ids = new Set(incoming.map(({ id }) => id));
          for (const id of pendingLoudness.keys()) {
            if (!ids.has(id)) pendingLoudness.delete(id);
          }
        }
      }
      const folders = data.folders == null || equalFields(state.folders, data.folders) ? state.folders : data.folders;
      const rebuilt = items !== state.items || folders !== state.folders;
      const history = sameGeneration ? state.moved : [];
      const incomingMoves = data.moved ?? [];
      const moves = data.delta ? incomingMoves : newFullMoves(history, incomingMoves);
      const moved = moves.length ? [...history, ...moves].slice(-MOVE_LIMIT) : history;
      publish({
        generation: data.generation ?? null, revision: data.revision, items, folders, moved,
        missingFiles: missingAfterRefresh(items), loaded: true,
      }, moves);
      if (rebuilt) lastRebuildMs = now() - started;
    }).finally(() => {
      scope.library = null;
      if (session === scope && (job.followUp || job.fullFollowUp)) {
        return fetchLibrary(scope, job.fullFollowUp);
      }
    });
    return job.promise;
  }

  function applyStatus(status) {
    if (scanRunning && !status.scanning) finishRefresh = {};
    scanRunning = status.scanning;
    statusFailures = 0;
    errors.delete('status');
    if (!status.scanning) errors.delete('cancel');
    publish({ status });
  }

  function schedule(scope) {
    if (session !== scope || !scanRunning) return;
    scope.timer = setTimer(() => {
      scope.timer = null;
      run(scope, 'poll');
    }, POLL_MS * 2 ** Math.min(3, Math.max(0, statusFailures - 1)));
  }

  async function updateStatus(scope, action) {
    const initialFetch = !state.loaded && (action === 'open' || action === 'retry')
      ? fetchLibrary(scope) : null;

    const starting = action === 'start' || (action === 'retry' && errors.has('start'))
      || (action === 'open' && firstScan);
    const cancelling = action === 'cancel' || (action === 'retry' && errors.has('cancel'));
    let ok;
    if (starting || cancelling) {
      if (!cancelling) {
        firstScan = false;
        scope.actions.delete('start');
      }
      let receivedStatus = false;
      ok = await request(scope, cancelling ? 'cancel' : 'start', cancelling ? cancelScan : startScan, (status) => {
        receivedStatus = typeof status?.scanning === 'boolean';
        if (receivedStatus) applyStatus(status);
      });
      if (ok && !receivedStatus && session === scope) ok = await request(scope, 'status', readStatus, applyStatus);
    } else ok = await request(scope, 'status', readStatus, applyStatus);
    return { ok, initialFetch };
  }

  async function updateLibrary(scope, action, { ok, initialFetch }) {
    const elapsed = now() - lastFetch >= Math.max(LIBRARY_INTERVAL_MS, REBUILD_INTERVAL_MULTIPLIER * lastRebuildMs);
    const due = elapsed || (action !== 'poll' && !state.status?.scanning);
    const changed = state.status?.revision != null && state.status.revision !== state.revision;
    const restarted = state.loaded && state.status?.generation != null && state.status.generation !== state.generation;
    const needed = ok && due && !initialFetch && (!state.loaded || changed || errors.has('library'));
    if (action === 'folders' || finishRefresh || restarted || needed) {
      await fetchLibrary(scope, action === 'folders' || restarted);
    } else await initialFetch;
  }

  function run(scope, action) {
    if (session !== scope) return;
    if (scope.statusPending) {
      if (action === 'folders' || ((action === 'cancel' || action === 'start') && action !== scope.action)) {
        scope.actions.add(action);
      }
      return scope.update;
    }
    if (scope.timer != null) {
      clearTimer(scope.timer);
      scope.timer = null;
    }
    scope.action = action;
    scope.statusPending = true;
    scope.update = Promise.resolve().then(() => {
      if (session === scope) return updateStatus(scope, action);
    }).then((result) => {
      scope.statusPending = false;
      if (session !== scope) return;
      // Keep polling and allow scan controls while the library is downloading.
      const next = scope.actions.values().next().value;
      if (next) {
        scope.actions.delete(next);
        run(scope, next);
      } else schedule(scope);
      return updateLibrary(scope, action, result);
    });
    return scope.update;
  }

  function act(action) {
    if (session) return run(session, action);
  }

  function newScope() {
    return { controller: new AbortController(), timer: null, library: null, folderVersion: 0, actions: new Set() };
  }

  return {
    getComputerLibrary: () => state,
    ensureComputerLibrary() {
      if (state.loaded) return;
      if (session) return fetchLibrary(session);
      if (preload) return preload.promise;
      // Library can read the snapshot without opening a scan session.
      const scope = preload = newScope();
      scope.promise = fetchLibrary(scope).finally(() => {
        if (preload === scope) preload = null;
      });
      return scope.promise;
    },
    subscribeComputerLibrary(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    openComputerLibrary() {
      if (session) return session.update;
      session = preload || newScope();
      preload = null;
      return act('open');
    },
    closeComputerLibrary() {
      if (!session) return;
      const scope = session;
      session = null;
      if (scope.timer != null) clearTimer(scope.timer);
      scope.controller.abort();
    },
    retry: () => act('retry'),
    refreshAvailability() {
      if (session && state.loaded) return fetchLibrary(session);
    },
    markFileMissing(id) {
      if (id && !state.missingFiles.has(id)) publish({ missingFiles: new Set([...state.missingFiles, id]) });
      if (session) void fetchLibrary(session);
    },
    acceptLoudness(entry, fields) {
      const index = state.items.findIndex((item) => item.id === entry.id);
      const row = state.items[index];
      if (row && (!sameLoudnessFile(row, entry) || hasTrackGain(row))) return;
      // A refresh already in flight can still carry the row from before the measurement.
      pendingLoudness.set(entry.id, { entry: row ?? entry, fields });
      if (row) publish({ items: state.items.with(index, { ...row, ...fields }) });
    },
    acceptPlayedEntry(id, entry) {
      if (entry) entry = withLoudness(entry);
      const missingFiles = new Set(state.missingFiles);
      missingFiles.delete(id);
      const index = entry ? state.items.findIndex((item) => item.id === id) : -1;
      const items = index < 0 || equalFields(state.items[index], entry)
        ? state.items : state.items.with(index, entry);
      if (items !== state.items || missingFiles.size !== state.missingFiles.size) publish({ items, missingFiles });
    },
    rescan: () => act('start'),
    cancel: () => act('cancel'),
    foldersChanged(folders) {
      if (!session) return;
      session.folderVersion++;
      publish({ folders });
      return act('folders');
    },
  };
}

export const computerLibrary = createComputerLibrary();
export const {
  getComputerLibrary, subscribeComputerLibrary, openComputerLibrary, closeComputerLibrary,
} = computerLibrary;
