import { addPlaylistLink, getPlaylists, importPlaylistFile, loadPlaylists, playlistName, removePlaylist } from '../../lib/playlists.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { isPersonalSource, personalFilters } from './personal.js';
import { renderResults, renderStatus, updateSentinelStatus } from './render.js';

function refresh() { renderResults(); renderStatus(); updateSentinelStatus(); }

function selectControl(label, options, onChange) {
  const select = el('select', { className: 'chip', attrs: { 'aria-label': label, title: label }, on: { change: onChange } },
    ...options.map(([value, text]) => el('option', { attrs: { value }, text })));
  if (options.length) select.value = options[0][0];
  return select;
}

export function buildPersonalControls() {
  ui.personalControls = el('div', { className: 'personal-controls' });
  ui.personalType = selectControl('Filter saved items by media type', [
    ['', 'All media'], ['radio', 'Radio'], ['tv', 'TV'], ['video', 'Video'], ['audio', 'Audio'],
  ], (event) => { personalFilters().type = event.target.value; refresh(); });
  ui.playlistSelect = selectControl('Choose an imported playlist', [], (event) => {
    view.playlistId = event.target.value;
    syncPersonalControls(); refresh();
  });
  const defaultType = selectControl('Media type for new channels; playlist radio metadata overrides this', [
    ['tv', 'TV'], ['radio', 'Radio'],
  ], () => {});
  const file = el('input', { attrs: { type: 'file', accept: '.m3u,.m3u8', 'aria-label': 'Choose channel playlist' }, style: { display: 'none' } });
  const message = el('span', { className: 'playlist-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  ui.playlistMessage = message;
  const importButton = el('button', { className: 'btn', text: 'Import M3U',
    attrs: { type: 'button', title: 'Import a local channel list. A matching filename replaces that playlist; favorites are kept.' },
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
  const linkKind = selectControl('Link type', [['stream', 'Single channel'], ['playlist', 'Online M3U playlist']], () => {});
  const saveLink = el('button', { className: 'btn', text: 'Add', attrs: { type: 'submit' } });
  const addLink = el('button', { className: 'btn', text: 'Add link', attrs: { type: 'button', 'aria-expanded': 'false' },
    on: { click: () => { linkForm.hidden = !linkForm.hidden; addLink.setAttribute('aria-expanded', String(!linkForm.hidden)); if (!linkForm.hidden) linkUrl.focus?.(); } } });
  const cancelLink = el('button', { className: 'btn', text: 'Cancel', attrs: { type: 'button' },
    on: { click: () => { linkForm.hidden = true; addLink.setAttribute('aria-expanded', 'false'); addLink.focus?.(); } } });
  linkForm.append(el('label', { text: 'Link' }, linkUrl), el('label', { text: 'Name (optional)' }, linkName),
    el('label', { text: 'Link contains' }, linkKind), saveLink, cancelLink,
    el('p', { className: 'playlist-link-help', text: 'Paste a direct TV/radio stream, or select Online M3U playlist for a channel list. Adding the same link updates it; favorites are kept. Website and login pages are not supported.' }));
  ui.playlistLinkForm = linkForm;
  const removeButton = el('button', { className: 'btn', text: 'Remove playlist', attrs: { type: 'button' } });
  ui.playlistRemove = removeButton;
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    importButton.disabled = value;
    for (const control of [addLink, linkUrl, linkName, linkKind, saveLink, cancelLink]) control.disabled = value;
    defaultType.disabled = value;
    removeButton.disabled = value || !view.playlistId;
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
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected || busy) return;
    setBusy(true);
    message.textContent = 'Importing playlist...';
    try {
      await loadPlaylists();
      const exists = getPlaylists().some((entry) => entry.name.toLowerCase() === playlistName(selected.name).toLowerCase());
      if (exists && !globalThis.confirm(`Replace ${selected.name}? Saved favorites will be kept.`)) {
        message.textContent = 'Import cancelled.';
        return;
      }
      const data = await importPlaylistFile(selected, defaultType.value);
      view.playlistId = data.playlist.id;
      message.textContent = `${data.replaced ? 'Updated' : 'Imported'} ${data.playlist.items.length} channels; ${data.playlist.skipped} unsupported entries skipped; ${data.playlist.duplicates} duplicates removed.`;
      syncPersonalControls(); refresh();
    } catch (error) { message.textContent = error.message || 'Playlist import failed.'; }
    finally { setBusy(false); }
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
    el('label', { className: 'playlist-media-type', text: 'Add as ' }, defaultType), addLink, importButton, removeButton, file, linkForm);
  ui.personalControls.append(ui.personalType, ui.playlistSelect, ui.playlistActions, message);
  syncPersonalControls();
  return ui.personalControls;
}

export function syncPersonalControls() {
  if (!ui.personalControls) return;
  const personal = isPersonalSource();
  const playlist = view.activeSource === 'playlists';
  ui.personalControls.style.display = personal ? 'flex' : 'none';
  ui.playlistSelect.style.display = playlist ? '' : 'none';
  ui.playlistActions.style.display = playlist ? 'flex' : 'none';
  ui.playlistMessage.style.display = playlist ? '' : 'none';
  if (personal) ui.personalType.value = personalFilters().type;
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
