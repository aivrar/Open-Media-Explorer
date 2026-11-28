/**
 * Sleep timer with 10s audio fade-out before pause.
 */

import { getState, emit } from './state.js';

const PRESETS = [
  { label: 'Off',     ms: 0 },
  { label: '1 min',   ms: 1 * 60 * 1000 },
  { label: '15 min',  ms: 15 * 60 * 1000 },
  { label: '30 min',  ms: 30 * 60 * 1000 },
  { label: '1 hour',  ms: 60 * 60 * 1000 },
  { label: '2 hours', ms: 120 * 60 * 1000 },
  { label: 'Custom…', ms: -1 },
];
const FADE_MS = 10000;

let outerTimerId = null;
let fadeTimerId = null;
let fadeIntervalId = null;
let countdownId = null;
let endsAt = null;
let host = null;
let select = null;
let display = null;
// The option that shows a running custom timer ("45 min"); hidden otherwise.
let customOption = null;
// The choice the menu shows: the running timer's ('custom' for a custom one),
// '0' (Off) when none runs.
let runningChoice = '0';

function fmt(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function render() {
  if (!host) return;
  if (host.firstChild) return;
  host.innerHTML = `
    <label for="sleep-select">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <span data-role="display">Sleep</span>
    </label>
    <select id="sleep-select" data-role="select">
      ${PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('')}
      <option value="custom" data-role="custom-running" hidden></option>
    </select>
  `;
  select = host.querySelector('[data-role="select"]');
  display = host.querySelector('[data-role="display"]');
  customOption = host.querySelector('[data-role="custom-running"]');
  select.addEventListener('change', () => onPresetChange(select.value));
}

/** Minutes typed for a custom timer (up to 720), or null when nothing usable
 *  was typed (empty, not a number, 0 or less) or the prompt was cancelled. */
export function customSleepMinutes(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(text)) return null;
  const mins = Number(text);
  if (!(mins > 0)) return null;
  // To a tenth of a minute, so the menu's label is the time that runs.
  return Math.max(0.1, Math.min(720, Math.round(mins * 10) / 10));
}

function minutesLabel(mins) {
  return `${Number.isInteger(mins) ? mins : Number(mins.toFixed(1))} min`;
}

/** The menu shows the running timer's choice, or Off when none runs. */
function showChoice() {
  if (!select) return;
  const custom = Boolean(endsAt) && runningChoice === 'custom';
  if (customOption) customOption.hidden = !custom;
  select.value = endsAt ? runningChoice : '0';
}

function onPresetChange(value) {
  const p = PRESETS[+value];
  if (!p) return;
  if (p.ms === -1) {
    const mins = customSleepMinutes(window.prompt('Set custom sleep timer (minutes):', '45'));
    // Nothing usable typed: nothing starts, and a running timer keeps going.
    if (mins === null) { showChoice(); return; }
    const ms = Math.round(mins * 60 * 1000);
    // A typed time that is one of the listed choices is shown as that choice.
    const listed = PRESETS.findIndex((preset) => preset.ms > 0 && preset.ms === ms);
    if (listed >= 0) setSleep(ms, { choice: String(listed) });
    else setSleep(ms, { custom: mins });
    return;
  }
  setSleep(p.ms, { choice: String(value) });
}

function setSleep(ms, { choice = '0', custom = 0 } = {}) {
  cancel();
  if (!ms || ms <= 0) {
    if (display) display.textContent = 'Sleep';
    return;
  }
  endsAt = Date.now() + ms;
  getState().sleepTimer.until = endsAt;
  runningChoice = custom ? 'custom' : choice;
  if (custom && customOption) customOption.textContent = minutesLabel(custom);
  showChoice();
  scheduleFire(ms);
  startCountdown();
}

function mediaElements() {
  return ['audio-el', 'computer-audio-el', 'video-el'].map((id) => document.getElementById(id)).filter(Boolean);
}

function scheduleFire(ms) {
  const beforeFade = Math.max(0, ms - FADE_MS);
  outerTimerId = setTimeout(() => {
    outerTimerId = null;
    startFade(FADE_MS);
    fadeTimerId = setTimeout(() => {
      fadeTimerId = null;
      for (const el of mediaElements()) {
        try { el.pause(); } catch (_) {}
      }
      cancel();
      emit('sleep-fired');
    }, FADE_MS);
  }, beforeFade);
}

function startFade(durationMs) {
  if (fadeIntervalId) clearInterval(fadeIntervalId);
  const els = mediaElements();
  for (const el of els) el.dataset.preFadeVol = String(el.volume);
  const startV = Math.max(...els.map((el) => el.volume), 0);
  if (startV <= 0) return;
  const step = 100;
  const steps = Math.max(1, durationMs / step);
  let i = 0;
  fadeIntervalId = setInterval(() => {
    i++;
    const t = Math.min(1, i / steps);
    const v = startV * (1 - t);
    for (const el of els) el.volume = Math.max(0, v);
    if (i >= steps) { clearInterval(fadeIntervalId); fadeIntervalId = null; }
  }, step);
}

function startCountdown() {
  if (countdownId) clearInterval(countdownId);
  const tick = () => {
    if (!endsAt) { if (display) display.textContent = 'Sleep'; return; }
    const remaining = endsAt - Date.now();
    if (remaining <= 0) display.textContent = '…';
    else display.textContent = `Sleep ${fmt(remaining)}`;
  };
  tick();
  countdownId = setInterval(tick, 1000);
}

function cancel() {
  if (outerTimerId) { clearTimeout(outerTimerId); outerTimerId = null; }
  if (fadeTimerId) { clearTimeout(fadeTimerId); fadeTimerId = null; }
  if (fadeIntervalId) { clearInterval(fadeIntervalId); fadeIntervalId = null; }
  if (countdownId) { clearInterval(countdownId); countdownId = null; }
  endsAt = null;
  getState().sleepTimer.until = null;
  // Restore any in-progress faded volume so a future play isn't silent.
  for (const el of mediaElements()) {
    if (el.dataset.preFadeVol) {
      el.volume = +el.dataset.preFadeVol;
      delete el.dataset.preFadeVol;
    }
  }
  if (display) display.textContent = 'Sleep';
  runningChoice = '0';
  showChoice();
}

export function initSleepTimer() {
  host = document.getElementById('sleep-timer');
  render();
}
