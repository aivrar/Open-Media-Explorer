import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeStationOption } from '../src/modes/tuner.js';
import { mountTunerStationList } from '../src/modes/tuner-station-list.js';
import { clearDidNotPlay, markDidNotPlay } from '../src/lib/did-not-play.js';
import { getState } from '../src/lib/state.js';
import { FakeElement } from './helpers/fake-dom.js';

class Node extends FakeElement {
  scrollTop = 0;
  focusVisible = false;
  hasFocus = false;

  replaceChildren(...nodes) { this.children = nodes; }
  contains(node) { return this.children.includes(node); }
  closest(selector) { return selector === '[role="option"]' && this.getAttribute('role') === 'option' ? this : null; }
  matches(selector) { return selector === ':focus-visible' && this.hasFocus && this.focusVisible; }
  focus() {
    if (this.hasFocus) return;
    this.hasFocus = true;
    this.dispatchEvent(new Event('focus'));
  }
  blur() {
    this.hasFocus = false;
    this.dispatchEvent(new Event('blur'));
  }
}

function dispatch(target, type, fields) {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(fields || {})) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}

test('a 12,000-station list renders a bounded window and restores the tuned station on rebuild', (t) => {
  const list = new Node();
  const content = new Node();
  const stations = Array.from({ length: 12000 }, (_, index) => ({ id: `station:${index}` }));
  const tuned = [];
  const view = mountTunerStationList(list, content, {
    makeOption: () => new Node(),
    tune(index) {
      tuned.push(index);
      view.update(stations, index, 376, 'small');
    },
    onRender() {},
    onScroll() {},
  });
  t.after(view.destroy);
  const shown = () => content.children.filter((row) => row.getAttribute('aria-selected') === 'true');
  view.update(stations, 8000, 376, 'small');
  assert.equal(list.tabIndex, 0);
  assert.ok(content.children.length <= 12);
  assert.equal(shown().length, 1);
  assert.equal(shown()[0].getAttribute('aria-posinset'), '8001');
  assert.equal(shown()[0].getAttribute('aria-setsize'), '12000');
  assert.equal(parseFloat(shown()[0].style.top) + 28 - list.scrollTop, 220);
  assert.equal(list.getAttribute('aria-activedescendant'), null);
  list.focusVisible = true;
  list.focus();
  assert.equal(list.getAttribute('aria-activedescendant'), shown()[0].id);

  list.scrollTop += 18 * 64;
  const handScroll = list.scrollTop;
  dispatch(list, 'scroll');
  assert.equal(shown().length, 0);
  assert.equal(list.hasAttribute('aria-activedescendant'), false);
  const refreshed = [{ id: 'new' }, ...stations];
  view.update(refreshed, 8001, 376, 'small', true);
  assert.notEqual(list.scrollTop, handScroll);
  assert.equal(shown()[0].id, 'tuner-station-8001');
  assert.ok(content.children.length <= 12);

  view.update(stations, 11999, 376, 'small');
  assert.equal(shown().length, 1);
  assert.equal(parseFloat(shown()[0].style.top) + 56 - list.scrollTop, 376);
  view.update(stations, 11999, 0, 'small');
  assert.equal(content.children.length, 0);
  assert.equal(list.tabIndex, -1);
  list.blur();
  view.update(stations, 11999, 376, 'small');
  assert.equal(shown().length, 1);

  list.focus();
  const press = (key) => {
    assert.equal(dispatch(list, 'keydown', { key }).defaultPrevented, true);
    return list.getAttribute('aria-activedescendant');
  };
  assert.equal(press('Home'), 'tuner-station-0');
  assert.equal(shown().length, 0, 'moving focus does not tune');
  assert.equal(press('ArrowDown'), 'tuner-station-1');
  assert.equal(press('PageDown'), 'tuner-station-7');
  assert.equal(press('PageUp'), 'tuner-station-1');
  assert.equal(press('ArrowUp'), 'tuner-station-0');
  press('Enter');
  assert.equal(shown()[0].id, 'tuner-station-0');
  assert.equal(press('End'), 'tuner-station-11999');
  press(' ');
  assert.equal(shown()[0].id, 'tuner-station-11999');
  const last = content.children.at(-2);
  dispatch(list, 'click', { target: last });
  assert.deepEqual(tuned, [0, 11999, 11998]);
  view.destroy();
  dispatch(list, 'keydown', { key: 'Enter' });
  assert.equal(tuned.length, 3);
});

test('two-column focus follows reading order and a hand scroll snaps only at rest', t => {
  const list = new Node(), content = new Node(), tuned = [];
  const view = mountTunerStationList(list, content, {
    makeOption: () => new Node(), tune: index => tuned.push(index), onRender() {}, onScroll() {},
  });
  t.after(view.destroy);
  view.update(Array.from({ length: 19 }, (_, id) => ({ id })), 0, 184, 'small', false, 2);
  assert.equal(content.children[0].style.top, content.children[1].style.top);
  assert.notEqual(content.children[0].style.left, content.children[1].style.left);
  list.focusVisible = true;
  list.focus();
  for (const [key, index] of [['ArrowRight', 1], ['ArrowRight', 1], ['ArrowDown', 3],
    ['ArrowLeft', 2], ['ArrowLeft', 2], ['ArrowUp', 0], ['End', 18], ['ArrowRight', 18]]) {
    dispatch(list, 'keydown', { key });
    assert.equal(list.getAttribute('aria-activedescendant'), 'tuner-station-' + index);
  }
  dispatch(list, 'keydown', { key: 'Enter' });
  assert.deepEqual(tuned, [18]);
  list.scrollTop = 111;
  dispatch(list, 'scroll');
  assert.equal(list.scrollTop, 111);
  dispatch(list, 'scrollend');
  assert.equal(list.scrollTop, 128);
  assert.deepEqual(tuned, [18]);
});

test('only keyboard focus marks a station, separately from the tuned row', t => {
  const list = new Node(), content = new Node(), tuned = [];
  const stations = [{}, {}, {}];
  const view = mountTunerStationList(list, content, {
    makeOption: () => new Node(),
    tune(index) {
      tuned.push(index);
      view.update(stations, index, 184, 'small');
    },
    onRender() {}, onScroll() {},
  });
  t.after(view.destroy);
  const check = (selected, focused) => {
    assert.deepEqual(content.children.filter(row => row.getAttribute('aria-selected') === 'true')
      .map(row => Number(row.dataset.index)), [selected]);
    assert.deepEqual(content.children.filter(row => row.classList.contains('is-focused'))
      .map(row => Number(row.dataset.index)), focused === null ? [] : [focused]);
    assert.equal(list.getAttribute('aria-activedescendant'), focused === null ? null : 'tuner-station-' + focused);
  };

  view.update(stations, 0, 184, 'small');
  check(0, null);
  list.focus();
  check(0, null);
  dispatch(list, 'keydown', { key: 'ArrowDown' });
  check(0, 1);
  dispatch(list, 'pointerdown');
  check(0, null);
  dispatch(list, 'click', { target: content.children[2] });
  check(2, null);
  assert.deepEqual(tuned, [2]);

  list.blur();
  list.focusVisible = true;
  list.focus();
  check(2, 2);
  dispatch(list, 'keydown', { key: 'ArrowUp' });
  check(2, 1);
  list.blur();
  check(2, null);

  list.focus();
  check(2, 1);
  const previousFocus = content.children[1];
  view.update(stations, 2, 0, 'small');
  assert.equal(previousFocus.classList.contains('is-focused'), false);
  assert.equal(list.getAttribute('aria-activedescendant'), null);
  view.update(stations, 2, 184, 'small');
  check(2, null);
});

test('the listbox suppresses its outline and only the focused option has an inset accent outline', () => {
  const css = readFileSync(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  assert.match(css, /\.tuner-station-list:focus \{ outline: none !important; \}/);
  assert.doesNotMatch(css, /\.tuner-station-list:focus-visible\s*\{/);
  assert.match(css, /\.tuner-station-list:focus \.station-pill\.is-focused \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: -3px;/);
});

test('station options carry the full name, radio or TV metadata, and the favorite and trouble marks', (t) => {
  const previousDocument = globalThis.document;
  const { favorites } = getState();
  globalThis.document = { createElement: (tag) => new Node('', tag) };
  const radio = {
    id: 'fav:tu1', type: 'radio', title: 'An especially long international radio station name',
    source: 'radio-browser', country: 'us', _extra: { codec: 'MP3', bitrate: 128 },
    stream_url: 'https://example.test/station',
  };
  getState().favorites = [radio];
  markDidNotPlay(radio.id, 1700000000000);
  t.after(() => {
    clearDidNotPlay(radio.id);
    getState().favorites = favorites;
    globalThis.document = previousDocument;
  });
  const option = makeStationOption(radio, true);
  const [[name, meta], mark] = [option.children[0].children, option.children[1]];
  assert.equal(name.textContent, `★ ${radio.title}`);
  assert.equal(name.getAttribute('title'), radio.title);
  assert.equal(meta.textContent, 'Radio Browser · US · MP3 128k');
  assert.match(option.className, /is-active/);
  assert.equal(mark.textContent, '!');
  assert.match(mark.getAttribute('aria-label'), /^Did not play last time/);

  const tv = makeStationOption({ id: 'other', title: 'TV', type: 'tv', source: 'iptv-org', country: 'US' }, false);
  assert.equal(tv.children[0].children[1].textContent, 'iptv-org · US');
  assert.equal(tv.children.length, 1);
  assert.doesNotMatch(tv.className, /is-active/);
});

