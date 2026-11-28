import { computerFileFormat, computerFileKind, searchEntries } from '../lib/computer-catalog.js';
import { reportOfflineComputerFolder } from '../lib/computer-play.js';
import { mountComputerTable, SONG_COLUMNS } from './computer-table.js';
import { compareLocalFileStars } from '../lib/state.js';

const columns = [
  ...SONG_COLUMNS.filter(({ name }) => name !== 'Year' && name !== 'Format'),
  { name: 'Format', key: (entry) => [
    entry.missing ? entry.savedKind : computerFileKind(entry),
    entry.missing ? entry.savedFormat : computerFileFormat(entry),
  ].filter(Boolean).join(' \u00b7 ') },
  { name: 'Play', action: true },
];

export function mountComputerFavorites(host, { play, onMissing, currentId, technical, windowOptions, empty, onEmptyFocus, onOffline = reportOfflineComputerFolder }) {
  const doc = host.ownerDocument;
  const actions = doc.createElement('div');
  actions.className = 'computer-album-actions';
  let playable = [];
  let visible = [];
  let directory;
  let items;
  let folders;
  let folderAvailability;
  let missingFiles;
  let stars;
  let revision;
  let ordered = [];
  let resolved = [];
  let lastQuery;
  const missingEntries = new WeakMap();

  function button(text, action, primary = false) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = primary ? 'btn btn-primary' : 'btn';
    node.textContent = text;
    node.addEventListener('click', action);
    actions.append(node);
    return node;
  }

  const playAll = button('Play all', () => play(playable, 0), true);
  const shuffle = button('Shuffle', () => play(playable, Math.floor(Math.random() * playable.length), { shuffle: true }));
  host.append(actions);
  const table = mountComputerTable(host, {
    columns, layout: 'songs', label: 'Favorites', currentId, technical, windowOptions, onOffline,
    onPlay: (_index, entry) => entry.missing ? onMissing() : play(playable, playable.indexOf(entry)),
  });

  function entryFor(item) {
    const { id, artist, album, duration, format, kind } = item._extra.computer;
    const entry = directory.get(id);
    const available = entry?.folder ? folderAvailability.get(entry.folder) : true;
    const offline = available === false;
    if (entry && !missingFiles?.has(id) && available === true) return entry;
    const cached = missingEntries.get(item);
    if (cached && cached.revision === item.__revision && cached.indexEntry === entry && cached.entry.offline === offline) return cached.entry;
    const fallback = {
      id, title: item.title, artist, album, duration: entry ? entry.duration : duration, missing: true, offline,
      duration_estimated: entry?.duration_estimated,
      savedFormat: format, savedKind: kind || (item.type === 'video' ? 'Video' : ''),
    };
    missingEntries.set(item, { revision: item.__revision, indexEntry: entry, entry: fallback });
    return fallback;
  }

  return {
    ...table,
    update(favorites, snapshot, query, resetScroll, saved) {
      const changed = stars !== favorites || revision !== snapshot.revision || items !== snapshot.items
        || folders !== snapshot.folders || missingFiles !== snapshot.missingFiles;
      if (items !== snapshot.items) {
        items = snapshot.items;
        directory = new Map(items.map((entry) => [entry.id, entry]));
      }
      if (folders !== snapshot.folders) {
        folders = snapshot.folders;
        folderAvailability = new Map(folders.map((folder) => [folder.id, folder.available !== false]));
      }
      if (stars !== favorites) {
        stars = favorites;
        ordered = [...favorites].sort(compareLocalFileStars);
      }
      if (changed) {
        revision = snapshot.revision;
        missingFiles = snapshot.missingFiles;
        resolved = ordered.map(entryFor);
      }
      if (!changed && lastQuery === query) return;
      lastQuery = query;
      const next = searchEntries(resolved, query);
      if (next.length !== visible.length || next.some((entry, index) => entry !== visible[index])) {
        const lostLastRow = !next.length && table.viewport.contains(doc.activeElement);
        visible = next;
        playable = visible.filter((entry) => !entry.missing);
        table.update(visible, undefined, resetScroll ? 0 : saved?.top, saved?.key == null ? null : saved, [], true);
        if (lostLastRow) onEmptyFocus?.();
      }
      playAll.disabled = shuffle.disabled = !playable.length;
      table.viewport.hidden = !visible.length;
      this.empty = visible.length ? '' : empty('favorites');
    },
    destroy() { table.destroy(); actions.remove(); },
  };
}
