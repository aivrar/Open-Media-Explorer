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
  personalControls: null,
  personalType: null,
  favoritesSort: null,
  favoriteTitles: null,
  // Favorites categories row (favorite-categories.js)
  favoriteCategories: null,
  categoryChips: null,
  categoryRename: null,
  categoryDelete: null,
  categoryNew: null,
  categoryForm: null,
  categoryInput: null,
  categorySubmit: null,
  categoryFormMessage: null,
  categoryStatus: null,
  playlistSelect: null,
  playlistActions: null,
  playlistRemove: null,
  playlistStarAll: null,
  favoritesExport: null,
  playlistExport: null,
  playlistMessage: null,
  playlistLinkForm: null,
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
