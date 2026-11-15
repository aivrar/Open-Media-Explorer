import { addPlaylistLink, getPlaylists, importPlaylistFile, loadPlaylists, playlistName, removePlaylist } from '../../lib/playlists.js';
import { addFavorites, BULK_FAVORITES_LIMIT, countNewFavorites, getState, saveSettings } from '../../lib/state.js';
import { FAVORITES_SORT_MANUAL, FAVORITES_SORT_NAME, normalizeFavoritesSort } from '../../lib/favorites-order.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { isPersonalSource, libraryPool, personalFilters } from './personal.js';
import { filteredItemsForCurrentView, renderResults, renderStatus, updateSentinelStatus } from './render.js';
import { buildFavoriteCategories, syncFavoriteCategories } from './favorite-categories.js';

function refresh() { renderResults(); renderStatus(); updateSentinelStatus(); }

/** Starring more new channels than this at once asks first: there is no bulk un-star. */
export const STAR_ALL_CONFIRM_ABOVE = 25;

/** Plain-words result of "Star all". */
export function starAllMessage(result) {
  const text = starAllSummary(result);
  return result.eqFailed ? `${text} Equalizer settings for the new favorites could not be saved.` : text;
}

function starAllSummary({ added, already, refused, leftOut, failed }) {
  if (failed) return 'Favorites could not be saved. Nothing was added.';
  if (!added && !already && !refused && !leftOut) return 'No channels are listed to star.';
  if (!added && !refused && !leftOut) return already === 1 ? 'It is already in Favorites.' : `All ${already} are already in Favorites.`;
  if (!added && leftOut) {
    const full = `Favorites is full (limited to ${BULK_FAVORITES_LIMIT}); ${leftOut} not added`;
    const notes = [already && `${already} ${already === 1 ? 'was' : 'were'} already there`, refused && `${refused} could not be added`].filter(Boolean);
    return `${[full, ...notes].join(', ')}.`;
  }
  const parts = [`Added ${added} to Favorites`];
  if (already) parts.push(`${already} ${already === 1 ? 'was' : 'were'} already there`);
  if (leftOut) parts.push(`${leftOut} left out (Favorites is limited to ${BULK_FAVORITES_LIMIT})`);
  if (refused) parts.push(`${refused} could not be added`);
  return `${parts.join('; ')}.`;
}

/** Star every channel My Playlists lists now: the chosen playlist, type and
 *  search, including cards not rendered yet. */
export function starAllListed({ confirmImpl = (text) => globalThis.confirm(text) } = {}) {
  const listed = filteredItemsForCurrentView(libraryPool());
  const count = countNewFavorites(listed);
  if (count > STAR_ALL_CONFIRM_ABOVE && !confirmImpl(`Add ${count} channels to Favorites? There is no undo for all of them at once.`)) {
    return { cancelled: true, message: 'Nothing was starred.' };
  }
  const result = addFavorites(listed);
  return { ...result, cancelled: false, message: starAllMessage(result) };
}

// Set while the Library is mounted; lets a dropped file use the same import
// path, busy state and messages as the Import playlist button.
let importLocal = null;

/** Import a local .m3u/.m3u8/.pls/.xspf file into My Playlists. `type` ('tv' or 'radio')
 *  overrides the "Add as" choice. Resolves false if the Library is not open. */
export function importLocalPlaylist(file, type = '') {
  return importLocal ? importLocal(file, type) : Promise.resolve(false);
}

function selectControl(label, options, onChange) {
  const select = el('select', { className: 'chip', attrs: { 'aria-label': label, title: label }, on: { change: onChange } },
    ...options.map(([value, text]) => el('option', { attrs: { value }, text })));
  if (options.length) select.value = options[0][0];
  return select;
}

const PERSONAL_TYPES = [['', 'All'], ['radio', 'Radio'], ['tv', 'TV'], ['audio', 'Audio'], ['video', 'Video']];

/** Shows `type` as the one pressed button in the media type group. */
export function pressTypeButton(group, type) {
  for (const button of group.children) {
    const active = button.getAttribute('data-type') === type;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// Favorites only. "My order" is the saved order, which the move buttons on
// each card change; "A-Z" sorts by name for display and keeps that order.
const FAVORITES_SORTS = [
  [FAVORITES_SORT_MANUAL, 'My order', 'Your own order. Use the arrows on each favorite to move it.'],
  [FAVORITES_SORT_NAME, 'A–Z', 'By name. Choose My order to arrange favorites by hand.'],
];

/** Shows the saved favorites sort as the pressed button. */
export function syncFavoritesSort() {
  if (!ui.favoritesSort) return;
  const current = normalizeFavoritesSort(getState().settings.favoritesSort);
  for (const button of ui.favoritesSort.children) {
    const value = button.getAttribute('data-sort');
    if (!value) continue;
    button.classList.toggle('is-active', value === current);
    button.setAttribute('aria-pressed', value === current ? 'true' : 'false');
  }
}

function buildFavoritesSort() {
  return el('div', { className: 'personal-sort', attrs: { role: 'group', 'aria-label': 'Sort favorites' } },
    el('span', { className: 'personal-sort-label', text: 'Sort', attrs: { 'aria-hidden': 'true' } }),
    ...FAVORITES_SORTS.map(([value, text, tip]) => el('button', {
      className: 'chip', text, attrs: { type: 'button', 'data-sort': value, 'aria-pressed': 'false', title: tip },
      on: { click: () => {
        // settings-change re-renders the Favorites view and the Tuner dial.
        if (normalizeFavoritesSort(getState().settings.favoritesSort) !== value) saveSettings({ favoritesSort: value });
        syncFavoritesSort();
      } },
    })));
}

export function buildPersonalControls() {
  ui.personalControls = el('div', { className: 'personal-controls' });
  // One click per type, instead of opening a dropdown first.
  ui.personalType = el('div', { className: 'personal-type', attrs: { role: 'group', 'aria-label': 'Filter saved items by media type' } },
    ...PERSONAL_TYPES.map(([value, text]) => el('button', {
      className: 'chip', text, attrs: { type: 'button', 'data-type': value, 'aria-pressed': 'false' },
      on: { click: () => { personalFilters().type = value; pressTypeButton(ui.personalType, value); refresh(); } },
    })));
  ui.playlistSelect = selectControl('Choose an imported playlist', [], (event) => {
    view.playlistId = event.target.value;
    syncPersonalControls(); refresh();
  });
  const defaultType = selectControl('Media type for new channels; playlist radio metadata overrides this', [
    ['tv', 'TV'], ['radio', 'Radio'],
  ], () => {});
  const file = el('input', { attrs: { type: 'file', accept: '.m3u,.m3u8,.pls,.xspf', 'aria-label': 'Choose channel playlist' }, style: { display: 'none' } });
  const message = el('span', { className: 'playlist-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  ui.playlistMessage = message;
  const importButton = el('button', { className: 'btn', text: 'Import playlist',
    attrs: { type: 'button', title: 'Import a local .m3u, .m3u8, .pls or .xspf channel list. A matching filename replaces that playlist; favorites are kept.' },
    on: { click: () => file.click() } });
  const linkForm = el('form', { className: 'playlist-link-form', attrs: { 'aria-label': 'Add a channel or playlist link' } });
  linkForm.hidden = true;
  const linkUrl = el('input', { className: 'chip', attrs: {
    type: 'url', required: '', maxlength: '4096', placeholder: 'https://example.com/stream.m3u8',
    'aria-label': 'Stream or playlist URL', autocomplete: 'off', spellcheck: 'false',
  } });
  const linkName = el('input', { className: 'chip', attrs: {
    type: 'text', maxlength: '160', placeholder: 'Name (optional)', 'aria-label': 'Channel or playlist name', autocomplete: 'off',
  } });
  const linkKind = selectControl('Link type', [['stream', 'Single channel'], ['playlist', 'Online playlist']], () => {});
  const saveLink = el('button', { className: 'btn', text: 'Add', attrs: { type: 'submit' } });
  const addLink = el('button', { className: 'btn', text: 'Add link', attrs: { type: 'button', 'aria-expanded': 'false' },
    on: { click: () => { linkForm.hidden = !linkForm.hidden; addLink.setAttribute('aria-expanded', String(!linkForm.hidden)); if (!linkForm.hidden) linkUrl.focus?.(); } } });
  const cancelLink = el('button', { className: 'btn', text: 'Cancel', attrs: { type: 'button' },
    on: { click: () => { linkForm.hidden = true; addLink.setAttribute('aria-expanded', 'false'); addLink.focus?.(); } } });
  linkForm.append(el('label', { text: 'Link' }, linkUrl), el('label', { text: 'Name (optional)' }, linkName),
    el('label', { text: 'Link contains' }, linkKind), saveLink, cancelLink,
    el('p', { className: 'playlist-link-help', text: 'Paste a direct TV/radio stream, or select Online playlist for an M3U, PLS or XSPF channel list. Adding the same link updates it; favorites are kept. Website and login pages are not supported.' }));
  ui.playlistLinkForm = linkForm;
  const removeButton = el('button', { className: 'btn', text: 'Remove playlist', attrs: { type: 'button' } });
  ui.playlistRemove = removeButton;
  const starAll = el('button', { className: 'btn', text: 'Star all', attrs: { type: 'button', title: 'Add every channel shown to Favorites' },
    on: { click: () => { if (!busy) message.textContent = starAllListed().message; } } });
  ui.playlistStarAll = starAll;
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    importButton.disabled = value;
    for (const control of [addLink, linkUrl, linkName, linkKind, saveLink, cancelLink]) control.disabled = value;
    defaultType.disabled = value;
    removeButton.disabled = value || !view.playlistId;
    starAll.disabled = value;
    ui.playlistSelect.disabled = value;
  };
  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message.textContent = linkKind.value === 'playlist' ? 'Fetching channel list...' : 'Saving channel link...';
    try {
      const data = await addPlaylistLink({ url: linkUrl.value, name: linkName.value, kind: linkKind.value, defaultType: defaultType.value });
      view.playlistId = data.playlist.id;
      message.textContent = data.kind === 'stream'
        ? 'Channel saved. Select it below to play.'
        : `${data.replaced ? 'Updated' : 'Imported'} ${data.playlist.items.length} channels; ${data.playlist.skipped} unsupported entries skipped; ${data.playlist.duplicates} duplicates removed.`;
      linkUrl.value = ''; linkName.value = '';
      linkForm.hidden = true;
      addLink.setAttribute('aria-expanded', 'false');
      syncPersonalControls(); refresh();
      addLink.focus?.();
    } catch (error) { message.textContent = error.message || 'Could not add this link.'; }
    finally { setBusy(false); }
  });
  importLocal = async (selected, type = '') => {
    if (!selected || busy) return false;
    if (type === 'tv' || type === 'radio') defaultType.value = type;
    setBusy(true);
    message.textContent = 'Importing playlist...';
    try {
      await loadPlaylists();
      const exists = getPlaylists().some((entry) => entry.name.toLowerCase() === playlistName(selected.name).toLowerCase());
      if (exists && !globalThis.confirm(`Replace ${selected.name}? Saved favorites will be kept.`)) {
        message.textContent = 'Import cancelled.';
        return false;
      }
      const data = await importPlaylistFile(selected, defaultType.value);
      view.playlistId = data.playlist.id;
      message.textContent = `${data.replaced ? 'Updated' : 'Imported'} ${data.playlist.items.length} channels; ${data.playlist.skipped} unsupported entries skipped; ${data.playlist.duplicates} duplicates removed.`;
      syncPersonalControls(); refresh();
      return true;
    } catch (error) {
      message.textContent = error.message || 'Playlist import failed.';
      return false;
    } finally { setBusy(false); }
  };
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    file.value = '';
    importLocal(selected);
  });
  removeButton.addEventListener('click', async () => {
    const selected = getPlaylists().find((entry) => entry.id === view.playlistId);
    if (!selected || busy || !globalThis.confirm(`Remove ${selected.name}? Saved favorites and the original file will be kept.`)) return;
    setBusy(true);
    try {
      await removePlaylist(selected.id);
      view.playlistId = '';
      message.textContent = 'Playlist removed. Favorites were kept.';
      syncPersonalControls(); refresh();
    } catch (error) { message.textContent = error.message || 'Could not remove playlist.'; }
    finally { setBusy(false); }
  });
  ui.playlistActions = el('div', { className: 'playlist-actions' },
    el('label', { className: 'playlist-media-type', text: 'Add as ' }, defaultType), addLink, importButton, removeButton, starAll, file, linkForm);
  ui.favoritesSort = buildFavoritesSort();
  // Favorites categories: a second row of chips (favorite-categories.js).
  buildFavoriteCategories();
  ui.personalControls.append(ui.personalType, ui.favoritesSort, ui.favoriteCategories, ui.playlistSelect, ui.playlistActions, message);
  syncPersonalControls();
  return ui.personalControls;
}

export function syncPersonalControls() {
  if (!ui.personalControls) return;
  const personal = isPersonalSource();
  const playlist = view.activeSource === 'playlists';
  // Saved collections use the compact card layout (see library.css).
  ui.root?.classList.toggle('is-personal-view', personal);
  ui.personalControls.style.display = personal ? 'flex' : 'none';
  ui.favoritesSort.style.display = view.activeSource === 'favorites' ? '' : 'none';
  syncFavoritesSort();
  ui.favoriteCategories.style.display = view.activeSource === 'favorites' ? '' : 'none';
  syncFavoriteCategories();
  ui.playlistSelect.style.display = playlist ? '' : 'none';
  ui.playlistActions.style.display = playlist ? 'flex' : 'none';
  ui.playlistMessage.style.display = playlist ? '' : 'none';
  if (personal) pressTypeButton(ui.personalType, personalFilters().type);
  const lists = getPlaylists();
  if (view.playlistId && !lists.some((entry) => entry.id === view.playlistId)) view.playlistId = '';
  const signature = JSON.stringify(lists.map((entry) => [entry.id, entry.name]));
  if (ui.playlistSelect.dataset.signature !== signature) {
    ui.playlistSelect.dataset.signature = signature;
    ui.playlistSelect.replaceChildren(el('option', { attrs: { value: '' }, text: 'All playlists' }),
      ...lists.map((entry) => el('option', { attrs: { value: entry.id }, text: entry.name })));
  }
  ui.playlistSelect.value = view.playlistId;
  ui.playlistRemove.disabled = !view.playlistId;
  if (ui.searchInput) {
    ui.searchInput.value = personal ? personalFilters().query : view.query;
    ui.searchInput.placeholder = personal ? 'Search saved titles and groups...' : 'Search radio, TV, archives...';
  }
}
