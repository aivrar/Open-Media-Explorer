import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BACKUP_BUSY_LABEL, BACKUP_FLUSH_FAILED, BACKUP_IDLE_LABEL, BACKUP_ROUTE,
  backupSuccessMessage, bindBackupControls, createBackup, runBackup,
} from '../src/lib/backup.js';
import {
  cancelScheduledProfileHandoff, flushProfileHandoff, scheduleProfileHandoff,
} from '../src/lib/profile-transfer.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { FakeElement } from './helpers/fake-dom.js';

const RESULT = {
  path: 'D:\\WorldMedia\\downloads\\WorldMedia-backup-20261114-221500.zip',
  name: 'WorldMedia-backup-20261114-221500.zip',
  size: 2048,
  summary: { favorites: 124, favorites_exported: 124, favorites_skipped: 0, playlists: 3 },
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function controls() {
  const button = new FakeElement('backup', 'button');
  button.textContent = BACKUP_IDLE_LABEL;
  const status = new FakeElement('backup-status', 'span');
  const openButton = new FakeElement('backup-open', 'button');
  openButton.hidden = true;
  return { button, status, openButton };
}

const click = (element) => element.dispatchEvent(new Event('click'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('backup mirrors the profile and waits for it before asking for the ZIP', async () => {
  const order = [];
  const flushed = deferred();
  const flush = () => { order.push('flush'); return flushed.promise; };
  const create = async () => { order.push('create'); return RESULT; };
  const running = runBackup({ flush, create });
  await settle();
  assert.deepEqual(order, ['flush']);
  flushed.resolve({ saved: true });
  assert.equal(await running, RESULT);
  assert.deepEqual(order, ['flush', 'create']);
});

test('a failed or skipped mirror stops the backup with a plain message', async () => {
  let created = 0;
  const create = async () => { created += 1; return RESULT; };
  await assert.rejects(runBackup({ flush: async () => { throw new Error('Disk full'); }, create }),
    (error) => error.message === BACKUP_FLUSH_FAILED);
  await assert.rejects(runBackup({ flush: async () => ({ saved: false }), create }),
    (error) => error.message === BACKUP_FLUSH_FAILED);
  assert.equal(created, 0);
});

test('the button is disabled while running, then shows the saved file and Open folder', async () => {
  const elements = controls();
  const created = deferred();
  const calls = [];
  bindBackupControls({
    ...elements,
    flush: async () => { calls.push('flush'); return { saved: true }; },
    create: () => { calls.push('create'); return created.promise; },
    openFolder: async () => { calls.push('open'); },
  });
  click(elements.button);
  await settle();
  assert.equal(elements.button.disabled, true);
  assert.equal(elements.button.textContent, BACKUP_BUSY_LABEL);
  assert.equal(elements.openButton.hidden, true);
  click(elements.button); // A second click while running starts nothing.
  await settle();
  assert.deepEqual(calls, ['flush', 'create']);

  created.resolve(RESULT);
  await settle();
  assert.equal(elements.button.disabled, false);
  assert.equal(elements.button.textContent, BACKUP_IDLE_LABEL);
  assert.equal(elements.status.textContent,
    'Backup saved: WorldMedia-backup-20261114-221500.zip (124 favorites, 3 playlists)');
  assert.equal(elements.status.dataset.state, 'ready');
  assert.equal(elements.openButton.hidden, false);

  click(elements.openButton);
  await settle();
  assert.deepEqual(calls, ['flush', 'create', 'open']);
});

test('flush and backend failures show one plain line and re-enable the button', async () => {
  const elements = controls();
  let created = 0;
  const api = bindBackupControls({
    ...elements,
    flush: async () => { throw new Error('Profile backup is too large.'); },
    create: async () => { created += 1; return RESULT; },
  });
  await api.backUp();
  assert.equal(created, 0);
  assert.equal(elements.status.textContent, BACKUP_FLUSH_FAILED);
  assert.equal(elements.status.dataset.state, 'error');
  assert.equal(elements.button.disabled, false);
  assert.equal(elements.openButton.hidden, true);

  const second = controls();
  const failing = bindBackupControls({
    ...second,
    flush: async () => ({ saved: true }),
    create: async () => { throw new Error('The downloads folder is not available, so no backup was made.'); },
    openFolder: async () => { throw new Error('Downloads directory is unavailable.'); },
  });
  await failing.backUp();
  assert.equal(second.status.textContent,
    'Backup failed: The downloads folder is not available, so no backup was made.');
  assert.equal(second.openButton.hidden, true);
  assert.equal(second.button.textContent, BACKUP_IDLE_LABEL);
  await failing.open();
  assert.equal(second.status.textContent, 'The folder could not be opened: Downloads directory is unavailable.');
});

test('closing Settings mid-backup leaves the removed controls alone', async () => {
  const elements = controls();
  let disposed = false;
  const api = bindBackupControls({
    ...elements,
    flush: async () => ({ saved: true }),
    create: async () => { disposed = true; return RESULT; },
    isDisposed: () => disposed,
  });
  await api.backUp();
  assert.equal(elements.status.textContent, '');
  assert.equal(elements.button.textContent, BACKUP_BUSY_LABEL);
});

test('success text counts skipped favorites and stays plain', () => {
  assert.equal(
    backupSuccessMessage({ name: 'b.zip', summary: { favorites: 1, playlists: 1, favorites_skipped: 1 } }),
    'Backup saved: b.zip (1 favorite, 1 playlist). 1 favorite has no direct link, so the .m3u8 files leave it out',
  );
  assert.equal(
    backupSuccessMessage({ name: 'b.zip', summary: { favorites: 9, playlists: 0, favorites_skipped: 4 } }),
    'Backup saved: b.zip (9 favorites, 0 playlists). 4 favorites have no direct link, so the .m3u8 files leave them out',
  );
  assert.equal(backupSuccessMessage({}), 'Backup saved: backup file (0 favorites, 0 playlists)');
});

test('the backup route is a fixed authenticated POST with an empty body', async () => {
  resetControlSession();
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    const data = path === '/api/v1/session' ? { token: 'token' } : RESULT;
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  assert.deepEqual(await createBackup({ fetchImpl }), RESULT);
  assert.equal(calls[1].path, BACKUP_ROUTE);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['X-WorldMedia-Token'], 'token');
  assert.equal(calls[1].options.body, '{}');
  resetControlSession();
});

test('flushProfileHandoff waits for an automatic save already being sent, then saves again', async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:' };
  const storage = { getItem: (key) => (key === 'worldmedia.favorites.v1' ? '[{"id":"a"}]' : null) };
  const order = [];
  const background = deferred();
  try {
    scheduleProfileHandoff({
      delayMs: 0, storage,
      requestImpl: async () => { order.push('background-start'); await background.promise; order.push('background-end'); },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ['background-start']);
    const flushing = flushProfileHandoff({
      storage, requestImpl: async (path, options) => { order.push(`flush ${path} ${Object.keys(options.body.values)}`); },
    });
    await settle();
    assert.deepEqual(order, ['background-start']);
    background.resolve();
    const result = await flushing;
    assert.equal(result.saved, true);
    assert.deepEqual(order, [
      'background-start', 'background-end', 'flush /api/v1/profile/preferences worldmedia.favorites.v1',
    ]);
    await assert.rejects(flushProfileHandoff({ storage, requestImpl: async () => { throw new Error('Disk full'); } }),
      /Disk full/);
  } finally {
    cancelScheduledProfileHandoff(); // The retry a failed flush queues.
    globalThis.location = previousLocation;
  }
});

test('Settings shows the backup button, its permanent note and a live status line', async () => {
  const [settings, css] = await Promise.all([
    readFile(new URL('../src/lib/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8'),
  ]);
  assert.match(settings, /data-act="create-backup"[^>]*>Back up my data</);
  assert.match(settings, /data-act="backup-open-folder" hidden>Open folder</);
  assert.match(settings, /share the backup only with people you trust/);
  assert.match(settings, /data-backup-status role="status" aria-live="polite"/);
  assert.match(settings, /bindBackupControls\(\{[\s\S]*isDisposed: \(\) => disposed/);
  assert.match(css, /\.row \.backup-status \{[^}]*overflow-wrap: anywhere/);
  const source = await readFile(new URL('../src/lib/backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});
