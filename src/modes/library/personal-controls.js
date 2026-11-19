import {
  addPlaylistLink, getPlaylistItems, getPlaylists, importPlaylistFile, loadPlaylists, playlistName, playlistsLoaded,
  removePlaylist,
} from '../../lib/playlists.js';
import { moveFavoritesToNewIds, planTypeMoves, typeMoveMessage } from '../../lib/favorite-migration.js';
import {
  addFavorites, BULK_FAVORITES_LIMIT, countNewFavorites, getState, removeAllFavorites, saveSettings,
} from '../../lib/state.js';
import { FAVORITES_SORT_MANUAL, FAVORITES_SORT_NAME, normalizeFavoritesSort } from '../../lib/favorites-order.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { isPersonalSource, libraryPool, personalFilters } from './personal.js';
import { filteredItemsForCurrentView, renderResults, renderStatus, updateSentinelStatus } from './render.js';
import { buildFavoriteCategories, syncFavoriteCategories } from './favorite-categories.js';

function refresh() { renderResults(); renderStatus(); updateSentinelStatus(); }

/** Read the saved playlists if that has not worked yet. A failed read (for
 *  example a busy local server just after start) is tried again each time My
 *  Playlists is opened, instead of leaving the list empty for the session.
 *  The error is shown under the playlist buttons. */
export function ensurePlaylistsLoaded(load = loadPlaylists) {
  if (playlistsLoaded()) return Promise.resolve(true);
  const mountedRoot = ui.root;
  return Promise.resolve().then(() => load()).then(() => {
    if (ui.root === mountedRoot && ui.playlistMessage?.dataset?.loadError === 'true') {
      ui.playlistMessage.textContent = '';
      delete ui.playlistMessage.dataset.loadError;
    }
    return true;
  }, (error) => {
    if (ui.root === mountedRoot && ui.playlistMessage) {
      ui.playlistMessage.textContent = `Your playlists could not be loaded: ${error?.message || 'the app did not answer.'} `
        + 'Open My Playlists again to try again.';
      ui.playlistMessage.dataset.loadError = 'true';
    }
    return false;
  });
}

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

/** "Add as" choices. Auto (the default) gives a channel that does not say
 *  radio or TV the type most channels in the same file say; TV and Radio
 *  give it that type (worldmedia_playlists.py auto_type). */
export const ADD_AS_CHOICES = [['auto', 'Auto'], ['tv', 'TV'], ['radio', 'Radio']];

/** Plain-words result of an import or an added online playlist. `type` is the
 *  "Add as" choice ('auto', 'tv' or 'radio'); with Auto the backend says which
 *  type it chose (`playlist.default_type`) and why (`playlist.auto`). */
export function importResultMessage(data, type = 'tv') {
  const playlist = data?.playlist || {};
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  const plural = (number, one, many) => `${number} ${number === 1 ? one : many}`;
  // Entries pointing at this computer or a private network are part of
  // `skipped`; they get their own sentence saying why.
  const skipped = count(playlist.skipped);
  const privateSkipped = Math.min(count(playlist.private), skipped);
  let text = `${data?.replaced ? 'Updated' : 'Imported'} ${plural(count(playlist.items?.length), 'channel', 'channels')}; `
    + `${plural(skipped - privateSkipped, 'unsupported entry', 'unsupported entries')} skipped; `
    + `${plural(count(playlist.duplicates), 'duplicate', 'duplicates')} removed.`;
  if (privateSkipped) {
    text += privateSkipped === 1
      ? ' 1 entry was skipped because it points at this computer or a private network address.'
      : ` ${privateSkipped} entries were skipped because they point at this computer or a private network address.`;
  }
  const defaulted = count(playlist.defaulted);
  if (!defaulted) return text;
  const auto = type === 'auto' ? playlist.auto : '';
  const radio = (auto ? playlist.default_type : type) === 'radio';
  const one = defaulted === 1;
  const as = radio ? 'radio' : 'TV';
  const other = radio ? 'TV' : 'Radio';
  const otherWhat = radio ? (one ? 'a TV channel' : 'TV channels') : (one ? 'a radio station' : 'radio stations');
  text += one
    ? ' 1 channel does not say in the file whether it is radio or TV'
    : ` ${defaulted} channels do not say in the file whether they are radio or TV`;
  if (auto === 'majority') {
    text += `. Most channels in the file that do say are ${as}, so ${one ? 'it was' : 'these were'} added as ${as} too.`
      + ` If that is wrong, choose Add as ${other} and import the file again.`;
  } else {
    text += auto === 'fallback' ? ', and the rest of the file does not decide it,' : ',';
    text += ` so ${one ? 'it was' : 'they were'} added as ${as}.`
      + ` If ${one ? 'it is' : 'they are'} ${otherWhat}, choose Add as ${other} and import the file again.`;
  }
  return text;
}

/** Each saved playlist's channels, taken before an import replaces one. */
export function playlistSnapshot() {
  return new Map(getPlaylists().map((entry) => [entry.id, entry.items]));
}

/** After a playlist was imported again (same name, or the same link), move
 *  favorites whose channel changed between radio and TV to the new channel
 *  (favorite-migration.js). Returns the words to add to the import message. */
export function followTypeChanges(before, data) {
  if (!data?.replaced) return '';
  const old = before.get(data.playlist?.id);
  if (!old) return '';
  const moves = planTypeMoves(old, getPlaylistItems(data.playlist.id), getState().favorites);
  if (moves.size === 0) return '';
  return typeMoveMessage(moveFavoritesToNewIds(moves), moves);
}

/** Remove every favorite after the user agrees. Nothing changes without a yes. */
export function removeAllFavoritesAsked({ confirmImpl = (text) => globalThis.confirm(text) } = {}) {
  const count = getState().favorites.length;
  if (count === 0) return { removed: 0, message: 'There are no favorites to remove.' };
  const what = count === 1 ? 'the 1 favorite' : `all ${count} favorites`;
  if (!confirmImpl(`Remove ${what}? This cannot be undone. To keep a copy, first use Back up my data in Settings > Storage.`)) {
    return { removed: 0, cancelled: true, message: 'Nothing was removed.' };
  }
  const { removed, failed } = removeAllFavorites();
  if (failed === 'curves') {
    return { removed: 0, message: 'Favorites could not be saved, so they were kept, but their own equalizer settings '
      + 'were lost; they now use the main equalizer.' };
  }
  if (failed) return { removed: 0, message: 'Favorites could not be saved. Nothing was removed.' };
  return { removed, message: removed === 1 ? 'The favorite was removed.' : `All ${removed} favorites were removed.` };
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
  const defaultType = selectControl('Radio or TV, for channels the playlist does not mark. '
    + 'Auto uses what most channels in the same file say, else TV.', ADD_AS_CHOICES, () => {});
  const file = el('input', { attrs: { type: 'file', accept: '.m3u,.m3u8,.pls,.xspf', 'aria-label': 'Choose channel playlist' }, style: { display: 'none' } });
  const message = el('span', { className: 'playlist-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  ui.playlistMessage = message;
  const importButton = el('button', { className: 'btn', text: 'Import playlist',
    attrs: { type: 'button', title: 'Import a local .m3u, .m3u8, .pls or .xspf channel list. A matching filename replaces that playlist; favorites are kept. '
      + 'To change the stations, edit your own playlist file and import it again under the same file name; the copy the app keeps is not meant to be edited by hand.' },
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
  const removeButton = el('button', { className: 'btn', text: 'Remove playlist', attrs: {
    type: 'button', title: 'Remove the playlist chosen in the list from My Playlists. Favorites and your own file are kept.',
  } });
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
    removeButton.disabled = value || getPlaylists().length === 0;
    starAll.disabled = value;
    ui.playlistSelect.disabled = value;
  };
  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message.textContent = linkKind.value === 'playlist' ? 'Fetching channel list...' : 'Saving channel link...';
    try {
      await loadPlaylists();
      const before = playlistSnapshot();
      const data = await addPlaylistLink({ url: linkUrl.value, name: linkName.value, kind: linkKind.value, defaultType: defaultType.value });
      view.playlistId = data.playlist.id;
      message.textContent = (data.kind === 'stream'
        ? 'Channel saved. Select it below to play.'
        : importResultMessage(data, defaultType.value)) + followTypeChanges(before, data);
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
      const before = playlistSnapshot();
      const data = await importPlaylistFile(selected, defaultType.value);
      view.playlistId = data.playlist.id;
      message.textContent = importResultMessage(data, defaultType.value) + followTypeChanges(before, data);
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
    if (busy) return;
    const lists = getPlaylists();
    // "All playlists" with only one imported: that one is meant.
    const selected = lists.find((entry) => entry.id === view.playlistId) || (lists.length === 1 ? lists[0] : null);
    if (!selected) {
      message.textContent = lists.length
        ? 'Choose the playlist to remove in the list that says All playlists, then press Remove playlist.'
        : 'There is no imported playlist to remove.';
      if (lists.length) ui.playlistSelect.focus?.();
      return;
    }
    const channelCount = selected.items?.length || 0;
    if (!globalThis.confirm(`Remove the playlist ${selected.name} with its ${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}? `
      + 'Saved favorites and your own file will be kept.')) return;
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
  // Remove all favorites: asks first, with the count (removeAllFavoritesAsked).
  const favoritesMessage = el('span', { className: 'playlist-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  ui.favoritesRemoveAll = el('button', { className: 'btn', text: 'Remove all favorites', attrs: {
    type: 'button', title: 'Remove every favorite. You are asked first; a backup can be made in Settings > Storage.',
  }, on: { click: () => { favoritesMessage.textContent = removeAllFavoritesAsked().message; } } });
  ui.favoritesActions = el('div', { className: 'favorites-actions' }, ui.favoritesRemoveAll, favoritesMessage);
  // Favorites categories: a second row of chips (favorite-categories.js).
  buildFavoriteCategories();
  ui.personalControls.append(ui.personalType, ui.favoritesSort, ui.favoritesActions, ui.favoriteCategories,
    ui.playlistSelect, ui.playlistActions, message);
  syncPersonalControls();
  return ui.personalControls;
}

/** "Remove all favorites" can be pressed only while there are favorites. */
export function syncFavoritesActions() {
  if (ui.favoritesRemoveAll) ui.favoritesRemoveAll.disabled = getState().favorites.length === 0;
}

export function syncPersonalControls() {
  if (!ui.personalControls) return;
  const personal = isPersonalSource();
  const playlist = view.activeSource === 'playlists';
  // Saved collections use the compact card layout (see library.css).
  ui.root?.classList.toggle('is-personal-view', personal);
  ui.personalControls.style.display = personal ? 'flex' : 'none';
  ui.favoritesSort.style.display = view.activeSource === 'favorites' ? '' : 'none';
  ui.favoritesActions.style.display = view.activeSource === 'favorites' ? '' : 'none';
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
  // Enabled whenever there is a playlist; with several and none chosen, a
  // press says which list to choose it in.
  ui.playlistRemove.disabled = lists.length === 0;
  syncFavoritesActions();
  if (ui.searchInput) {
    ui.searchInput.value = personal ? personalFilters().query : view.query;
    ui.searchInput.placeholder = personal ? 'Search saved titles and groups...' : 'Search radio, TV, archives...';
  }
}
