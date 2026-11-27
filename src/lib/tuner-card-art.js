/**
 * Pictures on the Tuner's medium and large station cards.
 *
 * The list renders only rows near its viewport. Station logos may come from
 * third-party servers, so pictures wait until the dial and list come to rest:
 *
 *  - Each card gets a fixed-size picture box with the station's initials on
 *    its colour (as in the Library and the player bar). A picture that is
 *    slow, fails, or does not exist never changes any size.
 *  - Nothing loads until the list window has been still for TUNER_ART_SETTLE_MS.
 *    Every rebuild (a step) or list scroll starts that wait again, so a fast
 *    turn through 100 stations asks for nothing until it stops.
 *  - Then only the cards actually in view start, each at most once. A load in
 *    flight for a card still in the list window is left alone; a card that leaves
 *    the list window stops its load (and starts again only once it is back in view).
 *  - Boxes are kept per station and moved into the rebuilt card, so a loaded
 *    picture stays on screen on each step without flicker or a new request.
 *    The last TUNER_ART_KEEP finished boxes are kept for when the dial comes
 *    back, including those that ended without a picture (no retries).
 *
 * Every picture goes through artwork.js: the user's own station picture
 * first (shown whole: is-station-image), then the station's relay artwork,
 * resolved through the backend when needed, in the shared bounded queues.
 */

import {
  artworkSourceFor, isStationImageSource, loadArtworkImage, resolveArtworkRelay,
} from './artwork.js';
import { stationImageSourceFor } from './station-images.js';
import { artworkInitials, initialsHue } from './initials.js';

export const TUNER_ART_SETTLE_MS = 350;
export const TUNER_ART_KEEP = 120;
export const TUNER_ART_PRIORITY = 15;

/**
 * One controller per Tuner. Build a list window by asking `box(item)` for each
 * card, then call `commit()`. `isInView(box)` says whether a card's box is in
 * the visible part of the list window; it is asked only once the list window has settled.
 * The other options exist for tests.
 */
export function createTunerCardArt({
  doc = globalThis.document,
  isInView = () => true,
  allowed = () => true,
  load = loadArtworkImage,
  resolve = resolveArtworkRelay,
  sourceFor = artworkSourceFor,
  customSourceFor = stationImageSourceFor,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  settleMs = TUNER_ART_SETTLE_MS,
  keep = TUNER_ART_KEEP,
} = {}) {
  // Station id -> entry, least recently shown first.
  const entries = new Map();
  let building = [];
  let shown = [];
  let timer = null;
  const stats = { started: 0, stopped: 0, rechecked: 0 };

  function makeBox(item) {
    const node = doc.createElement('span');
    node.className = 'pill-art';
    node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--ph-hue', String(initialsHue(item?.title)));
    const initials = doc.createElement('span');
    initials.className = 'pill-initials';
    // Upper-casing can lengthen a title (a sharp s or a ligature becomes two or
    // three letters), and four letters is the most the box fits.
    const letters = [...artworkInitials(item?.title)].slice(0, 4);
    initials.textContent = letters.join('');
    // tuner.css sizes three and four letters down so they fit the box.
    initials.setAttribute('data-length', String(letters.length));
    node.appendChild(initials);
    return node;
  }

  function removeImage(entry) {
    entry.img?.remove();
    entry.img = null;
  }

  function stop(entry) {
    if (entry.state !== 'loading') return;
    entry.abort?.abort();
    entry.abort = null;
    removeImage(entry);
    entry.state = 'idle';
    entry.recheck = false;
    stats.stopped += 1;
  }

  /** The picture box for a card of the list window being built now. */
  function box(item) {
    const key = String(item?.id ?? '');
    let entry = entries.get(key);
    // The same station twice in one list window: the second card gets a plain box.
    if (entry && building.includes(entry)) return makeBox(item);
    if (entry) {
      entries.delete(key);
      entry.item = item;
    } else {
      entry = {
        key, item, box: makeBox(item), img: null, state: 'idle', abort: null, custom: '', recheck: false,
      };
    }
    entries.set(key, entry);
    building.push(entry);
    return entry.box;
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  /** (Re)start the wait before pictures load: on every rebuild and scroll. */
  function poke() {
    cancelTimer();
    timer = setTimer(() => { timer = null; settle(); }, settleMs);
  }

  /** The list window now holds the boxes asked for since the last commit. */
  function commit() {
    shown = building;
    building = [];
    const current = new Set(shown);
    for (const entry of [...entries.values()]) {
      if (current.has(entry)) continue;
      // Off the list window: stop its load, and forget a box that never started.
      stop(entry);
      if (entry.state === 'idle') entries.delete(entry.key);
    }
    let excess = entries.size - keep;
    for (const entry of [...entries.values()]) {
      if (excess <= 0) break;
      if (current.has(entry)) continue;
      entries.delete(entry.key);
      excess -= 1;
    }
    poke();
  }

  function show(entry, source, signal) {
    const img = doc.createElement('img');
    img.className = 'pill-art-img';
    img.setAttribute('alt', '');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    entry.box.appendChild(img);
    entry.img = img;
    return load(img, source, { signal, priority: TUNER_ART_PRIORITY }).then(() => {
      if (!(img.naturalWidth > 0)) throw new Error('Artwork image decoded without pixels.');
      img.classList.add('loaded');
    }).catch((error) => {
      if (entry.img === img) removeImage(entry);
      throw error;
    });
  }

  /** The station's own artwork (a relay URL), resolved first when needed. */
  async function ownArtwork(entry, signal) {
    let source = sourceFor(entry.item);
    if (!source) {
      await resolve(entry.item, { priority: TUNER_ART_PRIORITY, signal });
      if (signal.aborted) return false;
      source = sourceFor(entry.item);
    }
    if (!source || isStationImageSource(source)) return false;
    await show(entry, source, signal);
    return true;
  }

  async function start(entry) {
    const controller = new AbortController();
    const { signal } = controller;
    entry.abort = controller;
    entry.state = 'loading';
    entry.recheck = false;
    entry.custom = customSourceFor(entry.item) || '';
    stats.started += 1;
    let done = false;
    try {
      const source = allowed(entry.item) ? sourceFor(entry.item) : null;
      if (source === null) {
        done = false;
      } else if (isStationImageSource(source)) {
        try {
          await show(entry, source, signal);
          done = true;
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error;
          // artwork.js marked the picture failed: show the station's own artwork.
          entry.custom = '';
          done = await ownArtwork(entry, signal);
        }
      } else {
        done = await ownArtwork(entry, signal);
      }
    } catch (_) {
      done = false;
    }
    if (entry.abort !== controller) return; // Stopped meanwhile.
    entry.abort = null;
    entry.state = done ? 'loaded' : 'none';
    // The station pictures changed while this card loaded: once more, now,
    // if its picture is a different one (only this card, after the usual wait).
    if (entry.recheck) {
      entry.recheck = false;
      if ((customSourceFor(entry.item) || '') !== entry.custom) {
        removeImage(entry);
        entry.state = 'idle';
        stats.rechecked += 1;
        poke();
      }
    }
  }

  /** The list window is still: start the cards in view that have not started. */
  function settle() {
    for (const entry of shown) {
      if (entry.state !== 'idle' || entries.get(entry.key) !== entry) continue;
      if (!isInView(entry.box)) continue;
      void start(entry);
    }
  }

  /** The station pictures changed (startup list, Refresh). Forget finished
   *  boxes whose picture is a different one now; true when the list window should
   *  be rebuilt to start them again. A card still loading is marked and
   *  checked again when its load settles (start). */
  function stationImagesChanged() {
    let changed = false;
    for (const entry of [...entries.values()]) {
      if (entry.state === 'loading') entry.recheck = true;
      if (entry.state !== 'loaded' && entry.state !== 'none') continue;
      if ((customSourceFor(entry.item) || '') === entry.custom) continue;
      entries.delete(entry.key);
      changed = true;
    }
    return changed;
  }

  /** Stop everything and forget every box (Small chosen, Tuner left). */
  function clear() {
    cancelTimer();
    for (const entry of entries.values()) stop(entry);
    entries.clear();
    building = [];
    shown = [];
  }

  return {
    box, commit, poke, settle, clear, stationImagesChanged,
    get size() { return entries.size; },
    get pending() { return timer !== null; },
    stats,
  };
}
