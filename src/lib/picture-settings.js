import { isEqStation } from './eq-store.js';
import { checkProfileStorageBudget, PICTURE_STORAGE_KEY } from './profile-storage.js';

export const PICTURE_SLIDERS = Object.freeze({
  brightness: { min: 0, max: 200, neutral: 100 },
  contrast: { min: 0, max: 200, neutral: 100 },
  saturation: { min: 0, max: 200, neutral: 100 },
  hue: { min: -180, max: 180, neutral: 0 },
});

const FIT_CLASSES = {
  fill: 'video-fit-fill',
  'zoom-110': 'video-fit-zoom-110',
  'zoom-125': 'video-fit-zoom-125',
  'zoom-133': 'video-fit-zoom-133',
};

export function normalizePicture(value) {
  const picture = {};
  for (const [name, { min, max, neutral }] of Object.entries(PICTURE_SLIDERS)) {
    const setting = value?.[name];
    picture[name] = Number.isFinite(setting) ? Math.round(Math.min(max, Math.max(min, setting))) : neutral;
  }
  const fit = value?.fit;
  picture.fit = typeof fit === 'string' && Object.hasOwn(FIT_CLASSES, fit) ? fit : 'whole';
  return picture;
}

export function pictureFilter(value) {
  const { brightness, contrast, saturation, hue } = normalizePicture(value);
  return [
    brightness === 100 ? '' : `brightness(${brightness}%)`,
    contrast === 100 ? '' : `contrast(${contrast}%)`,
    saturation === 100 ? '' : `saturate(${saturation}%)`,
    hue === 0 ? '' : `hue-rotate(${hue}deg)`,
  ].filter(Boolean).join(' ');
}

export function applyVideoPicture(video, value) {
  const filter = pictureFilter(value);
  if (filter) video.style.filter = filter;
  else if (video.style.filter) video.style.removeProperty('filter');
  for (const [fit, className] of Object.entries(FIT_CLASSES)) {
    video.classList.toggle(className, value?.fit === fit);
  }
}

export function pictureChannelId(item) {
  const id = item?.id;
  return isEqStation(item) && typeof id === 'string' && id.length <= 512 ? id : '';
}

function normalizePictureState(value) {
  const channels = Object.create(null);
  const source = value?.channels;
  const entries = source && typeof source === 'object' && !Array.isArray(source) ? Object.entries(source) : [];
  for (const [id, settings] of entries) {
    if (id && id.length <= 512 && settings && typeof settings === 'object' && !Array.isArray(settings)) {
      channels[id] = normalizePicture(settings);
    }
  }
  return { main: normalizePicture(value?.main), channels };
}

export function effectivePicture(state, channelId) {
  return channelId && Object.hasOwn(state.channels, channelId) ? state.channels[channelId] : state.main;
}

export function loadPictureSettings(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(PICTURE_STORAGE_KEY);
    return normalizePictureState(JSON.parse(raw || 'null'));
  } catch (_) {
    return normalizePictureState(null);
  }
}

export function savePictureSettings(state, storage = globalThis.localStorage) {
  const raw = JSON.stringify(normalizePictureState(state));
  checkProfileStorageBudget(storage, [[PICTURE_STORAGE_KEY, raw]]);
  storage.setItem(PICTURE_STORAGE_KEY, raw);
}

export function prunePictureChannels(state, savedIds) {
  let changed = false;
  for (const id of Object.keys(state.channels)) {
    if (savedIds.has(id)) continue;
    delete state.channels[id];
    changed = true;
  }
  return changed;
}
