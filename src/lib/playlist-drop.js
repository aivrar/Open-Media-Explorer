/**
 * Drag-and-drop for local M3U playlists.
 *
 * Without these handlers the WebView treats a dropped file like a link and
 * hands it to Windows, which opens an .m3u in Notepad. Any file drop is now
 * kept inside the app: a .m3u/.m3u8 file is imported through the same path as
 * Library > My Playlists > Import playlist, and anything else is ignored with a
 * short message.
 */

const PLAYLIST_NAME = /\.m3u8?$/i;
const HINT_TEXT = 'Drop a playlist file (.m3u or .m3u8) to import it into My Playlists';
const REJECT_TEXT = 'Only .m3u or .m3u8 playlist files can be dropped here.';
const REJECT_SHOW_MS = 3500;

/** True when a drag carries files from outside the page (not text or links). */
export function carriesFiles(dataTransfer) {
  const types = dataTransfer?.types;
  if (!types) return false;
  return typeof types.includes === 'function' ? types.includes('Files') : [...types].includes('Files');
}

/** The first dropped .m3u/.m3u8 file, or null. */
export function pickPlaylistFile(files) {
  for (const file of Array.from(files || [])) {
    if (file && PLAYLIST_NAME.test(file.name || '')) return file;
  }
  return null;
}

export function initPlaylistDrop({ onPlaylist, target = globalThis.window, documentImpl = globalThis.document } = {}) {
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

  const onDragOver = (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // Required for the drop event to fire at all, and stops the default
    // "open this file" behaviour.
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    if (hint.hidden || hint.classList.contains('is-rejected')) show(HINT_TEXT);
  };
  const onDragLeave = (event) => {
    // relatedTarget is null only when the pointer leaves the window.
    if (!event.relatedTarget && !hint.classList.contains('is-rejected')) hide();
  };
  const onDrop = (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    const file = pickPlaylistFile(event.dataTransfer.files);
    if (!file) {
      show(REJECT_TEXT, true);
      hideTimer = setTimeout(hide, REJECT_SHOW_MS);
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
