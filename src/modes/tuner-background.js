/** Host the shared picture behind the Tuner while the backdrop is enabled. */
import { getState, subscribe } from '../lib/state.js';
import {
  TUNER_BACKGROUND_RELEASED, TUNER_BACKGROUND_STOP_GRACE_MS, tunerBackgroundOpacity, tunerBackgroundAllowsPlayback,
  tunerBackgroundShownLevel, tunerBackgroundWanted,
} from '../lib/tuner-background.js';
import { showVisualizer } from './visualizer.js';

export function attachTunerBackground(root, {
  released = TUNER_BACKGROUND_RELEASED,
  state = getState,
  on = subscribe,
  doc = globalThis.document,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  ...visualizerOptions
} = {}) {
  if (!released || !root) return () => {};
  const subs = [];
  let layer = null;
  let release = null;
  let stopTimer = 0;
  let detached = false;

  function clearStop() {
    if (stopTimer) clearTimer(stopTimer);
    stopTimer = 0;
  }

  function stop(handoff = false) {
    clearStop();
    release?.(handoff);
    release = null;
    layer?.remove();
    layer = null;
    root.classList.remove('has-viz-bg');
  }

  // How strongly it shows (the Tuner's stepper): only the layer's opacity
  // follows a new level; the Visualizer in it is not started again.
  function applyLevel() {
    if (!layer?.style) return;
    const opacity = String(tunerBackgroundOpacity(tunerBackgroundShownLevel(state().settings || {})));
    if (layer.style.opacity !== opacity) layer.style.opacity = opacity;
  }

  function start() {
    layer = doc.createElement('div');
    layer.className = 'tuner-viz-bg';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    applyLevel();
    root.classList.add('has-viz-bg');
    root.append(layer);
    release = showVisualizer(layer, 'tuner', {
      ...visualizerOptions, state, on, doc,
      onError: () => stop(),
    });
  }

  function update() {
    if (detached) return;
    const appState = state();
    // The Tuner has gone: everything away, listeners too.
    if (appState.mode !== 'tuner') { detach(appState.mode === 'visualizer'); return; }
    if (tunerBackgroundWanted(appState)) {
      clearStop();
      if (!layer) start();
      else applyLevel();
      return;
    }
    if (!layer) return;
    const settings = appState.settings || {};
    // Only the sound stopped: a short wait, so a new station picks up again.
    if (settings.tunerVisualizerBackground === true && settings.visualizerNoticeSeen === true
      && tunerBackgroundAllowsPlayback(appState.currentItem)) {
      if (!stopTimer) stopTimer = setTimer(() => { stopTimer = 0; stopUnlessWanted(); }, TUNER_BACKGROUND_STOP_GRACE_MS);
      return;
    }
    stop();
  }
  // After the wait: stop unless it is wanted again.
  function stopUnlessWanted() {
    if (detached) return;
    if (!tunerBackgroundWanted(state()) || state().mode !== 'tuner') stop();
  }

  function detach(handoff = false) {
    if (detached) return;
    stop(handoff);
    detached = true;
    while (subs.length) { try { subs.pop()(); } catch (_) {} }
  }

  subs.push(on('settings-change', update));
  subs.push(on('playing-change', update));
  subs.push(on('current-item', update));
  subs.push(on('mode-change', update));
  update();
  return detach;
}
