import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement, createFakeDocument } from './helpers/fake-dom.js';

/** The sleep timer's host: its markup becomes a menu, a countdown line and
 *  the option that shows a running custom timer. */
function fakeHost() {
  const host = new FakeElement('sleep-timer');
  const select = new FakeElement('sleep-select', 'select');
  select.value = '0';
  const display = new FakeElement('', 'span');
  display.textContent = 'Sleep';
  const customOption = new FakeElement('', 'option');
  customOption.hidden = true;
  const parts = {
    '[data-role="select"]': select, '[data-role="display"]': display, '[data-role="custom-running"]': customOption,
  };
  let markup = '';
  Object.defineProperty(host, 'innerHTML', { get: () => markup, set: (value) => { markup = value; } });
  Object.defineProperty(host, 'firstChild', { get: () => (markup ? select : null) });
  host.querySelector = (selector) => parts[selector] ?? null;
  return { host, select, display, customOption, markup: () => markup };
}

test('the sleep timer menu shows the running choice, Off when it ends or is cancelled, and an empty custom answer starts nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_795_000_000_000 });
  const previous = { document: globalThis.document, window: globalThis.window };
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  });
  const { host, select, display, customOption, markup } = fakeHost();
  const document = createFakeDocument([host]);
  globalThis.document = document;
  const answers = [];
  globalThis.window = { prompt: () => answers.shift() };
  const { initSleepTimer, customSleepMinutes } = await import(`../src/lib/sleep-timer.js?menu=${Date.now()}`);
  const { getState } = await import('../src/lib/state.js');
  initSleepTimer();
  assert.match(markup(), /<option value="custom" data-role="custom-running" hidden><\/option>/);
  const choose = (value) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };

  // 2 hours: the menu keeps saying so while it counts down.
  choose('5');
  assert.equal(select.value, '5');
  assert.equal(display.textContent, 'Sleep 120:00');
  t.mock.timers.tick(6_000);
  assert.equal(select.value, '5', 'still the running choice');
  assert.equal(display.textContent, 'Sleep 119:54');
  // Off cancels it.
  choose('0');
  assert.equal(select.value, '0');
  assert.equal(display.textContent, 'Sleep');
  assert.equal(getState().sleepTimer.until, null);

  // An empty, blank or non-numeric custom answer (or Cancel) starts nothing.
  for (const answer of ['', '   ', 'soon', '0', '-5', null]) {
    answers.push(answer);
    choose('6');
    assert.equal(select.value, '0', `answer ${JSON.stringify(answer)}: still Off`);
    assert.equal(getState().sleepTimer.until, null, `answer ${JSON.stringify(answer)}: nothing started`);
    assert.equal(display.textContent, 'Sleep');
  }

  // A custom 45 minutes shows as such in the menu.
  answers.push('45');
  choose('6');
  assert.equal(select.value, 'custom');
  assert.equal(customOption.hidden, false);
  assert.equal(customOption.textContent, '45 min');
  assert.equal(display.textContent, 'Sleep 45:00');
  // An empty answer while it runs leaves it running, and shown.
  answers.push('');
  choose('6');
  assert.equal(select.value, 'custom');
  assert.equal(display.textContent, 'Sleep 45:00');

  // When it ends, the menu goes back to Off.
  t.mock.timers.tick(45 * 60_000 - 10_000); // the fade begins
  assert.equal(select.value, 'custom', 'shown while it fades out');
  t.mock.timers.tick(10_000);
  assert.equal(getState().sleepTimer.until, null);
  assert.equal(select.value, '0');
  assert.equal(customOption.hidden, true);
  assert.equal(display.textContent, 'Sleep');

  // A preset after a custom timer: the custom line goes.
  answers.push('20');
  choose('6');
  choose('2');
  assert.equal(select.value, '2');
  assert.equal(customOption.hidden, true);
  choose('0');

  // A typed time that is a listed choice selects that choice, not a second line.
  answers.push('15');
  choose('6');
  assert.equal(select.value, '2');
  assert.equal(customOption.hidden, true);
  assert.equal(display.textContent, 'Sleep 15:00');
  choose('0');

  // The label is the time that runs.
  answers.push('1.24');
  choose('6');
  assert.equal(customOption.textContent, '1.2 min');
  assert.equal(display.textContent, 'Sleep 1:12');
  choose('0');

  assert.equal(customSleepMinutes('1.24'), 1.2);
  assert.equal(customSleepMinutes('1,5'), 1.5);
  assert.equal(customSleepMinutes(' 90 '), 90);
  assert.equal(customSleepMinutes('5000'), 720);
  assert.equal(customSleepMinutes('12abc'), null);
  assert.equal(customSleepMinutes(undefined), null);
});
