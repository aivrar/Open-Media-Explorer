/** Picture drops on the Library's saved stations. The chooser in the
 *  details panel uses the same save path with its existing confirmation. */

import { getState } from '../../lib/state.js';
import { isComputerItem } from '../../lib/item-model.js';
import { isContentAllowed } from '../../lib/content-rating.js';
import { loadArtworkImage } from '../../lib/artwork.js';
import { isSavedItem } from '../../lib/did-not-play-view.js';
import {
  PICTURE_BAD_NAME_TEXT, saveStationPicture, stationOwnName, validateDroppedPicture,
} from '../../lib/station-image-files.js';
import { loadStationImages, stationImageSourceFor, stationPictureFileKey } from '../../lib/station-images.js';
import { ui } from './shell-refs.js';

const pending = new Map();
const writes = new Map();

function dropTarget(target) {
  const state = getState();
  if (state.mode !== 'library') return null;
  const node = target?.closest?.('.card[data-id], .detail-picture-drop');
  if (!node) return null;
  const surface = node.__thumb || node;
  if (!ui.resultsHost?.contains?.(node) && !ui.detailPanel?.contains?.(node)) return null;
  const item = node.__item;
  if (!item?.id || isComputerItem(item) || !isSavedItem(item.id)
      || item.__contentHidden === true || !isContentAllowed(item, state.settings)) return null;
  return { node, surface, item, key: stationPictureFileKey(stationOwnName(item)) ? item.id : null };
}

export function pictureDropTarget(target) {
  const drop = dropTarget(target);
  return drop?.key ? drop.node : null;
}

function showPreview(surface, url) {
  surface.classList.toggle('is-picture-saving', Boolean(url));
  if (url) surface.style.setProperty('--picture-drop-preview', 'url("' + url + '")');
  else surface.style.removeProperty('--picture-drop-preview');
}

// A save refresh can rebuild a card or the details picture while a drop is
// pending. Attach its preview to the replacement as well.
export function mountPictureDropPreview(surface, item) {
  const job = pending.get(item.id);
  if (!job || item.__contentHidden === true || !isContentAllowed(item, getState().settings)) return false;
  job.surfaces.add(surface);
  if (job.preview) showPreview(surface, job.preview.url);
  return true;
}

function clearPreview(job) {
  if (!job.preview) return;
  for (const surface of job.surfaces) showPreview(surface, '');
  job.preview.release();
  job.preview = null;
}

export async function dropStationPicture(file, target, {
  validate = validateDroppedPicture, save = saveStationPicture,
} = {}) {
  const drop = dropTarget(target);
  if (!drop) return null;
  const { surface, item, key } = drop;
  if (!key) return { text: PICTURE_BAD_NAME_TEXT, rejected: true };
  const previous = pending.get(item.id);
  const job = { surfaces: new Set(previous?.surfaces), preview: previous?.preview ?? null };
  if (previous) previous.preview = null;
  job.surfaces.add(surface);
  pending.set(item.id, job);
  const isLatest = () => pending.get(item.id) === job;

  try {
    const preview = await validate(file);
    if (!isLatest()) {
      preview.release?.();
      return null;
    }
    if (!preview.url) {
      // Roll back to the previous write if it was already in flight.
      await writes.get(key);
      return isLatest() ? { text: preview.text, rejected: true } : null;
    }
    job.preview?.release();
    job.preview = preview;
    for (const mounted of job.surfaces) showPreview(mounted, preview.url);

    // Only one write per station can be in flight. A superseded drop
    // that has not started writing can be skipped entirely.
    const write = (writes.get(key) || Promise.resolve()).then(() => {
      if (!isLatest()) return null;
      return save(item, file, {
        // Dropping onto the labeled target is the replacement action. The
        // server still checks the exact existing filenames against the write.
        confirmImpl: () => true,
        retryChanged: false,
        reload: async () => {
          await loadStationImages({ afterCurrent: true });
          const source = stationImageSourceFor(item);
          // Warm the saved artwork while the local preview covers the handoff.
          if (isLatest() && source) await loadArtworkImage(new Image(), source, { requireConnected: false, priority: 30 });
        },
      });
    });
    const tail = write.catch(() => {});
    writes.set(key, tail);
    try {
      const result = await write;
      if (!isLatest() || !result || result.cancelled) return null;
      return { text: result.text || '', rejected: result.ok !== true };
    } finally {
      if (writes.get(key) === tail) writes.delete(key);
    }
  } finally {
    if (isLatest()) {
      pending.delete(item.id);
      clearPreview(job);
    }
  }
}
