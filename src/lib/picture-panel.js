import { getPlaylistItems, loadPlaylists, playlistsLoaded } from './playlists.js';
import { getState, favoritesLoaded, subscribe } from './state.js';
import { ProfileStorageBudgetError } from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import {
  PICTURE_SLIDERS, applyVideoPicture, effectivePicture, loadPictureSettings,
  normalizePicture, pictureChannelId, prunePictureChannels, savePictureSettings,
} from './picture-settings.js';

export function bindPicturePanel(video, getElement) {
  const slot = getElement('player-picture-slot');
  const panel = getElement('picture-panel');
  if (!slot || !panel) return () => {};

  const scope = getElement('picture-scope');
  const channelOption = getElement('picture-scope-channel');
  const fit = getElement('picture-fit');
  const sessionNote = getElement('picture-session-note');
  const feedback = getElement('picture-feedback');
  const sliders = Object.keys(PICTURE_SLIDERS).map((name) => [name, getElement(`picture-${name}`)]);
  const session = new Map();
  let settings = loadPictureSettings();
  let savedChannels = new Set();
  let item = null;
  let channelId = '';
  let open = false;

  function forChannel() {
    return Boolean(channelId && scope.value === 'channel');
  }

  function currentPicture() {
    const membershipKnown = favoritesLoaded() && playlistsLoaded();
    const id = !membershipKnown || savedChannels.has(channelId) ? channelId : '';
    return session.get(channelId) || effectivePicture(settings, id);
  }

  function render() {
    const picture = open && !forChannel() ? settings.main : currentPicture();
    applyVideoPicture(video, item ? picture : null);
    if (!open) return;
    for (const [name, slider] of sliders) slider.value = String(picture[name]);
    fit.value = picture.fit;
    sessionNote.hidden = !forChannel() || savedChannels.has(channelId);
  }

  function persist(next) {
    try {
      savePictureSettings(next);
    } catch (error) {
      feedback.textContent = error instanceof ProfileStorageBudgetError
        ? error.message : 'Could not save picture settings.';
      return false;
    }
    settings = next;
    feedback.textContent = '';
    scheduleProfileHandoff();
    return true;
  }

  function reconcileChannels() {
    savedChannels = new Set([...getState().favorites, ...getPlaylistItems()].map(pictureChannelId).filter(Boolean));
    if (favoritesLoaded() && playlistsLoaded()) {
      const next = { ...settings, channels: { ...settings.channels } };
      if (prunePictureChannels(next, savedChannels)) persist(next);
    }
    render();
  }

  function readControls() {
    const values = sliders.map(([name, slider]) => [name, Number(slider.value)]);
    return normalizePicture({ ...Object.fromEntries(values), fit: fit.value });
  }

  function commit(picture) {
    if (!item || !open) return;
    feedback.textContent = '';
    if (!forChannel()) {
      if (!persist({ ...settings, main: picture })) return;
    } else if (savedChannels.has(channelId)) {
      if (!persist({ ...settings, channels: { ...settings.channels, [channelId]: picture } })) return;
      session.delete(channelId);
    } else {
      session.set(channelId, picture);
    }
    render();
  }

  panel.addEventListener('beforetoggle', (event) => {
    open = event.newState === 'open';
    if (open) {
      feedback.textContent = '';
      channelOption.hidden = channelOption.disabled = !channelId;
      scope.value = channelId ? 'channel' : 'all';
      if (channelId) loadPlaylists().catch(() => {});
    }
    render();
  });
  scope.addEventListener('change', render);
  for (const [, slider] of sliders) {
    slider.addEventListener('input', () => {
      if (open && item) applyVideoPicture(video, readControls());
    });
    slider.addEventListener('change', () => commit(readControls()));
  }
  fit.addEventListener('change', () => commit(readControls()));
  getElement('picture-reset').addEventListener('click', () => commit(normalizePicture(null)));

  subscribe('favorites-change', reconcileChannels);
  subscribe('playlists-change', reconcileChannels);
  subscribe('picture-settings-cleared', () => {
    settings = loadPictureSettings();
    session.clear();
    feedback.textContent = '';
    render();
  });
  if (Object.keys(settings.channels).length) loadPlaylists().catch(() => {});
  reconcileChannels();

  return (nextItem) => {
    if (item === nextItem) return;
    if (open) panel.hidePopover();
    item = nextItem;
    channelId = pictureChannelId(item);
    slot.toggleAttribute('inert', !item);
    render();
  };
}
