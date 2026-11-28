import { controlRequest } from './capture-client.js';
import { clearDidNotPlay } from './did-not-play.js';
import { isSavedItem } from './did-not-play-view.js';
import { safeExternalUrl } from './item-model.js';
import { clearPlayedStream } from './played-streams.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { emit } from './state.js';
import {
  cleanStreamAddress, MAX_BACKUP_STREAMS, stationStreamDocument, writeStationStreamEdits,
} from './station-stream-addresses.js';

const invalidAddress = 'Enter a public HTTP or HTTPS address without a username or password.';

export function canEditStationStreams(item) {
  return (item?.type === 'radio' || item?.type === 'tv')
    && item.__contentHidden !== true && isSavedItem(item.id);
}

export async function saveStationStreams(item, value, { request = controlRequest, signal } = {}) {
  if (!canEditStationStreams(item)) throw new Error('Save this station before editing its stream addresses.');
  const doc = stationStreamDocument();
  if (doc.locked) throw new Error('These addresses were saved by a newer version of World Media.');
  const original = item.stream_url || '';
  const typed = value.main.trim();
  const cleanMain = cleanStreamAddress(typed);
  const originalSelected = typed === original || (cleanMain && safeExternalUrl(cleanMain) === safeExternalUrl(original));
  const main = originalSelected ? '' : cleanMain;
  if (!originalSelected && !main) throw new Error(invalidAddress);

  const backups = value.backups.map(cleanStreamAddress);
  if (backups.length > MAX_BACKUP_STREAMS) throw new Error(`Add up to ${MAX_BACKUP_STREAMS} backup addresses.`);
  if (backups.some((url) => !url)) throw new Error(invalidAddress);
  const keys = [main || original, ...backups].map(safeExternalUrl).filter(Boolean);
  if (new Set(keys).size !== keys.length) throw new Error('Use a different address for each stream.');

  const imported = item._extra?.backupStreamUrls || [];
  const keptBackups = JSON.stringify(backups) === JSON.stringify(imported) ? null : backups;
  const previous = doc.edits.get(item.id);
  if ((previous?.main || '') === main && JSON.stringify(previous?.backups ?? null) === JSON.stringify(keptBackups)) {
    return false;
  }

  // Use the same native URL checks as playlist imports, without fetching any stream.
  const urls = [...(main ? [main] : []), ...(keptBackups || [])];
  if (urls.length) await request('/api/v1/playlists/validate-stream-addresses', {
    method: 'POST', body: { urls }, ownConnection: true, signal,
  });

  signal?.throwIfAborted();
  const latest = stationStreamDocument();
  if (latest.locked || JSON.stringify(latest.edits.get(item.id)) !== JSON.stringify(previous) || !canEditStationStreams(item)) {
    throw new Error('The saved station changed. Open the editor again and retry.');
  }
  const edits = new Map(latest.edits);
  if (main || keptBackups) edits.set(item.id, { main, backups: keptBackups });
  else edits.delete(item.id);
  writeStationStreamEdits(edits, { checkBudget: true });
  scheduleProfileHandoff();
  emit('station-streams-change', item.id);
  clearDidNotPlay(item.id);
  if (safeExternalUrl(previous?.main || original) !== safeExternalUrl(main || original)) {
    clearPlayedStream(item.id);
  }
  return true;
}
