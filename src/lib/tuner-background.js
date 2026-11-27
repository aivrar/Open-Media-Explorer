/** Backdrop visibility, strength and frame rate for the Tuner. */

export const TUNER_BACKGROUND_RELEASED = true;
export const TUNER_BACKGROUND_FPS_MAX = 30;
export const TUNER_BACKGROUND_OPACITY = 0.08;
export const TUNER_BACKGROUND_STOP_GRACE_MS = 3000;
export const TUNER_BACKGROUND_TEXT = Object.freeze({
  label: 'Show the Visualizer behind the Tuner',
  description: 'Show the Visualizer behind the Tuner during music, TV, or video playback after accepting the flashing notice.',
});

/** The level a new user (or one from before the level existed) gets:
 *  TUNER_BACKGROUND_OPACITY in percent, the look it always had. */
export const TUNER_BACKGROUND_DEFAULT_LEVEL = 8;
export const TUNER_BACKGROUND_LEVEL_MAX = 100;

/** The saved level: a whole number from 1 to 100 (0 is the switch off, so
 *  it is never the saved level); anything else is the default. */
export function normalizeTunerBackgroundLevel(value) {
  // Only a number, or a string of plain digits (true, [100] and the like are
  // not levels, though Number() would make them one).
  const plain = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
  if (!plain) return TUNER_BACKGROUND_DEFAULT_LEVEL;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return TUNER_BACKGROUND_DEFAULT_LEVEL;
  return Math.min(TUNER_BACKGROUND_LEVEL_MAX, n);
}

/** The layer's opacity for a level: the level in percent. */
export function tunerBackgroundOpacity(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return TUNER_BACKGROUND_OPACITY;
  return Math.max(0, Math.min(TUNER_BACKGROUND_LEVEL_MAX, n)) / 100;
}

/** The level the Tuner's stepper shows: 0 while the setting is off. */
export function tunerBackgroundShownLevel(settings = {}) {
  return settings.tunerVisualizerBackground === true
    ? normalizeTunerBackgroundLevel(settings.tunerVisualizerLevel)
    : 0;
}

/** The settings to save for the stepper set to `level`, or null for none:
 *  0 turns the setting off, as the Settings switch does; above 0 sets the
 *  level and, from off, turns the setting on. Turned down to 0 here, the
 *  last level on the way was 1, which would be all but invisible when the
 *  Settings switch turns it on again, so the default is kept instead (the
 *  Settings switch itself keeps whatever level was set). */
export function tunerBackgroundLevelPatch(settings = {}, level) {
  const n = Math.max(0, Math.min(TUNER_BACKGROUND_LEVEL_MAX, Math.round(Number(level)) || 0));
  if (n === tunerBackgroundShownLevel(settings)) return null;
  if (n === 0) return { tunerVisualizerBackground: false, tunerVisualizerLevel: TUNER_BACKGROUND_DEFAULT_LEVEL };
  return settings.tunerVisualizerBackground === true
    ? { tunerVisualizerLevel: n }
    : { tunerVisualizerBackground: true, tunerVisualizerLevel: n };
}

/** Include all TV and video, and skip other items identified as speech. */
export function tunerBackgroundAllowsPlayback(item) {
  if (!item || item.type === 'tv' || item.type === 'video') return true;
  if (item.source === 'librivox') return false;
  return !Array.isArray(item.tags)
    || !item.tags.some((tag) => /^(speech|spoken word|talk|talk radio|podcast|audiobook)$/i.test(tag));
}

/** Whether the background should be drawn now (the Tuner showing aside). */
export function tunerBackgroundWanted(appState) {
  const settings = appState?.settings || {};
  return settings.tunerVisualizerBackground === true
    && settings.visualizerNoticeSeen === true
    && appState?.isPlaying === true
    && tunerBackgroundAllowsPlayback(appState.currentItem);
}
