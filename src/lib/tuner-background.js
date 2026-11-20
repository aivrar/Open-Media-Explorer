/**
 * The Visualizer behind the Tuner, held: the rules and numbers, without the
 * DOM (modes/tuner-background.js draws it). Released with
 * TUNER_BACKGROUND_RELEASED once measured; until then the setting is not
 * offered and nothing is made.
 *
 * - One renderer in the whole app: the Visualizer tab and this background
 *   take the one slot in turn (visualizer-slot.js). Only one is ever
 *   mounted; the other is destroyed (its WebGL context with it) before the
 *   new one makes its own.
 * - The scene is drawn as the tab would draw it, through the same mount, so
 *   the flash limiter, step-down and processor budget all apply. What it may
 *   draw is narrowed by tunerBackgroundSettings: no overlays (so no Strobe),
 *   no post effects at all (stricter than calm effects only), Low quality
 *   and at most 30 frames a second, no panel, readout or developer strip.
 * - It is drawn only after the photosensitivity notice was accepted in the
 *   Visualizer tab, only while sound plays, and only while the Tuner is the
 *   tab shown; it stops TUNER_BACKGROUND_STOP_GRACE_MS after the sound stops
 *   (a change of station does not start it all again).
 * - Dimmed: the layer is shown at TUNER_BACKGROUND_OPACITY over the Tuner's
 *   own background. Designed for 4.5:1 (WCAG AA) for every text colour the
 *   Tuner uses, in every theme, with the picture at its worst (all white in a
 *   dark theme, all black in the light one). At 0.08 the faintest, --text-mute,
 *   keeps 4.6:1 (5.5:1 to 6.2:1 without the layer), --text-dim 6.5:1 and
 *   --text 13.4:1 or more.
 *
 * All numbers PROPOSED.
 */

import { VISUALIZER_FRAME_RATES } from './visualizer-settings.js';

export const TUNER_BACKGROUND_RELEASED = false;
export const TUNER_BACKGROUND_QUALITY = 'low';
export const TUNER_BACKGROUND_FPS_MAX = 30;
export const TUNER_BACKGROUND_OPACITY = 0.08;
export const TUNER_BACKGROUND_STOP_GRACE_MS = 3000;
export const TUNER_BACKGROUND_TEXT = Object.freeze({
  label: 'Show the Visualizer behind the Tuner',
  description: 'Draws the Visualizer\'s scene, strongly dimmed, behind the Tuner\'s dial and cards while sound plays. No overlays or effects there. Starts once the Visualizer tab\'s notice about flashing has been accepted. Uses some processor and graphics power.',
});

/** Whether the background should be drawn now (the Tuner showing aside). */
export function tunerBackgroundWanted(appState) {
  const settings = appState?.settings || {};
  return settings.tunerVisualizerBackground === true
    && settings.visualizerNoticeSeen === true
    && appState?.isPlaying === true;
}

/** The settings the background's mount sees: the user's own, narrowed. */
export function tunerBackgroundSettings(settings = {}) {
  const fps = Number(settings.visualizerFps);
  const capped = VISUALIZER_FRAME_RATES.filter((rate) => rate <= TUNER_BACKGROUND_FPS_MAX);
  return {
    ...settings,
    visualizerQuality: TUNER_BACKGROUND_QUALITY,
    visualizerQualityPicked: false,
    visualizerFps: capped.includes(fps) ? fps : Math.max(...capped),
    visualizerOverlays: false,
    visualizerFx: false,
    visualizerPanelOpen: false,
    visualizerShowFps: false,
    visualizerDebug: false,
  };
}
