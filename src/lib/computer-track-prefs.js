import { checkProfileStorageBudget, EXTRA_SETTINGS_STORAGE_KEY } from './profile-storage.js';
import { movedComputerRecords, stageComputerMoves } from './part-resume.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import { clearPersistenceFailure, reportPersistenceFailure } from './persistence-notice.js';

const FILE_LIMIT = 500;
export const validSubtitleKey = (key) => typeof key === 'string' && /^[\w-]{1,64}$/.test(key);
const validAudioIndex = (index) => Number.isSafeInteger(index) && index >= 0;
const language = (tag) => typeof tag === 'string' && /^[a-z0-9-]{1,35}$/i.test(tag) ? tag.toLowerCase() : '';

export function computerTrackFileKey(id, entry) {
  if (!id || !Number.isFinite(entry?.size) || !Number.isFinite(entry?.mtime)) return '';
  return JSON.stringify([id, entry.size, entry.mtime]);
}

function readExtraSettings(storage) {
  try {
    const value = JSON.parse(storage?.getItem(EXTRA_SETTINGS_STORAGE_KEY) ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  return {};
}

function trackPrefs(value) {
  const files = new Map();
  if (Array.isArray(value?.files)) {
    for (const entry of value.files.slice(-FILE_LIMIT)) {
      const { file, audio, subtitle } = entry ?? {};
      if (typeof file !== 'string' || !file || file.length > 256) continue;
      const picks = {};
      if (validAudioIndex(audio)) picks.audio = audio;
      if (subtitle === '' || validSubtitleKey(subtitle)) picks.subtitle = subtitle;
      if (Object.keys(picks).length) files.set(file, picks);
    }
  }
  return { files, audioLanguage: language(value?.audioLanguage), subtitleLanguage: language(value?.subtitleLanguage) };
}

export function loadComputerTrackPrefs(storage = globalThis.localStorage) {
  return trackPrefs(readExtraSettings(storage).computerTracks);
}

export function rememberComputerTracks(file, choices, languages = {}, storage = globalThis.localStorage) {
  const extra = readExtraSettings(storage);
  const prefs = trackPrefs(extra.computerTracks);
  if (file) {
    const picks = { ...prefs.files.get(file), ...choices };
    prefs.files.delete(file);
    if (validAudioIndex(picks.audio) || picks.subtitle != null) prefs.files.set(file, picks);
  }
  prefs.audioLanguage = language(languages.audio ?? prefs.audioLanguage);
  prefs.subtitleLanguage = language(languages.subtitle ?? prefs.subtitleLanguage);
  saveTrackPrefs(storage, extra, prefs);
}

function saveTrackPrefs(storage, extra, prefs) {
  const current = {
    ...prefs, files: [...prefs.files].slice(-FILE_LIMIT).map(([key, picks]) => ({ file: key, ...picks })),
  };
  try {
    const raw = JSON.stringify({ ...extra, computerTracks: current });
    checkProfileStorageBudget(storage, [[EXTRA_SETTINGS_STORAGE_KEY, raw]]);
    storage.setItem(EXTRA_SETTINGS_STORAGE_KEY, raw);
    clearPersistenceFailure('computer-tracks');
    scheduleProfileHandoff({ storage });
  } catch {
    reportPersistenceFailure('computer-tracks', 'Track choices could not be saved.');
  }
}

export function rekeyComputerTrackFile(file, id) {
  if (!file) return file;
  const [, size, mtime] = JSON.parse(file);
  return computerTrackFileKey(id, { size, mtime });
}

export function moveComputerTrackPrefs(moves, storage = globalThis.localStorage) {
  const extra = readExtraSettings(storage);
  const prefs = trackPrefs(extra.computerTracks);
  if (!prefs.files.size) return;
  stageComputerMoves(moves, (batch) => {
    const updated = movedComputerRecords(prefs.files, batch, (file, destinations) => {
      try {
        const [from, size, mtime] = JSON.parse(file);
        const to = destinations.get(from);
        if (to && computerTrackFileKey(from, { size, mtime }) === file) {
          return { from, to, key: computerTrackFileKey(to, { size, mtime }) };
        }
      } catch { /* Ignore malformed keys. */ }
    });
    if (updated.size === prefs.files.size && [...updated].every(([key, value]) => prefs.files.get(key) === value)) return;
    prefs.files = updated;
    saveTrackPrefs(storage, extra, prefs);
  });
}

export function preferredComputerAudio(prefs, file, tracks) {
  const saved = prefs.files.get(file)?.audio;
  const matchingLanguage = (track) => prefs.audioLanguage && language(track.language) === prefs.audioLanguage;
  const match = tracks.find((track) => track.index === saved)
    ?? tracks.find((track) => track.selected && matchingLanguage(track))
    ?? tracks.find(matchingLanguage);
  return match?.selected ? undefined : match?.index;
}

export function preferredComputerSubtitle(prefs, file, tracks, audioTracks) {
  const saved = prefs.files.get(file)?.subtitle;
  if (saved === '' || tracks.some((track) => track.key === saved)) return saved;
  const audioLanguage = language(audioTracks.find((track) => track.selected)?.language);
  return tracks.find((track) => prefs.subtitleLanguage && language(track.language) === prefs.subtitleLanguage)?.key
    ?? tracks.find((track) => track.forced && audioLanguage && language(track.language) === audioLanguage)?.key
    ?? '';
}
