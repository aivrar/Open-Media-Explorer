/* The visualizer chunk's entry: what modes/visualizer.js loads with a
   dynamic import the first time the tab is opened. The styles come with it
   (Vite emits them as the chunk's own CSS file); index.js stays importable
   in tests without them. */

import './visualizer.css';

export { mountVisualizer } from './index.js';
