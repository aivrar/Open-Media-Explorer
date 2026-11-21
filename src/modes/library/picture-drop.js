/**
 * A picture dropped on a station's card in the Library becomes that station's
 * picture (station-image-files.js does the work, with the same checks and
 * question as "Choose picture..." in the details panel). Only the user's own
 * stations take one: favorites and stations of My Playlists. A picture dropped
 * anywhere else, or on another card, changes nothing and says where to drop it.
 * The window's drop handler (lib/playlist-drop.js) calls these.
 */

import { getState } from '../../lib/state.js';
import { isSavedItem } from '../../lib/did-not-play-view.js';
import { PICTURE_DROP_HINT, saveStationPicture, stationOwnName } from '../../lib/station-image-files.js';
import { ui } from './shell-refs.js';

const SHOWN_NAME_LENGTH = 60;

/** The station whose card `target` is on, when it can take a picture. */
export function pictureDropItem(target) {
  if (getState().mode !== 'library') return null;
  const card = target?.closest?.('.card[data-id]');
  if (!card || !ui.resultsHost?.contains?.(card)) return null;
  const item = card.__item;
  if (!item?.id || item.__contentHidden === true || !isSavedItem(item.id)) return null;
  return item;
}

/** What the drop hint says while a picture is dragged over `target`. */
export function pictureDropText(target) {
  const item = pictureDropItem(target);
  if (!item) return PICTURE_DROP_HINT;
  const name = stationOwnName(item).trim();
  const shown = name.length > SHOWN_NAME_LENGTH ? `${name.slice(0, SHOWN_NAME_LENGTH - 3)}...` : name;
  return `Drop to use this picture for ${shown}`;
}

/** A picture was dropped on `target`: { text, rejected } for the drop hint,
 *  or null when the user said no to replacing the station's picture. */
export async function dropStationPicture(file, target, { save = saveStationPicture } = {}) {
  const item = pictureDropItem(target);
  if (!item) return { text: PICTURE_DROP_HINT, rejected: true };
  const result = await save(item, file);
  if (result?.cancelled) return null;
  return { text: result?.text || '', rejected: result?.ok !== true };
}
