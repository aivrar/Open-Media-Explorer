import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogCountSnapshot, ensureCatalogStore, evictResidentItems,
  mergeCatalogItems, replaceSourceSnapshot,
} from '../src/modes/library/catalog-store.js';
import { RESIDENT_ITEM_LIMIT } from '../src/modes/library/state.js';

function store() {
  return ensureCatalogStore({
    items: [], itemIndex: new Map(), finiteItemIds: new Set(), snapshotIdsBySource: new Map(),
    cumulativeCounts: new Map(), cumulativeTypeCounts: new Map(),
    cumulativeSourceTypeCounts: new Map(), sessionCounts: new Map(),
  });
}

function item(id, source = 'archive', type = 'audio', title = id) {
  return { id, source, type, title, thumbnail: '', content_rating: 'unrated' };
}

test('duplicate catalog ids update their existing object and query identity in place', () => {
  const target = store();
  const original = item('archive:one', 'archive', 'audio', 'Old title');
  assert.deepEqual(mergeCatalogItems(target, [original], { kind: 'finite' }), { added: 1, updated: 0 });
  const heldReference = target.itemIndex.get(original.id);
  const result = mergeCatalogItems(target, [{
    ...item('archive:one', 'archive', 'video', 'New title'), thumbnail: 'https://img.example/new.jpg',
  }], { kind: 'search', queryTag: 'new' });
  assert.deepEqual(result, { added: 0, updated: 1 });
  assert.equal(target.itemIndex.get(original.id), heldReference);
  assert.equal(heldReference.title, 'New title');
  assert.equal(heldReference.thumbnail, 'https://img.example/new.jpg');
  assert.deepEqual(heldReference.__queries, ['new']);
  assert.deepEqual(catalogCountSnapshot(target).byType, { video: 1 });
  assert.equal(target.sessionCounts.get('archive'), 1);

  for (let index = 0; index < 24; index++) {
    mergeCatalogItems(target, [item('archive:one', 'archive', 'video', `Query ${index}`)], {
      kind: 'search', queryTag: `query-${index}`,
    });
  }
  assert.equal(heldReference.__queries.length, 16);
  assert.equal(heldReference.__queries.at(-1), 'query-23');
  assert.equal(heldReference.__queries.includes('query-0'), false);
});

test('snapshot refresh preserves an opaque hydrated thumbnail only while canonical artwork is unchanged', () => {
  const target = store();
  const original = {
    ...item('media-ccc:live:event/room/native', 'media-ccc', 'tv'),
    thumbnail: '/api/v1/assets/opaque_asset_000000000001',
    _extra: { artworkUrl: 'https://static.media.ccc.de/event/room.jpg' },
  };
  mergeCatalogItems(target, [original], { kind: 'snapshot' });
  const held = target.itemIndex.get(original.id);

  mergeCatalogItems(target, [{
    ...item(original.id, 'media-ccc', 'tv'),
    thumbnail: '',
    _extra: { artworkUrl: 'https://static.media.ccc.de/event/room.jpg' },
  }], { kind: 'snapshot' });
  assert.equal(held.thumbnail, '/api/v1/assets/opaque_asset_000000000001');

  mergeCatalogItems(target, [{
    ...item(original.id, 'media-ccc', 'tv'),
    thumbnail: '',
    _extra: { artworkUrl: 'https://static.media.ccc.de/event/new-room.jpg' },
  }], { kind: 'snapshot' });
  assert.equal(held.thumbnail, '', 'changed canonical art must be rehydrated, not kept stale');
});

test('snapshot replacement is atomic, updates/removes entries, and retains an offline pinned identity', () => {
  const target = store();
  mergeCatalogItems(target, [item('live:also-finite', 'live', 'video')], { kind: 'finite' });
  replaceSourceSnapshot(target, 'live', [
    item('live:one', 'live', 'tv', 'One'),
    item('live:two', 'live', 'tv', 'Two'),
    item('live:also-finite', 'live', 'video', 'Finite and live'),
  ]);
  const held = target.itemIndex.get('live:two');
  const replaced = replaceSourceSnapshot(target, 'live', [
    item('live:two', 'live', 'tv', 'Two updated'),
    item('live:three', 'live', 'tv', 'Three'),
  ], { pinnedIds: new Set(['live:one']) });
  assert.equal(target.itemIndex.get('live:two'), held);
  assert.equal(held.title, 'Two updated');
  assert.deepEqual(replaced.removed, []);
  assert.deepEqual(replaced.retained, ['live:one']);
  assert.equal(target.itemIndex.get('live:one').__snapshotOffline, true);
  assert.ok(target.itemIndex.has('live:also-finite'), 'finite ownership survives snapshot removal');
  assert.deepEqual([...target.snapshotIdsBySource.get('live')], ['live:two', 'live:three', 'live:one']);

  const unpinned = replaceSourceSnapshot(target, 'live', [
    item('live:two', 'live', 'tv', 'Two updated again'),
    item('live:three', 'live', 'tv', 'Three'),
  ]);
  assert.deepEqual(unpinned.removed, ['live:one']);
  assert.equal(target.itemIndex.has('live:one'), false);
  assert.deepEqual([...target.snapshotIdsBySource.get('live')], ['live:two', 'live:three']);

  const beforeIds = [...target.snapshotIdsBySource.get('live')];
  const beforeItems = [...target.items];
  assert.throws(() => replaceSourceSnapshot(target, 'live', [
    item('wrong:source', 'wrong', 'tv'),
  ]), /Invalid live snapshot item/);
  assert.deepEqual([...target.snapshotIdsBySource.get('live')], beforeIds);
  assert.deepEqual(target.items, beforeItems);
});

test('production retention keeps more than 40,000 collected items and every source count', () => {
  const target = store();
  const total = 40_050;
  mergeCatalogItems(target, Array.from({ length: total }, (_, index) =>
    item(`source-${index % 2}:${index}`, `source-${index % 2}`, index % 2 ? 'video' : 'audio')),
  { kind: 'finite' });

  const evicted = evictResidentItems(target, { limit: RESIDENT_ITEM_LIMIT });
  const counts = catalogCountSnapshot(target);
  assert.deepEqual(evicted, []);
  assert.equal(counts.resident, total);
  assert.equal(counts.indexed, total);
  assert.deepEqual(counts.bySource, { 'source-0': 20_025, 'source-1': 20_025 });
});

test('resident eviction removes oldest unseen entries while preserving every pin and count/index invariant', () => {
  const target = store();
  mergeCatalogItems(target, Array.from({ length: 7 }, (_, index) =>
    item(`archive:${index}`, index < 5 ? 'archive' : 'second', index % 2 ? 'video' : 'audio')),
  { kind: 'finite' });
  mergeCatalogItems(target, [item('archive:2', 'archive', 'audio')], {
    kind: 'search', queryTag: 'needle',
  });
  replaceSourceSnapshot(target, 'live', [
    item('live:a', 'live', 'tv'), item('live:b', 'live', 'tv'),
  ]);

  const evicted = evictResidentItems(target, {
    limit: 5,
    pinnedIds: new Set(['archive:0']),
    visibleIds: new Set(['archive:1']),
    activeQuery: 'needle',
  });
  assert.deepEqual(new Set(target.itemIndex.keys()), new Set([
    'archive:0', 'archive:1', 'archive:2', 'live:a', 'live:b',
  ]));
  assert.equal(target.items.length, 5);
  assert.equal(target.itemIndex.size, 5);
  assert.equal(evicted.length, 4);
  const counts = catalogCountSnapshot(target);
  assert.equal(Object.values(counts.bySource).reduce((sum, count) => sum + count, 0), counts.resident);
  assert.equal(Object.values(counts.byType).reduce((sum, count) => sum + count, 0), counts.resident);
  assert.deepEqual(counts.bySource, { archive: 3, live: 2 });
  assert.deepEqual(counts.byType, { audio: 2, video: 1, tv: 2 });
  assert.deepEqual(counts.sessionBySource, { archive: 5, second: 2, live: 2 });
});

test('repeated eleven-source catalog churn stays bounded and preserves pins and count invariants', () => {
  const target = store();
  const sources = Array.from({ length: 11 }, (_, index) => `source-${index}`);
  const pinnedIds = new Set(['source-0:pinned', 'source-5:pinned', 'source-10:pinned']);
  mergeCatalogItems(target, [...pinnedIds].map((id) => {
    const source = id.split(':')[0];
    return item(id, source, 'audio');
  }), { kind: 'finite' });

  for (let cycle = 0; cycle < 120; cycle++) {
    const batch = Array.from({ length: 60 }, (_, index) => {
      const source = sources[(cycle + index) % sources.length];
      const type = ['audio', 'video', 'radio', 'tv'][index % 4];
      return item(`${source}:finite:${cycle}:${index}`, source, type);
    });
    mergeCatalogItems(target, batch, { kind: 'finite' });

    const snapshotSource = sources[cycle % sources.length];
    replaceSourceSnapshot(target, snapshotSource, Array.from({ length: 5 }, (_, index) =>
      item(`${snapshotSource}:live:${cycle}:${index}`, snapshotSource, index % 2 ? 'radio' : 'tv')),
    { pinnedIds });

    evictResidentItems(target, { limit: 600, pinnedIds });
    const counts = catalogCountSnapshot(target);
    assert.ok(counts.resident <= 600);
    assert.equal(counts.resident, counts.indexed);
    assert.equal(Object.values(counts.bySource).reduce((sum, count) => sum + count, 0), counts.resident);
    assert.equal(Object.values(counts.byType).reduce((sum, count) => sum + count, 0), counts.resident);
    for (const pinnedId of pinnedIds) assert.ok(target.itemIndex.has(pinnedId));
  }

  assert.equal(target.items.length, target.itemIndex.size);
  assert.ok(target.items.length <= 600);
  assert.equal(target.snapshotIdsBySource.size, 11);
});
