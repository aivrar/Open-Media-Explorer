import { EQ_GAIN_STEP_DB, roundEqDb } from '../lib/eq-curve.js';
import { readTunerTone, tunerToneValue, TUNER_TONES, turnTunerTone } from '../lib/tuner-tone.js';
import { getState, subscribe } from '../lib/state.js';
import { buildDialSvg, dialTurn, wheelSteps } from './tuner-dial.js';

import { placeTunerPart } from './tuner-layout.js';

const ARC_HALF = 135;

function toneAngle(tone, value) {
  return value * ARC_HALF / (value < 0 ? -tone.min : tone.max);
}

function toneDb(tone, angle) {
  return roundEqDb(angle / ARC_HALF * (angle < 0 ? -tone.min : tone.max));
}

function keyValue(tone, value, key) {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight': return value + EQ_GAIN_STEP_DB;
    case 'ArrowDown':
    case 'ArrowLeft': return value - EQ_GAIN_STEP_DB;
    case 'PageUp': return value + 6 * EQ_GAIN_STEP_DB;
    case 'PageDown': return value - 6 * EQ_GAIN_STEP_DB;
    case 'Home': return tone.min;
    case 'End': return tone.max;
    case 'Backspace':
    case 'Delete': return 0;
    default: return undefined;
  }
}

function makeToneKnob(tone, announce, signal) {
  const knob = document.createElement('div');
  knob.className = 'tuner-tone-knob';
  knob.tabIndex = 0;
  knob.title = tone.name;
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', tone.name);
  knob.setAttribute('aria-valuemin', tone.min);
  knob.setAttribute('aria-valuemax', tone.max);
  knob.innerHTML = buildDialSvg(true) + `
    <span class="tuner-tone-label" aria-hidden="true">${tone.name}</span>`;
  const label = knob.querySelector('.tuner-tone-label');
  const svg = knob.querySelector('svg');
  const needle = svg.querySelector('.dial-body');
  const pointer = svg.querySelector('.tuner-pointer');
  const wheel = { px: 0 };
  let drag = null;
  let keyChanged = false;
  let value;
  let destination;
  function setDestination(next) {
    destination = next;
    knob.title = `${tone.name} · ${destination} · ${value > 0 ? '+' : ''}${value} dB`;
  }
  function setCurve(curve) {
    const next = tunerToneValue(tone, curve);
    if (next === value) return;
    value = next;
    const db = `${value > 0 ? '+' : ''}${value} dB`;
    const rotation = `rotate(${toneAngle(tone, value)} 200 200)`;
    needle.setAttribute('transform', rotation);
    pointer.setAttribute('transform', rotation);
    knob.setAttribute('aria-valuenow', value);
    knob.setAttribute('aria-valuetext', `${tone.name} ${db}`);
    if (destination) setDestination(destination);
  }

  const announceValue = () => announce(knob.getAttribute('aria-valuetext'));
  const angleAt = (event, { x, y }) => Math.atan2(event.clientY - y, event.clientX - x) * 180 / Math.PI;
  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    if (drag.changed) announceValue();
    drag = null;
  }

  knob.addEventListener('pointerdown', (event) => {
    knob.classList.add('is-pointer-input');
    if (event.button !== 0 || drag) return;
    knob.setPointerCapture(event.pointerId);
    const rect = svg.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    drag = {
      id: event.pointerId, center, previousAngle: angleAt(event, center),
      angle: toneAngle(tone, value), requested: value, changed: false,
    };
  }, { signal });
  knob.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const angle = angleAt(event, drag.center);
    drag.angle = Math.min(ARC_HALF, Math.max(-ARC_HALF, drag.angle + dialTurn(drag.previousAngle, angle)));
    drag.previousAngle = angle;
    const target = toneDb(tone, drag.angle);
    if (target === drag.requested) return;
    drag.requested = target;
    if (turnTunerTone(tone, target) && drag) drag.changed = true;
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    knob.addEventListener(event, finishDrag, { signal });
  }
  knob.addEventListener('wheel', (event) => {
    event.stopPropagation();
    knob.classList.add('is-pointer-input');
    if (event.ctrlKey) return;
    event.preventDefault();
    // Three lines are a standard wheel notch in line mode.
    const steps = wheelSteps(wheel, event, 100 / 3);
    if (steps && turnTunerTone(tone, value - steps * EQ_GAIN_STEP_DB)) announceValue();
  }, { passive: false, signal });
  knob.addEventListener('keydown', (event) => {
    const target = keyValue(tone, value, event.key);
    if (target === undefined && event.key !== 'Enter' && event.key !== ' ') return;
    event.stopPropagation();
    event.preventDefault();
    if (target !== undefined && turnTunerTone(tone, target)) keyChanged = true;
  }, { signal });
  function commitKeys() {
    if (keyChanged) announceValue();
    keyChanged = false;
  }
  knob.addEventListener('keyup', (event) => {
    if (keyValue(tone, value, event.key) !== undefined) commitKeys();
  }, { signal });
  knob.addEventListener('blur', commitKeys, { signal });
  knob.addEventListener('dblclick', () => {
    if (turnTunerTone(tone, 0)) announceValue();
  }, { signal });

  return {
    knob, setCurve, setDestination,
    place({ knob: rim, label: text }) {
      placeTunerPart(knob, rim);
      placeTunerPart(label, text, rim.x, rim.y);
    },
    allowKeyboardFocus() {
      if (!drag) knob.classList.remove('is-pointer-input');
    },
    cancelInput() {
      const id = drag?.id;
      drag = null;
      keyChanged = false;
      wheel.px = 0;
      if (id != null && knob.hasPointerCapture(id)) knob.releasePointerCapture(id);
    },
  };
}

export function mountToneKnobs(row) {
  const column = document.createElement('div');
  column.className = 'tuner-tone-column';
  column.inert = true;
  const stack = document.createElement('div');
  stack.className = 'tuner-tone-knobs';
  const scope = document.createElement('span');
  scope.className = 'sr-only';
  scope.setAttribute('role', 'status');
  scope.setAttribute('aria-live', 'polite');
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const announce = (value) => { status.textContent = value; };
  const controller = new AbortController();
  const knobs = Object.values(TUNER_TONES).map((tone) => makeToneKnob(tone, announce, controller.signal));
  // Tab can reach a knob from anywhere in the document.
  document.addEventListener('keydown', () => {
    for (const knob of knobs) knob.allowKeyboardFocus();
  }, { capture: true, signal: controller.signal });
  stack.append(...knobs.map(({ knob }) => knob));
  column.append(stack, scope, status);
  row.appendChild(column);

  const shareCurve = (curve) => { for (const knob of knobs) knob.setCurve(curve); };
  const refresh = () => {
    const current = readTunerTone();
    shareCurve(current.curve);
    if (scope.textContent !== current.scope) scope.textContent = current.scope;
    const destination = current.stationName ? `saved for ${current.stationName}` : 'main EQ';
    for (const knob of knobs) knob.setDestination(destination);
  };
  const cancelInput = () => { for (const knob of knobs) knob.cancelInput(); };
  const refreshScope = () => { cancelInput(); refresh(); };
  const off = [
    subscribe('eq-preview', ({ itemId, curve, mainEq }) => {
      const { currentItem, isPlaying } = getState();
      if (itemId === currentItem?.id && (isPlaying || mainEq)) shareCurve(curve);
    }),
    subscribe('eq-change', (change) => {
      if (change?.source !== 'tuner-tone') cancelInput();
      refresh();
    }),
    ...['current-item', 'playing-change', 'favorites-change', 'eq-scope-change'].map((event) => subscribe(event, refreshScope)),
  ];
  refresh();

  return {
    column,
    setLayout(parts) {
      column.hidden = !parts.length;
      column.inert = !parts.length;
      parts.forEach((part, index) => knobs[index].place(part));
    },
    destroy() {
      for (const unsubscribe of off) unsubscribe();
      controller.abort();
      cancelInput();
      column.remove();
    },
  };
}
