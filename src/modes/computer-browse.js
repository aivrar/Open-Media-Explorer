import {
  audioLayout, durationText, durationTooltip, entrySearch, episodeCode, episodeTitle, fileName, movieBadges,
  movieCodec, movieCodecs, movieResolution, pluralCount, sizeText, totalLengthText,
} from '../lib/computer-catalog.js';
import { mountAlbumGrid, mountComputerCards, computerCover } from './computer-albums.js';
import { normalizeChapters } from './computer-chapters.js';
import { mountComputerTable, SONG_COLUMNS, VIDEO_COLUMNS } from './computer-table.js';
import { computerFileStar, computerGroupStar } from './computer-star.js';

const facts = (...parts) => parts.filter(Boolean).join(' · ');
const songs = (count) => pluralCount(count, 'song');
const actionColumn = { name: 'Play', action: true };

function element(doc, tag, className = '', text = '') {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(doc, text, action, primary = false) {
  const node = element(doc, 'button', primary ? 'btn btn-primary' : 'btn', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function titled(node, title, error) {
  node.title = title;
  if (error) node.classList.add('has-error');
  return node;
}

function detailPage(host, item, onBack) {
  const doc = host.ownerDocument;
  const page = element(doc, 'section', 'computer-album-page');
  page.setAttribute('aria-label', item.title);
  if (item.error) page.title = item.error;
  const header = element(doc, 'div', 'computer-detail-header');
  const back = button(doc, 'Back', onBack);
  header.append(back);
  page.append(header);
  host.append(page);
  return { page, header, back, focus: () => back.focus() };
}

function remember(list, item, index, part) {
  return { key: item.key, index, top: list.position?.() ?? list.viewport.scrollTop, part };
}

function update(list, rows, saved, { part, table = false, leading } = {}) {
  const location = saved?.part === part ? saved : null;
  const restore = location?.key != null ? location : null;
  if (table) list.update(rows, undefined, location?.top, restore, leading);
  else list.update(rows, location?.top, restore);
}

export function mountGroupCards(host, type, entries, { open, loadImage, windowOptions, saved, empty }) {
  const [label, detail, describe, poster] = {
    artists: ['Artists', 'artist', (item) => ({
      facts: facts(pluralCount(item.albums.length, 'album'), songs(item.entries.length)),
    })],
    shows: ['Shows', 'show', (item) => ({
      facts: facts(pluralCount(item.seasons.size, 'season'), pluralCount(item.entries.length, 'episode')),
    }), true],
    audiobooks: ['Audiobooks', 'book', (item) => ({
      subtitle: item.author, facts: totalLengthText(item), factsTooltip: durationTooltip(item),
    })],
  }[type];
  const cards = mountComputerCards(host, {
    label, describe, poster, width: poster ? 144 : undefined, height: poster ? 290 : undefined,
    onOpen: (item, index) => open(detail, item.key, remember(cards, item, index)),
    loadImage, windowOptions,
    fileEntry: type === 'audiobooks' ? (book) => book.entries.length === 1 ? book.entries[0] : null : undefined,
  });
  update(cards, entries, saved);
  return { ...cards, empty: entries.length ? '' : empty(label.toLowerCase()) };
}

export function mountGenres(host, entries, { open, currentId, technical, windowOptions, saved, empty }) {
  const table = mountComputerTable(host, {
    columns: [
      { name: 'Genre', key: (entry) => entry.title, wrap: true },
      { name: 'Songs', key: (entry) => songs(entry.entries.length) },
    ],
    label: 'Genres', layout: 'genres', currentId, technical, windowOptions,
    rowFor: (item, index) => ({
      key: item.key, entry: item, markPlaying: false, openOnClick: true,
      action: () => open('genre', item.key, remember(table, item, index)),
    }),
  });
  update(table, entries, saved, { table: true });
  return { ...table, empty: entries.length ? '' : empty('genres') };
}

export function mountMusicCollection(host, item, albums, {
  type, onBack, open, play, loadImage, currentId, technical, windowOptions, saved, query, empty, offline, onOffline,
}) {
  const doc = host.ownerDocument;
  const { page, header, focus } = detailPage(host, item, onBack);
  const title = titled(element(doc, 'h2', 'computer-detail-title', item.title), item.title, item.error);
  header.append(title);
  const allSongs = item.songs;
  let star;
  if (type === 'artist') {
    star = computerGroupStar(doc, allSongs, 'artist');
    page.classList.add('computer-artist-page');
    header.append(
      button(doc, 'Play all', () => play(allSongs, 0), true),
      button(doc, 'Shuffle', () => play(allSongs, Math.floor(Math.random() * allSongs.length), { shuffle: true })),
      star.button,
    );
  }

  const artist = type === 'artist';
  const compact = artist ? windowOptions?.win?.matchMedia?.('(height < 760px)') : undefined;
  let entries = allSongs;
  let table;
  const albumForTrack = new Map();
  if (type === 'artist') {
    for (const album of albums) {
      for (const track of album.tracks) albumForTrack.set(track, album);
    }
  }
  const grid = mountAlbumGrid(page, {
    loadImage, windowOptions, artist, compact,
    onOpen: (album, index) => open('album', album.key, {
      ...remember(grid, album, index, 'albums'), songsTop: table?.viewport.scrollTop,
    }),
  });

  if (type === 'artist') {
    table = mountComputerTable(page, {
      columns: SONG_COLUMNS, layout: 'songs', label: 'Artist songs', currentId, technical, windowOptions, offline, onOffline,
      onPlay: (index) => play(entries, index),
    });
  }
  const screen = {
    focus,
    updateQuery(text, location) {
      const matches = entrySearch(text);
      let visibleAlbums = albums;
      if (table) {
        const withMatches = new Set();
        entries = matches ? allSongs.filter((entry) => {
          if (!matches(entry)) return false;
          withMatches.add(albumForTrack.get(entry));
          return true;
        }) : allSongs;
        if (matches) visibleAlbums = albums.filter((album) => withMatches.has(album));
      } else if (matches) visibleAlbums = albums.filter((album) => album.tracks.some(matches));
      grid.viewport.hidden = !visibleAlbums.length;
      update(grid, visibleAlbums, {
        top: location?.albumsTop ?? location?.top, part: 'albums',
        ...(location?.part === 'albums' && location),
      }, { part: 'albums' });
      if (table) {
        // Size the albums first so the songs viewport has its final height.
        table.viewport.hidden = !entries.length;
        update(table, entries, {
          top: location?.songsTop ?? location?.top, part: 'songs',
          ...(location?.part === 'songs' && location),
        }, { part: 'songs', table: true });
      }
      screen.empty = visibleAlbums.length ? '' : empty(type === 'artist' ? 'songs' : 'albums');
    },
    location() {
      const positions = { albumsTop: grid.position(), songsTop: table?.viewport.scrollTop };
      const row = grid.focusedRow();
      if (row) return { ...positions, ...row, part: 'albums' };
      const song = table?.focusedRow();
      return song ? { ...positions, ...song, part: 'songs' } : positions;
    },
    markPlaying: table?.markPlaying,
    markFavorites() { star?.sync(); table?.markFavorites(); },
    destroy() { grid.destroy(); table?.destroy(); page.remove(); },
  };
  screen.updateQuery(query, saved);
  return screen;
}

const folderEntries = (folder) => folder.entries.slice(folder.start, folder.end);

export function mountFolderBrowser(host, tree, folder, {
  kind, query, open, onBack, goToFolder, play, currentId, technical, windowOptions, saved, empty, offline, onOffline,
}) {
  const doc = host.ownerDocument;
  const page = element(doc, 'section', 'computer-album-page');
  const isVideo = kind === 'videos';
  const noun = isVideo ? 'video' : 'song';
  let entries;
  const directories = folder ? [...folder.children.values()] : tree.roots;
  let back;
  if (folder) {
    const header = element(doc, 'div', 'computer-detail-header');
    back = button(doc, 'Back', onBack);
    const crumbs = element(doc, 'nav', 'computer-breadcrumbs');
    crumbs.setAttribute('aria-label', 'Folder path');
    const ancestors = [];
    for (let parent = folder.parent; parent; parent = parent.parent) ancestors.unshift(parent);
    for (const part of [null, ...ancestors, folder]) {
      if (part) crumbs.append(element(doc, 'span', 'computer-crumb-divider', '/'));
      const current = part === folder;
      const name = part?.title || 'Folders';
      const crumb = current ? element(doc, 'span', 'computer-detail-title', name)
        : button(doc, name, () => goToFolder(part?.key));
      crumb.title = part?.path || name;
      if (current) {
        titled(crumb, part.path, part.error);
        crumb.setAttribute('aria-current', 'location');
      }
      crumbs.append(crumb);
    }
    const playFolder = button(doc, 'Play folder', () => play(folderEntries(folder), 0), true);
    playFolder.disabled = folder.start === folder.end;
    header.append(back, crumbs, playFolder);
    page.append(header);
  }
  if (folder?.error) page.title = folder.error;
  host.append(page);

  const table = mountComputerTable(page, {
    columns: isVideo ? VIDEO_COLUMNS : SONG_COLUMNS, layout: isVideo ? 'videos' : 'songs',
    label: folder?.title || 'Folders', currentId, technical, windowOptions, inlineHeader: true, offline, onOffline,
    onPlay: (index) => play(entries, index),
  });
  const rows = directories.map((directory, index) => ({
    key: directory.key, folder: directory, facts: pluralCount(directory.end - directory.start, noun),
    action: () => open('folder', directory.key, remember(table, directory, index)),
  }));
  const screen = {
    ...table, focus: () => back ? back.focus() : table.focus(0),
    updateQuery(text, location) {
      const matches = entrySearch(text, { paths: true });
      entries = folder?.files || [];
      if (matches) {
        entries = [];
        const all = folder?.entries || tree.entries;
        const end = folder?.end ?? all.length;
        for (let index = folder?.start ?? 0; index < end; index++) {
          if (matches(all[index])) entries.push(all[index]);
        }
      }
      const leading = matches ? [] : rows;
      update(table, entries, location, { table: true, leading });
      table.viewport.hidden = !entries.length && !leading.length;
      screen.empty = table.viewport.hidden ? empty(folder || matches ? `${noun}s` : 'folders') : '';
    },
    destroy() { table.destroy(); page.remove(); },
  };
  screen.updateQuery(query, saved);
  return screen;
}

export function mountShowPage(host, show, { onBack, play, currentId, technical, windowOptions, saved, query, empty, offline, onOffline }) {
  const doc = host.ownerDocument;
  const { page, header, focus } = detailPage(host, show, onBack);
  const star = computerGroupStar(doc, show.entries, 'show');
  header.append(
    titled(element(doc, 'h2', 'computer-detail-title', show.title), show.title, show.error),
    button(doc, 'Play all', () => play(show.entries, 0), true),
    button(doc, 'Shuffle', () => play(show.entries, Math.floor(Math.random() * show.entries.length), { shuffle: true })),
    star.button,
  );

  const table = mountComputerTable(page, {
    columns: [
      { name: 'Episode', key: episodeCode },
      { name: 'Title', key: episodeTitle, wrap: true, empty: '' },
      { name: 'Length', key: totalLengthText, tooltip: durationTooltip },
      actionColumn,
    ],
    label: 'Show episodes', layout: 'episodes', currentId, technical, windowOptions, structured: true, offline, onOffline,
    rowFor: (row) => row.heading ? row : { ...row, action: () => play(show.entries, row.index) },
  });
  const screen = {
    ...table, focus,
    updateQuery(text, location) {
      const matches = entrySearch(text);
      const rows = [];
      for (const { heading, episodes } of show.rows) {
        let needsHeading = true;
        for (const episode of episodes) {
          if (matches && !matches(episode.entry)) continue;
          if (needsHeading) rows.push({ heading });
          needsHeading = false;
          rows.push(episode);
        }
      }
      update(table, rows, location, { table: true });
      table.viewport.hidden = !rows.length;
      screen.empty = rows.length ? '' : empty('episodes');
    },
    markFavorites() { star.sync(); table.markFavorites(); },
    destroy() { table.destroy(); page.remove(); },
  };
  screen.updateQuery(query, saved);
  return screen;
}

export function mountBookPage(host, book, { onBack, playBook, currentId, technical, loadImage, windowOptions, saved, query, empty, offline, onOffline }) {
  const doc = host.ownerDocument;
  const { page, header, focus } = detailPage(host, book, onBack);
  const hero = element(doc, 'div', 'computer-album-hero computer-book-hero');
  const { tile, dispose } = computerCover(doc, book, { loadImage, large: true, priority: 30 });
  const details = element(doc, 'div', 'computer-album-details');
  details.append(
    titled(element(doc, 'h2', 'computer-detail-title', book.title), book.title, book.error),
    titled(element(doc, 'div', 'computer-card-title', book.author), book.author),
    titled(element(doc, 'div', 'computer-card-title', book.narrator ? `Narrator ${book.narrator}` : ''), book.narrator),
    titled(element(doc, 'div', 'computer-quiet', totalLengthText(book)), durationTooltip(book)),
  );
  header.append(button(doc, 'Play', () => playBook(book), true));
  hero.append(tile, details);
  page.append(hero);
  const single = book.entries.length === 1;
  const first = book.entries[0];
  const chapters = single ? normalizeChapters(first.chapters) : [];
  const chapterList = chapters.length > 0;
  const star = single && chapterList ? computerFileStar(header, first, book.title) : null;
  if (star) header.append(star.button);
  const rows = chapterList
    ? chapters.map(({ title, start }, index) => ({
      entry: { ...first, title: title || `Chapter ${index + 1}`, number: index + 1, start },
      key: start, markPlaying: false, action: () => playBook(book, 0, { startAt: start }),
    }))
    : book.entries.map((entry, index) => ({ entry, action: () => playBook(book, index) }));
  const table = mountComputerTable(page, {
    columns: chapterList ? [
      { name: 'Chapter', key: (entry) => entry.number },
      { name: 'Title', key: (entry) => entry.title, wrap: true },
      { name: 'Start', key: (entry) => durationText(entry.start) },
      actionColumn,
    ] : SONG_COLUMNS,
    label: chapterList ? 'Chapters' : 'Book files', layout: chapterList ? 'chapters' : 'songs',
    currentId, technical, windowOptions, structured: true, offline, onOffline,
  });
  const screen = {
    ...table, focus,
    updateQuery(text, location) {
      const matches = entrySearch(text);
      const visible = matches ? rows.filter(({ entry }) => matches(entry)) : rows;
      update(table, visible, location, { table: true });
      table.viewport.hidden = !visible.length;
      screen.empty = visible.length ? '' : empty(chapterList ? 'chapters' : 'files');
    },
    markFavorites() { star?.sync(); table.markFavorites(); },
    destroy() { dispose?.(); table.destroy(); page.remove(); },
  };
  screen.updateQuery(query, saved);
  return screen;
}

export function mountMovies(host, { play, loadImage, windowOptions, technical, empty, onBack, offline }) {
  const doc = host.ownerDocument;
  const split = element(doc, 'div', 'computer-movies');
  const side = element(doc, 'aside', 'computer-movie-side');
  side.setAttribute('aria-label', 'Movie details');
  let selected;
  let origin;
  let details;
  let movies = [];
  const cards = mountComputerCards(split, {
    label: 'Movies', poster: true, width: 144, height: 310, loadImage, windowOptions, offline,
    describe: (movie) => ({
      subtitle: facts(movie.entry.year, totalLengthText(movie.entry)),
      subtitleTooltip: durationTooltip(movie.entry),
      badges: [...movieBadges(movie.entry), technical() && movieCodecs(movie.entry)].filter(Boolean),
    }),
    selected: (movie) => movie.key === selected?.key,
    fileEntry: (movie) => movie.entry,
    onOpen(movie, index) {
      if (selected?.key === movie.key) return;
      origin = remember(cards, movie, index);
      selected = movie;
      drawDetails();
    },
    onPlay: (movie) => play([movie.entry], 0),
  });
  split.append(side);
  host.append(split);

  function drawDetails() {
    details?.dispose();
    side.replaceChildren();
    side.scrollTop = 0;
    cards.markSelection();
    details = selected ? movieDetails(side, selected, { loadImage, close: onBack, play }) : null;
    if (!details) side.append(element(doc, 'p', 'computer-quiet', 'Select a movie.'));
  }

  function close() {
    if (!selected) return false;
    selected = null;
    drawDetails();
    const index = movies.findIndex((movie) => movie.key === origin.key);
    cards.update(movies, origin.top, { ...origin, index });
    return true;
  }

  return {
    ...cards, close, hasDetails: () => Boolean(selected),
    location: () => ({ top: cards.position(), selected: selected?.key, origin, sideTop: side.scrollTop }),
    update(next, top, saved) {
      movies = next;
      const movie = movies.find(({ key }) => key === (saved?.selected ?? selected?.key));
      if (saved?.selected) origin = saved.origin;
      if (movie !== selected || !side.children.length) {
        const focus = side.contains(doc.activeElement);
        selected = movie;
        drawDetails();
        if (focus) (details?.back || cards.viewport).focus();
      }
      if (saved?.sideTop != null) side.scrollTop = saved.sideTop;
      split.hidden = !movies.length;
      cards.update(next, top);
      this.empty = movies.length ? '' : empty('movies');
    },
    destroy() { details?.dispose(); cards.destroy(); split.remove(); },
  };
}

function movieDetails(host, movie, { loadImage, close, play }) {
  const doc = host.ownerDocument;
  const { entry } = movie;
  const heading = titled(element(doc, 'h2', 'computer-detail-title', movie.title), movie.title, movie.error);
  const back = button(doc, 'Back', close);
  const header = element(doc, 'div', 'computer-detail-header');
  header.append(back, heading);
  if (movie.error) header.title = movie.error;
  const { tile, dispose } = computerCover(doc, movie, { loadImage, poster: true, large: true, priority: 30 });
  const actions = element(doc, 'div', 'computer-album-actions');
  actions.append(
    button(doc, 'Play', () => play([entry], 0), true),
    button(doc, 'Play from the beginning', () => play([entry], 0, { startAt: 0 })),
  );
  const list = element(doc, 'dl', 'computer-movie-facts');
  function field(name, values) {
    if (!values.some(Boolean)) return;
    list.append(element(doc, 'dt', '', name));
    for (const value of values.filter(Boolean)) {
      const line = element(doc, 'dd', 'computer-detail-title', value);
      line.title = value;
      list.append(line);
    }
  }
  const trackName = (track) => track.language || track.title || '';
  const audioTracks = entry.audio_tracks?.length ? entry.audio_tracks : entry.acodec ? [{
    codec: entry.acodec, channels: entry.channels,
  }] : [];
  field('Size', [sizeText(entry.size)]);
  field('Resolution', [facts(entry.width && entry.height && `${entry.width} × ${entry.height}`, movieResolution(entry))]);
  field('Codecs', [movieCodecs(entry)]);
  const defaultIndex = Math.max(0, audioTracks.findIndex((track) => track.default));
  field('Audio', audioTracks.map((track, index) => facts(
    trackName(track), movieCodec(track.codec),
    track.layout || track.channel_layout || audioLayout(track.channels ?? (index === defaultIndex ? entry.channels : undefined)),
  ) || `Track ${index + 1}`));
  field('Subtitles', [
    ...(entry.subtitle_tracks || []).map((track, index) => trackName(track) || `Track ${index + 1}`),
    ...(entry.subs || []).map((rel) => fileName({ rel })),
  ]);
  field('Path', [entry.rel]);
  const length = titled(element(doc, 'div', 'computer-quiet', facts(entry.year, totalLengthText(entry))), durationTooltip(entry));
  host.append(header, actions, tile, length, list);
  return { back, dispose: () => dispose?.() };
}
