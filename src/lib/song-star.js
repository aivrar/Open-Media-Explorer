/**
 * The star for the song playing now, on the player bar next to the song line
 * (#player-song-star in index.html). It is shown only while the playing
 * station announces a song that can be starred, and it is pressed while that
 * song is starred (starred-songs.js). Event driven: it changes only when the
 * song, the playing item or the starred list changes; nothing polls.
 */

import { NOW_PLAYING_EVENT } from './now-playing.js';
import { songStarBlock } from './starred-songs.js';

/**
 * @param {object} options
 * @param {HTMLButtonElement} options.button
 * @param {object} options.starred the starred songs store
 * @param {() => object|null} options.getNowPlaying { itemId, title } or null
 * @param {() => object|null} options.getCurrentItem the playing item
 * @param {(event: string, fn: Function) => Function} options.subscribe state.js's
 * @returns {{ sync: () => void, song: () => object|null, destroy: () => void }}
 */
export function bindSongStar({ button, starred, getNowPlaying, getCurrentItem, subscribe }) {
  if (!button) return { sync() {}, song: () => null, destroy() {} };

  /** The song playing now as { title, station, stationId, source }, or null. */
  function song() {
    const playing = getNowPlaying?.() || null;
    const item = getCurrentItem?.() || null;
    if (!playing?.title || !item || playing.itemId !== item.id) return null;
    const station = typeof item.title === 'string' ? item.title : '';
    if (songStarBlock(playing.title, station)) return null;
    // A renamed favorite: the station's own name is not a song either.
    if (item.__favoriteName === true && songStarBlock(playing.title, item.originalTitle || '')) return null;
    return {
      title: playing.title,
      station,
      stationId: typeof item.id === 'string' ? item.id : '',
      source: typeof item.source === 'string' ? item.source : '',
    };
  }

  function sync() {
    const current = song();
    button.hidden = !current;
    if (!current) return;
    const on = Boolean(starred.starredFor(current));
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList?.toggle?.('is-starred', on);
    button.title = on ? `Unstar "${current.title}"` : `Star "${current.title}"`;
    button.setAttribute('aria-label', button.title);
  }

  const onClick = () => {
    const current = song();
    if (!current) return;
    starred.toggle(current);
    sync();
  };
  button.addEventListener('click', onClick);
  const unbind = [
    subscribe?.(NOW_PLAYING_EVENT, sync),
    starred.onChange(sync),
  ];
  sync();
  return {
    sync,
    song,
    destroy() {
      button.removeEventListener('click', onClick);
      for (const off of unbind) if (typeof off === 'function') off();
    },
  };
}
