/**
 * Loaded by the About page when it is shown (its own chunk): the
 * Visualizer credits from the vendored manifest. Only the manifest's keys
 * named here are bundled (the build's JSON named exports), not its per-file
 * hashes. Node cannot import JSON this way: tests build the section with
 * about-credits.js and the manifest read from disk.
 */

import { borrowed, copyright, license, origin } from '../visualizer/vendor/psychedelia/manifest.json';
import { HELD_SCENE_ENTRIES, SCENES } from '../visualizer/scenes.js';
import { buildVisualizerCredits } from './about-credits.js';

const names = new Map([...SCENES, ...HELD_SCENE_ENTRIES].map((entry) => [entry.id, entry.name]));

/** The credits section, for `doc`. */
export function visualizerCredits(doc) {
  return buildVisualizerCredits(doc, { borrowed, copyright, license, origin }, (id) => names.get(id) || null);
}
