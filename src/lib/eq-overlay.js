/** Accessible, automatically persisted equalizer overlay. */

import {
  cloneEqCurve, EQ_MAX_Q, EQ_MIN_Q, getEffectiveEq, getEqPreset, hasFavoriteEq,
  loadEqState, normalizeEqCurve, removeCustomEqPreset, saveEqState, setCustomEqPreset,
  setScopedEq, setStationEqPreset,
} from './eq-store.js';
import {
  BUILT_IN_EQ_PRESETS, createCustomEqPresetKey, customEqPresetId,
  customEqPresetKey, getBuiltInEqPreset, isBuiltInEqPreset,
} from './eq-presets.js';
import { savedEqStations, trackEqStations } from './eq-stations.js';
import { loadPlaylists, playlistsLoaded } from './playlists.js';
import { getAudioFrequencyResponse, previewEqCurve } from './player.js';
import { addFavorite, emit, getState, isFavorite, removeFavorite, subscribe } from './state.js';
import { ProfileStorageBudgetError } from './profile-storage.js';
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
  const values = kind === 'q' ? curve.q : curve.bands;
  if (Number.isInteger(index) && index >= 0 && index < values.length) values[index] = gain;
  return normalizeEqCurve({ ...curve, presetId });
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
  const widths = BAND_LABELS.map((label, index) => `<label class="eq-width">
    <span>${label} Hz Q</span>
    <input type="range" min="${EQ_MIN_Q}" max="${EQ_MAX_Q}" step="any" value="1"
      data-kind="q" data-index="${index}" aria-label="${label} Hz Q">
    <output></output>
  </label>`).join('');
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
      <div class="eq-content">
      <p class="eq-station-message" data-eq-save-message role="status" hidden></p>
      <div class="eq-toolbar">
        <div class="eq-scope-wrap">
          <span data-eq-scope-label>Saving to</span><strong data-eq-scope>Main EQ</strong>
          <button class="btn eq-favorite-scope" type="button" data-eq-favorite aria-pressed="false">☆ Add favorite</button>
        </div>
        <label class="eq-bypass"><input type="checkbox" class="switch" data-eq-bypass /> Bypass</label>
      </div>
      <div class="eq-preset-row">
        <label for="eq-preset-select">Preset</label>
        <select id="eq-preset-select" data-eq-preset aria-label="Equalizer preset"></select>
        <button class="btn" type="button" data-eq-act="edit-preset" aria-pressed="false" hidden>Edit preset</button>
        <button class="btn" type="button" data-eq-act="reset">Reset to flat</button>
      </div>
      <div class="eq-preset-row">
        <label for="eq-preset-name">Preset name</label>
        <input id="eq-preset-name" type="text" data-eq-preset-name maxlength="80" />
        <button class="btn" type="button" data-eq-act="new-preset">Save new preset</button>
        <button class="btn" type="button" data-eq-act="rename-preset" disabled>Rename preset</button>
        <button class="btn btn-danger-subtle" type="button" data-eq-act="delete-preset" disabled>Delete preset</button>
      </div>
      <div class="eq-assigned" data-eq-assigned hidden>
        <span data-eq-assigned-name></span>
        <button class="btn" type="button" data-eq-act="stop-preset">Stop using for this station</button>
      </div>
      <details class="eq-stations" data-eq-stations>
        <summary>Stations...</summary>
        <div class="eq-station-controls">
          <label for="eq-station-filter">Filter stations</label>
          <input id="eq-station-filter" type="search" />
          <label for="eq-station-preset">Use preset</label>
          <select id="eq-station-preset"></select>
          <button type="button" class="btn" data-eq-act="apply-stations" disabled>Apply to selected</button>
          <span class="eq-station-count" role="status" data-eq-station-count></span>
        </div>
        <p class="eq-station-message" data-eq-station-message role="status" hidden></p>
        <ul class="eq-station-list" aria-label="Saved stations"></ul>
      </details>
      <div class="eq-response" role="img" aria-label="Equalizer frequency response" data-eq-response-wrap>
        <svg viewBox="0 0 640 116" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="58" x2="640" y2="58" />
          <path data-eq-response d="M0 58 L640 58" />
        </svg>
        <span>-18</span><span>0 dB</span><span>+18</span>
      </div>
      <div class="eq-bands" aria-label="Equalizer gain controls">${bands}</div>
      <details class="eq-advanced">
        <summary>Advanced</summary>
        <p>Q controls band width. For the 31 Hz and 16 kHz shelves, it adjusts resonance.</p>
        <div class="eq-widths" aria-label="Equalizer Q controls">${widths}</div>
      </details>
      </div>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-eq-announcement></span>
    </div>`;

  const app = document.getElementById('app');
  const previousInert = Boolean(app?.inert);
  let disposed = false;
  let timer = 0;
  let curve = normalizeEqCurve(null);
  let pending = null;
  let editKey = '';
  let activeId = '';
  let stationLoadFailed = false;
  const checked = new Set();
  const unsubscribers = [];
  const action = (name) => root.querySelector(`[data-eq-act="${name}"]`);
  const select = root.querySelector('[data-eq-preset]');
  const nameInput = root.querySelector('[data-eq-preset-name]');
  const deleteButton = action('delete-preset');
  const renameButton = action('rename-preset');
  const editButton = action('edit-preset');
  const assignedRow = root.querySelector('[data-eq-assigned]');
  const assignedName = root.querySelector('[data-eq-assigned-name]');
  const bypass = root.querySelector('[data-eq-bypass]');
  const scope = root.querySelector('[data-eq-scope]');
  const scopeLabel = root.querySelector('[data-eq-scope-label]');
  const favoriteButton = root.querySelector('[data-eq-favorite]');
  const responsePath = root.querySelector('[data-eq-response]');
  const responseWrap = root.querySelector('[data-eq-response-wrap]');
  const announcement = root.querySelector('[data-eq-announcement]');
  const saveMessage = root.querySelector('[data-eq-save-message]');
  const stations = root.querySelector('[data-eq-stations]');
  const stationFilter = root.querySelector('#eq-station-filter');
  const stationPreset = root.querySelector('#eq-station-preset');
  const stationList = root.querySelector('.eq-station-list');
  const stationCount = root.querySelector('[data-eq-station-count]');
  const stationMessage = root.querySelector('[data-eq-station-message]');
  const applyStations = action('apply-stations');

  function item() { return getState().currentItem; }

  function announce(message) { announcement.textContent = message; }

  function assignedPreset(eq) { return getEqPreset(eq, eq.assignments[item()?.id]); }

  function save(eq) {
    let message = '';
    saveEqState(eq, undefined, (error) => {
      message = error instanceof ProfileStorageBudgetError ? error.message : 'Equalizer settings could not be saved.';
    });
    saveMessage.textContent = message;
    saveMessage.hidden = !message;
    if (message) return false;
    scheduleProfileHandoff();
    emit('eq-change');
    return true;
  }

  function persistNow() {
    window.clearTimeout(timer);
    timer = 0;
    if (!pending) return true;
    const change = pending;
    pending = null;
    let eq = loadEqState();
    if (change.key) {
      const preset = eq.customPresets[change.key];
      if (!preset) return true;
      eq = setCustomEqPreset(eq, change.key, preset.name, { ...change.curve, bypassed: false });
    }
    if (change.scoped) eq = setScopedEq(eq, change.itemId, change.favorited, change.curve);
    const saved = save(eq);
    if (!saved && item()?.id === change.itemId) refreshFromStorage();
    return saved;
  }

  function queuePersistence(nextCurve, eq) {
    const current = item();
    if (!current?.id) return;
    pending = {
      itemId: current.id,
      favorited: hasFavoriteEq(eq, current.id, isFavorite(current.id)),
      scoped: !assignedPreset(eq),
      curve: cloneEqCurve(nextCurve),
      key: editKey,
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

  function presetGroups(eq, forStations = false) {
    const builtIns = document.createElement('optgroup');
    builtIns.label = 'Built-in presets';
    const custom = document.createElement('optgroup');
    custom.label = 'Custom presets';
    const option = (value, label) => {
      const node = document.createElement('option');
      node.value = value;
      node.textContent = label;
      return node;
    };
    for (const entry of BUILT_IN_EQ_PRESETS) {
      builtIns.appendChild(option(forStations ? entry.id : `builtin:${entry.id}`, entry.name));
    }
    for (const [key, preset] of Object.entries(eq.customPresets)) {
      custom.appendChild(option(customEqPresetId(key), preset.name));
    }
    const first = option(forStations ? '' : 'manual', forStations ? 'Choose a preset' : 'Manual curve');
    first.disabled = true;
    const options = [first];
    if (forStations) options.push(option('none', 'Clear preset assignment'));
    options.push(builtIns);
    if (custom.childElementCount) options.push(custom);
    return options;
  }

  function renderPresetControls(eq) {
    select.replaceChildren(...presetGroups(eq));
    select.value = curveSelection(curve, eq);
    const key = customEqPresetKey(curve.presetId);
    const custom = key && eq.customPresets[key];
    const assigned = assignedPreset(eq);
    select.disabled = Boolean(assigned || editKey);
    editButton.hidden = !custom;
    editButton.textContent = editKey ? 'Done editing' : 'Edit preset';
    editButton.setAttribute('aria-pressed', String(Boolean(editKey)));
    nameInput.value = custom?.name || '';
    renameButton.disabled = !custom;
    deleteButton.disabled = !custom;
    assignedRow.hidden = !assigned;
    assignedName.textContent = assigned ? `Using preset ${assigned.name} for this station` : '';
  }

  function renderCurve(eq) {
    const current = item();
    const favorited = isFavorite(current?.id);
    const stationCurve = hasFavoriteEq(eq, current?.id, favorited);
    const locked = Boolean(assignedPreset(eq) && !editKey);
    scopeLabel.hidden = locked;
    scope.hidden = locked;
    scope.textContent = editKey ? eq.customPresets[editKey]?.name || 'Custom preset'
      : (stationCurve ? current.title || 'Favorite item' : 'Main EQ');
    scope.dataset.scope = stationCurve ? 'favorite' : 'global';
    favoriteButton.textContent = favorited ? 'Remove favorite' : 'Add favorite';
    favoriteButton.setAttribute('aria-pressed', String(favorited));
    favoriteButton.setAttribute('aria-label', favorited ? 'Remove this item from Favorites' : 'Add this item to Favorites');
    bypass.checked = curve.bypassed;
    action('reset').disabled = locked;
    for (const slider of root.querySelectorAll('input[data-kind]')) {
      const { kind, index } = slider.dataset;
      const value = kind === 'preamp' ? curve.preamp : (kind === 'q' ? curve.q[index] : curve.bands[index]);
      slider.value = String(value);
      slider.disabled = locked;
      const text = kind === 'q' ? Number(value.toFixed(2)).toString() : displayDb(value);
      slider.setAttribute('aria-valuetext', text.replace('dB', 'decibels'));
      slider.closest('label').querySelector('output').textContent = text;
    }
    updateResponse();
  }

  function updateSelection() {
    applyStations.disabled = !checked.size || !stationPreset.value;
    stationCount.textContent = `${checked.size} selected`;
  }

  function renderStations(eq = loadEqState()) {
    if (!stations.open) return;
    const saved = savedEqStations();
    for (const id of checked) {
      if (!saved.has(id)) checked.delete(id);
    }
    const selectedPreset = stationPreset.value;
    stationPreset.replaceChildren(...presetGroups(eq, true));
    stationPreset.value = selectedPreset === 'none' || getEqPreset(eq, selectedPreset) ? selectedPreset : '';
    const focused = document.activeElement;
    const focusedId = focused?.type === 'checkbox' && stationList.contains(focused) ? focused.value : '';
    let replacementFocus;
    const filter = stationFilter.value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    for (const station of saved.values()) {
      const lists = [...station.lists].join(', ');
      if (filter && !`${station.name} ${station.original} ${station.type} ${lists}`.toLocaleLowerCase().includes(filter)) continue;
      const row = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = station.id;
      checkbox.checked = checked.has(station.id);
      if (station.id === focusedId) replacementFocus = checkbox;
      const name = document.createElement('span');
      name.textContent = `${station.name} (${station.type}, ${lists})`;
      const assignment = document.createElement('span');
      assignment.textContent = getEqPreset(eq, eq.assignments[station.id])?.name
        || (Object.hasOwn(eq.favorites, station.id) && station.lists.has('Favorites') ? 'Saved station curve' : 'No preset');
      assignment.className = 'eq-station-assignment';
      label.append(checkbox, name, assignment);
      row.appendChild(label);
      fragment.appendChild(row);
    }
    stationMessage.textContent = stationLoadFailed ? 'My Playlists could not be loaded.'
      : (!playlistsLoaded() ? 'Loading My Playlists...' : (!fragment.childNodes.length ? 'No stations found.' : ''));
    stationMessage.hidden = !stationMessage.textContent;
    stationList.replaceChildren(fragment);
    if (focusedId) (replacementFocus || stationFilter).focus();
    updateSelection();
  }

  function savedCurve(eq, current = item()) {
    return getEffectiveEq(eq, current?.id, isFavorite(current?.id));
  }

  function applyPreview(value) {
    previewEqCurve(value);
    emit('eq-preview', { itemId: item()?.id || '', curve: cloneEqCurve(value) });
  }

  function refreshFromStorage() {
    const eq = loadEqState();
    curve = savedCurve(eq);
    if (editKey) {
      const preset = curve.presetId === customEqPresetId(editKey) && getEqPreset(eq, curve.presetId);
      if (preset) curve = { ...preset.curve, bypassed: curve.bypassed };
      else editKey = '';
    }
    applyPreview(curve);
    renderPresetControls(eq);
    renderCurve(eq);
    renderStations(eq);
  }

  function loadCurrent() {
    persistNow();
    const current = item();
    if (!current?.id) {
      close(true);
      return;
    }
    if (current.id !== activeId) {
      editKey = '';
      activeId = current.id;
    }
    refreshFromStorage();
  }

  function preview(nextCurve, eq = loadEqState()) {
    curve = normalizeEqCurve(nextCurve);
    applyPreview(curve);
    renderCurve(eq);
    if (select.value !== curveSelection(curve, eq)) renderPresetControls(eq);
    queuePersistence(curve, eq);
  }

  root.addEventListener('input', (event) => {
    const slider = event.target.closest('input[data-kind]');
    if (!slider || slider.disabled) return;
    const next = curveAfterEqInput(curve, {
      kind: slider.dataset.kind,
      index: Number(slider.dataset.index),
      gain: Number(slider.value),
    });
    if (!editKey && customEqPresetKey(next.presetId)) next.presetId = 'manual';
    preview(next);
  });

  bypass.addEventListener('change', () => {
    const bypassed = bypass.checked;
    persistNow();
    const eq = loadEqState();
    const id = item()?.id;
    const favorited = !assignedPreset(eq) && hasFavoriteEq(eq, id, isFavorite(id));
    const base = favorited ? eq.favorites[id] : eq.global;
    save(setScopedEq(eq, id, favorited, { ...base, bypassed }));
    refreshFromStorage();
  });

  favoriteButton.addEventListener('click', () => {
    const current = item();
    if (!current?.id) return;
    if (isFavorite(current.id)) removeFavorite(current.id);
    else addFavorite(current);
  });

  select.addEventListener('change', () => {
    const value = select.value.replace(/^builtin:/, '');
    persistNow();
    const eq = loadEqState();
    const preset = getEqPreset(eq, value);
    if (!preset || assignedPreset(eq) || editKey) return;
    preview({ ...preset.curve, bypassed: curve.bypassed }, eq);
    renderPresetControls(eq);
    announce(`${preset.name} selected.`);
  });

  editButton.addEventListener('click', () => {
    persistNow();
    editKey = editKey ? '' : customEqPresetKey(curve.presetId);
    refreshFromStorage();
    announce(editKey ? 'Changes update this preset for every station using it.' : 'Finished editing preset.');
  });

  action('new-preset').addEventListener('click', () => {
    const enteredName = nameInput.value.trim();
    persistNow();
    let eq = loadEqState();
    let key = createCustomEqPresetKey();
    while (Object.hasOwn(eq.customPresets, key)) key = createCustomEqPresetKey();
    const name = enteredName || `Custom preset ${Object.keys(eq.customPresets).length + 1}`;
    const next = { ...curve, presetId: customEqPresetId(key) };
    eq = setCustomEqPreset(eq, key, name, { ...next, bypassed: false });
    const id = item()?.id;
    if (!assignedPreset(eq)) {
      eq = setScopedEq(eq, id, hasFavoriteEq(eq, id, isFavorite(id)), next);
    }
    if (!save(eq)) return;
    editKey = '';
    refreshFromStorage();
    announce(`${name} saved.`);
  });

  renameButton.addEventListener('click', () => {
    const name = nameInput.value.trim();
    const key = customEqPresetKey(curve.presetId);
    persistNow();
    const eq = loadEqState();
    const preset = key && eq.customPresets[key];
    if (!preset) return;
    if (!name) {
      announce('Enter a preset name.');
      nameInput.focus();
      return;
    }
    if (!save(setCustomEqPreset(eq, key, name, preset))) return;
    refreshFromStorage();
    announce('Preset renamed.');
  });

  deleteButton.addEventListener('click', () => {
    persistNow();
    const key = customEqPresetKey(curve.presetId);
    if (!key) return;
    let eq = loadEqState();
    const assigned = assignedPreset(eq);
    eq = removeCustomEqPreset(eq, key);
    if (!assigned) {
      const id = item()?.id;
      const favorited = hasFavoriteEq(eq, id, isFavorite(id));
      eq = setScopedEq(eq, id, favorited, { ...savedCurve(eq), presetId: 'manual' });
    }
    if (!save(eq)) return;
    editKey = '';
    refreshFromStorage();
    action('new-preset').focus();
    announce('Custom preset deleted.');
  });

  action('reset').addEventListener('click', () => {
    persistNow();
    const eq = loadEqState();
    const flat = getBuiltInEqPreset('flat');
    preview({ ...flat, bypassed: curve.bypassed, presetId: editKey ? customEqPresetId(editKey) : 'flat' }, eq);
    announce('Equalizer reset to flat.');
  });

  action('stop-preset').addEventListener('click', () => {
    persistNow();
    if (!save(setStationEqPreset(loadEqState(), [item()?.id]))) return;
    editKey = '';
    refreshFromStorage();
    select.focus();
    announce('Preset assignment cleared.');
  });

  stations.addEventListener('toggle', () => {
    if (!stations.open) return;
    stationLoadFailed = false;
    renderStations();
    if (!playlistsLoaded()) {
      loadPlaylists().catch(() => {
        if (disposed) return;
        stationLoadFailed = true;
        renderStations();
      });
    }
  });
  stationFilter.addEventListener('input', () => renderStations());
  stationPreset.addEventListener('change', updateSelection);
  stationList.addEventListener('change', (event) => {
    const checkbox = event.target;
    if (checkbox.checked) checked.add(checkbox.value);
    else checked.delete(checkbox.value);
    updateSelection();
  });
  applyStations.addEventListener('click', () => {
    persistNow();
    const saved = savedEqStations();
    const ids = [...checked].filter((id) => saved.has(id));
    const preset = stationPreset.value;
    if (!ids.length || !preset || !save(setStationEqPreset(loadEqState(), ids, preset === 'none' ? '' : preset))) return;
    if (ids.includes(item()?.id)) editKey = '';
    stationPreset.value = '';
    checked.clear();
    refreshFromStorage();
    stationFilter.focus();
    announce(`Updated ${ids.length} ${ids.length === 1 ? 'station' : 'stations'}.`);
  });

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), summary',
    )].filter((element) => element.getClientRects().length > 0
      && (element.tagName === 'SUMMARY' || !element.closest('details:not([open])')));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  function close(force = false) {
    if (disposed) return;
    if (!persistNow() && !force) return;
    if (item()) applyPreview(savedCurve(loadEqState()));
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    document.removeEventListener('keydown', onKeyDown);
    if (app) app.inert = previousInert;
    root.remove();
    activeOverlay = null;
    previousFocus?.focus?.();
  }

  root.querySelector('[data-eq-act="close"]').addEventListener('click', () => close());
  root.addEventListener('click', (event) => { if (event.target === root) close(); });
  document.addEventListener('keydown', onKeyDown);
  unsubscribers.push(subscribe('current-item', loadCurrent));
  unsubscribers.push(subscribe('favorites-change', loadCurrent));
  unsubscribers.push(subscribe('playlists-change', () => {
    stationLoadFailed = false;
    const eq = loadEqState();
    if (!assignedRow.hidden && !assignedPreset(eq)) loadCurrent();
    else renderStations(eq);
  }));
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
  root._close = () => close(true);
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
  const untrackStations = trackEqStations();
  const onPageHide = () => flushEqPersistence();
  globalThis.window?.addEventListener?.('pagehide', onPageHide);
  return {
    destroy() {
      unsubscribe();
      untrackStations();
      globalThis.window?.removeEventListener?.('pagehide', onPageHide);
      activeOverlay?._close?.();
    },
  };
}
