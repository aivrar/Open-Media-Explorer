/**
 * Visualizer tab. This shell is all the main bundle holds: the visualizer
 * itself (visualizer/visualizer.js: index.js, its scenes and styles) is a
 * separate chunk fetched the first time the tab is opened. Leaving the tab
 * tears everything down (timers, animation frames, the sound subscription,
 * listeners and the WebGL context), so a closed tab costs nothing.
 */

import { getState, saveSettings, subscribe } from '../lib/state.js';
import { getAudioSignal } from '../lib/player.js';

const subs = [];
let session = null;
let loadToken = 0;

/** Loads the visualizer module; replaceable in tests. */
let loadVisualizer = () => import('../visualizer/visualizer.js');

export function setVisualizerLoaderForTests(loader) {
  loadVisualizer = loader || (() => import('../visualizer/visualizer.js'));
}

function tearDown() {
  loadToken += 1;
  while (subs.length) { try { subs.pop()(); } catch (_) {} }
  if (session) {
    const current = session;
    session = null;
    try { current.destroy(); } catch (error) { console.error('visualizer teardown failed:', error); }
  }
}

export function renderVisualizer(host) {
  tearDown();
  const token = loadToken;
  const root = document.createElement('div');
  root.className = 'visualizer-root';
  root.innerHTML = '<div class="boot-state"><p>Loading the visualizer...</p></div>';
  host.appendChild(root);
  subs.push(subscribe('mode-change', (mode) => {
    if (mode !== 'visualizer') tearDown();
  }));
  loadVisualizer().then(({ mountVisualizer }) => {
    if (token !== loadToken) return; // left the tab (or opened it again) meanwhile
    root.replaceChildren();
    session = mountVisualizer(root, {
      signal: getAudioSignal(),
      getSettings: () => getState().settings,
      saveSettings,
      subscribeSettings: (fn) => subscribe('settings-change', fn),
    });
  }).catch((error) => {
    if (token !== loadToken) return;
    console.error('visualizer failed to load:', error);
    root.innerHTML = '<div class="boot-state"><p>The visualizer could not be loaded.</p></div>';
  });
}

/** For tests: whether a visualizer is mounted right now. */
export function visualizerMounted() { return Boolean(session); }
