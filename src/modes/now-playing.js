/**
 * Now Playing tab: whatever plays now, shown large. The station or item
 * picture (with the same initials tile as the cards), its name and category,
 * the song the station announces with the star and Copy, the stream details
 * the app already knows, and a large copy of the player bar's LED sound meter,
 * over a blurred and dimmed copy of the picture.
 *
 * It only reads what other parts of the app keep: the player (the item, the
 * song, the stream it plays), the favorites, the station pictures, the play
 * clock and the shared sound signal. It sends no requests of its own beyond
 * the artwork the player bar asks for too, and it never touches Web Audio.
 * Play, pause and stop stay in the player bar; the video stays in its square.
 *
 * Costs nothing while closed: leaving the tab removes every listener, timer,
 * picture load and the meter's subscription (mountNowPlaying's destroy). While
 * open, it changes only on events; one timer moves the "Playing for" line on
 * once a minute while something plays and the window is shown.
 */

import {
  addFavorite as appAddFavorite, getState, isFavorite as appIsFavorite,
  removeFavorite as appRemoveFavorite, subscribe as appSubscribe,
} from '../lib/state.js';
import { getAudioSignal, getCurrentItem as appCurrentItem, getNowPlaying as appNowPlaying } from '../lib/player.js';
import { NOW_PLAYING_EVENT } from '../lib/now-playing.js';
import { bindSongStar as appBindSongStar } from '../lib/song-star.js';
import { songStarBlock, starredSongs } from '../lib/starred-songs.js';
import { favoriteNamesSnapshot, withFavoriteName } from '../lib/favorite-names.js';
import { FAVORITE_GROUPS_EVENT, favoriteGroupsSnapshot } from '../lib/favorite-groups.js';
import { getSourceLabel } from '../lib/sources.js';
import { playedStream as appPlayedStream } from '../lib/media-failover.js';
import { playedQualityLabel } from '../lib/stream-quality.js';
import {
  isArtworkRelayUrl, loadArtworkImage, resolveArtworkRelay, stationImageSourceFor,
} from '../lib/artwork.js';
import { onStationImagesChange as appOnStationImagesChange } from '../lib/station-images.js';
import { artworkInitials, initialsHue } from '../lib/initials.js';
import { createPlayerMeter } from '../lib/player-meter.js';
import { MEDIA_ADVANCING_EVENT, playClock as appPlayClock } from '../lib/play-clock.js';
import { COPIED_LABEL, COPIED_MS, COPY_FAILED, COPY_LABEL } from '../lib/song-log-panel.js';
import { bestStreamAutoOn } from '../lib/best-stream.js';
import { createBestStreamStatus } from './library/other-streams.js';

export const NOW_PLAYING_MODE = 'now-playing';

/** About this many LED segments over the large meter's height. */
export const NOW_PLAYING_METER_SEGMENTS = 20;
/** Artwork priority: the same as the player bar's picture. */
export const NOW_PLAYING_ART_PRIORITY = 20;

export const NOW_PLAYING_TEXT = Object.freeze({
  emptyTitle: 'Nothing is playing',
  emptyText: 'Play a station, a channel, a podcast or a video, and it is shown here with its picture, '
    + 'the song and the stream details.',
  emptyHint: 'Find something in the Library, or turn the dial in the Tuner.',
  openLibrary: 'Open the Library',
  openTuner: 'Open the Tuner',
  songHeading: 'Song',
  noSong: 'The station is not announcing a song title right now.',
  detailsHeading: 'Stream details',
  addFavorite: 'Add to favorites',
  removeFavorite: 'Remove from favorites',
  untitled: 'Untitled',
  notYet: 'Not playing yet',
  paused: 'paused',
});

/* ---------------- Pure parts: what is shown ---------------- */

/** What kind of item it is, in a few words, or ''. */
export function kindText(item) {
  const type = item?.type;
  const live = item?.delivery === 'live';
  if (type === 'radio') return 'Radio station';
  if (type === 'tv') return 'TV channel';
  if (item?.source === 'gpodder') return type === 'video' ? 'Video podcast' : 'Podcast';
  if (type === 'video') return live ? 'Live video' : 'Video';
  if (type === 'audio') return live ? 'Live audio' : 'Audio';
  return '';
}

/** Whether the item is the kind that can announce songs (live radio and
 *  live audio); for these the tab says so when none is announced. */
export function songApplies(item) {
  if (!item) return false;
  return item.type === 'radio' || (item.type === 'audio' && item.delivery === 'live');
}

let regionNames = null;
let languageNames = null;

function displayName(kind, code) {
  try {
    if (kind === 'region') regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' });
    else languageNames ||= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = (kind === 'region' ? regionNames : languageNames).of(code);
    return typeof name === 'string' && name.toLowerCase() !== code.toLowerCase() ? name : '';
  } catch (_) {
    return '';
  }
}

/** A country as a name: a two-letter code ("DE") becomes "Germany";
 *  anything else is shown as the item has it. */
export function countryText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^[A-Za-z]{2}$/.test(text)) return displayName('region', text.toUpperCase()) || text.toUpperCase();
  return text;
}

/** Languages as names: codes ("fr") become "French", words are capitalized,
 *  at most four. */
export function languageText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.split(/[,;/]/).map((part) => part.trim()).filter(Boolean).slice(0, 4).map((part) => {
    if (/^[A-Za-z]{2,3}$/.test(part)) {
      const name = displayName('language', part.toLowerCase());
      if (name) return name;
    }
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(', ');
}

/** "Under a minute", "12 min", "1 h 5 min", or '' for no time. */
export function elapsedText(ms) {
  if (!(ms >= 0)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Milliseconds until the minute shown by elapsedText changes. */
export function msToNextMinute(ms) {
  const played = ms >= 0 ? ms : 0;
  return 60_000 - (played % 60_000);
}

/** The "Playing for" value: time with sound (the play clock), marked when
 *  nothing sounds now. */
export function playingForText(playedMs, playing) {
  if (playedMs === null || playedMs === undefined || !(playedMs >= 0)) {
    return playing ? elapsedText(0) : NOW_PLAYING_TEXT.notYet;
  }
  const text = elapsedText(playedMs);
  return playing ? text : `${text} (${NOW_PLAYING_TEXT.paused})`;
}

/** The song part: { show, title, text }. `title` is the announced song for
 *  this item ('' when none); `text` what the line says. */
export function songView(item, nowPlaying) {
  const title = item && nowPlaying?.title && nowPlaying.itemId === item.id ? String(nowPlaying.title) : '';
  if (title) return { show: true, title, text: title };
  if (!songApplies(item)) return { show: false, title: '', text: '' };
  return { show: true, title: '', text: NOW_PLAYING_TEXT.noSong };
}

/** Whether a title is worth reading out: the star's rule (song-star.js), so
 *  the station's own name, the original name of a renamed favorite and text
 *  without letters are shown but not announced. `shown` is the item as the
 *  tab names it (withFavoriteName). */
export function announceable(title, shown) {
  if (!title || !shown) return false;
  if (songStarBlock(title, typeof shown.title === 'string' ? shown.title : '')) return false;
  if (shown.__favoriteName === true && songStarBlock(title, shown.originalTitle || '')) return false;
  return true;
}

/** The stream details as [label, value] rows, in order; only what is known. */
export function detailRows(item, { stream = null, playedMs = null, playing = false } = {}) {
  if (!item) return [];
  const rows = [];
  const source = getSourceLabel(item.source);
  if (source) rows.push(['Source', source]);
  const kind = kindText(item);
  if (kind) rows.push(['Type', kind]);
  const format = playedQualityLabel(item, stream);
  if (format) rows.push(['Format', format]);
  const country = countryText(item.country);
  if (country) rows.push(['Country', country]);
  const language = languageText(item.language);
  if (language) rows.push(['Language', language]);
  rows.push(['Playing for', playingForText(playedMs, playing)]);
  return rows;
}

/** The item as the lists show it: a renamed favorite under the user's name. */
export function shownItem(item, favorite, names) {
  return item && favorite ? withFavoriteName(item, names) : item;
}

/**
 * Everything the tab shows for one moment, from plain inputs. `item` is the
 * player's item (null: nothing loaded).
 */
export function nowPlayingView({
  item = null, favorite = false, names = new Map(), groups = null, nowPlaying = null,
  stream = null, playedMs = null, playing = false,
} = {}) {
  if (!item) return { empty: true };
  const shown = shownItem(item, favorite, names);
  const name = (typeof shown.title === 'string' && shown.title.trim()) || NOW_PLAYING_TEXT.untitled;
  const renamed = shown.__favoriteName === true;
  const categoryId = favorite && groups ? groups.groupOf(item.id) : '';
  return {
    empty: false,
    name,
    originalName: renamed ? (shown.originalTitle || NOW_PLAYING_TEXT.untitled) : '',
    category: categoryId ? groups.nameOf(categoryId) || '' : '',
    kind: kindText(item),
    favorite: favorite === true,
    initials: artworkInitials(name),
    hue: initialsHue(name),
    logo: item.type === 'radio' || item.type === 'tv',
    song: songView(item, nowPlaying),
    rows: detailRows(item, { stream, playedMs, playing }),
  };
}

/* ---------------- The tab ---------------- */

const STAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
  + '</svg>';

function defaultDeps() {
  return {
    doc: globalThis.document,
    win: globalThis.window,
    subscribe: appSubscribe,
    getCurrentItem: appCurrentItem,
    getNowPlaying: appNowPlaying,
    isPlaying: () => getState().isPlaying === true,
    getSettings: () => getState().settings,
    isFavorite: appIsFavorite,
    addFavorite: appAddFavorite,
    removeFavorite: appRemoveFavorite,
    favoriteNames: () => favoriteNamesSnapshot().names,
    favoriteGroups: favoriteGroupsSnapshot,
    signal: getAudioSignal(),
    starred: starredSongs,
    bindSongStar: appBindSongStar,
    createMeter: createPlayerMeter,
    playClock: appPlayClock,
    clipboard: globalThis.navigator?.clipboard,
    loadImage: loadArtworkImage,
    resolveArtwork: resolveArtworkRelay,
    customSourceFor: stationImageSourceFor,
    onStationImagesChange: appOnStationImagesChange,
    playedStream: appPlayedStream,
    bestStream: (item, options) => createBestStreamStatus(item, options),
    // The same as pressing the tab's button in the top bar.
    openMode: (mode) => globalThis.document?.querySelector?.(`.mode-btn[data-mode="${mode}"]`)?.click?.(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
  };
}

/**
 * Build the tab into `host`. Every dependency can be replaced (tests).
 * Returns { root, refresh, destroy, ... }; destroy leaves nothing behind.
 */
export function mountNowPlaying(host, options = {}) {
  const deps = { ...defaultDeps(), ...options };
  const { doc } = deps;
  const stops = [];
  let destroyed = false;

  function make(tag, className = '', attrs = null, text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== null) node.textContent = text;
    return node;
  }
  function append(parent, ...children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }
  function listen(node, type, fn) {
    node.addEventListener(type, fn);
    stops.push(() => node.removeEventListener(type, fn));
  }

  /* -- The shell -- */
  const root = make('div', 'np-root');
  const backdrop = make('div', 'np-backdrop', { 'aria-hidden': 'true' });
  const backdropImg = make('img', 'np-backdrop-img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
  backdrop.hidden = true;
  append(backdrop, backdropImg);
  const scrim = make('div', 'np-scrim', { 'aria-hidden': 'true' });

  const empty = make('section', 'np-empty', { 'aria-labelledby': 'np-empty-title' });
  const libraryBtn = make('button', 'btn btn-primary np-empty-btn', { type: 'button' }, NOW_PLAYING_TEXT.openLibrary);
  const tunerBtn = make('button', 'btn np-empty-btn', { type: 'button' }, NOW_PLAYING_TEXT.openTuner);
  append(empty,
    make('h2', 'np-empty-title', { id: 'np-empty-title' }, NOW_PLAYING_TEXT.emptyTitle),
    make('p', 'np-empty-text', null, NOW_PLAYING_TEXT.emptyText),
    make('p', 'np-empty-text', null, NOW_PLAYING_TEXT.emptyHint),
    append(make('div', 'np-empty-actions'), libraryBtn, tunerBtn));

  const layout = make('div', 'np-layout');
  const art = make('div', 'np-art', { 'aria-hidden': 'true' });
  const artInitials = make('span', 'np-art-initials');
  const artImg = make('img', 'np-art-img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
  append(art, artInitials, artImg);

  const info = make('div', 'np-info');
  const kind = make('p', 'np-kind');
  const title = make('h2', 'np-title', { id: 'np-title' });
  const fav = make('button', 'np-fav', { type: 'button', 'aria-pressed': 'false' });
  fav.innerHTML = STAR_SVG;
  const original = make('p', 'np-original');
  const category = make('p', 'np-category');

  const song = make('section', 'np-song', { 'aria-labelledby': 'np-song-heading' });
  const songText = make('p', 'np-song-title');
  const songStarBtn = make('button', 'np-song-star', { type: 'button', 'aria-pressed': 'false' });
  songStarBtn.innerHTML = `${STAR_SVG}<span class="np-when-off" aria-hidden="true">Star</span>`
    + '<span class="np-when-on" aria-hidden="true">Starred</span>';
  songStarBtn.hidden = true;
  const copyBtn = make('button', 'btn np-copy', { type: 'button' }, COPY_LABEL);
  const copyStatus = make('span', 'np-copy-status', { role: 'status' });
  // Says a new song once, politely; the visible line is not a live region,
  // so the tab opening or a title going away is never read out.
  const announcer = make('span', 'sr-only np-announce', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  append(song,
    make('h3', 'np-label', { id: 'np-song-heading' }, NOW_PLAYING_TEXT.songHeading),
    append(make('div', 'np-song-row'), songText,
      append(make('div', 'np-song-actions'), songStarBtn, copyBtn, copyStatus)),
    announcer);

  const meterBox = make('div', 'np-meter', { 'aria-hidden': 'true' });
  const canvas = make('canvas', 'player-meter-canvas np-meter-canvas');
  append(meterBox, canvas);

  const details = make('section', 'np-details', { 'aria-labelledby': 'np-details-heading' });
  const facts = make('dl', 'np-facts');
  const bestHost = make('div', 'np-best');
  append(details, make('h3', 'np-label', { id: 'np-details-heading' }, NOW_PLAYING_TEXT.detailsHeading), facts, bestHost);

  append(info,
    kind,
    append(make('div', 'np-heading-row'), title, fav),
    original,
    category,
    song,
    meterBox,
    details);
  append(layout, art, info);
  // The picture and its scrim stay put; only this part scrolls (a short window).
  const scroller = make('div', 'np-scroll');
  append(scroller, empty, layout);
  append(root, backdrop, scrim, scroller);
  host.appendChild(root);

  /* -- State kept between renders -- */
  let current = null; // the player's item shown now
  let factsKey = '';
  let lastSong = deps.getNowPlaying?.()?.title || ''; // never announced on opening
  let tick = null;
  let copyTimer = null;
  let picture = { key: '', abort: null };
  let best = null;
  let bestFor = null; // { id, auto } the "Better stream" line was made for

  const favorite = (item) => Boolean(item && deps.isFavorite(item.id));
  const shownCurrent = () => {
    const item = deps.getCurrentItem();
    return shownItem(item, favorite(item), deps.favoriteNames());
  };

  function view() {
    const item = deps.getCurrentItem();
    return nowPlayingView({
      item,
      favorite: favorite(item),
      names: deps.favoriteNames(),
      groups: item ? deps.favoriteGroups() : null,
      nowPlaying: deps.getNowPlaying(),
      stream: item ? deps.playedStream(item) : null,
      playedMs: item ? deps.playClock.played(item.id) : null,
      playing: deps.isPlaying(),
    });
  }

  /* -- The picture -- */
  function clearPicture() {
    artImg.removeAttribute('src');
    artImg.classList.remove('loaded');
    backdropImg.removeAttribute('src');
    backdrop.hidden = true;
    root.classList.remove('has-picture');
  }

  // The user's own station picture first, then the item's relay artwork,
  // resolved when needed (the same request the player bar makes). A picture
  // of the user's that will not load is marked failed by artwork.js, and the
  // station-pictures change below starts this again without it.
  async function loadPicture(item, shown, signal) {
    const options = { signal, priority: NOW_PLAYING_ART_PRIORITY };
    const custom = deps.customSourceFor(shown);
    if (custom) {
      try {
        await deps.loadImage(artImg, custom, options);
        return artImg.getAttribute('src') || '';
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') throw error;
      }
    }
    // Without this tab's signal: the player bar may wait on the same shared
    // lookup, and leaving the tab must not cancel it for the bar.
    if (!isArtworkRelayUrl(item.thumbnail)) {
      await deps.resolveArtwork(item, { priority: NOW_PLAYING_ART_PRIORITY });
    }
    if (signal.aborted) return '';
    const own = isArtworkRelayUrl(item.thumbnail) ? item.thumbnail.trim() : '';
    if (!own) return '';
    await deps.loadImage(artImg, own, options);
    return own;
  }

  // What the picture depends on: the item, the user's own picture and the
  // item's relay artwork, which can arrive after the first look (LibriVox
  // fills it in when its stream resolves, and the player sends the item again).
  function pictureKey(item, shown) {
    if (!item) return '';
    // The user's picture wins; one that fails is dropped by artwork.js, which
    // changes this key, so the relay artwork matters only without it.
    const custom = deps.customSourceFor(shown) || '';
    const own = !custom && isArtworkRelayUrl(item.thumbnail) ? item.thumbnail.trim() : '';
    return `${item.id}\u0000${custom}\u0000${own}`;
  }

  function syncPicture(item, force = false) {
    const shown = item ? shownItem(item, favorite(item), deps.favoriteNames()) : null;
    const key = pictureKey(item, shown);
    if (!force && key === picture.key) return;
    picture.abort?.abort();
    clearPicture();
    const mine = { key, abort: null };
    picture = mine;
    if (!item) return;
    const controller = new AbortController();
    mine.abort = controller;
    loadPicture(item, shown, controller.signal).then((url) => {
      if (destroyed || picture !== mine || controller.signal.aborted) return;
      mine.abort = null;
      // The lookup may have filled in the artwork meanwhile: key what was
      // really loaded, so the next render does not load it a second time.
      mine.key = pictureKey(item, shown);
      if (!url) return;
      artImg.classList.add('loaded');
      backdropImg.setAttribute('src', url);
      backdrop.hidden = false;
      root.classList.add('has-picture');
    }, () => {
      if (picture === mine) mine.abort = null;
    });
  }

  /* -- The parts -- */
  function renderFavorite(isFavorite) {
    const label = isFavorite ? NOW_PLAYING_TEXT.removeFavorite : NOW_PLAYING_TEXT.addFavorite;
    fav.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
    fav.setAttribute('aria-label', label);
    fav.title = label;
    fav.classList.toggle('is-fav', isFavorite);
  }

  function renderSong(songPart) {
    song.hidden = !songPart.show;
    setText(songText, songPart.text);
    songText.classList.toggle('is-none', !songPart.title);
    copyBtn.hidden = !songPart.title;
    if (!songPart.title) setText(copyStatus, '');
    if (songPart.title && songPart.title !== lastSong) {
      lastSong = songPart.title;
      // A station that sends its own name between songs is shown, not read out.
      if (announceable(songPart.title, shownCurrent())) setText(announcer, `Now playing: ${songPart.title}`);
    }
    songStar?.sync();
  }

  function renderFacts(rows) {
    const key = JSON.stringify(rows);
    if (key === factsKey) return;
    factsKey = key;
    facts.replaceChildren();
    for (const [label, value] of rows) {
      append(facts, append(make('div', 'np-fact'), make('dt', '', null, label), make('dd', '', null, value)));
    }
  }

  function syncBest(item) {
    const id = item?.id || '';
    const auto = bestStreamAutoOn(deps.getSettings?.() || {});
    if (bestFor && bestFor.id === id && bestFor.auto === auto) return;
    best?.destroy?.();
    best = null;
    bestHost.replaceChildren();
    bestFor = { id, auto };
    if (!item) return;
    // Its "Use the station's own stream" button removes itself: focus then
    // moves to the favorite star beside the name (this tab has no panel).
    best = deps.bestStream(item, { focusAfterUse: () => fav }) || null;
    if (best?.node) bestHost.appendChild(best.node);
  }

  function hidden() {
    return doc?.visibilityState === 'hidden';
  }

  function clearTick() {
    if (tick !== null) deps.clearTimer(tick);
    tick = null;
  }

  // One timer, only while the clock counts (the media really advances) and
  // the window is shown: it moves the "Playing for" line on when its minute
  // changes. Buffering stops the clock, and with it this timer.
  function syncTick() {
    clearTick();
    if (destroyed || !current || hidden()) return;
    if (!deps.playClock.running || deps.playClock.itemId !== current.id) return;
    const played = deps.playClock.played(current.id);
    tick = deps.setTimer(() => {
      tick = null;
      if (destroyed) return;
      renderFacts(view().rows || []);
      syncTick();
    }, msToNextMinute(played ?? 0) + 50);
  }

  function render() {
    if (destroyed) return;
    const item = deps.getCurrentItem();
    const v = view();
    current = item || null;
    root.dataset.state = v.empty ? 'empty' : 'playing';
    empty.hidden = !v.empty;
    layout.hidden = v.empty;
    if (v.empty) {
      syncPicture(null);
      syncBest(null);
      renderFacts([]);
      clearTick();
      return;
    }
    setText(kind, v.kind);
    kind.hidden = !v.kind;
    setText(title, v.name);
    setText(original, v.originalName ? `Original name: ${v.originalName}` : '');
    original.hidden = !v.originalName;
    setText(category, v.category ? `Category: ${v.category}` : '');
    category.hidden = !v.category;
    renderFavorite(v.favorite);
    setText(artInitials, v.initials);
    artInitials.hidden = !v.initials;
    art.style?.setProperty?.('--ph-hue', String(v.hue));
    art.classList.toggle('is-logo', v.logo);
    renderSong(v.song);
    renderFacts(v.rows);
    syncPicture(item);
    syncBest(item);
    syncTick();
  }

  /* -- Controls -- */
  listen(libraryBtn, 'click', () => deps.openMode('library'));
  listen(tunerBtn, 'click', () => deps.openMode('tuner'));
  listen(fav, 'click', () => {
    const item = deps.getCurrentItem();
    if (!item) return;
    if (deps.isFavorite(item.id)) deps.removeFavorite(item.id);
    else deps.addFavorite(item);
    render();
  });
  listen(copyBtn, 'click', async () => {
    const text = songView(deps.getCurrentItem(), deps.getNowPlaying()).title;
    if (!text) return;
    try {
      if (typeof deps.clipboard?.writeText !== 'function') throw new Error('unavailable');
      await deps.clipboard.writeText(text);
    } catch (_) {
      if (!destroyed) setText(copyStatus, COPY_FAILED);
      return;
    }
    if (destroyed) return;
    setText(copyBtn, COPIED_LABEL);
    setText(copyStatus, COPIED_LABEL);
    if (copyTimer !== null) deps.clearTimer(copyTimer);
    copyTimer = deps.setTimer(() => {
      copyTimer = null;
      if (destroyed) return;
      setText(copyBtn, COPY_LABEL);
      if (copyStatus.textContent === COPIED_LABEL) setText(copyStatus, '');
    }, COPIED_MS);
  });

  // The star for the song: the player bar's own rules (song-star.js), so it
  // shows only when what is announced looks like a song.
  const songStar = deps.bindSongStar({
    button: songStarBtn,
    starred: deps.starred,
    getNowPlaying: deps.getNowPlaying,
    getCurrentItem: shownCurrent,
    subscribe: deps.subscribe,
  });
  stops.push(() => songStar?.destroy?.());

  // The large sound meter: the player bar's meter with bigger LEDs, on the
  // same shared signal. It listens only while laid out and allowed to move,
  // and the signal itself runs only while something plays and the window is
  // shown, so a paused, stopped or hidden tab draws nothing.
  const meter = deps.createMeter({
    root: meterBox,
    canvas,
    signal: deps.signal,
    win: deps.win,
    doc,
    segments: NOW_PLAYING_METER_SEGMENTS,
  });
  stops.push(() => meter?.destroy?.());

  /* -- Events -- */
  const on = (event, fn) => {
    const stop = deps.subscribe(event, fn);
    if (typeof stop === 'function') stops.push(stop);
  };
  on('current-item', render);
  on('playing-change', render);
  // The clock starts and stops with this (play-clock.js), and the timer too.
  on(MEDIA_ADVANCING_EVENT, render);
  on(NOW_PLAYING_EVENT, render);
  on('favorites-change', render);
  on(FAVORITE_GROUPS_EVENT, render);
  // The stream that plays is known once the relay has connected.
  on('media-relay', render);
  on('settings-change', render);
  const stopPictures = deps.onStationImagesChange?.(() => {
    if (!destroyed) syncPicture(deps.getCurrentItem());
  });
  if (typeof stopPictures === 'function') stops.push(stopPictures);
  if (doc?.addEventListener) {
    const onVisibility = () => { if (!destroyed) render(); };
    doc.addEventListener('visibilitychange', onVisibility);
    stops.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  }

  render();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTick();
    if (copyTimer !== null) deps.clearTimer(copyTimer);
    copyTimer = null;
    picture.abort?.abort();
    picture = { key: '', abort: null };
    best?.destroy?.();
    best = null;
    for (const stop of stops.splice(0).reverse()) {
      try { stop(); } catch (_) { /* the rest still runs */ }
    }
    root.remove?.();
  }

  return {
    root,
    refresh: render,
    destroy,
    meter,
    parts: {
      empty, layout, title, kind, original, category, fav, song, songText, songStarBtn, copyBtn, copyStatus,
      announcer, facts, bestHost, art, artImg, artInitials, backdrop, backdropImg, meterBox, canvas, libraryBtn, tunerBtn,
    },
    get timerPending() { return tick !== null || copyTimer !== null; },
    get pictureLoading() { return Boolean(picture.abort); },
    get destroyed() { return destroyed; },
  };
}

/* ---------------- Mode registration ---------------- */

let session = null;
const subs = [];

function tearDown() {
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
  if (session) {
    const current = session;
    session = null;
    try { current.destroy(); } catch (error) { console.error('Now Playing teardown failed:', error); }
  }
}

export function renderNowPlaying(host, options = {}) {
  tearDown();
  session = mountNowPlaying(host, options);
  const on = options.subscribe || appSubscribe;
  subs.push(on('mode-change', (mode) => {
    if (mode !== NOW_PLAYING_MODE) tearDown();
  }));
}

/** For tests: whether the tab is mounted right now. */
export function nowPlayingMounted() { return Boolean(session); }
