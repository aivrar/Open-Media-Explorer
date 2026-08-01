/** Accessible, automatically persisted equalizer overlay. */

import {
  cloneEqCurve, getEffectiveEq, loadEqState, normalizeEqCurve, removeCustomEqPreset,
  saveEqState, setCustomEqPreset, setScopedEq,
} from './eq-store.js';
import {
  BUILT_IN_EQ_PRESETS, createCustomEqPresetKey, customEqPresetId,
  customEqPresetKey, getBuiltInEqPreset, isBuiltInEqPreset, snapshotEqPreset,
} from './eq-presets.js';
import { getAudioFrequencyResponse, previewEqCurve } from './player.js';
import { addFavorite, emit, getState, isFavorite, removeFavorite, subscribe } from './state.js';
import { scheduleProfileHandoff } from './profile-transfer.js';

const PERSIST_DEBOUNCE_MS = 150;
const BAND_LABELS = Object.freeze(['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
const RESPONSE_FREQUENCIES = Object.freeze(Array.from({ length: 65 }, (_, index) => (
  20 * ((20000 / 20) ** (index / 64))
)));

let activeOverlay = null;

function sliderMarkup(kind, index, label, minimum, maximum) {
  const dataIndex = index == null ? '' : ` data-index="${index}"`;
  const name = kind === 'preamp' ? 'Preamp' : `${label}Hz band`;
  return `<label class="eq-band${kind === 'preamp' ? ' is-preamp' : ''}">
    <output data-eq-value="${kind}${index ?? ''}">0 dB</output>
    <input class="eq-band-slider" type="range" min="${minimum}" max="${maximum}" step="0.5" value="0"
      data-kind="${kind}"${dataIndex} aria-orientation="vertical" aria-label="${name} gain" aria-valuetext="0 decibels" />
    <span>${label}</span>
  </label>`;
}

function displayDb(value) {
  const number = Number(value) || 0;
  const rounded = Math.round(number * 2) / 2;
  return `${rounded > 0 ? '+' : ''}${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} dB`;
}

function curveSelection(curve, eqState) {
  if (isBuiltInEqPreset(curve.presetId)) return `builtin:${curve.presetId}`;
  const key = customEqPresetKey(curve.presetId);
  if (key && Object.hasOwn(eqState.customPresets, key)) return `custom:${key}`;
  return 'manual';
}

export function curveAfterEqInput(value, { kind, index = -1, gain }) {
  const curve = normalizeEqCurve(value);
  // Preamp is a master headroom/level control, not a frequency-shape edit.
  // Keep the chosen built-in/custom identity when only preamp changes.
  if (kind === 'preamp') {
    return normalizeEqCurve({ ...curve, preamp: gain, presetId: curve.presetId });
  }
  const key = customEqPresetKey(curve.presetId);
  const presetId = key ? curve.presetId : 'manual';
  const bands = [...curve.bands];
  if (Number.isInteger(index) && index >= 0 && index < bands.length) bands[index] = gain;
  return normalizeEqCurve({ ...curve, bands, presetId });
}

function buildOverlay() {
  const previousFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'modal-backdrop eq-backdrop';
  root.dataset.eqModal = 'true';
  const bands = [
    sliderMarkup('preamp', null, 'Preamp', -12, 6),
    ...BAND_LABELS.map((label, index) => sliderMarkup('band', index, label, -12, 12)),
  ].join('');
  root.innerHTML = `
    <div class="modal eq-modal" role="dialog" aria-modal="true" aria-labelledby="eq-title" aria-describedby="eq-description">
      <div class="modal-header eq-header">
        <div>
          <h2 id="eq-title">Equalizer</h2>
          <p id="eq-description">Changes apply immediately and save automatically.</p>
        </div>
        <button class="icon-btn" type="button" data-eq-act="close" aria-label="Close Equalizer">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="eq-toolbar">
        <div class="eq-scope-wrap">
          <span>Saving to</span><strong data-eq-scope>Global</strong>
          <button class="btn eq-favorite-scope" type="button" data-eq-favorite aria-pressed="false">☆ Add favorite</button>
        </div>
        <label class="eq-bypass"><input type="checkbox" class="switch" data-eq-bypass /> Bypass</label>
      </div>
      <div class="eq-preset-row">
        <label for="eq-preset-select">Preset</label>
        <select id="eq-preset-select" data-eq-preset aria-label="Equalizer preset"></select>
        <button class="btn" type="button" data-eq-act="new-preset">New preset</button>
        <input type="text" data-eq-preset-name maxlength="80" aria-label="Custom preset name" placeholder="Custom preset name" disabled />
        <button class="btn btn-danger-subtle" type="button" data-eq-act="delete-preset" disabled>Delete preset</button>
        <button class="btn" type="button" data-eq-act="reset">Reset to flat</button>
      </div>
      <div class="eq-response" role="img" aria-label="Equalizer frequency response" data-eq-response-wrap>
        <svg viewBox="0 0 640 116" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="58" x2="640" y2="58" />
          <path data-eq-response d="M0 58 L640 58" />
        </svg>
        <span>-18</span><span>0 dB</span><span>+18</span>
      </div>
      <div class="eq-bands" aria-label="Equalizer gain controls">${bands}</div>
      <p class="eq-auto-note">No Apply or Save button is needed. The current global or favorite setting updates automatically.</p>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-eq-announcement></span>
    </div>`;

  const app = document.getElementById('app');
  const previousInert = Boolean(app?.inert);
  let disposed = false;
  let timer = 0;
  let curve = normalizeEqCurve(null);
  let pending = null;
  const unsubscribers = [];
  const select = root.querySelector('[data-eq-preset]');
  const nameInput = root.querySelector('[data-eq-preset-name]');
  const deleteButton = root.querySelector('[data-eq-act="delete-preset"]');
  const bypass = root.querySelector('[data-eq-bypass]');
  const scope = root.querySelector('[data-eq-scope]');
  const favoriteButton = root.querySelector('[data-eq-favorite]');
  const responsePath = root.querySelector('[data-eq-response]');
  const responseWrap = root.querySelector('[data-eq-response-wrap]');
  const announcement = root.querySelector('[data-eq-announcement]');

  function item() { return getState().currentItem; }

  function announce(message) { announcement.textContent = message; }

  function persistNow() {
    window.clearTimeout(timer);
    timer = 0;
    if (!pending) return;
    const change = pending;
    pending = null;
    let state = setScopedEq(loadEqState(), change.itemId, change.favorited, change.curve);
    if (change.customKey) {
      state = setCustomEqPreset(
        state, change.customKey, change.customName,
        { ...change.curve, bypassed: false, presetId: customEqPresetId(change.customKey) },
      );
    }
    saveEqState(state);
    scheduleProfileHandoff();
    emit('eq-change', { itemId: change.itemId, scope: change.favorited ? 'favorite' : 'global' });
  }

  function queuePersistence(nextCurve) {
    const current = item();
    if (!current?.id) return;
    const state = loadEqState();
    const customKey = customEqPresetKey(nextCurve.presetId);
    const custom = customKey ? state.customPresets[customKey] : null;
    const pendingName = pending?.customKey === customKey ? pending.customName : null;
    pending = {
      itemId: current.id,
      favorited: isFavorite(current.id),
      curve: cloneEqCurve(nextCurve),
      customKey: custom ? customKey : '',
      customName: pendingName ?? custom?.name ?? 'Custom preset',
    };
    window.clearTimeout(timer);
    timer = window.setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
  }

  function updateResponse() {
    const response = getAudioFrequencyResponse(RESPONSE_FREQUENCIES);
    const points = [...response].map((gain, index) => {
      const x = index * 10;
      const y = 58 - Math.max(-18, Math.min(18, Number(gain) || 0)) * (58 / 18);
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    responsePath.setAttribute('d', points);
    const low = Number(response[1] || 0).toFixed(1);
    const mid = Number(response[36] || 0).toFixed(1);
    const high = Number(response[63] || 0).toFixed(1);
    responseWrap.setAttribute('aria-label', `Equalizer response: low ${low} dB, mid ${mid} dB, high ${high} dB`);
  }

  function renderPresets(state = loadEqState()) {
    const builtInGroup = document.createElement('optgroup');
    builtInGroup.label = 'Built-in presets';
    for (const entry of BUILT_IN_EQ_PRESETS) {
      const option = document.createElement('option');
      option.value = `builtin:${entry.id}`;
      option.textContent = entry.name;
      builtInGroup.appendChild(option);
    }
    const customGroup = document.createElement('optgroup');
    customGroup.label = 'Custom presets';
    const manual = document.createElement('option');
    manual.value = 'manual';
    manual.textContent = 'Manual curve';
    customGroup.appendChild(manual);
    for (const [key, value] of Object.entries(state.customPresets)) {
      const option = document.createElement('option');
      option.value = `custom:${key}`;
      option.textContent = value.name;
      customGroup.appendChild(option);
    }
    select.replaceChildren(builtInGroup, customGroup);
    select.value = curveSelection(curve, state);
    const key = customEqPresetKey(curve.presetId);
    const custom = key ? state.customPresets[key] : null;
    nameInput.disabled = !custom;
    deleteButton.disabled = !custom;
    nameInput.value = custom?.name || '';
  }

  function renderCurve({ rebuildPresets = false } = {}) {
    const current = item();
    const favorited = Boolean(current && isFavorite(current.id));
    scope.textContent = favorited ? current.title || 'Favorite item' : 'Global';
    scope.dataset.scope = favorited ? 'favorite' : 'global';
    favoriteButton.textContent = favorited ? '★ Remove favorite' : '☆ Add favorite';
    favoriteButton.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    favoriteButton.setAttribute('aria-label', favorited
      ? 'Remove this item from favorites and use Global equalizer settings'
      : 'Add this item to favorites and give it its own equalizer settings');
    bypass.checked = curve.bypassed;
    const sliders = root.querySelectorAll('.eq-band-slider');
    for (const slider of sliders) {
      const value = slider.dataset.kind === 'preamp'
        ? curve.preamp
        : curve.bands[Number(slider.dataset.index)];
      slider.value = String(value);
      const text = displayDb(value);
      slider.setAttribute('aria-valuetext', text.replace('dB', 'decibels'));
      slider.closest('.eq-band')?.querySelector('output').replaceChildren(text);
    }
    if (rebuildPresets) renderPresets();
    updateResponse();
  }

  function preview(nextCurve, { rebuildPresets = false } = {}) {
    curve = normalizeEqCurve(nextCurve);
    previewEqCurve(curve);
    emit('eq-preview', { itemId: item()?.id || '', curve: cloneEqCurve(curve) });
    renderCurve({ rebuildPresets });
    queuePersistence(curve);
  }

  function loadCurrent() {
    persistNow();
    const current = item();
    if (!current?.id) {
      close();
      return;
    }
    curve = getEffectiveEq(loadEqState(), current.id, isFavorite(current.id));
    previewEqCurve(curve);
    renderCurve({ rebuildPresets: true });
  }

  function saveDiscrete(nextCurve, state, message) {
    const current = item();
    if (!current?.id) return;
    curve = normalizeEqCurve(nextCurve);
    previewEqCurve(curve);
    state = setScopedEq(state, current.id, isFavorite(current.id), curve);
    saveEqState(state);
    scheduleProfileHandoff();
    emit('eq-change', { itemId: current.id, scope: isFavorite(current.id) ? 'favorite' : 'global' });
    renderCurve({ rebuildPresets: true });
    announce(message);
  }

  root.querySelector('.eq-bands').addEventListener('input', (event) => {
    const slider = event.target.closest('.eq-band-slider');
    if (!slider) return;
    preview(curveAfterEqInput(curve, {
      kind: slider.dataset.kind,
      index: Number(slider.dataset.index),
      gain: Number(slider.value),
    }), { rebuildPresets: curveSelection(curve, loadEqState()).startsWith('builtin:') });
  });

  bypass.addEventListener('change', () => preview({ ...curve, bypassed: bypass.checked }));

  favoriteButton.addEventListener('click', () => {
    const current = item();
    if (!current?.id) return;
    if (isFavorite(current.id)) removeFavorite(current.id);
    else addFavorite(current);
  });

  select.addEventListener('change', () => {
    persistNow();
    const [type, id] = select.value.split(':', 2);
    if (type === 'builtin') {
      const selected = getBuiltInEqPreset(id);
      if (selected) preview({ ...selected, bypassed: curve.bypassed }, { rebuildPresets: true });
    } else if (type === 'custom') {
      const selected = loadEqState().customPresets[id];
      if (selected) {
        const { name: _name, ...selectedCurve } = selected;
        preview(snapshotEqPreset(
          { ...selectedCurve, bypassed: curve.bypassed }, customEqPresetId(id),
        ), { rebuildPresets: true });
      }
    }
    announce(`${select.options[select.selectedIndex]?.text || 'Preset'} selected.`);
  });

  nameInput.addEventListener('input', () => {
    const key = customEqPresetKey(curve.presetId);
    if (!key) return;
    const selectedOption = [...select.options].find((option) => option.value === `custom:${key}`);
    if (selectedOption) selectedOption.textContent = nameInput.value.trim() || 'Custom preset';
    const current = item();
    if (!current?.id) return;
    pending = {
      itemId: current.id, favorited: isFavorite(current.id), curve: cloneEqCurve(curve),
      customKey: key, customName: nameInput.value,
    };
    window.clearTimeout(timer);
    timer = window.setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
  });
  nameInput.addEventListener('blur', () => {
    persistNow();
    renderPresets();
  });

  root.querySelector('[data-eq-act="new-preset"]').addEventListener('click', () => {
    persistNow();
    let state = loadEqState();
    let key = createCustomEqPresetKey();
    while (Object.hasOwn(state.customPresets, key)) key = createCustomEqPresetKey();
    const name = `Custom preset ${Object.keys(state.customPresets).length + 1}`;
    const next = snapshotEqPreset(curve, customEqPresetId(key));
    state = setCustomEqPreset(state, key, name, { ...next, bypassed: false });
    saveDiscrete(next, state, `${name} created.`);
    nameInput.focus();
    nameInput.select();
  });

  deleteButton.addEventListener('click', () => {
    persistNow();
    const key = customEqPresetKey(curve.presetId);
    if (!key) return;
    const state = removeCustomEqPreset(loadEqState(), key);
    saveDiscrete({ ...curve, presetId: 'manual' }, state, 'Custom preset deleted. The current curve was kept.');
  });

  root.querySelector('[data-eq-act="reset"]').addEventListener('click', () => {
    persistNow();
    const flat = getBuiltInEqPreset('flat');
    preview({ ...flat, bypassed: curve.bypassed }, { rebuildPresets: true });
    announce('Current equalizer reset to flat.');
  });

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled])',
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  function close() {
    if (disposed) return;
    persistNow();
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    document.removeEventListener('keydown', onKeyDown);
    if (app) app.inert = previousInert;
    root.remove();
    activeOverlay = null;
    previousFocus?.focus?.();
  }

  root.querySelector('[data-eq-act="close"]').addEventListener('click', close);
  root.addEventListener('click', (event) => { if (event.target === root) close(); });
  document.addEventListener('keydown', onKeyDown);
  unsubscribers.push(subscribe('current-item', loadCurrent));
  unsubscribers.push(subscribe('favorites-change', loadCurrent));
  unsubscribers.push(subscribe('eq-scope-change', loadCurrent));
  unsubscribers.push(subscribe('eq-before-scope-change', ({ itemId } = {}) => {
    if (pending && (!pending.favorited || pending.itemId === itemId)) persistNow();
  }));

  root._activate = () => {
    if (app) app.inert = true;
    loadCurrent();
    root.querySelector('[data-eq-act="close"]')?.focus();
  };
  root._flush = persistNow;
  root._close = close;
  return root;
}

/** Persist an in-flight slider/name edit synchronously without closing the UI. */
export function flushEqPersistence() {
  activeOverlay?._flush?.();
}

export function openEqOverlay() {
  if (!getState().currentItem) return null;
  if (activeOverlay) {
    activeOverlay.querySelector('[data-eq-act="close"]')?.focus();
    return activeOverlay;
  }
  const host = document.getElementById('modal-host') || document.body;
  activeOverlay = buildOverlay();
  host.appendChild(activeOverlay);
  activeOverlay._activate?.();
  return activeOverlay;
}

export function initEqOverlay() {
  const unsubscribe = subscribe('eq-open', openEqOverlay);
  const onPageHide = () => flushEqPersistence();
  globalThis.window?.addEventListener?.('pagehide', onPageHide);
  return {
    destroy() {
      unsubscribe();
      globalThis.window?.removeEventListener?.('pagehide', onPageHide);
      activeOverlay?._close?.();
    },
  };
}
