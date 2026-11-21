/**
 * Drag-and-drop of files on the window: local playlists, and station pictures.
 *
 * Without these handlers the WebView treats a dropped file like a link and
 * hands it to Windows, which opens an .m3u in Notepad. Any file drop is now
 * kept inside the app: a .m3u/.m3u8/.pls/.xspf/.json/.csv file is imported through the same path as
 * Library > My Playlists > Import playlist, wherever it is dropped. A picture
 * goes to `onPicture` with the element it was dropped on (the Library gives
 * it to the station whose card that is, or says where to drop it; see
 * modes/library/picture-drop.js). Anything else is ignored with a short
 * message. A favorite card dragged to a new place carries no files, so it is
 * never taken for either.
 */

const PLAYLIST_NAME = /\.(m3u8?|pls|xspf|json|csv)$/i;
const PICTURE_NAME = /\.(png|jpe?g|jfif|webp|gif|svgz?|bmp|ico|avif|tiff?|heic)$/i;
const HINT_TEXT = 'Drop a playlist file (.m3u, .m3u8, .pls, .xspf, .json or .csv) to import it into My Playlists';
const REJECT_TEXT = 'Only .m3u, .m3u8, .pls, .xspf, .json or .csv playlist files can be dropped here.';
const REJECT_SHOW_MS = 3500;
const RESULT_SHOW_MS = 5000;

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
  onPlaylist, onPicture = null, describePictureDrop = null,
  target = globalThis.window, documentImpl = globalThis.document,
} = {}) {
  if (!target?.addEventListener || !documentImpl?.body) return () => {};
  const hint = documentImpl.createElement('div');
  hint.className = 'drop-hint';
  hint.hidden = true;
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  documentImpl.body.appendChild(hint);
  let hideTimer = null;

  const show = (text, rejected = false) => {
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
  };
  const showFor = (text, rejected, ms) => {
    show(text, rejected);
    hideTimer = setTimeout(hide, ms);
  };

  const onDragOver = (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // Required for the drop event to fire at all, and stops the default
    // "open this file" behaviour.
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    // A picture: say where it goes (or where to drop it) under the pointer.
    if (onPicture && describePictureDrop && carriesPicture(event.dataTransfer)) {
      const text = describePictureDrop(event.target);
      if (text && (hint.hidden || hint.textContent !== text || hint.classList.contains('is-rejected'))) show(text);
      return;
    }
    if (hint.hidden || hint.classList.contains('is-rejected') || hint.textContent !== HINT_TEXT) show(HINT_TEXT);
  };
  const onDragLeave = (event) => {
    // relatedTarget is null only when the pointer leaves the window.
    if (!event.relatedTarget && !hint.classList.contains('is-rejected')) hide();
  };
  const onDrop = (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    const file = pickPlaylistFile(event.dataTransfer.files);
    const picture = !file && onPicture ? pickPictureFile(event.dataTransfer.files) : null;
    if (picture) {
      hide();
      const dropTarget = event.target;
      Promise.resolve()
        .then(() => onPicture(picture, dropTarget))
        .then((result) => {
          if (result?.text) showFor(result.text, result.rejected === true, RESULT_SHOW_MS);
        })
        .catch((error) => console.warn('Dropped picture failed:', error));
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
  return () => {
    hide();
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
    hint.remove?.();
  };
}
