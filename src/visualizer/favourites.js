/**
 * Favourites: starred scene + look + post effects + overlays, kept in the
 * `visualizerFavourites` setting as short strings ("sceneId" for a scene
 * without looks, else "sceneId:look", then "|fx+fx" when post effects were
 * on, then "/ov+ov" when overlays were on: their saved tokens, with any
 * blend-in, overlay-catalog.js overlayToken; lib/visualizer-settings.js),
 * oldest first, at most VISUALIZER_FAVOURITES_MAX. Strings from before post
 * effects (no "|") are read as they are: that scene and look with no effects;
 * strings from before overlays (no "/") as no overlays. A new star is always
 * kept: when the list is full, room is made by dropping favourites of scenes
 * this build does not have, then the oldest (as for the looks setting).
 */

import {
  VISUALIZER_FAVOURITES_MAX, normalizeVisualizerFavourites, olderReleaseReadsFavourite, parseVisualizerFavourite,
} from '../lib/visualizer-settings.js';
import { overlayToken, readOverlayToken } from './overlay-catalog.js';

const tokenOf = (item) => (typeof item === 'string' ? item : overlayToken(item));

/** The string for scene `scene` at look `look` (null or undefined: none)
 *  with post effects `fx` (ids in chain order; none: no "|" part) and
 *  overlays `overlays` ([{ id, blend }] or saved tokens, in the table's
 *  order; none: no "/" part). */
export function favouriteKey(scene, look, fx = null, overlays = null) {
  const base = Number.isInteger(look) ? `${scene}:${look}` : scene;
  const withFx = Array.isArray(fx) && fx.length ? `${base}|${fx.join('+')}` : base;
  return Array.isArray(overlays) && overlays.length ? `${withFx}/${overlays.map(tokenOf).join('+')}` : withFx;
}

/** [{ scene, look, fx, overlays }] of the setting's strings (shape-checked;
 *  overlays as [{ id, blend }]: a blend-in this build does not know is read
 *  as plain, overlay-catalog.js readOverlayToken). The whole list
 *  (visualizerFavouritesAll), newer favourites with the rest. */
export function favouriteEntries(list) {
  return normalizeVisualizerFavourites(list).map((item) => {
    const entry = parseVisualizerFavourite(item);
    return { ...entry, overlays: entry.overlays.map((token) => readOverlayToken(token)) };
  });
}

export function isFavourite(list, scene, look, fx = null, overlays = null) {
  return Array.isArray(list) && list.includes(favouriteKey(scene, look, fx, overlays));
}

/** The look numbers starred for `scene` (an empty list when none, or when
 *  only the scene without a look is starred). */
export function favouriteLooks(list, scene) {
  return [...new Set(favouriteEntries(list).filter((entry) => entry.scene === scene && entry.look !== null).map((entry) => entry.look))];
}

/** The post effect sets starred with `scene` at `look` (each a list of ids;
 *  an empty list is "no effects"). */
export function favouriteFx(list, scene, look) {
  return favouriteCombos(list, scene, look).map((combo) => combo.fx);
}

/** The effects and overlays starred together with `scene` at `look`:
 *  [{ fx, overlays }] (the exact combinations, "none" too). */
export function favouriteCombos(list, scene, look) {
  const wanted = Number.isInteger(look) ? look : null;
  return favouriteEntries(list).filter((entry) => entry.scene === scene && entry.look === wanted)
    .map((entry) => ({ fx: entry.fx, overlays: entry.overlays }));
}

/** The favourite of `scene` to bring back when it is picked by hand from
 *  the favourites: { scene, look, fx, overlays }, or null when none is
 *  starred. The one after `shownKey` (favouriteKey of what is shown now) in
 *  the order starred, so picking the scene again steps through its
 *  favourites; the first when what is shown is none of them. */
export function favouriteToRecall(list, scene, shownKey = null) {
  const entries = favouriteEntries(list).filter((entry) => entry.scene === scene);
  if (!entries.length) return null;
  const at = entries.findIndex((entry) => favouriteKey(entry.scene, entry.look, entry.fx, entry.overlays) === shownKey);
  return entries[(at + 1) % entries.length];
}

/** `list` with each favourite's effects as its scene draws them
 *  (`drawnFor(scene, fx)`: fx-catalog.js fxDrawnFor for that scene), and its
 *  overlays likewise (`overlaysFor(scene, overlays)`: overlay-catalog.js
 *  overlaysDrawnFor; none: as saved), so the star always matches what is
 *  drawn; a favourite that becomes the same as an earlier one is dropped (the
 *  earlier kept). The same strings, in the same order, when nothing changes. */
export function favouritesAsDrawn(list, drawnFor, overlaysFor = null) {
  const out = [];
  for (const entry of favouriteEntries(list)) {
    const overlays = overlaysFor ? overlaysFor(entry.scene, entry.overlays) : entry.overlays;
    const key = favouriteKey(entry.scene, entry.look, drawnFor(entry.scene, entry.fx), overlays);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The whole list of favourites from the two saved fields
 *  (lib/visualizer-settings.js): `older` (visualizerFavourites, the ones
 *  release 0.1.12 reads, as it last left them) and `all`
 *  (visualizerFavouritesAll, the whole list as this build last saved it;
 *  not a list: `older` is the whole list), each favourite in the form it is
 *  drawn (favouritesAsDrawn, with the same `drawnFor` and `overlaysFor`).
 *  0.1.12's tab rewrites a favourite it reads into that same form, so the
 *  two are compared in it:
 *  - one of `all` that 0.1.12 reads (it was in its field) stays only while
 *    its drawn form is in `older`: when it is not, it was taken off there;
 *  - one that 0.1.12 does not read is kept (it never saw it);
 *  - two that come to the same form are one favourite, in the earlier one's
 *    place (as 0.1.12's tab merges them);
 *  - one of `older` found nowhere in `all` was starred there: it goes after
 *    the one before it in `older` and any newer ones that follow that one
 *    (0.1.12 adds a new star at the end).
 *  At most VISUALIZER_FAVOURITES_MAX, both kinds counted; when stars added
 *  in 0.1.12 make it longer, the oldest go. */
export function favouritesFromSaved(older, all, drawnFor, overlaysFor = null) {
  const kept = favouritesAsDrawn(older, drawnFor, overlaysFor);
  if (!Array.isArray(all)) return kept;
  const there = new Set(kept);
  const out = [];
  for (const item of normalizeVisualizerFavourites(all)) {
    const drawn = favouritesAsDrawn([item], drawnFor, overlaysFor)[0];
    if (out.includes(drawn)) continue;
    if (olderReleaseReadsFavourite(item) && !there.has(drawn)) continue;
    out.push(drawn);
  }
  let at = 0;
  for (const item of kept) {
    const found = out.indexOf(item);
    if (found >= 0) {
      at = found + 1;
      continue;
    }
    while (at < out.length && !there.has(out[at])) at += 1;
    out.splice(at, 0, item);
    at += 1;
  }
  return out.length > VISUALIZER_FAVOURITES_MAX ? out.slice(out.length - VISUALIZER_FAVOURITES_MAX) : out;
}

/** `list` with scene + look + effects + overlays starred (`on` true) or not.
 *  `known`: the scene ids this build has (for making room). */
export function withFavourite(list, scene, look, on, known = null, fx = null, overlays = null) {
  const key = favouriteKey(scene, look, fx, overlays);
  const next = normalizeVisualizerFavourites(list).filter((item) => item !== key);
  if (!on) return next;
  const knownIds = known ? new Set(known) : null;
  while (next.length >= VISUALIZER_FAVOURITES_MAX) {
    const unknown = knownIds ? next.findIndex((item) => !knownIds.has(parseVisualizerFavourite(item).scene)) : -1;
    next.splice(unknown >= 0 ? unknown : 0, 1);
  }
  next.push(key);
  return next;
}
