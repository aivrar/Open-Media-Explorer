// Release 0.1.12 (commit f8e9634), normalizeSettings from src/lib/state.js as released, with the defaults it reads; fields outside the Visualizer use this build's helpers.
import { isRetiredSource, SOURCE_IDS } from '../../../../src/lib/sources.js';
import { bestStreamMode } from '../../../../src/lib/best-stream.js';
import { normalizeProcessorLimit, normalizeProcessorUse } from '../../../../src/lib/processor-budget.js';
import { normalizeRecordingQuality } from '../../../../src/lib/recording-profiles.js';
import { normalizeTheme } from '../../../../src/lib/themes.js';
import { normalizeFavoritesSort } from '../../../../src/lib/favorites-order.js';
import { normalizeTunerCardSize } from '../../../../src/lib/tuner-card-size.js';
import {
  normalizeVisualizerBrightness, normalizeVisualizerFps,
  normalizeVisualizerQuality, normalizeVisualizerScene, normalizeVisualizerLooks, normalizeVisualizerExtras,
} from './visualizer-settings.js';

export const SETTINGS_VERSION = 1;

const DEFAULT_SETTINGS = {
  defaultMode: 'library',
  enabledSources: Object.fromEntries(SOURCE_IDS.map((id) => [id, true])),
};

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const enabledSources = { ...DEFAULT_SETTINGS.enabledSources };
  if (source.enabledSources && typeof source.enabledSources === 'object' && !Array.isArray(source.enabledSources)) {
    for (const [sourceId, enabled] of Object.entries(source.enabledSources)) {
      // A switch saved for a source the app no longer offers is dropped quietly.
      if (isRetiredSource(sourceId)) continue;
      if (typeof enabled === 'boolean') enabledSources[sourceId] = enabled;
    }
  }
  const version = Number.isInteger(source.version) && source.version > 0
    ? source.version
    : SETTINGS_VERSION;
  return {
    ...source,
    version,
    theme: normalizeTheme(source.theme),
    defaultMode: ['library', 'tuner', 'grid', 'discovery', 'about'].includes(source.defaultMode)
      ? source.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    recordingEnabled: source.recordingEnabled !== false,
    recordingQuality: normalizeRecordingQuality(source.recordingQuality),
    showExplicitContent: source.showExplicitContent === true,
    tunerFavoritesOnly: source.tunerFavoritesOnly === true,
    showTechnicalDetails: source.showTechnicalDetails === true,
    videoSize: source.videoSize === 'large' ? 'large' : 'normal',
    favoritesSort: normalizeFavoritesSort(source.favoritesSort),
    tunerCardSize: normalizeTunerCardSize(source.tunerCardSize),
    // Only an explicit false turns it off; older builds keep the field as is.
    soundMeter: source.soundMeter !== false,
    bestStreamMode: bestStreamMode(source),
    processorUse: normalizeProcessorUse(source.processorUse),
    processorLimit: normalizeProcessorLimit(source.processorLimit),
    visualizerQuality: normalizeVisualizerQuality(source.visualizerQuality),
    visualizerFps: normalizeVisualizerFps(source.visualizerFps),
    visualizerBrightness: normalizeVisualizerBrightness(source.visualizerBrightness),
    visualizerScene: normalizeVisualizerScene(source.visualizerScene),
    visualizerLooks: normalizeVisualizerLooks(source.visualizerLooks),
    // Off unless turned on (an explicit true).
    visualizerShowFps: source.visualizerShowFps === true,
    visualizerQualityPicked: source.visualizerQualityPicked === true,
    visualizerShuffleCostPicked: source.visualizerShuffleCostPicked === true,
    tunerVisualizerBackground: source.tunerVisualizerBackground === true,
    visualizerDebug: source.visualizerDebug === true,
    ...normalizeVisualizerExtras(source),
    enabledSources,
  };
}

/** What its saveSettings stores: the settings with `partial` over them,
 *  normalised (state.js saveSettings). */
export function savedSettings(current, partial) {
  return normalizeSettings({ ...current, ...partial });
}
