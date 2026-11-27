import { getPlaylistItems, loadPlaylists, playlistsLoaded } from './playlists.js';
import { getState, favoritesLoaded, subscribe } from './state.js';
import { ProfileStorageBudgetError } from './profile-storage.js';
import { scheduleProfileHandoff } from './profile-transfer.js';
import {
  PICTURE_SLIDERS, applyVideoPicture, effectivePicture, loadPictureSettings,
  normalizePicture, pictureChannelId, prunePictureChannels, savePictureSettings,
} from './picture-settings.js';

const PANEL_EDGE_GAP = 12;

export function choosePicturePanelLeft(panel, picture, viewportWidth) {
  const overlapHeight = picture && Math.min(panel.bottom, picture.bottom) - Math.max(panel.top, picture.top);
  if (!(overlapHeight > 0)) return panel.left;

  // Each candidate has the same vertical overlap, so only compare widths.
  const overlap = left => Math.max(0, Math.min(left + panel.width, picture.right) - Math.max(left, picture.left));
  let best = panel.left;
  for (const left of [PANEL_EDGE_GAP, viewportWidth - PANEL_EDGE_GAP - panel.width]) {
    if (overlap(left) < overlap(best)) best = left;
  }
  return best;
}

function visiblePictureRect(video, view) {
  if (video.hidden || !video.videoWidth || !video.videoHeight) return null;
  const style = view.getComputedStyle(video);
  if (style.visibility !== 'visible') return null;
  const box = video.getBoundingClientRect();
  const borderLeft = parseFloat(style.borderLeftWidth);
  const borderTop = parseFloat(style.borderTopWidth);
  const width = box.width - borderLeft - parseFloat(style.borderRightWidth);
  const height = box.height - borderTop - parseFloat(style.borderBottomWidth);
  if (width <= 0 || height <= 0) return null;

  let pictureWidth = width;
  let pictureHeight = height;
  if (style.objectFit === 'contain') {
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    pictureWidth = video.videoWidth * scale;
    pictureHeight = video.videoHeight * scale;
  }
  const left = box.left + borderLeft + (width - pictureWidth) / 2;
  const top = box.top + borderTop + (height - pictureHeight) / 2;
  return { left, top, right: left + pictureWidth, bottom: top + pictureHeight };
}

export function bindPicturePanel(video, getElement, quality) {
  const slot = getElement('player-picture-slot');
  const panel = getElement('picture-panel');
  if (!slot || !panel) return () => {};

  const view = panel.ownerDocument?.defaultView;
  const scope = getElement('picture-scope');
  const channelOption = getElement('picture-scope-channel');
  const fit = getElement('picture-fit');
  const qualitySelect = getElement('picture-quality');
  const qualityRow = getElement('picture-quality-row');
  const qualityLabel = getElement('picture-quality-label');
  const qualityNow = getElement('picture-quality-now');
  const qualityHint = getElement('picture-quality-hint');
  const picks = new WeakMap();
  let qualityView = null;
  let shownOptions = null;
  const sessionNote = getElement('picture-session-note');
  const feedback = getElement('picture-feedback');
  const sliders = Object.keys(PICTURE_SLIDERS).map((name) => [name, getElement(`picture-${name}`)]);
  const session = new Map();
  let settings = loadPictureSettings();
  let savedChannels = new Set();
  let item = null;
  let channelId = '';
  let open = false;
  let resizeTimer;
  let saveError = '';

  function forChannel() {
    return Boolean(channelId && scope.value === 'channel');
  }

  function savedChannelId() {
    const membershipKnown = favoritesLoaded() && playlistsLoaded();
    return !membershipKnown || savedChannels.has(channelId) ? channelId : '';
  }

  function channelPicture() {
    return session.get(channelId) || settings.channels[savedChannelId()];
  }

  function currentPicture() {
    const local = session.get(channelId);
    if (!local) return effectivePicture(settings, savedChannelId());
    return local.quality == null ? { ...local, quality: settings.main.quality } : local;
  }

  function scopedPicture() {
    return forChannel() ? currentPicture() : settings.main;
  }

  function clearQuality() {
    if (!qualitySelect) return;
    qualityLabel.hidden = qualityRow.hidden = qualityNow.hidden = qualityHint.hidden = true;
    qualityNow.textContent = '';
    if (shownOptions) qualitySelect.replaceChildren();
    shownOptions = qualityView = null;
  }

  function renderQuality() {
    if (!open || !item || !qualitySelect || !quality) return;
    const { quality: choice } = scopedPicture();
    qualityView = quality.view(choice, picks.get(choice));
    const { options, selected, now, fellBack } = qualityView;
    const fallbackHere = fellBack && (forChannel() || channelPicture()?.quality == null);
    feedback.textContent = saveError || (fellBack ? 'Fixed quality failed. Using Auto for this session.' : '');
    if (options.length < 2) {
      clearQuality();
      return;
    }
    qualityLabel.hidden = qualityRow.hidden = false;
    qualityNow.hidden = !now;
    qualityHint.hidden = fallbackHere || choice !== 'best';
    qualityNow.textContent = now ? 'Now ' + now + 'p' : '';
    if (shownOptions !== options) {
      shownOptions = options;
      const entries = [['auto', 'Auto'], ['best', 'Best available'],
        ...options.map((option, index) => [String(index), option.label])];
      qualitySelect.replaceChildren(...entries.map(([value, label]) => {
        const option = qualitySelect.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }));
    }
    if (fallbackHere) qualitySelect.value = 'auto';
    else if (selected) qualitySelect.value = String(options.indexOf(selected));
    else qualitySelect.value = choice === 'best' ? 'best' : 'auto';
  }

  function render(chosen = false) {
    const current = currentPicture();
    if (item) quality?.setPreference(current.quality, picks.get(current.quality), chosen === true);
    const picture = open ? scopedPicture() : current;
    applyVideoPicture(video, item ? picture : null);
    if (!open) return;
    for (const [name, slider] of sliders) slider.value = String(picture[name]);
    fit.value = picture.fit;
    renderQuality();
    sessionNote.hidden = !forChannel() || savedChannels.has(channelId);
  }

  function persist(next) {
    try {
      savePictureSettings(next);
    } catch (error) {
      saveError = feedback.textContent = error instanceof ProfileStorageBudgetError
        ? error.message : 'Could not save picture settings.';
      return false;
    }
    settings = next;
    saveError = feedback.textContent = '';
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
    const quality = forChannel() ? channelPicture()?.quality ?? null : settings.main.quality;
    return { ...normalizePicture({ ...Object.fromEntries(values), fit: fit.value }), quality };
  }

  function commit(picture, chosen = false) {
    if (!item || !open) return;
    saveError = feedback.textContent = '';
    if (!forChannel()) {
      if (!persist({ ...settings, main: picture })) return;
    } else if (savedChannels.has(channelId)) {
      if (!persist({ ...settings, channels: { ...settings.channels, [channelId]: picture } })) return;
      session.delete(channelId);
    } else {
      session.set(channelId, picture);
    }
    render(chosen && (forChannel() || channelPicture()?.quality == null));
  }

  function positionPanel() {
    panel.style.left = '';
    const picture = visiblePictureRect(video, view);
    if (!picture) return;
    const bounds = panel.getBoundingClientRect();
    const left = choosePicturePanelLeft(bounds, picture, view.innerWidth);
    if (left !== bounds.left) panel.style.left = left + 'px';
  }

  function onResize() {
    view.clearTimeout(resizeTimer);
    // Let the Tuner layout and its 180 ms dock transition settle after resize.
    resizeTimer = view.setTimeout(positionPanel, 220);
  }

  panel.addEventListener('toggle', (event) => {
    if (!view || !open || event.newState !== 'open') return;
    positionPanel();
    view.addEventListener('resize', onResize);
  });
  panel.addEventListener('beforetoggle', (event) => {
    open = event.newState === 'open';
    if (open) {
      saveError = feedback.textContent = '';
      channelOption.hidden = channelOption.disabled = !channelId;
      scope.value = channelId ? 'channel' : 'all';
      if (channelId) loadPlaylists().catch(() => {});
    } else {
      view?.removeEventListener('resize', onResize);
      view?.clearTimeout(resizeTimer);
      panel.style.left = '';
      clearQuality();
    }
    render();
  });
  // Refresh when the decoder starts showing a different resolution.
  video.addEventListener?.('resize', renderQuality);
  scope.addEventListener('change', render);
  for (const [, slider] of sliders) {
    slider.addEventListener('input', () => {
      if (open && item) applyVideoPicture(video, readControls());
    });
    slider.addEventListener('change', () => commit(readControls()));
  }
  fit.addEventListener('change', () => commit(readControls()));
  qualitySelect?.addEventListener('change', () => {
    const value = qualitySelect.value;
    const option = qualityView?.options[value];
    if (!option && value !== 'auto' && value !== 'best') return;
    const choice = option ? { ...option.quality } : value;
    if (option) picks.set(choice, qualityView.pick(option));
    commit({ ...readControls(), quality: choice }, true);
  });
  getElement('picture-reset').addEventListener('click', () => commit(normalizePicture(null), true));

  subscribe('favorites-change', reconcileChannels);
  subscribe('playlists-change', reconcileChannels);
  subscribe('picture-settings-cleared', () => {
    settings = loadPictureSettings();
    session.clear();
    saveError = feedback.textContent = '';
    render(true);
  });
  if (Object.keys(settings.channels).length) loadPlaylists().catch(() => {});
  reconcileChannels();

  const setItem = (nextItem) => {
    if (item === nextItem) return;
    if (open) panel.hidePopover();
    clearQuality();
    item = nextItem;
    channelId = pictureChannelId(item);
    slot.toggleAttribute('inert', !item);
    render();
  };
  setItem.renderQuality = renderQuality;
  return setItem;
}
