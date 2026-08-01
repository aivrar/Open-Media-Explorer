/** Pure catalog-pool mutation helpers used by Library and deterministic tests. */

export const DEFAULT_RESIDENT_ITEM_LIMIT = 6_000;
export const MAX_QUERY_TAGS_PER_ITEM = 16;

function mapIncrement(map, key, amount) {
  if (!key) return;
  const next = (map.get(key) || 0) + amount;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function adjustResidentCounts(store, item, amount) {
  mapIncrement(store.cumulativeCounts, item.source, amount);
  if (!item.type) return;
  mapIncrement(store.cumulativeTypeCounts, item.type, amount);
  let sourceTypes = store.cumulativeSourceTypeCounts.get(item.source);
  if (!sourceTypes && amount > 0) {
    sourceTypes = new Map();
    store.cumulativeSourceTypeCounts.set(item.source, sourceTypes);
  }
  if (sourceTypes) {
    mapIncrement(sourceTypes, item.type, amount);
    if (sourceTypes.size === 0) store.cumulativeSourceTypeCounts.delete(item.source);
  }
}

export function ensureCatalogStore(store) {
  store.items ||= [];
  store.itemIndex ||= new Map();
  store.finiteItemIds ||= new Set();
  store.snapshotIdsBySource ||= new Map();
  store.cumulativeCounts ||= new Map();
  store.cumulativeTypeCounts ||= new Map();
  store.cumulativeSourceTypeCounts ||= new Map();
  store.sessionCounts ||= new Map();
  return store;
}

function queryTags(item) {
  return new Set(item.__queries || (item.__query ? [item.__query] : []));
}

/**
 * Add or update normalized items. Existing objects are mutated in place so
 * player/detail/card references observe refreshed title, art, and online data.
 */
export function mergeCatalogItems(store, items, options = {}) {
  ensureCatalogStore(store);
  const currentQuery = String(options.queryTag || '').trim();
  const kind = options.kind || 'finite';
  let added = 0;
  let updated = 0;

  for (const incoming of items || []) {
    if (!incoming || typeof incoming !== 'object' || !incoming.id) continue;
    const existing = store.itemIndex.get(incoming.id);
    if (existing) {
      const oldSource = existing.source;
      const oldType = existing.type;
      const tags = queryTags(existing);
      if (currentQuery) {
        tags.delete(currentQuery);
        tags.add(currentQuery);
      }
      const recentTags = [...tags].slice(-MAX_QUERY_TAGS_PER_ITEM);
      const preserved = {
        __query: currentQuery || existing.__query || '',
        __queries: recentTags,
        __snapshotOffline: false,
        __revision: (Number(existing.__revision) || 0) + 1,
      };
      const existingArtwork = typeof existing._extra?.artworkUrl === 'string'
        ? existing._extra.artworkUrl
        : '';
      const incomingArtwork = typeof incoming._extra?.artworkUrl === 'string'
        ? incoming._extra.artworkUrl
        : '';
      const sameCanonicalArtwork = existingArtwork && existingArtwork === incomingArtwork;
      const refreshed = sameCanonicalArtwork && existing.thumbnail && !incoming.thumbnail
        ? { ...incoming, thumbnail: existing.thumbnail }
        : incoming;
      Object.assign(existing, refreshed, preserved);
      if (oldSource !== existing.source || oldType !== existing.type) {
        adjustResidentCounts(store, { source: oldSource, type: oldType }, -1);
        adjustResidentCounts(store, existing, 1);
      }
      updated += 1;
    } else {
      incoming.__query = currentQuery;
      incoming.__queries = currentQuery ? [currentQuery] : [];
      incoming.__snapshotOffline = false;
      incoming.__revision = 0;
      store.itemIndex.set(incoming.id, incoming);
      store.items.push(incoming);
      adjustResidentCounts(store, incoming, 1);
      mapIncrement(store.sessionCounts, incoming.source, 1);
      added += 1;
    }
    if (kind === 'finite') store.finiteItemIds.add(incoming.id);
  }
  return { added, updated };
}

export function removeResidentItem(store, itemId) {
  ensureCatalogStore(store);
  const item = store.itemIndex.get(itemId);
  if (!item) return null;
  store.itemIndex.delete(itemId);
  store.finiteItemIds.delete(itemId);
  const index = store.items.indexOf(item);
  if (index >= 0) store.items.splice(index, 1);
  adjustResidentCounts(store, item, -1);
  for (const [sourceId, ids] of store.snapshotIdsBySource) {
    ids.delete(itemId);
    if (ids.size === 0) store.snapshotIdsBySource.delete(sourceId);
  }
  return item;
}

/** Remove one disabled source's transient catalog pool without touching the
 * separately persisted favorites collection or favorite EQ map. */
export function removeSourceItems(store, sourceId) {
  ensureCatalogStore(store);
  const removed = [];
  for (const item of [...store.items]) {
    if (item?.source === sourceId && removeResidentItem(store, item.id)) removed.push(item.id);
  }
  store.snapshotIdsBySource.delete(sourceId);
  store.sessionCounts.delete(sourceId);
  return removed;
}

/**
 * Atomically replace one source's live snapshot. Invalid payloads throw before
 * any store mutation. Offline pinned items remain addressable but are hidden
 * from the normal pool; favorites themselves live in persistent app state.
 */
export function replaceSourceSnapshot(store, sourceId, items, options = {}) {
  ensureCatalogStore(store);
  if (!sourceId || typeof sourceId !== 'string') throw new TypeError('Snapshot requires a source id');
  if (!Array.isArray(items)) throw new TypeError('Snapshot items must be an array');
  const validated = [];
  const nextIds = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !item.id || item.source !== sourceId) {
      throw new TypeError(`Invalid ${sourceId} snapshot item`);
    }
    if (nextIds.has(item.id)) throw new TypeError(`Duplicate ${sourceId} snapshot id ${item.id}`);
    nextIds.add(item.id);
    validated.push(item);
  }
  const liveIds = new Set(nextIds);

  const previousIds = new Set(store.snapshotIdsBySource.get(sourceId) || []);
  const pinnedIds = options.pinnedIds instanceof Set ? options.pinnedIds : new Set(options.pinnedIds || []);
  const merge = mergeCatalogItems(store, validated, { kind: 'snapshot' });
  store.snapshotIdsBySource.set(sourceId, nextIds);

  const removed = [];
  const retained = [];
  for (const itemId of previousIds) {
    if (nextIds.has(itemId) || store.finiteItemIds.has(itemId)) continue;
    const item = store.itemIndex.get(itemId);
    if (!item) continue;
    if (pinnedIds.has(itemId)) {
      item.__snapshotOffline = true;
      // Keep ownership until a later refresh can reconsider this identity
      // after current/detail/favorite pins change.
      nextIds.add(itemId);
      retained.push(itemId);
    } else if (removeResidentItem(store, itemId)) {
      removed.push(itemId);
    }
  }
  for (const itemId of liveIds) {
    const item = store.itemIndex.get(itemId);
    if (item) item.__snapshotOffline = false;
  }
  return { ...merge, removed, retained, ids: nextIds };
}

function belongsToActiveSnapshot(store, itemId) {
  for (const ids of store.snapshotIdsBySource.values()) {
    if (ids.has(itemId)) return true;
  }
  return false;
}

export function evictResidentItems(store, options = {}) {
  ensureCatalogStore(store);
  const limit = Math.max(1, Number(options.limit) || DEFAULT_RESIDENT_ITEM_LIMIT);
  if (store.items.length <= limit) return [];
  const pinned = options.pinnedIds instanceof Set ? options.pinnedIds : new Set(options.pinnedIds || []);
  const visible = options.visibleIds instanceof Set ? options.visibleIds : new Set(options.visibleIds || []);
  const activeQuery = String(options.activeQuery || '').trim();
  const evicted = [];

  // Oldest entries are first in the array. Re-scan after each splice so index
  // and count changes remain simple and deterministic at the 6,000-item cap.
  for (let index = 0; store.items.length > limit && index < store.items.length;) {
    const item = store.items[index];
    const tags = queryTags(item);
    const protectedItem = pinned.has(item.id)
      || visible.has(item.id)
      || belongsToActiveSnapshot(store, item.id)
      || (activeQuery && tags.has(activeQuery));
    if (protectedItem) {
      index += 1;
      continue;
    }
    if (removeResidentItem(store, item.id)) evicted.push(item.id);
    else index += 1;
  }
  return evicted;
}

export function catalogCountSnapshot(store) {
  ensureCatalogStore(store);
  return {
    resident: store.items.length,
    indexed: store.itemIndex.size,
    bySource: Object.fromEntries(store.cumulativeCounts),
    byType: Object.fromEntries(store.cumulativeTypeCounts),
    sessionBySource: Object.fromEntries(store.sessionCounts),
  };
}
