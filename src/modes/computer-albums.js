import { computerArtSource, computerArtworkTile, loadArtworkImage } from '../lib/artwork.js';
import { discNumber, durationTooltip, entrySearch, pluralCount, totalLengthText } from '../lib/computer-catalog.js';
import { COMPUTER_OFFLINE_TOOLTIP } from '../lib/computer-play.js';
import { mountComputerWindow } from './computer-window.js';
import { mountComputerTable, trackColumns } from './computer-table.js';
import { computerFileStar, computerGroupStar } from './computer-star.js';

const CARD_WIDTH = 156;
const CARD_HEIGHT = 230;
const CARD_GAP = 12;
const COMPACT_CARD_WIDTH = 170;
const ARTIST_CARD_WIDTH = 224;
const ARTIST_CARD_HEIGHT = 74;

const songCount = (count) => pluralCount(count, 'song');

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function computerCover(doc, item, { priority = 10, loadImage = loadArtworkImage, poster = false, large = false } = {}) {
  const tile = computerArtworkTile(doc, item.title);
  if (poster) tile.classList.add('computer-poster');
  const source = !item.error && computerArtSource(item.artEntryId, { large });
  if (!source) return { tile };

  const img = doc.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  tile.append(img);
  const controller = new AbortController();
  const { signal } = controller;
  // The row is inserted before the shared loader checks that it is connected.
  Promise.resolve().then(() => {
    if (!signal.aborted) return loadImage(img, source, { priority, signal });
  }).then(() => {
    if (!signal.aborted) img.classList.add('loaded');
  }).catch(() => {
    if (!signal.aborted) img.classList.add('errored');
  });
  return { tile, dispose() {
    controller.abort();
    img.removeAttribute('src');
  } };
}

export function mountAlbumGrid(host, options) {
  return mountComputerCards(host, {
    ...options, label: 'Albums',
    describe(album) {
      const facts = [album.year, songCount(album.tracks.length), totalLengthText(album)].filter(Boolean);
      return {
        subtitle: album.artist,
        facts: options.artist
          ? facts.map((part) => String(part).replaceAll(' ', '\u00a0')).join(' ·\u00a0')
          : facts.join(' · '),
        factsTooltip: durationTooltip(album),
      };
    },
  });
}

export function mountComputerCards(host, {
  onOpen, onPlay, selected, loadImage, windowOptions, label, describe, fileEntry, offline,
  poster = false, width = CARD_WIDTH, height = CARD_HEIGHT, artist, compact,
}) {
  const doc = host.ownerDocument;
  const viewport = element(doc, 'div', 'computer-viewport computer-album-scroll');
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', label);
  const space = element(doc, 'div', 'computer-grid-space');
  const cards = element(doc, 'div', 'computer-album-grid');
  space.append(cards);
  viewport.append(space);
  host.append(viewport);
  let items = [];
  const cardWidth = () => artist ? ARTIST_CARD_WIDTH : width;
  const stride = () => (artist ? ARTIST_CARD_HEIGHT : height) + CARD_GAP;
  if (poster) viewport.classList.add('computer-poster-scroll');
  if (artist) viewport.classList.add('computer-artist-albums');

  function mark(card, item) {
    if (selected) card.setAttribute('aria-pressed', String(selected(item)));
  }

  const windowed = mountComputerWindow(viewport, cards, {
    ...windowOptions,
    stride,
    columnWidth: cardWidth,
    columnGap: CARD_GAP,
    horizontalStride: () => artist && compact?.matches ? COMPACT_CARD_WIDTH + CARD_GAP : 0,
    indexOfKey: (key) => items.findIndex((item) => item.key === key),
    placeWindow({ start, total, columns, horizontal, step }) {
      const size = `${Math.max(0, total - CARD_GAP)}px`;
      space.style.width = horizontal ? size : '';
      space.style.height = horizontal ? 'var(--computer-artist-card-height)' : size;
      cards.style.top = horizontal ? '0' : `${start / columns * step}px`;
      cards.style.left = horizontal ? `${start * step}px` : '';
      cards.style.right = horizontal ? 'auto' : '';
      cards.style.gridAutoColumns = horizontal ? `${step - CARD_GAP}px` : '';
      cards.style.gridTemplateColumns = horizontal ? '' : `repeat(${columns}, minmax(0, ${cardWidth()}px))`;
    },
    makeRow(index) {
      const item = items[index];
      const { subtitle, subtitleTooltip, facts, factsTooltip, badges } = describe(item);
      const disconnected = offline?.(item.entry);
      const error = disconnected ? COMPUTER_OFFLINE_TOOLTIP : item.error;
      const card = element(doc, 'button', 'card computer-album-card');
      card.type = 'button';
      card.style.height = artist ? 'var(--computer-artist-card-height)' : `${height}px`;
      card.title = error || [item.title, subtitle].filter(Boolean).join(' · ');
      card.classList.toggle('has-error', Boolean(error));
      const { tile, dispose } = computerCover(doc, error ? { ...item, error } : item, { loadImage, poster });
      const body = element(doc, 'span', 'computer-card-body');
      const title = element(doc, 'span', 'computer-card-title', item.title);
      title.title = disconnected ? error : item.title;
      const caption = element(doc, 'span', 'computer-card-artist', subtitle);
      if (subtitle) caption.title = disconnected ? error : subtitleTooltip || subtitle;
      body.append(title, caption);
      const foot = element(doc, 'span', badges ? 'computer-card-facts computer-badges' : 'computer-card-facts', facts);
      if (facts) foot.title = disconnected ? error : factsTooltip || facts;
      for (const badge of badges || []) {
        const label = element(doc, 'span', 'computer-badge', badge);
        label.title = disconnected ? error : badge;
        foot.append(label);
      }
      body.append(foot);
      card.append(tile, body);
      mark(card, item);
      card.addEventListener('click', () => onOpen(item, index));
      if (onPlay) {
        card.addEventListener('dblclick', () => onPlay(item));
        card.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (!event.repeat) onPlay(item);
        });
      }
      const entry = fileEntry?.(item);
      if (!entry) return { node: card, key: item.key, item, dispose };
      const wrapper = element(doc, 'div', 'computer-file-card');
      const star = computerFileStar(card, entry, item.title);
      wrapper.append(card, star.button);
      return { node: wrapper, focusNode: card, key: item.key, item, dispose, star: star.button, syncStar: star.sync };
    },
  });

  return {
    viewport,
    position: windowed.position,
    focus: windowed.focus,
    focusedRow: windowed.focusedRow,
    update(next, top, restoreFocus) {
      items = next;
      windowed.update(items.length, top, restoreFocus);
    },
    markSelection() { windowed.forEachRow(({ node, focusNode, item }) => mark(focusNode || node, item)); },
    markFavorites() { windowed.forEachRow(({ syncStar }) => syncStar?.()); },
    destroy() { windowed.destroy(); viewport.remove(); },
  };
}

export function mountAlbumPage(host, album, {
  onBack, onPlay, currentId, technical, loadImage, windowOptions, restoreFocus, scrollTop, query = '', empty, offline, onOffline,
}) {
  const doc = host.ownerDocument;
  const page = element(doc, 'section', 'computer-album-page');
  page.setAttribute('aria-label', album.title);
  const back = element(doc, 'button', 'btn computer-album-back', 'Back');
  back.type = 'button';
  back.addEventListener('click', onBack);
  const hero = element(doc, 'div', 'computer-album-hero');
  const { tile, dispose } = computerCover(doc, album, { priority: 30, loadImage });
  const details = element(doc, 'div', 'computer-album-details');
  const actions = element(doc, 'div', 'computer-album-actions');
  const play = element(doc, 'button', 'btn btn-primary', 'Play');
  const shuffle = element(doc, 'button', 'btn', 'Shuffle');
  play.type = shuffle.type = 'button';
  play.addEventListener('click', () => onPlay(0));
  shuffle.addEventListener('click', () => onPlay(Math.floor(Math.random() * album.tracks.length), { shuffle: true }));
  const star = computerGroupStar(doc, album.tracks, 'album');
  actions.append(play, shuffle, star.button);
  const albumTitle = element(doc, 'h2', 'computer-detail-title', album.title);
  albumTitle.title = album.title;
  if (album.error) hero.title = album.error;
  if (album.error) albumTitle.classList.add('has-error');
  const facts = element(doc, 'div', 'computer-quiet', [
    album.year, album.genre, songCount(album.tracks.length), totalLengthText(album),
  ].filter(Boolean).join(' · '));
  const tooltip = durationTooltip(album);
  if (tooltip) facts.title = tooltip;
  details.append(
    albumTitle,
    element(doc, 'div', 'computer-album-artist', album.artist),
    facts,
    element(doc, 'div', 'computer-album-format', album.format === 'Mixed' ? 'Mixed formats' : album.formatDetails),
    actions,
  );
  hero.append(tile, details);
  page.append(back, hero);
  host.append(page);

  const table = mountComputerTable(page, {
    columns: trackColumns(album), label: 'Album tracks', layout: 'tracks',
    onPlay, currentId, technical, windowOptions, offline, onOffline,
  });
  const tracks = album.tracks.map((entry, index) => ({ entry, index, disc: discNumber(entry) }));
  const showDiscs = tracks[0]?.disc !== tracks.at(-1)?.disc;
  const screen = {
    updateQuery(text, location) {
      const matches = entrySearch(text);
      const rows = [];
      let lastDisc;
      let visible = 0;
      for (const track of tracks) {
        if (matches && !matches(track.entry)) continue;
        if (showDiscs && track.disc !== lastDisc) rows.push({ heading: `Disc ${track.disc}` });
        lastDisc = track.disc;
        rows.push(track);
        visible++;
      }
      table.update(rows, undefined, location?.top, location?.key == null ? null : location);
      screen.empty = visible ? '' : empty?.('songs') || '';
    },
    focus: () => back.focus(),
    viewport: table.viewport,
    focusedRow: table.focusedRow,
    markPlaying: table.markPlaying,
    markFavorites() { star.sync(); table.markFavorites(); },
    destroy() { dispose?.(); table.destroy(); page.remove(); },
  };
  screen.updateQuery(query, { ...restoreFocus, top: scrollTop });
  return screen;
}
