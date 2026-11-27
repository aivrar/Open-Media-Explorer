/** The Visualizer tab and the Tuner share a lazy-loaded Visualizer mount. */
import { getState, saveSettings, subscribe } from '../lib/state.js';
import { getAudioSignal } from '../lib/player.js';
import { TUNER_BACKGROUND_RELEASED, tunerBackgroundWanted } from '../lib/tuner-background.js';
import { hostVisualizer, visualizerHolder } from '../lib/visualizer-slot.js';

const defaultLoad = () => import('../visualizer/visualizer.js');
let loadVisualizer = defaultLoad;

export function setVisualizerLoaderForTests(loader) {
  loadVisualizer = loader || defaultLoad;
}

export function showVisualizer(host, owner, {
  doc = globalThis.document,
  load = loadVisualizer,
  state = getState,
  on = subscribe,
  save = saveSettings,
  signal = getAudioSignal,
  mountOptions = {},
  onError,
} = {}) {
  return hostVisualizer(host, {
    owner, doc, load, onError,
    options: () => ({
      signal: signal(),
      getSettings: () => state().settings,
      saveSettings: save,
      subscribeSettings: (fn) => on('settings-change', fn),
      ...mountOptions,
    }),
  });
}

let leaveTab = null;

export function renderVisualizer(host, options) {
  leaveTab?.();
  const release = showVisualizer(host, 'tab', {
    ...options,
    onError(root) {
      root.innerHTML = '<div class="boot-state"><p>The visualizer could not be loaded.</p></div>';
    },
  });
  const state = options?.state || getState;
  const on = options?.on || subscribe;
  const unsubscribe = on('mode-change', (mode) => {
    if (mode !== 'visualizer') {
      leaveTab(mode === 'tuner' && TUNER_BACKGROUND_RELEASED && tunerBackgroundWanted(state()));
    }
  });
  leaveTab = (handoff = false) => {
    unsubscribe();
    leaveTab = null;
    release(handoff);
  };
}

export function visualizerMounted() { return visualizerHolder() === 'tab'; }
