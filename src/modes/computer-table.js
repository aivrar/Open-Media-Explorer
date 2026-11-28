import { computerArtworkTile } from '../lib/artwork.js';
import {
  durationTooltip, entryDurationText, fileName, formatDetails, formatLabel, sizeText, videoQuality, videoTitle,
} from '../lib/computer-catalog.js';
import { COMPUTER_OFFLINE_TOOLTIP, reportOfflineComputerFolder } from '../lib/computer-play.js';
import { computerFileStar } from './computer-star.js';
import { mountComputerWindow } from './computer-window.js';

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 36;

const songTitle = (entry) => entry.title || fileName(entry);
const title = { name: 'Title', key: songTitle, wrap: true };
const artist = { name: 'Artist', key: (entry) => entry.artist, wrap: true };
const year = { name: 'Year', key: (entry) => entry.year, numeric: true };
const length = {
  name: 'Length', key: (entry) => entry.duration, numeric: true, text: entryDurationText, tooltip: durationTooltip,
};
const format = { name: 'Format', key: formatLabel, tooltip: formatDetails };

export const SONG_COLUMNS = [
  title, artist, { name: 'Album', key: (entry) => entry.album, wrap: true }, year, length, format,
];
export const VIDEO_COLUMNS = [
  { name: 'Title', key: videoTitle, wrap: true }, year, length,
  { name: 'Size', key: (entry) => entry.size, numeric: true, text: (entry) => sizeText(entry.size) },
  { name: 'Quality', key: (entry) => entry.height, numeric: true, text: videoQuality },
];

export function trackColumns(album) {
  return [
    { name: 'Track', key: (entry) => entry.track },
    title,
    ...(album.showTrackArtist ? [{ ...artist, key: (entry) => entry.artist === album.artist ? '' : entry.artist, empty: '' }] : []),
    ...(album.format === 'Mixed' ? [format] : []),
    length,
  ];
}

export function mountComputerTable(host, {
  columns, label, layout, onSort, onPlay, currentId, technical, windowOptions, structured = layout === 'tracks',
  favoritable = layout !== 'chapters' && layout !== 'genres', rowFor, inlineHeader = false, offline, onOffline = reportOfflineComputerFolder,
}) {
  const doc = host.ownerDocument;
  const viewport = doc.createElement('div');
  viewport.className = `computer-viewport computer-table-scroll${inlineHeader ? ' computer-folder-table-scroll' : ''}`;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', label);
  const table = doc.createElement('table');
  table.className = `computer-table computer-table-${layout}`;
  table.setAttribute('aria-label', label);
  const thead = doc.createElement('thead');
  const header = doc.createElement('tr');
  header.setAttribute('aria-rowindex', '1');
  const columnCount = columns.length + Number(favoritable);
  const entryTitle = columns.find((column) => column.name === 'Title')?.key || songTitle;
  if (favoritable) {
    const th = doc.createElement('th');
    th.className = 'computer-star-column';
    th.setAttribute('scope', 'col');
    th.setAttribute('aria-label', 'Favorite');
    header.append(th);
  }
  const headers = columns.map((column, index) => {
    const th = doc.createElement('th');
    th.setAttribute('scope', 'col');
    th.dataset.column = column.name.toLowerCase();
    if (onSort) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = column.name;
      button.addEventListener('click', () => onSort(index));
      th.append(button);
    } else th.textContent = column.name;
    header.append(th);
    return th;
  });
  if (inlineHeader) {
    header.className = 'computer-inline-header';
    const widths = doc.createElement('colgroup');
    for (const th of header.children) {
      const col = doc.createElement('col');
      col.className = th.className;
      if (th.dataset.column) col.dataset.column = th.dataset.column;
      widths.append(col);
    }
    table.append(widths);
  } else {
    thead.append(header);
    table.append(thead);
  }

  function spacer() {
    const row = doc.createElement('tr');
    row.className = 'computer-spacer';
    row.setAttribute('aria-hidden', 'true');
    const cell = doc.createElement('td');
    cell.colSpan = columnCount;
    row.append(cell);
    return { row, cell };
  }

  const body = doc.createElement('tbody');
  const top = spacer();
  const bottom = spacer();
  body.append(top.row, bottom.row);
  table.append(body);
  viewport.append(table);
  host.append(viewport);
  let data = [];
  let leading = [];
  function rowAt(index) {
    if (index < leading.length) return leading[index];
    const offset = index - leading.length;
    if (rowFor) return rowFor(data[offset], offset);
    return structured ? data[offset] : { entry: data[offset], index: offset };
  }

  function mark(row, entry) {
    const playing = currentId() === `computer:${entry.id}`;
    row.classList.toggle('is-playing', playing);
    if (playing) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }

  function buildFileRow(item) {
    const node = doc.createElement('tr');
    const star = favoritable ? computerFileStar(node, item.favoriteEntry || item.entry, entryTitle(item.entry)) : null;
    if (star) {
      const cell = doc.createElement('td');
      cell.className = 'computer-star-column';
      cell.append(star.button);
      node.append(cell);
    }
    let action;
    const cells = columns.map((column) => {
      const cell = doc.createElement('td');
      node.append(cell);
      if (column.action) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn computer-row-play';
        button.textContent = 'Play';
        button.tabIndex = -1;
        button.addEventListener('click', () => action());
        cell.append(button);
        return { cell, button };
      }
      if (!column.wrap) return { cell };
      const label = doc.createElement('span');
      label.className = 'computer-cell-wrap';
      cell.append(label);
      return { cell, label };
    });

    let openOnClick;
    node.addEventListener('click', () => { if (openOnClick) action(); });
    node.addEventListener('dblclick', (event) => {
      if (!openOnClick && event.target.tagName !== 'BUTTON') action();
    });
    node.addEventListener('keydown', (event) => {
      if (event.target !== node || event.key !== 'Enter' || event.repeat) return;
      event.preventDefault();
      action();
    });
    return {
      node, star: star?.button, syncStar: star?.sync,
      bind(item, index) {
        const { entry } = item;
        const disconnected = entry.offline || offline?.(entry);
        const error = disconnected ? COMPUTER_OFFLINE_TOOLTIP : entry.missing ? 'Not found' : entry.error;
        action = disconnected ? onOffline : item.action || (() => onPlay(item.index, entry));
        openOnClick = item.openOnClick;
        this.key = item.key ?? entry.id;
        this.entry = item.markPlaying === false ? null : entry;
        node.classList.toggle('has-error', Boolean(error));
        node.title = error || '';
        if (this.entry) mark(node, entry);
        else {
          node.classList.remove('is-playing');
          node.removeAttribute('aria-current');
        }
        this.reindex = (next) => node.setAttribute('aria-rowindex', next + (inlineHeader ? 1 : 2));
        this.reindex(index);
        star?.update(item.favoriteEntry || entry, entryTitle(entry));
        columns.forEach((column, columnIndex) => {
          const { cell, button, label } = cells[columnIndex];
          if (button) {
            button.setAttribute('aria-label', `Play ${entryTitle(entry) || videoTitle(entry)}`);
            button.title = disconnected ? error : '';
            return;
          }
          const value = column.text ? column.text(entry, technical()) : column.key(entry);
          const text = String(value ?? (column.empty ?? '\u2014')) || (column.empty ?? '\u2014');
          if (!label) {
            cell.textContent = text;
            const tooltip = column.tooltip?.(entry) || value;
            cell.title = disconnected ? error : tooltip ? String(tooltip) : '';
            return;
          }
          label.textContent = text;
          label.title = disconnected ? error : text;
          if (column.name === 'Title' && (entry.missing || entry.error)) {
            const title = doc.createElement('span');
            if (entry.missing) {
              title.className = 'computer-missing-title';
              const status = doc.createElement('span');
              status.className = 'computer-quiet';
              status.textContent = disconnected ? 'Not connected' : 'Not found';
              status.title = error;
              title.append(label, status);
            } else {
              title.className = 'computer-error-title';
              title.append(computerArtworkTile(doc, text || videoTitle(entry)), label);
            }
            cell.replaceChildren(title);
          } else if (label.parentElement !== cell) cell.replaceChildren(label);
        });
      },
    };
  }

  function buildFolderRow() {
    const node = doc.createElement('tr');
    node.className = 'computer-directory-row';
    const cell = doc.createElement('td');
    cell.colSpan = columnCount;
    const name = doc.createElement('span');
    name.className = 'computer-directory-name';
    const icon = doc.createElement('span');
    icon.className = 'computer-folder-mark';
    icon.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'computer-cell-wrap';
    const facts = doc.createElement('span');
    facts.className = 'computer-quiet';
    name.append(icon, title, facts);
    cell.append(name);
    node.append(cell);

    let action;
    let disconnected;
    node.addEventListener('click', () => action());
    node.addEventListener('dblclick', () => { if (disconnected) onOffline(); });
    node.addEventListener('keydown', (event) => {
      if (event.target !== node || event.key !== 'Enter' || event.repeat) return;
      event.preventDefault();
      action();
    });
    return {
      node,
      bind(item) {
        const { folder } = item;
        disconnected = folder.offline;
        action = item.action;
        this.key = item.key;
        const error = disconnected ? COMPUTER_OFFLINE_TOOLTIP : folder.error;
        node.classList.toggle('has-error', Boolean(error));
        node.title = error || folder.path;
        title.textContent = folder.title;
        title.title = disconnected ? error : folder.title;
        facts.textContent = item.facts;
      },
    };
  }

  const windowed = mountComputerWindow(viewport, body, {
    ...windowOptions,
    stride: ROW_HEIGHT,
    headerHeight: inlineHeader ? 0 : HEADER_HEIGHT,
    endMarker: bottom.row,
    canFocus: (index) => !rowAt(index).heading && !rowAt(index).header,
    indexOfKey(key) {
      const before = leading.findIndex((item) => item.key === key);
      if (before >= 0) return before;
      const index = data.findIndex((item) => (structured ? item.key ?? item.entry?.id : item.key ?? item.id) === key);
      return index < 0 ? index : index + leading.length;
    },
    placeWindow({ start, end, total, step }) {
      top.cell.style.height = `${start * step}px`;
      bottom.cell.style.height = `${total - end * step}px`;
    },
    rowKind(index) {
      const item = rowAt(index);
      if (item.header) return;
      return item.entry ? 'file' : item.heading ? 'heading' : 'folder';
    },
    makeRow(index, recycled) {
      const item = rowAt(index);
      if (item.entry) {
        const row = recycled || buildFileRow(item);
        row.bind(item, index);
        return row;
      }
      if (item.header) {
        header.setAttribute('aria-rowindex', index + 1);
        return { node: header, focusable: false };
      }
      if (item.heading) {
        const node = recycled?.node || doc.createElement('tr');
        if (!recycled) {
          node.className = 'computer-disc';
          const cell = doc.createElement('th');
          cell.colSpan = columnCount;
          node.append(cell);
        }
        node.setAttribute('aria-rowindex', index + (inlineHeader ? 1 : 2));
        node.children[0].textContent = item.heading;
        return recycled || { node, focusable: false };
      }
      const row = recycled || buildFolderRow();
      row.node.setAttribute('aria-rowindex', index + (inlineHeader ? 1 : 2));
      row.bind(item);
      return row;
    },
  });

  return {
    viewport,
    focusedRow: windowed.focusedRow,
    focus: windowed.focus,
    update(next, sort, scrollTop, restoreFocus, before = [], reuse = false) {
      data = next;
      leading = inlineHeader && data.length ? [...before, { header: true }] : before;
      table.setAttribute('aria-rowcount', data.length + leading.length + Number(!inlineHeader));
      if (sort) {
        headers.forEach((th, index) => {
          if (sort.column === index) th.setAttribute('aria-sort', sort.descending ? 'descending' : 'ascending');
          else th.removeAttribute('aria-sort');
        });
      }
      const indices = reuse && new Map(next.map((entry, index) => [entry, index]));
      windowed.update(data.length + leading.length, scrollTop, restoreFocus, indices ? (row) => indices.get(row.entry) : undefined);
    },
    markFavorites() { windowed.forEachRow(({ syncStar }) => syncStar?.()); },
    markPlaying() {
      windowed.forEachRow(({ node, entry }) => { if (entry) mark(node, entry); });
    },
    destroy() { windowed.destroy(); viewport.remove(); },
  };
}
