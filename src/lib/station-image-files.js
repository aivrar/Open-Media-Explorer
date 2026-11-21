/**
 * A station picture chosen in the details panel or dropped on a station's
 * card (the user's own stations only: favorites and My Playlists).
 *
 * The page sends the picture's bytes and the station's own name to the local
 * server (POST /api/v1/station-images/save, session token, size limit); the
 * server checks the bytes exactly as the folder scan does, makes the file
 * name from the station's name by the same naming rule, and writes the file
 * into the station-images folder (worldmedia_station_images.py). The page
 * never names a file or a path. A station that has a picture of its own
 * already is only given a new one after the user said yes. The list is then
 * read again, so every card, the Tuner and the player bar show it at once
 * (the station pictures change event).
 */

import { controlRequest } from './capture-client.js';
import { isStationImageSource, loadStationImages, STATION_IMAGE_MAX_BYTES, stationImageSourceFor } from './station-images.js';

export const STATION_IMAGE_SAVE_ROUTE = '/api/v1/station-images/save';
export const STATION_IMAGE_REMOVE_ROUTE = '/api/v1/station-images/remove';
// The file chooser offers these; anything else is still checked by the server.
export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const PICTURE_DROP_HINT = 'To give a station a picture, drop it on the station\'s card in Favorites or My Playlists.';
export const PICTURE_TOO_LARGE_TEXT = 'The picture is too large. The limit is 2 MB.';
const SHOWN_NAME_LENGTH = 60;
// A question names every file it is about; more than this (the server's
// limit too) is refused rather than shown in part.
export const MAX_FILES_SHOWN = 20;
export const TOO_MANY_FILES_TEXT = 'More than 20 files in the station-images folder, where your station pictures '
  + 'are kept, belong to this station, so nothing was changed and nothing was deleted. Tidy that folder by hand '
  + 'first, then try again.';

/** The station's own name, which its picture is filed under: for a favorite
 *  the user renamed, the name it came with (as station-images.js matches). */
export function stationOwnName(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.__favoriteName === true && typeof item.originalTitle === 'string' && item.originalTitle) {
    return item.originalTitle;
  }
  return typeof item.title === 'string' ? item.title : '';
}

function shownName(name) {
  const text = String(name || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return text.length > SHOWN_NAME_LENGTH ? `${text.slice(0, SHOWN_NAME_LENGTH - 3)}...` : text;
}

/** The picture id of a station picture source ('station-image:<id>:<stamp>'). */
export function pictureIdOf(source) {
  return isStationImageSource(source) ? source.split(':')[1] : '';
}

/** The file's bytes as base64 (the control routes take JSON). */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  const step = 0x8000;
  for (let at = 0; at < bytes.length; at += step) {
    text += String.fromCharCode.apply(null, bytes.subarray(at, at + step));
  }
  return globalThis.btoa(text);
}

function failureText(error, fallback) {
  // The server's refusals are plain sentences; anything else did not reach it.
  if (error?.name === 'ControlApiError' && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

/** A file name as shown in a question: in full (only control characters,
 *  which cannot be shown, are left out). */
function fileName(name) {
  return String(name || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** The server's list of file names, or [] (it answers with plain names). */
function fileList(answer) {
  return Array.isArray(answer?.files) ? answer.files.filter((file) => typeof file === 'string' && file) : [];
}

/** "The file AC-DC.png is already there. Replace it?" (every name, in full). */
export function replaceQuestion(files) {
  const names = files.map(fileName);
  if (names.length === 1) return `The file ${names[0]} is already there. Replace it?`;
  return `The files ${names.slice(0, -1).join(', ')} and ${names.at(-1)} are already there. Replace them?`;
}

/**
 * Give `item` the picture in `file`. When files are already there for it,
 * the server lists them all, the question names every one in full, and the
 * save carries exactly those names: the server replaces or deletes nothing
 * else. More files than a question can show are refused instead.
 * Resolves to { ok, text, cancelled } (text for the user, plain).
 */
export async function saveStationPicture(item, file, {
  confirmImpl = (text) => globalThis.confirm(text),
  request = controlRequest,
  reload = () => loadStationImages(),
  currentSource = stationImageSourceFor,
} = {}) {
  const name = stationOwnName(item);
  if (!name.trim()) return { ok: false, text: 'This station has no name to keep its picture under.' };
  if (!file || !(Number(file.size) > 0)) return { ok: false, text: 'The file is empty.' };
  if (Number(file.size) > STATION_IMAGE_MAX_BYTES) return { ok: false, text: PICTURE_TOO_LARGE_TEXT };
  const shown = shownName(name);
  // The picture shown for it now, by id: the server only acts on it for a
  // station matched by spelling, and names its file in the question.
  const current = pictureIdOf(currentSource(item));
  let data;
  try {
    data = await fileToBase64(file);
  } catch (_) {
    return { ok: false, text: 'The file could not be read.' };
  }
  const lost = 'The picture could not be saved: the app did not answer.';
  const ask = () => request(STATION_IMAGE_SAVE_ROUTE, {
    method: 'POST', body: { station: name, preview: true, ...(current ? { current } : {}) },
  });
  const send = (files) => request(STATION_IMAGE_SAVE_ROUTE, {
    method: 'POST',
    body: {
      station: name, data, replace: files.length > 0, ...(current ? { current } : {}),
      ...(files.length ? { files } : {}),
    },
  });
  let result = null;
  // A second round only when the folder changed between the question and
  // the save: the user is asked again about what is there now.
  for (let round = 0; round < 2 && !result; round += 1) {
    let files;
    try {
      files = fileList(await ask());
    } catch (error) {
      return { ok: false, text: failureText(error, lost) };
    }
    if (files.length > MAX_FILES_SHOWN) return { ok: false, text: TOO_MANY_FILES_TEXT };
    if (files.length && !confirmImpl(replaceQuestion(files))) return { ok: false, cancelled: true, text: '' };
    try {
      result = await send(files);
    } catch (error) {
      const changed = error?.code === 'STATION_IMAGE_EXISTS' || error?.code === 'STATION_IMAGE_CHANGED';
      if (!changed || round > 0) return { ok: false, text: failureText(error, lost) };
    }
  }
  try { await reload(); } catch (_) { /* shown after the next Refresh */ }
  const savedAs = typeof result?.file === 'string' && result.file ? ` as ${shownName(result.file)}` : '';
  return { ok: true, text: `Picture saved for ${shown}${savedAs}.` };
}

/** "Remove the picture of NAME? This file is deleted from the
 *  station-images folder: NAME.png" (or "These files are deleted ..."). */
export function removeQuestion(shown, files) {
  const names = files.map(fileName);
  const which = names.length === 1
    ? `This file is deleted from the station-images folder: ${names[0]}`
    : `These files are deleted from the station-images folder: ${names.join(', ')}`;
  return `Remove the picture of ${shown}? ${which}`;
}

/** Remove the station's own picture from the folder, after asking: the
 *  question names the files, and only those files are deleted. */
export async function removeStationPicture(item, {
  confirmImpl = (text) => globalThis.confirm(text),
  request = controlRequest,
  reload = () => loadStationImages(),
  currentSource = stationImageSourceFor,
} = {}) {
  const id = pictureIdOf(currentSource(item));
  const shown = shownName(stationOwnName(item));
  if (!id) return { ok: false, text: `${shown || 'This station'} has no picture of its own.` };
  let files;
  try {
    const preview = await request(STATION_IMAGE_REMOVE_ROUTE, { method: 'POST', body: { id, preview: true } });
    files = fileList(preview);
  } catch (error) {
    return { ok: false, text: failureText(error, 'The picture could not be removed: the app did not answer.') };
  }
  if (!files.length) return { ok: false, text: `${shown || 'This station'} has no picture of its own.` };
  if (files.length > MAX_FILES_SHOWN) return { ok: false, text: TOO_MANY_FILES_TEXT };
  if (!confirmImpl(removeQuestion(shown, files))) return { ok: false, cancelled: true, text: '' };
  let result;
  try {
    result = await request(STATION_IMAGE_REMOVE_ROUTE, { method: 'POST', body: { id, files } });
  } catch (error) {
    return { ok: false, text: failureText(error, 'The picture could not be removed: the app did not answer.') };
  }
  try { await reload(); } catch (_) { /* shown after the next Refresh */ }
  if (!(Number(result?.removed) > 0)) {
    return { ok: false, text: 'The picture\'s files had changed, so nothing was removed. Try again.' };
  }
  return { ok: true, text: `Picture removed for ${shown}.` };
}
