/**
 * How long the item that is loaded now has been playing, for the Now Playing
 * tab. Only time the media really advances counts: connecting, buffering
 * (the element's `waiting`), a pause, a reconnect wait or an error add
 * nothing. A different item (or Stop) starts from zero; the same item
 * started again keeps its time.
 *
 * The player publishes whether its media is advancing as MEDIA_ADVANCING_EVENT
 * (true from the element's `playing` event until `waiting`, a pause, the end,
 * an error or Stop). The clock follows that and 'current-item' and keeps two
 * numbers; nothing polls and no timer runs. Time is read from a monotonic
 * clock, so a change of the computer's clock never adds or removes time.
 */

/** state.js event: the player's media advances (true) or not (false). */
export const MEDIA_ADVANCING_EVENT = 'media-advancing';

const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

export function createPlayClock({ now = monotonicNow } = {}) {
  let itemId = '';
  let total = 0; // ms played before the current spell of playback
  let since = null; // clock ms the current spell of playback began, or null

  function itemChanged(item) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (id === itemId) return;
    itemId = id;
    total = 0;
    since = null;
  }

  /** The media started (true) or stopped (false) advancing. */
  function advancingChanged(advancing, item = undefined) {
    if (item !== undefined) itemChanged(item);
    if (advancing === true) {
      if (itemId && since === null) since = now();
      return;
    }
    if (since !== null) {
      total += Math.max(0, now() - since);
      since = null;
    }
  }

  /** Milliseconds `id` has played, or null when it is not the loaded item
   *  or has not played yet. */
  function played(id) {
    if (!id || id !== itemId) return null;
    if (since === null && total === 0) return null;
    return total + (since === null ? 0 : Math.max(0, now() - since));
  }

  /** Follow the app's events. `isAdvancing` reads the player's state now
   *  (player.js isMediaAdvancing). Returns a function that stops following. */
  function start(subscribe, getCurrentItem = () => null, isAdvancing = () => false) {
    itemChanged(getCurrentItem());
    if (isAdvancing()) advancingChanged(true);
    const stops = [
      subscribe('current-item', (item) => itemChanged(item)),
      subscribe(MEDIA_ADVANCING_EVENT, (advancing) => advancingChanged(advancing === true, getCurrentItem())),
    ];
    return () => { for (const stop of stops.splice(0)) if (typeof stop === 'function') stop(); };
  }

  return {
    itemChanged,
    advancingChanged,
    played,
    start,
    get itemId() { return itemId; },
    get running() { return since !== null; },
  };
}

/** The app's clock; main.js starts it once. */
export const playClock = createPlayClock();
