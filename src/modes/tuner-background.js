/**
 * The Visualizer behind the Tuner (held: lib/tuner-background.js has the
 * rules). attachTunerBackground(root) is called once by the Tuner; it returns
 * the function that takes it all away again.
 *
 * Held, or with the setting off: nothing is made, loaded or drawn (no layer,
 * no canvas, no context). Held: not even a listener.
 *
 * On: one layer (a div, aria-hidden and inert, after the Tuner's own
 * content) behind everything the Tuner shows, made only while it is wanted
 * (tunerBackgroundWanted). In it the same Visualizer the tab uses is mounted,
 * with the narrowed settings (tunerBackgroundSettings) and nothing saved
 * back. It takes the app's one Visualizer slot (visualizer-slot.js) before
 * mounting, so a Visualizer still mounted anywhere is destroyed first. It is
 * taken away when the setting goes off, at once; when the sound stops, after
 * TUNER_BACKGROUND_STOP_GRACE_MS; and when the Tuner goes, at once.
 */

import { getState, subscribe } from '../lib/state.js';
import { getAudioSignal } from '../lib/player.js';
import {
  TUNER_BACKGROUND_RELEASED, TUNER_BACKGROUND_STOP_GRACE_MS, tunerBackgroundSettings, tunerBackgroundWanted,
} from '../lib/tuner-background.js';
import { claimVisualizer } from '../lib/visualizer-slot.js';

const defaultLoad = () => import('../visualizer/visualizer.js');

export function attachTunerBackground(root, {
  released = TUNER_BACKGROUND_RELEASED,
  state = getState,
  on = subscribe,
  signal = () => getAudioSignal(),
  load = defaultLoad,
  doc = globalThis.document,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  mountOptions = {},
} = {}) {
  if (!released || !root) return () => {};
  const subs = [];
  let layer = null;
  let session = null;
  let unclaim = null;
  let token = 0;
  let stopTimer = 0;
  let detached = false;

  function clearStop() {
    if (stopTimer) clearTimer(stopTimer);
    stopTimer = 0;
  }

  function stop() {
    token += 1;
    clearStop();
    const current = session;
    session = null;
    if (current) {
      try { current.destroy(); } catch (error) { console.error('tuner background teardown failed:', error); }
    }
    unclaim?.();
    unclaim = null;
    layer?.remove();
    layer = null;
    root.classList.remove('has-viz-bg');
  }

  function start() {
    const mine = ++token;
    layer = doc.createElement('div');
    layer.className = 'tuner-viz-bg';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    root.classList.add('has-viz-bg');
    root.append(layer);
    load().then(({ mountVisualizer }) => {
      if (mine !== token || detached) return;
      unclaim = claimVisualizer('tuner', stop);
      const host = doc.createElement('div');
      layer.append(host);
      session = mountVisualizer(host, {
        signal: signal(),
        getSettings: () => tunerBackgroundSettings(state().settings),
        saveSettings: () => {},
        subscribeSettings: (fn) => on('settings-change', (settings) => fn(tunerBackgroundSettings(settings))),
        background: true,
        ...mountOptions,
      });
    }).catch((error) => {
      if (mine !== token) return;
      console.error('tuner background failed to load:', error);
      stop();
    });
  }

  function update() {
    if (detached) return;
    const appState = state();
    if (appState.mode !== 'tuner') { stop(); return; }
    if (tunerBackgroundWanted(appState)) {
      clearStop();
      if (!layer) start();
      return;
    }
    if (!layer) return;
    const settings = appState.settings || {};
    // Only the sound stopped: a short wait, so a new station picks up again.
    if (settings.tunerVisualizerBackground === true && settings.visualizerNoticeSeen === true) {
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

  subs.push(on('settings-change', update));
  subs.push(on('playing-change', update));
  subs.push(on('mode-change', update));
  update();

  return function detach() {
    if (detached) return;
    stop();
    detached = true;
    while (subs.length) { try { subs.pop()(); } catch (_) {} }
  };
}
