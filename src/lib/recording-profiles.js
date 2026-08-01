export const DEFAULT_RECORDING_QUALITY = 'balanced';

export const RECORDING_PROFILES = Object.freeze({
  compact: Object.freeze({
    id: 'compact',
    audioBitrateKbps: 96,
    videoMaxHeight: 480,
    videoCrf: 27,
    videoAudioBitrateKbps: 96,
  }),
  balanced: Object.freeze({
    id: 'balanced',
    audioBitrateKbps: 160,
    videoMaxHeight: 720,
    videoCrf: 23,
    videoAudioBitrateKbps: 160,
  }),
  high: Object.freeze({
    id: 'high',
    audioBitrateKbps: 256,
    videoMaxHeight: 1080,
    videoCrf: 20,
    videoAudioBitrateKbps: 192,
  }),
});

export function normalizeRecordingQuality(value) {
  return Object.hasOwn(RECORDING_PROFILES, value) ? value : DEFAULT_RECORDING_QUALITY;
}

export function getRecordingProfile(value) {
  return RECORDING_PROFILES[normalizeRecordingQuality(value)];
}
