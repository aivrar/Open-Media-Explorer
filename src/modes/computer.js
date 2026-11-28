import {
  albumsOf, artistsOf, audiobooksOf, booksOf, entrySearch, fileName, folderTree, genresOf, groupSearch, moviesOf,
  computerAlbumKey, computerBookKey, computerFolderKeys, durationTooltip, isAudiobook, musicOf, newestAlbums, prepareEntrySearch, showsOf,
  sortBy, totalLengthText, videosOf,
} from '../lib/computer-catalog.js';
import { computerLibrary } from '../lib/computer-library.js';
import { bookPlaybackOptions, bookResumeIndex, computerOpenMessage, playComputerEntries, reportMissingComputerFile, reportOfflineComputerFolder } from '../lib/computer-play.js';
import { getComputerStarsStatus, getState, isLocalFileFavorite, loadComputerStars, subscribe } from '../lib/state.js';
import { mountAlbumGrid, mountAlbumPage } from './computer-albums.js';
import {
  mountBookPage, mountFolderBrowser, mountGenres, mountGroupCards, mountMovies, mountMusicCollection, mountShowPage,
} from './computer-browse.js';
import { mountComputerFavorites } from './computer-favorites.js';
import { mountComputerFolders } from './computer-folders.js';
import { toggleFocusedComputerFavorite } from './computer-star.js';
import { mountComputerTable, SONG_COLUMNS, VIDEO_COLUMNS } from './computer-table.js';

const albumSorts = [
  ['Album A-Z', 'title', false], ['Artist A-Z', 'artist', false],
  ['Newest year', 'year', true, true], ['Recently added', 'added', true, true],
];
const movieSorts = [
  ['Title A-Z', 'title', false], ['Newest year', 'year', true, true],
  ['Recently added', 'mtime', true, true], ['Longest', 'duration', true, true],
];
const musicViews = [['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs'], ['genres', 'Genres'], ['folders', 'Folders']];
const videoViews = [['movies', 'Movies'], ['shows', 'Shows'], ['videos', 'All videos'], ['folders', 'Folders']];
const preferences = {
  kind: 'music', music: 'albums', video: 'movies', albumSort: 0, movieSort: 0, search: '',
  songs: { column: 0, descending: false }, videos: { column: 0, descending: false },
};
const count = (value) => (Number(value) || 0).toLocaleString();
let unmount;
const lastView = new WeakMap();

export function renderComputer(host, {
  doc = host.ownerDocument, win = doc.defaultView, library = computerLibrary,
  appState = getState, onState = subscribe, play = playComputerEntries, loadImage, windowOptions, entry,
  ...folderDeps
} = {}) {
  unmount?.();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const geometry = { doc, win, ...windowOptions };
  let snapshot = library.getComputerLibrary();
  let source;
  let music = [];
  let videos = [];
  let audioBooks = [];
  let unprobed = false;
  let catalog = {};
  let savedFolders;
  let offlineFolders = new Set();
  const previous = entry ? null : lastView.get(host);
  const trail = previous?.trail || [];
  let restore = previous?.location;
  let foldersOpen = previous?.foldersOpen ?? false;
  let panelFolders = snapshot.loaded ? snapshot.folders : undefined;
  let screen;
  let screenType;
  let mounted;
  let sortedLists = new WeakMap();
  let groupIndices = new WeakMap();
  let genreAlbums;
  let technicalDetails = technical();
  let playAttempt = 0;
  let offlineMessageTimer;
  let favorites = (appState().favorites || []).filter(isLocalFileFavorite);

  function element(tag, className = '', text = '') {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function button(text, action, className = 'btn') {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function select(label, choices, selected, action) {
    const node = element('select');
    node.setAttribute('aria-label', label);
    for (const [value, text] of choices) {
      const option = element('option', '', text);
      option.value = value;
      node.append(option);
    }
    node.value = selected;
    node.addEventListener('change', () => action(node.value));
    return node;
  }

  const root = element('div', 'computer-root');
  const chips = element('div', 'computer-kinds');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Media type');
  const musicChip = button('Music', () => chooseKind('music'), 'chip');
  const videoChip = button('Videos', () => chooseKind('videos'), 'chip');
  const bookChip = button('Audiobooks', () => chooseKind('audiobooks'), 'chip');
  const favoritesChip = button('Favorites', () => chooseKind('favorites'), 'chip');
  chips.append(musicChip, videoChip, bookChip, favoritesChip);

  const toolbar = element('div', 'computer-toolbar');
  function chooseView(kind, value) {
    preferences[kind] = value;
    clearTrail();
    render();
  }
  const view = select('Music view', musicViews, preferences.music, (value) => chooseView('music', value));
  const videoView = select('Video view', videoViews, preferences.video, (value) => chooseView('video', value));
  const searchBox = element('div', 'computer-search');
  const search = element('input');
  search.type = 'search';
  search.value = preferences.search;
  search.setAttribute('aria-keyshortcuts', 'Control+F /');
  search.addEventListener('input', () => searchFor(search.value));
  const clear = button('Clear', () => { searchFor(''); search.focus(); });
  clear.setAttribute('aria-label', 'Clear search');
  searchBox.append(search, clear);
  const sort = select('Sort albums', albumSorts.map(([label], index) => [String(index), label]), String(preferences.albumSort), (value) => {
    preferences.albumSort = Number(value);
    render(true);
  });
  const movieSort = select('Sort movies', movieSorts.map(([label], index) => [String(index), label]), String(preferences.movieSort), (value) => {
    preferences.movieSort = Number(value);
    render(true);
  });
  const folders = element('div', 'computer-folders');
  folders.id = 'computer-folder-panel';
  const folderButton = button('Folders', () => {
    foldersOpen = !foldersOpen;
    syncFrame();
    if (foldersOpen) void library.refreshAvailability?.();
  });
  folderButton.setAttribute('aria-controls', folders.id);

  const scan = element('div', 'computer-scan');
  const phase = element('span', 'computer-scan-text');
  phase.setAttribute('role', 'status');
  const progress = element('progress');
  progress.setAttribute('aria-label', 'Tags read');
  const scanText = element('div', 'computer-scan-progress');
  scanText.append(phase, progress);
  const rescan = button('Rescan', () => library.rescan());
  rescan.title = 'Look for new, changed and removed files';
  const cancel = button('Cancel', () => library.cancel());
  scan.append(scanText, rescan, cancel);
  toolbar.append(view, videoView, searchBox, sort, movieSort, folderButton, scan);

  const notes = element('div', 'computer-notes');
  const ffmpeg = element('div', 'computer-quiet', 'Install FFmpeg in Settings to read tags, covers and lengths.');
  const lastError = element('div', 'computer-quiet');
  const failure = element('div', 'computer-failure');
  const failureText = element('span');
  failureText.setAttribute('role', 'status');
  const retry = button('Retry', () => library.retry());
  failure.append(failureText, retry);
  const playError = element('div', 'computer-quiet');
  playError.setAttribute('role', 'status');
  notes.append(ffmpeg, lastError, failure, playError);

  const content = element('div', 'computer-content');
  const summary = element('div', 'computer-summary computer-quiet');
  const retryStars = button('Retry', () => loadComputerStars());
  retryStars.hidden = true;
  const results = element('div', 'computer-results');
  content.append(summary, retryStars, results);
  root.append(chips, toolbar, folders, notes, content);
  host.append(root);

  const folderPanel = mountComputerFolders(folders, {
    ...folderDeps, doc, initialFolders: panelFolders,
    onFoldersChanged(next) {
      panelFolders = next;
      foldersOpen = true;
      library.foldersChanged(next);
    },
  });

  function technical() { return appState().settings?.showTechnicalDetails === true; }
  function currentId() { return appState().currentItem?.id; }

  function setSearch(value) {
    search.value = preferences.search = value;
  }

  function clearTrail() {
    if (trail.length) setSearch(trail[0].query);
    trail.length = 0;
  }

  function chooseKind(kind) {
    if (preferences.kind === kind) return;
    preferences.kind = kind;
    clearTrail();
    render();
  }

  function open(type, key, origin) {
    trail.push({ type, key, origin, query: preferences.search });
    setSearch('');
    render(true);
    screen?.focus?.();
  }

  function goBack(depth) {
    const [{ origin, query }] = trail.splice(depth);
    setSearch(query);
    render(false, origin);
  }

  function back() {
    if (overlayOpen(doc.activeElement)) return;
    if (trail.length) goBack(trail.length - 1);
    else screen?.close?.();
  }

  function goToFolder(key) {
    if (!overlayOpen(doc.activeElement)) goBack(key == null ? 0 : trail.findIndex((page) => page.key === key) + 1);
  }

  function canGoBack() { return Boolean(trail.length || screen?.hasDetails?.()); }

  function overlayOpen(target) {
    const picture = doc.getElementById?.('picture-panel');
    return doc.getElementById?.('app')?.inert || doc.querySelector?.('dialog[open]')
      || picture?.matches?.(':popover-open') || picture?.contains?.(target);
  }

  function inputFocused(target) {
    return target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
  }

  doc.addEventListener?.('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = doc.activeElement || event.target;
    if (overlayOpen(target)) return;
    const key = event.key;
    if (canGoBack() && (key === 'BrowserBack' || (event.altKey && key === 'ArrowLeft')
      || (key === 'Escape' && (target === doc.body || root.contains(target))))) {
      event.preventDefault();
      back();
    } else if (!toolbar.hidden && !inputFocused(target)
      && ((event.ctrlKey && !event.altKey && key?.toLowerCase() === 'f')
        || (key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey))) {
      event.preventDefault();
      search.focus();
    } else if (root.contains(target) && !inputFocused(target) && !event.ctrlKey && !event.altKey && !event.metaKey
      && !event.shiftKey && !event.repeat && key?.toLowerCase() === 'f' && toggleFocusedComputerFavorite(target)) {
      event.preventDefault();
    }
  }, options);
  win?.addEventListener?.('mouseup', (event) => {
    if (!canGoBack() || event.button !== 3 || overlayOpen(doc.activeElement)) return;
    event.preventDefault();
    back();
  }, options);

  function searchFor(value) {
    setSearch(value);
    render(true);
  }

  function clearOfflineMessage() {
    if (offlineMessageTimer == null) return;
    clearTimeout(offlineMessageTimer);
    offlineMessageTimer = undefined;
    playError.textContent = '';
  }

  function onOffline() {
    playAttempt++;
    clearOfflineMessage();
    if (reportOfflineComputerFolder()) return;
    playError.textContent = 'That folder is not connected.';
    offlineMessageTimer = setTimeout(clearOfflineMessage, 5_000);
  }

  function offline(entry) { return offlineFolders.has(entry?.folder); }

  function screenLocation() {
    return screen?.location?.() || screen?.focusedRow?.()
      || (screen?.viewport && { top: screen.position?.() ?? screen.viewport.scrollTop });
  }

  async function playFrom(entries, index, opts) {
    if (offline(entries[index])) {
      onOffline();
      return;
    }
    const attempt = ++playAttempt;
    clearOfflineMessage();
    playError.textContent = '';
    try {
      await play(entries, index, opts);
    } catch {
      if (!options.signal.aborted && attempt === playAttempt) {
        playError.textContent = 'This file could not be played.';
      }
    }
  }

  function showBrowser() {
    return (snapshot.loaded && snapshot.folders.length > 0) || favorites.length > 0 || preferences.kind === 'favorites';
  }

  function syncFavoriteChip() {
    const active = preferences.kind === 'favorites';
    const label = `Favorites ${count(favorites.length)}`;
    if (favoritesChip.textContent !== label) favoritesChip.textContent = label;
    favoritesChip.className = active ? 'chip is-active' : 'chip';
    favoritesChip.setAttribute('aria-pressed', String(active));
  }

  function syncFrame() {
    const { status, error, items, folders: saved } = snapshot;
    const browsing = showBrowser();
    chips.hidden = toolbar.hidden = content.hidden = !browsing;
    folders.setAttribute('data-empty-state', String(!browsing && snapshot.loaded && !saved.length));
    folders.hidden = browsing && !foldersOpen && saved.length > 0;
    folderButton.setAttribute('aria-expanded', String(!folders.hidden));
    folderButton.textContent = `Folders (${count(saved.length)})`;
    const kind = preferences.kind;
    for (const [chip, type, label, total] of [
      [musicChip, 'music', 'Music', music.length],
      [videoChip, 'videos', 'Videos', videos.length],
      [bookChip, 'audiobooks', 'Audiobooks', audioBooks.length],
    ]) {
      const active = kind === type;
      chip.hidden = type !== 'music' && !total;
      chip.textContent = `${label} ${count(total)}`;
      chip.className = active ? 'chip is-active' : 'chip';
      chip.setAttribute('aria-pressed', String(active));
    }
    syncFavoriteChip();
    view.hidden = kind !== 'music';
    videoView.hidden = kind !== 'videos';
    sort.hidden = kind !== 'music' || preferences.music !== 'albums' || trail.length > 0;
    movieSort.hidden = kind !== 'videos' || preferences.video !== 'movies';
    search.placeholder = `Search ${kind}`;
    search.setAttribute('aria-label', search.placeholder);
    clear.hidden = !preferences.search;

    const scanning = status?.scanning === true;
    const walking = scanning && status.phase === 'walking';
    const reading = scanning && status.phase === 'reading';
    const cancelling = scanning && status.phase === 'cancelling';
    const text = walking ? `Looking for files... ${count(status.files_found)} found`
      : reading ? `Reading tags ${count(status.files_read)} of ${count(status.files_to_read)}`
      : cancelling ? 'Stopping...' : '';
    if (phase.textContent !== text) phase.textContent = text;
    scanText.hidden = !text;
    progress.hidden = !reading;
    if (reading) {
      progress.max = Math.max(1, Number(status.files_to_read) || 0);
      progress.value = Number(status.files_read) || 0;
    }
    cancel.hidden = !scanning || cancelling;
    rescan.hidden = scanning;
    ffmpeg.hidden = !items.length || status?.ffprobe !== false || !unprobed;
    lastError.textContent = status?.last_error || '';
    failureText.textContent = error || '';
    failure.hidden = !error;
  }

  function resetScreen(type) {
    clearOfflineMessage();
    screen?.destroy();
    screen = null;
    screenType = type;
    mounted = null;
  }

  function filteredList(list, choice, key, numeric, isAlbums = false, getEntry) {
    let sorted = sortedLists.get(list);
    if (sorted?.choice !== choice) {
      const entries = sortBy(list, key, { numeric, descending: choice.descending ?? choice[3] });
      let duration = 0;
      let duration_estimated = false;
      if (!isAlbums && !getEntry) {
        for (const entry of entries) {
          duration += Number(entry.duration) || 0;
          duration_estimated ||= entry.duration_estimated === true;
        }
      }
      sorted = { choice, entries, duration, duration_estimated };
      sortedLists.set(list, sorted);
    }
    const text = preferences.search;
    if (sorted.filtered?.text === text) return sorted.filtered;
    const matches = entrySearch(text);
    if (!matches) {
      const { entries, duration, duration_estimated } = sorted;
      sorted.filtered = { text, entries, duration, duration_estimated };
      return sorted.filtered;
    }
    let duration = 0;
    let duration_estimated = false;
    const entries = sorted.entries.filter((item) => {
      if (isAlbums) return item.tracks.some(matches);
      if (!matches(getEntry ? getEntry(item) : item)) return false;
      if (!getEntry) {
        duration += Number(item.duration) || 0;
        duration_estimated ||= item.duration_estimated === true;
      }
      return true;
    });
    sorted.filtered = { text, entries, duration, duration_estimated };
    return sorted.filtered;
  }

  function foldersFor(kind) {
    const key = kind === 'videos' ? 'videoFolders' : 'musicFolders';
    return catalog[key] ||= folderTree(snapshot.folders, kind === 'videos' ? videos : music);
  }

  function collection(type) {
    switch (type) {
      case 'albums': return catalog.albums ||= albumsOf(music);
      case 'artists': return catalog.artists ||= artistsOf(music);
      case 'genres': return catalog.genres ||= genresOf(music);
      case 'shows': return catalog.shows ||= showsOf(videos);
      case 'audiobooks': return catalog.books ||= booksOf(audioBooks);
      case 'movies': return catalog.movies ||= moviesOf(videos).map((entry) => ({
        key: entry.id, title: entry.title || fileName(entry) || 'Unknown movie', artEntryId: entry.id, error: entry.error, entry,
      }));
    }
  }

  function groupByKey(list, key) {
    if (!groupIndices.has(list)) groupIndices.set(list, new Map(list.map((group) => [group.key, group])));
    return groupIndices.get(list).get(key);
  }

  function resolveTrail() {
    let item;
    for (const [index, page] of trail.entries()) {
      switch (page.type) {
        case 'folder': item = foldersFor(preferences.kind).nodes.get(page.key); break;
        case 'artist': item = groupByKey(collection('artists'), page.key); break;
        case 'genre': item = groupByKey(collection('genres'), page.key); break;
        case 'show': item = groupByKey(collection('shows'), page.key); break;
        case 'book': item = groupByKey(collection('audiobooks'), page.key); break;
        case 'album': item = groupByKey(item?.albums || (item === genreAlbums?.group && genreAlbums?.albums)
          || collection('albums'), page.key); break;
      }
      if (!item) return { missing: index };
      if (page.type === 'genre' && genreAlbums?.group !== item) {
        genreAlbums = { group: item, albums: newestAlbums(albumsOf(item.entries)) };
      }
    }
    return { item };
  }

  function updateFavoriteScreen(resetScroll, saved) {
    const starsStatus = appState === getState ? getComputerStarsStatus() : 'loaded';
    const unavailable = starsStatus !== 'loaded';
    retryStars.hidden = starsStatus !== 'error';
    results.hidden = unavailable;
    screen.update(favorites, snapshot, preferences.search, resetScroll, saved);
    const message = starsStatus === 'error' ? 'Starred files could not be loaded.' : unavailable ? 'Loading starred files.' : screen.empty;
    if (summary.textContent !== message) summary.textContent = message;
  }

  function render(resetScroll = false, saved) {
    retryStars.hidden = true;
    results.hidden = false;
    summary.removeAttribute('title');
    if (source !== snapshot.items) {
      source = snapshot.items;
      sortedLists = new WeakMap();
      groupIndices = new WeakMap();
      genreAlbums = undefined;
      music = musicOf(source);
      videos = videosOf(source);
      audioBooks = audiobooksOf(source);
      prepareEntrySearch(source);
      unprobed = source.some((entry) => entry.probed === false);
      catalog = {};
    }
    if (savedFolders !== snapshot.folders) {
      savedFolders = snapshot.folders;
      const next = new Set(savedFolders.filter(({ available }) => available === false).map(({ id }) => id));
      if (screenType !== 'favorites' && (next.size !== offlineFolders.size || [...next].some((id) => !offlineFolders.has(id)))) {
        saved ??= screenLocation();
        resetScreen(null);
      }
      offlineFolders = next;
      delete catalog.musicFolders;
      delete catalog.videoFolders;
    }
    syncFrame();
    if (content.hidden) {
      resetScreen(null);
      if (snapshot.loaded) {
        clearTrail();
        restore = undefined;
      }
      return;
    }
    if (trail.length && !snapshot.loaded) return;
    saved ??= restore;
    restore = undefined;
    const { item, missing } = resolveTrail();
    if (missing != null) {
      goBack(missing);
      return;
    }
    const kind = preferences.kind;
    const type = trail.at(-1)?.type || (kind === 'music' ? preferences.music : kind === 'videos' ? preferences.video : kind);
    if (screenType !== type) resetScreen(type);
    const query = preferences.search;
    if (!trail.some(({ type }) => type === 'genre')) genreAlbums = undefined;
    const options = {
      onBack: back, open, play: playFrom, loadImage, currentId, technical,
      windowOptions: geometry, query, empty: emptyMessage, offline, onOffline,
    };

    if (type === 'favorites') {
      if (!screen) {
        screen = mountComputerFavorites(results, {
          ...options, onEmptyFocus: () => (preferences.search.trim() ? search : favoritesChip).focus(),
          onMissing() {
            const message = computerOpenMessage({ code: 'COMPUTER_FILE_GONE' });
            if (!reportMissingComputerFile()) playError.textContent = message;
          },
        });
        void library.refreshAvailability?.();
      }
      updateFavoriteScreen(resetScroll, saved);
      return;
    }

    if (type === 'albums') {
      const choice = albumSorts[preferences.albumSort];
      const entries = filteredList(collection(type), choice, (album) => album[choice[1]], choice[2], true).entries;
      if (!screen) {
        screen = mountAlbumGrid(results, {
          ...options,
          onOpen(album, index) {
            open('album', album.key, { key: album.key, top: screen.viewport.scrollTop, index });
          },
        });
      }
      if (screen.entries !== entries || saved) {
        screen.update(entries, resetScroll ? 0 : saved?.top, saved);
        screen.entries = entries;
      }
      summary.textContent = entries.length ? '' : emptyMessage('albums');
      return;
    }

    if (type === 'songs' || type === 'videos') {
      const columns = type === 'songs' ? SONG_COLUMNS : VIDEO_COLUMNS;
      const choice = preferences[type];
      const column = columns[choice.column];
      const list = filteredList(type === 'songs' ? music : videos, choice, column.key, column.numeric);
      const { entries } = list;
      if (!screen) {
        screen = mountComputerTable(results, {
          ...options, columns, layout: type, label: type === 'songs' ? 'Songs' : 'Videos',
          onSort(index) {
            const previousSort = preferences[type];
            preferences[type] = { column: index, descending: index === previousSort.column && !previousSort.descending };
            render(true);
          },
          onPlay: (index) => playFrom(screen.entries, index),
        });
      }
      if (screen.entries !== entries || screen.technical !== technicalDetails) {
        screen.entries = entries;
        screen.technical = technicalDetails;
        screen.update(entries, choice, resetScroll ? 0 : saved?.top, saved?.key == null ? null : saved);
      }
      const noun = entries.length === 1 ? (type === 'songs' ? 'song' : 'video') : type;
      const total = `${count(entries.length)} ${noun}`;
      summary.textContent = entries.length
        ? [total, totalLengthText(list, true)].filter(Boolean).join(' · ')
        : emptyMessage(type);
      const tooltip = durationTooltip(list);
      if (tooltip) summary.title = tooltip;
      return;
    }

    if (type === 'movies') {
      const choice = movieSorts[preferences.movieSort];
      const entries = filteredList(collection(type), choice, (movie) => movie[choice[1]] ?? movie.entry[choice[1]],
        choice[2], false, (movie) => movie.entry).entries;
      screen ||= mountMovies(results, options);
      if (screen.entries !== entries || screen.technical !== technicalDetails) {
        screen.entries = entries;
        screen.technical = technicalDetails;
        screen.update(entries, resetScroll ? 0 : saved?.top, saved);
      }
      summary.textContent = screen.empty;
      return;
    }

    const data = type === 'folders' || type === 'folder' ? foldersFor(kind) : item || collection(type);
    const detailTechnical = kind === 'videos' && technicalDetails;
    if (mounted?.data === data && mounted?.item === item && mounted?.technical === detailTechnical && !saved) {
      if (mounted.query === query) return;
      if (screen.updateQuery) {
        mounted.query = query;
        screen.updateQuery(query, resetScroll ? { top: 0 } : undefined);
        summary.textContent = screen.empty;
        return;
      }
    }
    const restorePageFocus = !resetScroll && results.contains?.(doc.activeElement);
    const location = saved || (!resetScroll && screenLocation());
    resetScreen(type);
    mounted = { data, item, query, technical: detailTechnical };
    options.saved = location;

    switch (type) {
      case 'album':
        screen = mountAlbumPage(results, item, {
          ...options, restoreFocus: location?.key != null ? location : undefined, scrollTop: location?.top,
          onPlay: (index, opts) => playFrom(item.tracks, index, opts),
        });
        break;
      case 'artist':
      case 'genre':
        screen = mountMusicCollection(results, item, item.albums || genreAlbums.albums, { ...options, type });
        break;
      case 'show':
        screen = mountShowPage(results, item, options);
        break;
      case 'book':
        screen = mountBookPage(results, item, {
          ...options,
          playBook: (book, index, opts) => {
            index ??= bookResumeIndex(book);
            if (index < 0) {
              playError.textContent = 'The saved file is gone. Choose a file to play.';
              return;
            }
            return playFrom(book.entries, index, { ...bookPlaybackOptions(book), ...opts });
          },
        });
        break;
      case 'folders':
      case 'folder':
        screen = mountFolderBrowser(results, data, item, { ...options, kind, goToFolder });
        break;
      default: {
        const matches = groupSearch(query);
        const entries = matches ? data.filter(matches) : data;
        screen = type === 'genres' ? mountGenres(results, entries, options)
          : mountGroupCards(results, type, entries, options);
      }
    }
    if (restorePageFocus && location?.key == null && !results.contains?.(doc.activeElement)) {
      screen.focus?.(0);
    }
    summary.textContent = screen.empty || '';
  }

  function emptyMessage(type) {
    if (type === 'albums' && !trail.length && !snapshot.items.length && !preferences.search.trim()) {
      return snapshot.status?.scanning ? '' : 'No music or videos were found in your folders.';
    }
    return preferences.search.trim() ? `No matching ${type}.` : `No ${type} found.`;
  }

  const unsubscribeLibrary = library.subscribeComputerLibrary((next) => {
    if (next.moved !== snapshot.moved) favorites = (appState().favorites || []).filter(isLocalFileFavorite);
    const previous = snapshot;
    snapshot = next;
    if (next.loaded && next.folders !== panelFolders) {
      panelFolders = next.folders;
      folderPanel.setFolders(next.folders);
    }
    if (next.items !== previous.items || next.folders !== previous.folders || next.loaded !== previous.loaded
        || (screenType === 'favorites' && (next.revision !== previous.revision
          || next.moved !== previous.moved || next.missingFiles !== previous.missingFiles))) render();
    else syncFrame();
  });
  const unsubscribePlaying = onState('current-item', () => screen?.markPlaying?.());
  function refreshFavorites() {
    favorites = (appState().favorites || []).filter(isLocalFileFavorite);
    if (content.hidden !== !showBrowser()) render();
    else {
      syncFavoriteChip();
      if (screenType === 'favorites') updateFavoriteScreen();
    }
    screen?.markFavorites?.();
  }
  const unsubscribeFavorites = onState('favorites-change', refreshFavorites);
  const unsubscribeStarStatus = onState('computer-stars-status', () => {
    if (screenType === 'favorites') updateFavoriteScreen();
  });
  const unsubscribeStarOrder = onState('computer-stars-order', refreshFavorites);
  const unsubscribeSettings = onState('settings-change', () => {
    if (technicalDetails === technical()) return;
    technicalDetails = technical();
    if (preferences.kind === 'videos') render();
  });
  const unsubscribeMode = onState('mode-change', (mode) => {
    if (mode !== 'computer') unmount?.();
  });
  const destroy = () => {
    if (controller.signal.aborted) return;
    lastView.set(host, { trail, foldersOpen, location: screenLocation() || restore });
    controller.abort();
    unsubscribeMode();
    unsubscribeSettings();
    unsubscribePlaying();
    unsubscribeFavorites();
    unsubscribeStarOrder();
    unsubscribeStarStatus();
    unsubscribeLibrary();
    library.closeComputerLibrary();
    folderPanel.destroy();
    resetScreen(null);
    root.remove();
    unmount = null;
  };

  unmount = destroy;
  library.openComputerLibrary();
  if (snapshot.loaded && preferences.kind !== 'favorites') void library.refreshAvailability?.();
  if (entry?.kind === 'video') {
    preferences.kind = 'videos';
    preferences.video = 'folders';
    const keys = computerFolderKeys(entry);
    for (const key of keys.slice(0, -1)) {
      trail.push({ type: 'folder', key, query: preferences.search });
      setSearch('');
    }
    open('folder', keys.at(-1));
  } else if (entry && isAudiobook(entry)) {
    preferences.kind = 'audiobooks';
    open('book', computerBookKey(entry));
  } else if (entry) {
    preferences.kind = 'music';
    preferences.music = 'albums';
    open('album', computerAlbumKey(entry));
  } else render();
  if (appState === getState) void loadComputerStars();
  return destroy;
}
