/**
 * Right-side detail panel for the currently selected item. Opens when a
 * card is clicked, closes via its own Close button or when the user
 * navigates source/mode. The panel is mounted on demand and removed
 * when closed — no persistent DOM cost when nothing is selected.
 */

import { getState, isFavorite, isLocalFileFavorite, addFavorite, removeFavorite, subscribe } from '../../lib/state.js';
import { getSourceLabel } from '../../lib/sources.js';
import { isComputerItem, safeExternalUrl, shownLicense } from '../../lib/item-model.js';
import { isTabShown } from '../../lib/top-tabs.js';
import { computerCardSubtitle, computerItemForView, computerFileState, playLibraryItem } from './computer.js';
import {
  artworkSourceFor, isArtworkRelayUrl, isStationImageSource, loadArtworkImage, stationImageSourceFor,
} from '../../lib/artwork.js';
import { getCurrentPart, playItem } from '../../lib/player.js';
import { hasPartsSource, loadParts, partKind, partTime } from '../../lib/media-parts.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { captureCardAnchor, restoreCardAnchor } from './render.js';
import { resolveItemArtwork } from './thumbnails.js';
import { createBestStreamStatus, createOtherStreams } from './other-streams.js';
import { createStreamAddressEditor } from './stream-addresses.js';
import { stationStreamLabel } from '../../lib/played-streams.js';
import {
  contentBadgeText, favoriteForContentView, isContentAllowed,
} from '../../lib/content-rating.js';
import {
  MAX_FAVORITE_NAME_LENGTH, favoriteName, withFavoriteName, withoutFavoriteName,
} from '../../lib/favorite-names.js';
import { renameFavorite, resetFavoriteName } from '../../lib/favorite-rename.js';
import { didNotPlayNote, isSavedItem } from '../../lib/did-not-play-view.js';
import { mountPictureDropPreview } from './picture-drop.js';
import {
  PICTURE_ACCEPT, removeStationPicture, saveStationPicture,
} from '../../lib/station-image-files.js';

let detailReturnFocus = null;
// The item the open panel shows, for the parts that change in place.
let detailItem = null;
let detailTrouble = null;
let detailQuality = null;
let detailPicture = null;
let detailKeyHandler = null;
let detailArtworkAbort = null;
let detailArtworkShown = null;
let detailOtherStreams = null;
let detailBestStream = null;
let detailStreamEditor = null;
let detailPartsCleanup = null;

function stopOtherStreams() {
  detailOtherStreams?.abort();
  detailOtherStreams = null;
  detailBestStream?.destroy();
  detailBestStream = null;
}

/** A row in "Other streams" is its own Radio Browser entry: play it and show
 *  its details, so the panel's Favorite button is about the entry playing. */
function playOtherStream(stream) {
  openDetail(stream, { focus: true });
  playItem(stream).catch((err) => console.warn('play failed:', err));
}

function bindDetailKeys() {
  if (detailKeyHandler || !globalThis.document?.addEventListener) return;
  detailKeyHandler = (event) => {
    if (event.key !== 'Escape' || !ui.detailPanel) return;
    // The detail panel is non-modal.  Do not let its Escape shortcut close
    // content behind a focused EQ/settings dialog or another app control.
    if (!ui.detailPanel.contains(document.activeElement)) return;
    event.preventDefault();
    closeDetail();
  };
  document.addEventListener('keydown', detailKeyHandler);
}

function unbindDetailKeys() {
  if (!detailKeyHandler) return;
  document.removeEventListener('keydown', detailKeyHandler);
  detailKeyHandler = null;
}

/** The panel's picture for an item: an <img> to mount, and start() to load it
 *  once mounted. Cancels the previous picture's work. */
function detailArtwork(item) {
  if (detailArtworkAbort && !detailArtworkAbort.signal.aborted) detailArtworkAbort.abort();
  detailArtworkAbort = new AbortController();
  const detailArtworkSignal = detailArtworkAbort.signal;
  // Which station picture is shown (refreshDetailArtwork compares).
  detailArtworkShown = { item, source: stationImageSourceFor(item) };
  const detailThumb = el('img', {
    className: 'detail-thumb',
    attrs: { alt: '', referrerpolicy: 'no-referrer' },
  });
  // A station's artwork is its logo, often a wide wordmark: shown whole.
  if (item.type === 'tv' || item.type === 'radio') detailThumb.classList?.add?.('logo-art');
  const loadDetailArtwork = () => {
    // The user's own station picture first, then the item's relay artwork.
    const source = artworkSourceFor(item);
    if (!source || !detailThumb.isConnected) return;
    detailThumb.style.display = '';
    void loadArtworkImage(detailThumb, source, {
      priority: 30,
      signal: detailArtworkSignal,
    }).catch((error) => {
      if (error?.name === 'AbortError' || detailArtworkSignal.aborted) return;
      detailThumb.style.display = 'none';
      // A station picture that would not load: show the item's own artwork.
      if (isStationImageSource(source) && item.__contentHidden !== true) {
        resolveItemArtwork(item, { priority: 30, signal: detailArtworkSignal })
          .then(loadDetailArtwork).catch(() => {});
      }
    });
  };
  const start = () => {
    if (artworkSourceFor(item) && isContentAllowed(item, getState().settings)) {
      loadDetailArtwork();
      return;
    }
    // Artwork may still be hydrating: mounted hidden, filled in once resolved.
    detailThumb.style.display = 'none';
    if (item.__contentHidden !== true) {
      resolveItemArtwork(item, { priority: 30, signal: detailArtworkSignal }).then(() => {
        if (isArtworkRelayUrl(item.thumbnail) && detailThumb.isConnected) {
          loadDetailArtwork();
        }
      }).catch(() => {});
    }
  };
  let picture = detailThumb;
  if (isSavedItem(item.id) && item.__contentHidden !== true && isContentAllowed(item, getState().settings)) {
    // Keep a drop surface even when the station has no artwork yet.
    picture = el('div', { className: 'detail-picture-drop' });
    picture.__item = item;
    picture.appendChild(detailThumb);
    mountPictureDropPreview(picture, item);
  }
  return { picture, start };
}

/** The station pictures changed: if the open panel's picture is a different
 *  one now, swap only the picture; the rest of the panel (buttons, focus,
 *  Other streams) stays as it is. Returns true when the picture was swapped. */
export function refreshDetailArtwork() {
  const shown = detailArtworkShown;
  const panel = ui.detailPanel;
  if (!panel || !shown || stationImageSourceFor(shown.item) === shown.source) return false;
  const old = [...panel.children].find((node) => /(?:^|\s)(?:detail-picture-drop|detail-thumb)(?:\s|$)/.test(node.className));
  if (!old) return false;
  const artwork = detailArtwork(shown.item);
  panel.insertBefore(artwork.picture, old);
  old.remove();
  artwork.start();
  return true;
}

export function openDetail(item, options = {}) {
  if (!item?.id) return;
  if (!isContentAllowed(item, getState().settings) && !isFavorite(item.id)) {
    closeDetail();
    return;
  }
  stopOtherStreams();
  detailPartsCleanup?.();
  detailPartsCleanup = null;
  detailStreamEditor?.destroy();
  detailStreamEditor = null;
  // A saved favorite is shown under the name the user gave it, wherever the
  // panel was opened from (favorite-names.js).
  if (isFavorite(item.id)) item = withFavoriteName(withoutFavoriteName(item));
  const local = isComputerItem(item);
  if (local) item = computerItemForView(item);
  item = favoriteForContentView(item, getState().settings);
  const opening = !ui.detailPanel;
  const anchor = options.anchorCard && opening ? captureCardAnchor(item.id, { viewport: true }) : null;
  view.detailItemId = item.id;
  if (!ui.detailPanel) {
    ui.detailPanel = el('aside', {
      className: 'detail-panel',
      attrs: { 'aria-labelledby': 'library-detail-title' },
    });
    ui.root.appendChild(ui.detailPanel);
    ui.root.classList.add('has-detail');
  }
  if (options.focus === true && !ui.detailPanel.contains(document.activeElement)) {
    detailReturnFocus = document.activeElement;
  }
  bindDetailKeys();
  ui.detailPanel.innerHTML = '';
  const closeBtn = el('button', {
    className: 'btn detail-close',
    attrs: { 'aria-label': 'Close media details' },
    on: { click: () => closeDetail() },
    text: 'Close',
  });
  ui.detailPanel.appendChild(closeBtn);

  const artwork = detailArtwork(item);
  ui.detailPanel.appendChild(artwork.picture);
  artwork.start();

  ui.detailPanel.appendChild(el('h2', {
    className: 'detail-title',
    text: item.title,
    attrs: { id: 'library-detail-title' },
  }));
  if (item.__favoriteName === true && item.__contentHidden !== true) {
    ui.detailPanel.appendChild(el('p', {
      className: 'detail-original-name', text: `Original name: ${item.originalTitle || 'Untitled'}`,
    }));
  }
  const meta = el('div', { className: 'detail-meta' });
  meta.appendChild(el('span', { className: 'source-badge', text: getSourceLabel(item.source) }));
  if (item.year) meta.appendChild(el('span', { text: String(item.year) }));
  if (item.country) meta.appendChild(el('span', { text: item.country }));
  if (item.language) meta.appendChild(el('span', { text: item.language }));
  if (shownLicense(item)) meta.appendChild(el('span', { text: shownLicense(item) }));
  // The stream's format and bitrate (played-streams.js), kept current: a
  // station played while the panel is open fills it in.
  detailQuality = meta.appendChild(el('span', {
    className: 'detail-quality', attrs: { title: 'Stream format and bitrate' },
  }));
  const ratingLabel = contentBadgeText(item);
  if (ratingLabel && item.__contentHidden !== true) {
    meta.appendChild(el('span', { className: 'content-rating-badge', text: ratingLabel }));
  }
  ui.detailPanel.appendChild(meta);
  // "Did not play last time" for the user's own stations (did-not-play.js).
  detailItem = item;
  detailTrouble = el('p', { className: 'detail-trouble', attrs: { role: 'note' } });
  ui.detailPanel.appendChild(detailTrouble);
  refreshDetailTrouble();
  refreshDetailQuality();
  // Auto (verified): what the check knows of this station, kept up to date.
  if (item.__contentHidden !== true) {
    detailBestStream = createBestStreamStatus(item);
    if (detailBestStream) ui.detailPanel.appendChild(detailBestStream.node);
  }
  if (item.tags && item.tags.length) {
    const tagsHost = el('div', { className: 'detail-meta' });
    for (const t of item.tags.slice(0, 12)) tagsHost.appendChild(el('span', { className: 'chip', text: t }));
    ui.detailPanel.appendChild(tagsHost);
  }
  const description = local ? computerCardSubtitle(item) : item.description;
  ui.detailPanel.appendChild(el('p', { className: 'detail-description', text: description || '' }));

  const actions = el('div', { className: 'detail-actions' });
  if (item.__contentHidden !== true) {
    actions.appendChild(el('button', { className: 'btn btn-primary', text: 'Play', on: { click: () => playLibraryItem(item) } }));
  }
  if (item.__contentHidden !== true || isFavorite(item.id)) {
    const favBtn = el('button', {
      className: 'btn',
      text: isFavorite(item.id) ? '★ Favorited' : '☆ Favorite',
      attrs: { 'aria-pressed': isFavorite(item.id) ? 'true' : 'false' },
      on: { click: () => {
        if (isFavorite(item.id)) {
          if (removeFavorite(item.id) === false) return;
          favBtn.textContent = '☆ Favorite';
          favBtn.setAttribute('aria-pressed', 'false');
        } else if (item.__contentHidden !== true) {
          if (addFavorite(item) === false) return;
          favBtn.textContent = '★ Favorited';
          favBtn.setAttribute('aria-pressed', 'true');
        }
      } },
    });
    actions.appendChild(favBtn);
  }
  if (local && ui.showInComputer && isTabShown('computer', getState().settings) && computerFileState(item).entry) {
    actions.appendChild(el('button', {
      className: 'btn',
      text: 'Show in Computer tab',
      on: { click: () => {
        const { entry } = computerFileState(item);
        if (entry) ui.showInComputer(entry);
      } },
    }));
  }
  const sourceUrl = safeExternalUrl(item.source_url);
  if (sourceUrl && item.__contentHidden !== true) {
    actions.appendChild(el('a', { className: 'btn', attrs: { href: sourceUrl, target: '_blank', rel: 'noopener' }, text: 'Source ↗' }));
  }
  const otherStreams = createOtherStreams(item, { onPlay: playOtherStream });
  detailOtherStreams = otherStreams;
  if (otherStreams.button) actions.appendChild(otherStreams.button);
  const rename = isFavorite(item.id) && !isLocalFileFavorite(item) && item.__contentHidden !== true ? buildRename(item) : null;
  if (rename) {
    actions.appendChild(rename.button);
    if (rename.reset) actions.appendChild(rename.reset);
  }
  // A picture of the station's own, for favorites and My Playlists stations.
  detailPicture = !local && isSavedItem(item.id) && item.__contentHidden !== true ? buildPictureControls(item) : null;
  if (detailPicture) {
    actions.appendChild(detailPicture.choose);
    actions.appendChild(detailPicture.remove);
    actions.appendChild(detailPicture.input);
    refreshDetailPictureControls();
  }
  if ((item.type === 'radio' || item.type === 'tv') && item.__contentHidden !== true) {
    detailStreamEditor = createStreamAddressEditor(item, { onSaved: () => {
      refreshDetailQuality();
      refreshDetailTrouble();
    } });
    actions.appendChild(detailStreamEditor.button);
  }
  ui.detailPanel.appendChild(actions);
  if (item.__contentHidden !== true && hasPartsSource(item)) {
    detailPartsCleanup = showDetailParts(item, ui.detailPanel);
  }
  if (detailStreamEditor) ui.detailPanel.appendChild(detailStreamEditor.form);
  if (detailPicture) ui.detailPanel.appendChild(detailPicture.message);
  if (rename) ui.detailPanel.appendChild(rename.form);
  if (otherStreams.section) ui.detailPanel.appendChild(otherStreams.section);
  if (otherStreams.note) ui.detailPanel.appendChild(otherStreams.note);
  if (opening) restoreCardAnchor(anchor);
  if (options.focus === true) {
    queueMicrotask(() => closeBtn.isConnected && closeBtn.focus({ preventScroll: true }));
  }
}

function showDetailParts(item, panel) {
  const kind = partKind(item);
  const heading = kind + 's';
  const section = el('section', { className: 'detail-parts', attrs: { 'aria-label': heading } });
  const status = el('p', { text: 'Loading ' + heading.toLowerCase() + '...', attrs: { role: 'status' } });
  section.appendChild(el('h3', { text: heading }));
  section.appendChild(status);
  // Archive audio items only get a list when there is more than one track.
  section.hidden = kind === 'Track';
  panel.appendChild(section);
  let active = true;
  let buttons = [];
  const markCurrent = () => {
    const selection = getCurrentPart(item.id);
    const current = selection?.parts[selection.index].key;
    for (const [button, part] of buttons) {
      if (part.key === current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };
  const unsubscribe = subscribe('current-item', markCurrent);
  loadParts(item).then((parts) => {
    if (!active) return;
    if (!parts.length || (kind === 'Track' && parts.length === 1)) {
      section.hidden = true;
      return;
    }
    const list = el('ol');
    buttons = parts.map((part, index) => {
      const button = el('button', {
        className: 'btn detail-part',
        attrs: { type: 'button' },
        on: { click: () => playItem(item, { parts, index }).catch(() => {}) },
      });
      button.appendChild(el('span', { text: part.title }));
      if (part.duration !== null) button.appendChild(el('span', { text: partTime(part.duration) }));
      const row = el('li');
      row.appendChild(button);
      list.appendChild(row);
      return [button, part];
    });
    status.hidden = true;
    section.appendChild(list);
    section.hidden = false;
    markCurrent();
  }).catch(() => {
    if (!active) return;
    status.textContent = 'Could not load ' + heading.toLowerCase() + '.';
    section.hidden = false;
  });
  return () => { active = false; unsubscribe(); };
}

/** "Rename" for a saved favorite: a small form under the buttons with the
 *  name, Save and Cancel; "Use original name" when it has a name of its own.
 *  The panel is drawn again after a change, with focus back on Rename. */
function buildRename(item) {
  const button = el('button', {
    className: 'btn', text: 'Rename',
    attrs: { type: 'button', 'data-act': 'rename-favorite', 'aria-expanded': 'false', 'aria-controls': 'library-detail-rename-form' },
  });
  const reset = favoriteName(item.id)
    ? el('button', {
      className: 'btn', text: 'Use original name',
      attrs: { type: 'button', 'data-act': 'reset-favorite-name', title: `Show it as "${item.originalTitle || ''}" again` },
    })
    : null;
  const form = el('form', { className: 'detail-rename', attrs: { 'aria-label': 'Rename favorite', id: 'library-detail-rename-form' } });
  form.hidden = true;
  const label = el('label', { className: 'detail-rename-label', text: 'Name' });
  const input = el('input', {
    className: 'detail-rename-input',
    attrs: {
      type: 'text', maxlength: String(MAX_FAVORITE_NAME_LENGTH), autocomplete: 'off', spellcheck: 'false',
      id: 'library-detail-rename', 'aria-describedby': 'library-detail-rename-hint',
    },
  });
  label.setAttribute('for', 'library-detail-rename');
  const message = el('p', { className: 'detail-rename-message', attrs: { role: 'alert' } });
  message.hidden = true;
  const save = el('button', { className: 'btn btn-primary', text: 'Save', attrs: { type: 'submit' } });
  const cancel = el('button', { className: 'btn', text: 'Cancel', attrs: { type: 'button' } });
  const row = el('div', { className: 'detail-rename-row' });
  row.appendChild(input);
  row.appendChild(save);
  row.appendChild(cancel);
  form.appendChild(label);
  form.appendChild(row);
  form.appendChild(message);
  form.appendChild(el('p', {
    className: 'detail-rename-hint',
    attrs: { id: 'library-detail-rename-hint' },
    text: `Shown everywhere this favorite is. Leave it empty to use the original name${item.originalTitle ? ` ("${item.originalTitle}")` : ''}.`,
  }));

  const close = () => {
    form.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    message.hidden = true;
    button.focus?.();
  };
  const redraw = () => {
    const saved = getState().favorites.find((favorite) => favorite.id === item.id);
    if (!saved || !ui.detailPanel) return;
    openDetail(saved);
    ui.detailPanel?.querySelector?.('[data-act="rename-favorite"]')?.focus?.();
  };
  const done = (result) => {
    if (!result.ok) {
      message.textContent = result.error;
      message.hidden = false;
      return;
    }
    if (result.changed) redraw();
    else close();
  };
  button.addEventListener('click', () => {
    if (!form.hidden) { close(); return; }
    form.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.value = item.title || '';
    input.focus?.();
    input.select?.();
  });
  reset?.addEventListener('click', () => done(resetFavoriteName(item.id)));
  cancel.addEventListener('click', close);
  form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    done(renameFavorite(item.id, input.value));
  });
  // Escape closes the form, not the panel, from any of its controls.
  const onEscape = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    close();
  };
  for (const control of [input, save, cancel]) control.addEventListener('keydown', onEscape);
  return { button, reset, form, input };
}

/** "Choose picture..." (a file chooser for pictures) and, while the station
 *  has a picture of its own in the station-images folder, "Remove picture".
 *  Both end in that folder with the folder's own checks (station-image-files.js);
 *  the result is said in plain words under the buttons. */
function buildPictureControls(item) {
  const input = el('input', {
    className: 'detail-picture-input',
    attrs: { type: 'file', accept: PICTURE_ACCEPT, tabindex: '-1', 'aria-hidden': 'true' },
  });
  input.hidden = true;
  const choose = el('button', {
    className: 'btn', text: 'Choose picture…',
    attrs: { type: 'button', 'data-act': 'choose-station-picture', title: 'Use a PNG, JPG, WebP or GIF picture (up to 2 MB) for this station' },
  });
  const remove = el('button', {
    className: 'btn', text: 'Remove picture',
    attrs: { type: 'button', 'data-act': 'remove-station-picture' },
  });
  const message = el('p', { className: 'detail-picture-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  message.hidden = true;
  let busy = false;
  const show = (result) => {
    if (!result || result.cancelled || !result.text) return;
    message.textContent = result.text;
    message.dataset.state = result.ok ? 'ready' : 'error';
    message.hidden = false;
  };
  const run = async (work) => {
    if (busy) return;
    busy = true;
    choose.disabled = true;
    remove.disabled = true;
    try {
      show(await work());
    } finally {
      busy = false;
      choose.disabled = false;
      remove.disabled = false;
      refreshDetailPictureControls();
    }
  };
  choose.addEventListener('click', () => { if (!busy) input.click?.(); });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void run(() => saveStationPicture(item, file)).finally(() => { input.value = ''; });
  });
  remove.addEventListener('click', () => { void run(() => removeStationPicture(item)); });
  return { item, input, choose, remove, message, show };
}

/** Show "Remove picture" only while the station has a picture of its own. */
export function refreshDetailPictureControls() {
  if (!detailPicture) return false;
  detailPicture.remove.hidden = !stationImageSourceFor(detailPicture.item);
  return true;
}

/** The "Did not play last time" sentence of the open panel, kept current. */
export function refreshDetailTrouble() {
  if (!detailTrouble || !detailItem) return false;
  const text = didNotPlayNote(detailItem);
  if (detailTrouble.textContent !== text) detailTrouble.textContent = text;
  detailTrouble.hidden = !text;
  return true;
}

/** The stream format and bitrate of the open panel, kept current. */
export function refreshDetailQuality() {
  if (!detailQuality || !detailItem) return false;
  const text = stationStreamLabel(detailItem);
  if (detailQuality.textContent !== text) detailQuality.textContent = text;
  detailQuality.hidden = !text;
  return true;
}

/** Tests: the open panel's picture controls. */
export function detailPictureControls() { return detailPicture; }

export function closeDetail({ preserveSelection = false } = {}) {
  const anchor = !preserveSelection && ui.detailPanel
    ? captureCardAnchor(view.detailItemId, { viewport: true }) : null;
  if (detailArtworkAbort && !detailArtworkAbort.signal.aborted) detailArtworkAbort.abort();
  detailArtworkAbort = null;
  detailArtworkShown = null;
  detailItem = null;
  detailTrouble = null;
  detailQuality = null;
  detailPicture = null;
  detailStreamEditor?.destroy();
  detailStreamEditor = null;
  stopOtherStreams();
  detailPartsCleanup?.();
  detailPartsCleanup = null;
  if (ui.detailPanel) {
    ui.detailPanel.remove();
    ui.detailPanel = null;
    ui.root?.classList.remove('has-detail');
  }
  unbindDetailKeys();
  restoreCardAnchor(anchor);
  if (!preserveSelection && detailReturnFocus?.isConnected) detailReturnFocus.focus?.({ preventScroll: true });
  detailReturnFocus = null;
  if (!preserveSelection) view.detailItemId = null;
}

/** Resolve the item to remount after mode navigation without conflating a
 * deliberately closed panel with a panel removed only for teardown. */
export function getRestorableDetailItem(currentItem, itemIndex, favorites = []) {
  if (!view.detailItemId) return null;
  if (currentItem?.id === view.detailItemId) return currentItem;
  return itemIndex?.get?.(view.detailItemId)
    || view.computerHits.find((item) => item.id === view.detailItemId)
    || favorites.find?.((item) => item?.id === view.detailItemId)
    || null;
}
