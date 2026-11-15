/**
 * "Back up my data" in Settings. The favorites and settings live in the page's
 * storage, so they are mirrored to the native copy first; only then does the
 * backend write the ZIP. All text shown is plain text, never HTML.
 */

import { controlRequest } from './capture-client.js';
import { flushProfileHandoff } from './profile-transfer.js';
import { openDownloadsFolder } from './download-client.js';

export const BACKUP_ROUTE = '/api/v1/backup/create';
export const BACKUP_IDLE_LABEL = 'Back up my data';
export const BACKUP_BUSY_LABEL = 'Creating backup…';
export const BACKUP_FLUSH_FAILED = 'Backup not made: your latest favorites and settings could not be saved first, so the backup would have been out of date. Try again in a moment.';
const BACKUP_FAILED = 'Backup failed: the backup could not be created.';

/** Ask the backend for a ZIP. The body is empty: the server chooses every path. */
export function createBackup(options = {}) {
  return controlRequest(BACKUP_ROUTE, { ...options, method: 'POST', body: {} });
}

function count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function plural(number, one, many) {
  return `${number} ${number === 1 ? one : many}`;
}

/** One plain line, e.g. "Backup saved: WorldMedia-backup-….zip (124 favorites, 3 playlists)". */
export function backupSuccessMessage(data) {
  const name = typeof data?.name === 'string' && data.name ? data.name : 'backup file';
  const summary = data?.summary || {};
  let text = `Backup saved: ${name} (${plural(count(summary.favorites), 'favorite', 'favorites')}, `
    + `${plural(count(summary.playlists), 'playlist', 'playlists')})`;
  const skipped = count(summary.favorites_skipped);
  if (skipped) {
    text += `. ${plural(skipped, 'favorite has', 'favorites have')} no direct link, so the .m3u8 files leave ${skipped === 1 ? 'it' : 'them'} out`;
  }
  return text;
}

export class BackupFlushError extends Error {
  constructor(cause) {
    super(BACKUP_FLUSH_FAILED);
    this.name = 'BackupFlushError';
    this.cause = cause;
  }
}

/** Mirror the profile, wait for it, then create the backup. A failed or
 *  skipped mirror stops here, so a stale backup is never made silently. */
export async function runBackup({ flush = flushProfileHandoff, create = createBackup } = {}) {
  let flushed;
  try {
    flushed = await flush();
  } catch (error) {
    throw new BackupFlushError(error);
  }
  if (flushed?.saved !== true) throw new BackupFlushError(null);
  return create();
}

export function backupFailureMessage(error) {
  if (error instanceof BackupFlushError) return error.message;
  const reason = typeof error?.message === 'string' ? error.message.trim() : '';
  return reason ? `Backup failed: ${reason}` : BACKUP_FAILED;
}

/**
 * Wire the Settings controls. `isDisposed` lets the modal close mid-backup
 * without writing to removed elements.
 */
export function bindBackupControls({
  button, status, openButton,
  flush = flushProfileHandoff, create = createBackup, openFolder = openDownloadsFolder,
  isDisposed = () => false,
}) {
  let running = false;
  openButton.hidden = true;

  function show(text, state) {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function backUp() {
    if (running) return;
    running = true;
    button.disabled = true;
    button.textContent = BACKUP_BUSY_LABEL;
    openButton.hidden = true;
    show('', 'checking');
    try {
      const data = await runBackup({ flush, create });
      if (isDisposed()) return;
      show(backupSuccessMessage(data), 'ready');
      openButton.hidden = false;
    } catch (error) {
      if (isDisposed()) return;
      show(backupFailureMessage(error), 'error');
    } finally {
      running = false;
      if (!isDisposed()) {
        button.disabled = false;
        button.textContent = BACKUP_IDLE_LABEL;
      }
    }
  }

  async function open() {
    openButton.disabled = true;
    try {
      await openFolder();
    } catch (error) {
      if (isDisposed()) return;
      const reason = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim() : 'it is not available.';
      show(`The folder could not be opened: ${reason}`, 'error');
    } finally {
      if (!isDisposed()) openButton.disabled = false;
    }
  }

  button.addEventListener('click', () => { void backUp(); });
  openButton.addEventListener('click', () => { void open(); });
  return { backUp, open };
}
