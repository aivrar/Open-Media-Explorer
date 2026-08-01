/**
 * Shared registry of DOM element references that get set once by shell.js
 * during `buildShell()` and read everywhere else (render, detail, sidebar,
 * chain). Keeping this in its own file avoids circular imports between
 * shell.js and the modules that need to read what shell built.
 *
 * Only DOM refs go here. State lives in state.js.
 */

export const ui = {
  root:           null,
  sidebar:        null,
  searchInput:    null,
  resultsHost:    null,
  statusHost:     null,
  windowBack:     null,
  detailPanel:    null,
  chipsHost:      null,
  sentinel:       null,
  sentinelStatus: null,
  sentinelButton: null,
  // Filter chip inputs (set by shell)
  countryInput:   null,
  languageInput:  null,
  yearMinInput:   null,
  yearMaxInput:   null,
};
