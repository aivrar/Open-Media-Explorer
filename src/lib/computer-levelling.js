import { isComputerItem } from './item-model.js';

export const LEVELLING_MODES = { off: 'Off', track: 'Track', album: 'Album' };
export const LEVELLING_PREAMP_MIN = -12;
export const LEVELLING_PREAMP_MAX = 12;
export const LEVELLING_RAMP_SECONDS = 1.5;
const MAX_GAIN = 10 ** (12 / 20);
const RETRY_MS = 5_000;

export function levellingMode(settings) {
  const mode = settings?.volumeLevelling;
  return typeof mode === 'string' && Object.hasOwn(LEVELLING_MODES, mode) ? mode : 'off';
}

export function levellingPreamp(settings) {
  const db = settings?.levellingPreamp;
  return Number.isFinite(db) ? Math.min(LEVELLING_PREAMP_MAX, Math.max(LEVELLING_PREAMP_MIN, Math.round(db))) : 0;
}

export const isComputerMusic = (item) => isComputerItem(item) && item.type === 'audio'
  && item._extra?.computer?.kind !== 'Audiobook';

const validGain = (db) => Number.isFinite(db) && Math.abs(db) <= 51;
const validPeak = (peak) => Number.isFinite(peak) && peak > 0 && peak <= 16;
export const hasTrackGain = (entry) => validGain(entry?.rg_track_gain);

export function loudnessFields(entry) {
  const { rg_track_gain, rg_album_gain, rg_track_peak, rg_album_peak, rg_measured } = entry;
  return {
    ...(validGain(rg_track_gain) && { rg_track_gain }),
    ...(validGain(rg_album_gain) && { rg_album_gain }),
    ...(validPeak(rg_track_peak) && { rg_track_peak }),
    ...(validPeak(rg_album_peak) && { rg_album_peak }),
    ...(rg_measured === true && validGain(rg_track_gain) && { rg_measured }),
  };
}

export function sameLoudnessFile(a, b) {
  return a.id === b.id
    && (a.size == null || b.size == null || a.size === b.size)
    && (a.mtime == null || b.mtime == null || a.mtime === b.mtime);
}

export function computerLevelling(entry, settings) {
  const mode = levellingMode(settings);
  if (!entry || mode === 'off') return { gain: 1 };
  const album = mode === 'album' && validGain(entry.rg_album_gain);
  const db = album ? entry.rg_album_gain : entry.rg_track_gain;
  if (!validGain(db)) return { gain: 1 };
  const peak = album && validPeak(entry.rg_album_peak) ? entry.rg_album_peak : entry.rg_track_peak;
  const preamp = levellingPreamp(settings);
  const requested = 10 ** ((db + preamp) / 20);
  const peakLimit = validPeak(peak) ? 1 / peak : Infinity;
  const gain = Math.min(requested, peakLimit, MAX_GAIN);
  const dbApplied = 20 * Math.log10(gain);
  if (gain === 1) return { gain };
  const signed = (value) => {
    const rounded = Number(value.toFixed(1));
    return rounded > 0 ? `+${rounded}` : String(rounded);
  };
  const measured = !album && entry.rg_measured === true ? ' (measured)' : '';
  const limited = [
    peakLimit < requested && peakLimit <= MAX_GAIN && 'limited to avoid clipping',
    MAX_GAIN < requested && MAX_GAIN <= peakLimit && 'limited to +12 dB',
  ].filter(Boolean);
  return {
    gain,
    text: `${signed(dbApplied)} dB`,
    title: [`Volume levelling: ${album ? 'album' : 'track'} gain ${signed(db)} dB${measured}, pre-amp ${signed(preamp)} dB`,
      ...limited].join(', '),
  };
}

function waitToRetry(signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, RETRY_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createLoudnessRequests({ measure, onResult }) {
  const jobs = new Map();

  async function run(job) {
    const { entry, controller: { signal } } = job;
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
      try {
        const result = await measure(entry.id, { signal });
        if (signal.aborted || result?.id !== entry.id || !hasTrackGain(result)) return;
        const { rg_track_gain, rg_track_peak, rg_measured } = loudnessFields(result);
        job.result = { rg_track_gain, ...(rg_track_peak != null && { rg_track_peak }), ...(rg_measured && { rg_measured }) };
        onResult(entry, job.result);
        return;
      } catch (error) {
        if (signal.aborted || attempt > 0 || error?.status !== 503 || !error.retryable) return;
        await waitToRetry(signal);
      }
    }
  }

  return {
    // The next track's job can become the current track's job on advance.
    retain(...ids) {
      for (const [id, job] of jobs) {
        if (ids.includes(id)) continue;
        job.controller.abort();
        jobs.delete(id);
      }
    },
    resultFor(entry) {
      const job = jobs.get(entry.id);
      return job && sameLoudnessFile(entry, job.entry) ? job.result : undefined;
    },
    request(entry) {
      const previous = jobs.get(entry.id);
      if (previous && sameLoudnessFile(entry, previous.entry)) return;
      previous?.controller.abort();
      const job = { entry, controller: new AbortController() };
      jobs.set(entry.id, job);
      void run(job);
    },
  };
}
