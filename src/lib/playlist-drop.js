/**
 * Drag-and-drop of files on the window: local playlists, and station pictures.
 *
 * Without these handlers the WebView treats a dropped file like a link and
 * hands it to Windows, which opens an .m3u in Notepad. Any file drop is now
 * kept inside the app: a .m3u/.m3u8/.pls/.xspf/.json/.csv file is imported through the same path as
 * Library > My Playlists > Import playlist, wherever it is dropped. A picture
 * goes to `onPicture` with the element it was dropped on (the Library gives
 * it to the saved station at the drop target; see
 * modes/library/picture-drop.js). Anything else is ignored with a short
 * message. A favorite card dragged to a new place carries no files, so it is
 * never taken for either.
 */

const PLAYLIST_NAME = /\.(m3u8?|pls|xspf|json|csv)$/i;
const PICTURE_NAME = /\.(png|jpe?g|jfif|webp|gif|svgz?|bmp|ico|avif|tiff?|heic)$/i;
const HINT_TEXT = 'Drop a playlist file (.m3u, .m3u8, .pls, .xspf, .json or .csv) to import it into My Playlists';
const REJECT_TEXT = 'Only .m3u, .m3u8, .pls, .xspf, .json or .csv playlist files can be dropped here.';
const REJECT_SHOW_MS = 3500;
const PICTURE_REJECT_SHOW_MS = 6000;
const PICTURE_REJECT_LONG_SHOW_MS = 8000;
const PICTURE_TARGET_TEXT = "Drop to set this station's picture";

/** True when a drag carries files from outside the page (not text or links). */
export function carriesFiles(dataTransfer) {
  const types = dataTransfer?.types;
  if (!types) return false;
  return typeof types.includes === 'function' ? types.includes('Files') : [...types].includes('Files');
}

/** True when a file drag carries a picture and no playlist (what the browser
 *  tells while dragging: the files' types, not their names). */
export function carriesPicture(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []).filter((item) => item?.kind === 'file');
  const types = items.map((item) => String(item.type || '').toLowerCase());
  return types.some((type) => type.startsWith('image/'))
    && !types.some((type) => /mpegurl|scpls|xspf|json|csv/.test(type));
}

/** The first dropped playlist file (see PLAYLIST_NAME), or null. */
export function pickPlaylistFile(files) {
  for (const file of Array.from(files || [])) {
    if (file && PLAYLIST_NAME.test(file.name || '')) return file;
  }
  return null;
}

/** True for a file meant as a picture (by its type or name); the server
 *  decides by its content whether it is one it can use. */
export function isPictureFile(file) {
  if (!file) return false;
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  return type.startsWith('image/') || PICTURE_NAME.test(String(file.name || ''));
}

/** The first dropped file meant as a picture, or null. */
export function pickPictureFile(files) {
  for (const file of Array.from(files || [])) if (isPictureFile(file)) return file;
  return null;
}

export function initPlaylistDrop({
  onPlaylist, onPicture = null, getPictureTarget = null,
  target = globalThis.window, documentImpl = globalThis.document,
} = {}) {
  if (!target?.addEventListener || !documentImpl?.body) return () => {};
  const hint = documentImpl.createElement('div');
  hint.className = 'drop-hint';
  hint.hidden = true;
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  documentImpl.body.appendChild(hint);
  const announcement = onPicture ? documentImpl.createElement('span') : null;
  if (announcement) {
    announcement.className = 'sr-only';
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    documentImpl.body.appendChild(announcement);
  }
  let hideTimer = null;
  let pictureTarget = null;
  let disposed = false;
  let pictureRejected = false;
  let dropGeneration = 0;

  const highlight = (next) => {
    if (next === pictureTarget) return;
    pictureTarget?.classList.remove('is-picture-drop-target');
    pictureTarget?.removeAttribute('data-picture-drop-label');
    pictureTarget = next;
    pictureTarget?.setAttribute('data-picture-drop-label', PICTURE_TARGET_TEXT);
    pictureTarget?.classList.add('is-picture-drop-target');
  };

  const show = (text, rejected = false) => {
    if (pictureRejected) hide();
    clearTimeout(hideTimer);
    hideTimer = null;
    hint.textContent = text;
    hint.classList.toggle('is-rejected', rejected);
    hint.hidden = false;
  };
  const hide = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    hint.hidden = true;
    if (pictureRejected) {
      pictureRejected = false;
      hint.removeAttribute('aria-hidden');
      announcement.textContent = '';
    }
  };
  const showFor = (text, rejected, ms) => {
    show(text, rejected);
    hideTimer = setTimeout(hide, ms);
  };

  const onDragOver = (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    dropGeneration += 1;
    // Required for the drop event to fire at all, and stops the default
    // "open this file" behaviour.
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    if (onPicture && carriesPicture(event.dataTransfer)) {
      const next = getPictureTarget?.(event.target) || null;
      highlight(next);
      hide();
      try { event.dataTransfer.dropEffect = next ? 'copy' : 'none'; } catch (_) {}
      return;
    }
    highlight(null);
    if (hint.hidden || hint.classList.contains('is-rejected') || hint.textContent !== HINT_TEXT) show(HINT_TEXT);
  };
  const onDragLeave = (event) => {
    // relatedTarget is null only when the pointer leaves the window.
    if (!event.relatedTarget) {
      highlight(null);
      if (!hint.classList.contains('is-rejected')) hide();
    }
  };
  const onPointerDown = () => {
    if (pictureRejected) hide();
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    dropGeneration += 1;
    if (pictureRejected) hide();
  };
  const onDrop = async (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    highlight(null);
    const generation = ++dropGeneration;
    const file = pickPlaylistFile(event.dataTransfer.files);
    const picture = !file && onPicture ? pickPictureFile(event.dataTransfer.files) : null;
    if (picture) {
      hide();
      announcement.textContent = '';
      try {
        const result = await onPicture(picture, event.target);
        if (disposed || !result?.text) return;
        if (result.rejected) {
          if (generation !== dropGeneration) return;
          const duration = result.text.length > 80 ? PICTURE_REJECT_LONG_SHOW_MS : PICTURE_REJECT_SHOW_MS;
          showFor(result.text, true, duration);
          pictureRejected = true;
          hint.setAttribute('aria-hidden', 'true');
          announcement.textContent = result.text;
        } else if (!pictureRejected) announcement.textContent = result.text;
      } catch (error) {
        console.warn('Dropped picture failed:', error);
      }
      return;
    }
    if (!file) {
      showFor(REJECT_TEXT, true, REJECT_SHOW_MS);
      return;
    }
    hide();
    Promise.resolve()
      .then(() => onPlaylist?.(file))
      .catch((error) => console.warn('Dropped playlist import failed:', error));
  };

  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);
  if (onPicture) {
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('keydown', onKeyDown, true);
  }
  return () => {
    disposed = true;
    hide();
    highlight(null);
    announcement?.remove?.();
    if (onPicture) {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('keydown', onKeyDown, true);
    }
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
    hint.remove?.();
  };
}
