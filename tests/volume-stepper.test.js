import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  VOLUME_STEP, VOLUME_WHEEL_STEP, VOLUME_HOLD_DELAY_MS, VOLUME_REPEAT_MS,
  clampVolume, steppedVolume, volumeWheelDelta, volumeKeyDelta, bindVolumeStepper, elementVolumeChange,
} from '../src/lib/volume-stepper.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; tasks.set(id, { fn, at: now + ms, every: 0 }); return id; },
    setInterval(fn, ms) { const id = nextId++; tasks.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    clearInterval(id) { tasks.delete(id); },
    pending: () => tasks.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let id = null;
        let task = null;
        for (const [key, entry] of tasks) if (entry.at <= end && (!task || entry.at < task.at)) { id = key; task = entry; }
        if (!task) break;
        now = task.at;
        if (task.every) task.at += task.every; else tasks.delete(id);
        task.fn();
      }
      now = end;
    },
  };
}

function rig(start = 50) {
  const clock = fakeClock();
  const group = new EventTarget();
  const down = new EventTarget();
  const up = new EventTarget();
  const win = new EventTarget();
  const state = { volume: start, sets: [] };
  const cleanup = bindVolumeStepper({
    group, down, up, win, timers: clock,
    getVolume: () => state.volume,
    setVolume: (value) => { state.volume = value; state.sets.push(value); },
  });
  return { clock, group, down, up, win, state, cleanup };
}

const fire = (target, type, props = {}) => {
  const event = Object.assign(new Event(type, { cancelable: true }), props);
  target.dispatchEvent(event);
  return event;
};

test('the constants are 1 per click, 2 per wheel notch, 400 ms before repeating, then every 50 ms', () => {
  assert.equal(VOLUME_STEP, 1);
  assert.equal(VOLUME_WHEEL_STEP, 2);
  assert.equal(VOLUME_HOLD_DELAY_MS, 400);
  assert.equal(VOLUME_REPEAT_MS, 50);
});

test('a step changes the volume by its delta and stops at 0 and 100', () => {
  assert.equal(steppedVolume(50, 1), 51);
  assert.equal(steppedVolume(50, -1), 49);
  assert.equal(steppedVolume(100, 1), 100);
  assert.equal(steppedVolume(0, -1), 0);
  assert.equal(steppedVolume(99, 2), 100);
  assert.equal(steppedVolume(1, -2), 0);
  assert.equal(clampVolume(54.6), 55);
  assert.equal(clampVolume(-3), 0);
  assert.equal(clampVolume(140), 100);
  assert.equal(clampVolume(Number.NaN), 0);
  assert.equal(clampVolume('65'), 65);
});

test('the wheel gives 2 per notch, up is louder, and small touchpad moves add up', () => {
  const pool = { px: 0 };
  assert.equal(volumeWheelDelta(pool, { deltaY: -100, deltaMode: 0 }), 2);
  assert.equal(volumeWheelDelta(pool, { deltaY: 100, deltaMode: 0 }), -2);
  assert.equal(volumeWheelDelta(pool, { deltaY: 300, deltaMode: 0 }), -6);
  assert.equal(pool.px, 0);
  const small = [-30, -30, -30, -30].map((deltaY) => volumeWheelDelta(pool, { deltaY, deltaMode: 0 }));
  assert.deepEqual(small, [0, 0, 0, 2]);
  const lines = { px: 0 };
  assert.equal(volumeWheelDelta(lines, { deltaY: -3, deltaMode: 1 }), 0);
  assert.equal(volumeWheelDelta(lines, { deltaY: -1, deltaMode: 1 }), 2);
  assert.equal(volumeWheelDelta({ px: 0 }, {}), 0);
});

test('arrow keys move by 1, page keys by 10, Home and End go to the ends', () => {
  assert.equal(volumeKeyDelta('ArrowUp'), 1);
  assert.equal(volumeKeyDelta('ArrowRight'), 1);
  assert.equal(volumeKeyDelta('ArrowDown'), -1);
  assert.equal(volumeKeyDelta('ArrowLeft'), -1);
  assert.equal(volumeKeyDelta('PageUp'), 10);
  assert.equal(volumeKeyDelta('PageDown'), -10);
  assert.equal(volumeKeyDelta('End'), 100);
  assert.equal(volumeKeyDelta('Home'), -100);
  assert.equal(volumeKeyDelta('a'), 0);
});

test('a click steps once, a pointer click only steps on pointerdown', () => {
  const { clock, down, up, state } = rig(50);
  fire(up, 'click');
  assert.equal(state.volume, 51);
  fire(down, 'click');
  assert.equal(state.volume, 50);
  fire(up, 'pointerdown', { button: 0 });
  assert.equal(state.volume, 51);
  fire(up, 'pointerup');
  fire(up, 'click', { detail: 1 });
  assert.equal(state.volume, 51);
  assert.equal(clock.pending(), 0);
});

test('holding a button repeats after 400 ms every 50 ms until it is let go', () => {
  const { clock, up, state } = rig(50);
  fire(up, 'pointerdown', { button: 0 });
  assert.equal(state.volume, 51);
  clock.advance(399);
  assert.equal(state.volume, 51);
  // The first repeated step comes at 400 ms, then one every 50 ms.
  clock.advance(1);
  assert.equal(state.volume, 52);
  clock.advance(49);
  assert.equal(state.volume, 52);
  clock.advance(1);
  assert.equal(state.volume, 53);
  clock.advance(500);
  assert.equal(state.volume, 63);
  fire(up, 'pointerup');
  assert.equal(clock.pending(), 0);
  clock.advance(1000);
  assert.equal(state.volume, 63);
});

test('the whole range takes about 5 seconds to cross when held', () => {
  const { clock, up, state } = rig(0);
  fire(up, 'pointerdown', { button: 0 });
  clock.advance(VOLUME_HOLD_DELAY_MS + 98 * VOLUME_REPEAT_MS - 1);
  assert.equal(state.volume, 99);
  clock.advance(1);
  assert.equal(state.volume, 100);
  // The next tick finds nothing left to change and ends the repeat.
  clock.advance(VOLUME_REPEAT_MS);
  assert.equal(clock.pending(), 0);
});

test('holding down stops at 0 and leaves no timer', () => {
  const { clock, down, state } = rig(3);
  fire(down, 'pointerdown', { button: 0 });
  assert.equal(state.volume, 2);
  clock.advance(400 + 50 * 10);
  assert.equal(state.volume, 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(state.sets, [2, 1, 0]);
});

test('leaving the button, a cancelled pointer, a lost capture, a release elsewhere or the window losing focus stops the repeat', () => {
  const cases = [
    (r) => [r.up, 'pointerleave'], (r) => [r.up, 'pointercancel'], (r) => [r.up, 'lostpointercapture'],
    (r) => [r.win, 'pointerup'], (r) => [r.win, 'pointercancel'], (r) => [r.win, 'blur'],
    (r) => [r.win, 'mouseup'], (r) => [r.win, 'contextmenu'], (r) => [r.win, 'dragstart'],
    (r) => [r.win, 'pointermove', { buttons: 0 }],
  ];
  for (const pick of cases) {
    const r = rig(50);
    fire(r.up, 'pointerdown', { button: 0 });
    r.clock.advance(450);
    assert.equal(r.state.volume, 53);
    const [target, type, props] = pick(r);
    fire(target, type, props);
    assert.equal(r.clock.pending(), 0, type);
    r.clock.advance(500);
    assert.equal(r.state.volume, 53, type);
  }
});

test('a move with the mouse button still down does not end a hold', () => {
  const r = rig(50);
  fire(r.up, 'pointerdown', { button: 0 });
  fire(r.win, 'pointermove', { buttons: 1 });
  r.clock.advance(450);
  assert.equal(r.state.volume, 53);
  fire(r.up, 'pointerup');
  assert.equal(r.clock.pending(), 0);
});

test('a lost pointerup cannot keep a mouse hold going: each step checks the button is still pressed (:active)', () => {
  const clock = fakeClock();
  const group = new EventTarget();
  const down = new EventTarget();
  const up = new EventTarget();
  let active = true;
  up.matches = (selector) => (selector === ':active' ? active : false);
  let volume = 10;
  bindVolumeStepper({
    group, down, up, win: new EventTarget(), timers: clock,
    getVolume: () => volume, setVolume: (value) => { volume = value; },
  });
  fire(up, 'pointerdown', { button: 0, pointerType: 'mouse' });
  assert.equal(volume, 11);
  clock.advance(450);
  assert.equal(volume, 13);
  // The mouse button is let go, but no pointerup or mouseup reaches us.
  active = false;
  clock.advance(50);
  assert.equal(volume, 13, 'no step once the button is no longer pressed');
  assert.equal(clock.pending(), 0, 'and no timer left');
  clock.advance(2000);
  assert.equal(volume, 13);
});

test('a hold keeps one timer at a time (no interval), so a busy moment cannot bring a burst of steps', () => {
  const clock = fakeClock();
  const calls = { setInterval: 0, maxPending: 0 };
  const timers = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => { calls.setInterval += 1; return clock.setInterval(fn, ms); },
    clearInterval: (id) => clock.clearInterval(id),
  };
  const group = new EventTarget();
  const down = new EventTarget();
  const up = new EventTarget();
  let volume = 0;
  bindVolumeStepper({
    group, down, up, win: new EventTarget(), timers,
    getVolume: () => volume, setVolume: (value) => { volume = value; },
  });
  fire(up, 'pointerdown', { button: 0 });
  for (let t = 0; t < 1000; t += 10) {
    clock.advance(10);
    calls.maxPending = Math.max(calls.maxPending, clock.pending());
  }
  assert.equal(calls.setInterval, 0);
  assert.equal(calls.maxPending, 1);
  assert.equal(volume, 1 + 1 + 12, 'one at once, one at 400 ms, then one per 50 ms');
  fire(up, 'pointerup');
  assert.equal(clock.pending(), 0);
});

test('the window\'s release listeners listen on the way down (capture), so nothing on the page can stop them first', () => {
  const added = [];
  const win = { addEventListener: (type, fn, options) => added.push([type, options]), removeEventListener() {} };
  bindVolumeStepper({
    group: new EventTarget(), down: new EventTarget(), up: new EventTarget(), win,
    getVolume: () => 50, setVolume() {},
  });
  for (const type of ['pointerup', 'pointercancel', 'mouseup', 'contextmenu', 'dragstart', 'pointermove']) {
    const entry = added.find(([name]) => name === type);
    assert.ok(entry, type);
    assert.equal(entry[1]?.capture, true, type);
  }
  assert.ok(added.some(([name]) => name === 'blur'));
});

test('only the main button starts a step', () => {
  const { clock, up, state } = rig(50);
  fire(up, 'pointerdown', { button: 2 });
  assert.equal(state.volume, 50);
  assert.equal(clock.pending(), 0);
});

test('the wheel over the control changes the volume and the page does not scroll', () => {
  const a = rig(50);
  const event = fire(a.group, 'wheel', { deltaY: -100, deltaMode: 0 });
  assert.equal(a.state.volume, 52);
  assert.equal(event.defaultPrevented, true);
  fire(a.group, 'wheel', { deltaY: 100, deltaMode: 0 });
  assert.equal(a.state.volume, 50);
  // A small touchpad move changes nothing yet, but the page still stays put.
  assert.equal(fire(a.group, 'wheel', { deltaY: 10, deltaMode: 0 }).defaultPrevented, true);
  assert.equal(a.state.volume, 50);
  const b = rig(99);
  fire(b.group, 'wheel', { deltaY: -100, deltaMode: 0 });
  assert.equal(b.state.volume, 100);
  fire(b.group, 'wheel', { deltaY: -100, deltaMode: 0 });
  assert.equal(b.state.volume, 100);
  assert.deepEqual(b.state.sets, [100]);
});

test('Ctrl + wheel (zoom) and a mainly sideways move are left to the page', () => {
  const { group, state } = rig(50);
  const zoom = fire(group, 'wheel', { deltaY: -100, deltaMode: 0, ctrlKey: true });
  assert.equal(zoom.defaultPrevented, false);
  assert.equal(state.volume, 50);
  const sideways = fire(group, 'wheel', { deltaX: 120, deltaY: -100, deltaMode: 0 });
  assert.equal(sideways.defaultPrevented, false);
  assert.equal(state.volume, 50);
  // Mostly vertical with a little drift still counts.
  const vertical = fire(group, 'wheel', { deltaX: 20, deltaY: -100, deltaMode: 0 });
  assert.equal(vertical.defaultPrevented, true);
  assert.equal(state.volume, 52);
});

test('arrow keys on the control change the volume', () => {
  const { group, state } = rig(50);
  assert.equal(fire(group, 'keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  assert.equal(state.volume, 51);
  fire(group, 'keydown', { key: 'ArrowLeft' });
  assert.equal(state.volume, 50);
  fire(group, 'keydown', { key: 'PageDown' });
  assert.equal(state.volume, 40);
  assert.equal(fire(group, 'keydown', { key: 'a' }).defaultPrevented, false);
  assert.equal(state.volume, 40);
  fire(group, 'keydown', { key: 'End' });
  assert.equal(state.volume, 100);
});

test('cleanup removes the listeners and stops a hold', () => {
  const { clock, group, up, state, cleanup } = rig(50);
  fire(up, 'pointerdown', { button: 0 });
  cleanup();
  assert.equal(clock.pending(), 0);
  fire(up, 'click');
  assert.equal(state.volume, 51);
  fire(group, 'wheel', { deltaY: -100, deltaMode: 0 });
  assert.equal(state.volume, 51);
});

test('a window without addEventListener (tests, old hosts) is skipped, not an error', () => {
  const group = new EventTarget();
  const down = new EventTarget();
  const up = new EventTarget();
  let volume = 10;
  const cleanup = bindVolumeStepper({ group, down, up, win: {}, getVolume: () => volume, setVolume: (v) => { volume = v; } });
  fire(up, 'click');
  assert.equal(volume, 11);
  cleanup();
});

test('a volumechange from the video asks the store only for what differs, rounded, and nothing during a fade', () => {
  const stored = { storedPct: '45', storedMuted: false };
  // The same level after rounding (our own write echoing back): nothing.
  assert.equal(elementVolumeChange({ volume: 0.45, muted: false, ...stored }), null);
  assert.equal(elementVolumeChange({ volume: 0.4537, muted: false, ...stored }), null);
  assert.equal(elementVolumeChange({ volume: 0.29, muted: false, storedPct: 29, storedMuted: false }), null);
  // The video's own slider moved.
  assert.deepEqual(elementVolumeChange({ volume: 0.62, muted: false, ...stored }), { muted: null, pct: 62 });
  assert.deepEqual(elementVolumeChange({ volume: 0, muted: false, ...stored }), { muted: null, pct: 0 });
  assert.deepEqual(elementVolumeChange({ volume: 1, muted: false, ...stored }), { muted: null, pct: 100 });
  // Its mute button, alone or with a level.
  assert.deepEqual(elementVolumeChange({ volume: 0.45, muted: true, ...stored }), { muted: true, pct: null });
  assert.deepEqual(elementVolumeChange({ volume: 0.45, muted: false, storedPct: 45, storedMuted: true }), { muted: false, pct: null });
  assert.deepEqual(elementVolumeChange({ volume: 0.3, muted: true, ...stored }), { muted: true, pct: 30 });
  // A sleep-timer fade's level is not the user's volume; it never mutes, so
  // a mute from the video's own button still counts while it runs.
  assert.equal(elementVolumeChange({ volume: 0.1, muted: false, ...stored, fading: true }), null);
  assert.deepEqual(elementVolumeChange({ volume: 0.1, muted: true, ...stored, fading: true }), { muted: true, pct: null });
  assert.deepEqual(elementVolumeChange({ volume: 0.1, muted: false, storedPct: 45, storedMuted: true, fading: true }), { muted: false, pct: null });
  // An unreadable volume is not taken as 0.
  assert.equal(elementVolumeChange({ volume: Number.NaN, muted: false, ...stored }), null);
});

test('the player bar has the speaker, then up, the level and down, and no visible slider', async () => {
  const html = await read('src/index.html');
  const block = html.match(/<div class="player-volume">[\s\S]*?\n {8}<\/div>/)[0];
  // Up first: on top in the column, and first in the tab order.
  const order = ['id="player-mute"', 'id="player-volume-up"', 'id="player-volume-readout"', 'id="player-volume-down"']
    .map((id) => block.indexOf(id));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'speaker, up, level, down');
  assert.match(block, /<div id="player-volume-control" class="volume-stepper" role="group" aria-label="Volume" title="Volume 80%" tabindex="-1">/);
  assert.match(block, /<button id="player-volume-down" class="volume-step" type="button" aria-label="Volume down"/);
  assert.match(block, /<button id="player-volume-up" class="volume-step" type="button" aria-label="Volume up"/);
  assert.match(block, /<output id="player-volume-readout" class="volume-led" aria-live="polite" aria-label="Volume 80">80<\/output>/);
  assert.match(block, /<input id="player-volume" [^>]*hidden \/>/);

  const css = await read('src/styles/base.css');
  // Three digits wide whatever the level, in the app's monospace font.
  const led = css.match(/\n\.volume-led \{([^}]*)\}/)[1];
  assert.match(led, /width: 3ch;/);
  assert.match(led, /font-family: var\(--font-mono\);/);
  assert.match(led, /font-variant-numeric: tabular-nums;/);
  // Centred on the arrows' axis for 1, 2 and 3 digits (measured in Chromium:
  // within 0.01 px for 5, 58 and 100; right-aligned, 5 sat 6 px and 58 3 px
  // right of it): even padding, no letter spacing after the last digit, and
  // no rule elsewhere that pushes the digits to one side.
  assert.match(led, /justify-content: center;/);
  assert.match(led, /text-align: center;/);
  assert.match(led, /padding: 0 4px;/);
  assert.match(led, /letter-spacing: 0;/);
  assert.doesNotMatch(css, /\.volume-led[^{]*\{[^}]*(justify-content: flex-(end|start)|text-align: (right|left)|padding-(left|right))/);
  const tuner = await read('src/styles/tuner.css');
  assert.doesNotMatch(tuner, /\.volume-led[^{]*\{[^}]*(justify-content|text-align|padding|letter-spacing)/);
  assert.match(led, /color: var\(--accent\);/);
  // No unlit "888" behind the digits: it made 83 read as 883.
  assert.doesNotMatch(css, /\.volume-led::(before|after)/);
  assert.doesNotMatch(css, /content: '888'/);
  // The wide bar: a column (up, level, down) beside the speaker, with thin
  // 16 px buttons as wide as the column (measured: 70 px for the whole
  // volume area, 54 px tall inside the 96 px bar).
  assert.match(css, /\n\.volume-stepper \{[^}]*flex-direction: column;/);
  assert.match(css, /\n\.volume-step \{[^}]*height: 16px;/);
  assert.doesNotMatch(css.match(/\n\.volume-step \{([^}]*)\}/)[1], /width:/);
  assert.doesNotMatch(css, /#player-volume \{ width:/);
  // The stacked bar's 24 px volume row: down - level - up in a row.
  const narrow = (css.match(/@media \(max-width: 1000px\) \{[\s\S]*?\n\}/g) || []).join('\n');
  assert.match(narrow, /\.volume-stepper \{ flex-direction: row-reverse; height: 24px; box-sizing: border-box; \}/);

  // The player keeps the hidden input as the one level and shows it.
  const player = await read('src/lib/player.js');
  const sync = player.match(/function syncVolumeUi\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(sync, /elements\.volReadout\.textContent = level;/);
  assert.match(sync, /elements\.volReadout\.setAttribute\('aria-label', `Volume \$\{level\}`\);/);
  assert.match(player, /bindVolumeStepper\(\{\s+group: elements\.volControl, down: elements\.volDown, up: elements\.volUp,\s+getVolume: \(\) => Number\(elements\.vol\.value\), setVolume,/);
});
