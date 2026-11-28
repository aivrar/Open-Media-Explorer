import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import {
  MAX_FILES_SHOWN, PICTURE_ACCEPT, PICTURE_TOO_LARGE_TEXT, STATION_IMAGE_REMOVE_ROUTE,
  STATION_IMAGE_SAVE_ROUTE, TOO_MANY_FILES_TEXT, fileToBase64, pictureIdOf, removeQuestion, removeStationPicture,
  saveStationPicture, stationOwnName, validateDroppedPicture,
} from '../src/lib/station-image-files.js';
import {
  STATION_IMAGE_MAX_BYTES, applyStationImageList, normalizeStationName, setStationImageTitleSource,
  migrateLegacyStationPictures, prepareStationPictureKey, stationImageSourceFor, stationPictureFileKey,
} from '../src/lib/station-images.js';
import { ControlApiError } from '../src/lib/capture-client.js';
import {
  carriesPicture, initPlaylistDrop, isPictureFile, pickPictureFile,
} from '../src/lib/playlist-drop.js';
import { getState } from '../src/lib/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { dropStationPicture, mountPictureDropPreview, pictureDropTarget } from '../src/modes/library/picture-drop.js';
import {
  closeDetail, detailPictureControls, openDetail, refreshDetailPictureControls, refreshDetailTrouble,
} from '../src/modes/library/detail.js';
import { clearDidNotPlay, forgetLoadedDidNotPlay, markDidNotPlay } from '../src/lib/did-not-play.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fileOf = (bytes = PNG_BYTES, { name = 'logo.png', type = 'image/png', size = bytes.length } = {}) => ({
  name, type, size, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const fav = (id, title, extra = {}) => ({ id, title, type: 'radio', source: 'radio-browser', ...extra });

/** The station pictures the page knows of: `entries` are [name, id]. */
function withPictures(t, titles, entries = []) {
  setStationImageTitleSource(() => [titles.map((title) => ({ title }))]);
  applyStationImageList({
    images: entries.map(([name, id]) => ({ key: normalizeStationName(name), id, v: '1', file: `${name}.png` })),
  });
  t.after(() => {
    applyStationImageList({ images: [] });
    setStationImageTitleSource(() => []);
  });
}

function withFavorites(t, list) {
  const state = getState();
  const before = { favorites: state.favorites, mode: state.mode };
  state.favorites = list;
  t.after(() => { state.favorites = before.favorites; state.mode = before.mode; });
  return state;
}

/** A fake control request: answers from `replies` in turn and keeps each call. */
function requests(...replies) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, ...options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  };
  return { request, calls };
}

/* ============ Naming: the server's file name always finds its station ============ */

test('every file name the server makes for a station is matched back to that station', async (t) => {
  const fixture = JSON.parse(await read('tests/fixtures/station-image-file-names.json'));
  for (const [station, stem] of fixture.cases) {
    assert.equal(stationPictureFileKey(station), normalizeStationName(stem), station);
  }
  const named = fixture.cases.filter(([, stem]) => stem);
  assert.ok(named.length > 15);
  for (const [station, stem] of named) {
    withPictures(t, [station], [[stem, ID_A]]);
    assert.equal(stationImageSourceFor({ title: station }), `station-image:${ID_A}:1`, `${station} -> ${stem}`);
  }
});

test('the picture is filed under the station\'s own name, also for a renamed favorite', () => {
  assert.equal(stationOwnName(fav('a', 'Morning', { __favoriteName: true, originalTitle: 'Radio One' })), 'Radio One');
  assert.equal(stationOwnName(fav('a', 'Radio One')), 'Radio One');
  assert.equal(stationOwnName({ title: 'X', originalTitle: 'Y' }), 'X');
  assert.equal(stationOwnName(null), '');
  assert.equal(pictureIdOf(`station-image:${ID_A}:1f`), ID_A);
  assert.equal(pictureIdOf('/api/v1/assets/x'), '');
});

/* ============ Saving ============ */

test('a picture is sent as base64 with the saved station ID', async (t) => {
  withPictures(t, ['Radio One'], []);
  const { request, calls } = requests({ files: [] }, { file: 'Radio One.png' });
  let reloads = 0;
  const asked = [];
  const result = await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request, reload: async () => { reloads += 1; }, confirmImpl: (text) => { asked.push(text); return true; },
  });
  assert.deepEqual(result, { ok: true, text: 'Picture saved for Radio One.' });
  assert.deepEqual(asked, [], 'nothing to replace: no question');
  assert.equal(reloads, 1, 'the list is read again, so every view updates');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { path: STATION_IMAGE_SAVE_ROUTE, method: 'POST', body: { station: 'Radio One', station_id: 'a', preview: true } },
    'first: what would it replace (no picture sent)');
  assert.equal(calls[1].path, STATION_IMAGE_SAVE_ROUTE);
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['data', 'replace', 'station', 'station_id']);
  assert.equal(calls[1].body.station, 'Radio One');
  assert.equal(calls[1].body.replace, false);
  assert.equal(calls[1].body.data, Buffer.from(PNG_BYTES).toString('base64'));
});

test('a station with its own picture is only given a new one after a yes to a question naming every file', async (t) => {
  withPictures(t, ['AC/DC'], [['AC-DC', ID_A]]);
  const item = fav('a', 'AC/DC');
  const no = requests({ files: ['AC-DC.png'] });
  const asked = [];
  const refused = await saveStationPicture(item, fileOf(), {
    request: no.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return false; },
  });
  assert.deepEqual(refused, { ok: false, cancelled: true, text: '' });
  assert.deepEqual(asked, ['The file AC-DC.png is already there. Replace it?']);
  assert.equal(no.calls.length, 1, 'only the question, which changes nothing');

  const yes = requests({ files: ['AC-DC.png', 'ac-dc.gif'] }, { file: 'AC-DC.png' });
  const replaced = await saveStationPicture(item, fileOf(), {
    request: yes.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return true; },
  });
  assert.equal(replaced.ok, true);
  assert.equal(asked.at(-1), 'The files AC-DC.png and ac-dc.gif are already there. Replace them?');
  assert.equal(yes.calls[1].body.replace, true);
  assert.deepEqual(yes.calls[1].body.files, ['AC-DC.png', 'ac-dc.gif'], 'the yes carries exactly the names shown');
  assert.deepEqual(yes.calls.map((call) => call.body.station_id), [item.id, item.id]);
  assert.ok(yes.calls.every((call) => !Object.hasOwn(call.body, 'current')),
    'the save only asks about files scoped to this station');
});

test('file names are shown in full, and more files than a question can show are refused', async (t) => {
  withPictures(t, ['Radio One'], []);
  const long = `Radio One ${'x'.repeat(180)}.png`;
  const asked = [];
  const yes = requests({ files: [long] }, { file: long });
  await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request: yes.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return true; },
  });
  assert.deepEqual(asked, [`The file ${long} is already there. Replace it?`]);
  assert.deepEqual(yes.calls[1].body.files, [long]);
  assert.equal(removeQuestion('Radio One', [long]),
    `Remove the picture of Radio One? This file is deleted from the station-images folder: ${long}`);

  const many = Array.from({ length: MAX_FILES_SHOWN + 1 }, (_, at) => `Radio One ${at}.png`);
  assert.equal(MAX_FILES_SHOWN, 20);
  const tooMany = requests({ files: many });
  const result = await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request: tooMany.request, reload: async () => {}, confirmImpl: () => assert.fail('never asked'),
  });
  assert.deepEqual(result, { ok: false, text: TOO_MANY_FILES_TEXT });
  assert.equal(tooMany.calls.length, 1, 'nothing saved');
  assert.match(TOO_MANY_FILES_TEXT, /where your station pictures are kept.*Tidy that folder by hand/);
  withPictures(t, ['Radio One'], [['Radio One', ID_A]]);
  const removeMany = requests({ files: many });
  assert.deepEqual(await removeStationPicture(fav('a', 'Radio One'), {
    request: removeMany.request, reload: async () => {}, confirmImpl: () => assert.fail('never asked'),
  }), { ok: false, text: TOO_MANY_FILES_TEXT });
  assert.equal(removeMany.calls.length, 1, 'nothing deleted');
});

test('when the folder changed after the question, the user is asked again about what is there now', async (t) => {
  withPictures(t, ['Radio One'], []);
  const changed = new ControlApiError('STATION_IMAGE_CHANGED', 'The station\'s picture files changed while you were asked, so nothing was changed. Try again.', 409);
  const asked = [];
  const again = requests({ files: ['Radio One.png'] }, changed, { files: ['Radio One.png', 'Radio One.gif'] }, { file: 'Radio One.png' });
  const result = await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request: again.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return true; },
  });
  assert.equal(result.ok, true);
  assert.equal(asked.length, 2);
  assert.deepEqual(again.calls[3].body.files, ['Radio One.png', 'Radio One.gif']);
  // A file that came in without a question (no yes yet): asked about too.
  const exists = new ControlApiError('STATION_IMAGE_EXISTS', 'The file Radio One.png is already there. Replace it?', 409);
  const late = requests({ files: [] }, exists, { files: ['Radio One.png'] }, { file: 'Radio One.png' });
  asked.length = 0;
  assert.equal((await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request: late.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return true; },
  })).ok, true);
  assert.deepEqual(asked, ['The file Radio One.png is already there. Replace it?']);
  // Only once more: then the server's sentence is shown.
  const twice = requests({ files: [] }, exists, { files: [] }, exists);
  assert.equal((await saveStationPicture(fav('a', 'Radio One'), fileOf(), {
    request: twice.request, reload: async () => {}, confirmImpl: () => true,
  })).text, exists.message);
});

test('refusals say why in plain words; large and empty files are not sent', async (t) => {
  withPictures(t, ['Radio One'], []);
  const item = fav('a', 'Radio One');
  const none = requests();
  const options = { request: none.request, reload: async () => {}, confirmImpl: () => true };
  assert.deepEqual(await saveStationPicture(item, fileOf(PNG_BYTES, { size: STATION_IMAGE_MAX_BYTES + 1 }), options),
    { ok: false, text: PICTURE_TOO_LARGE_TEXT });
  assert.equal((await saveStationPicture(item, fileOf(new Uint8Array(0)), options)).text, 'The file is empty.');
  assert.match((await saveStationPicture(fav('b', '   '), fileOf(), options)).text, /no name/);
  assert.equal(none.calls.length, 0);

  const svg = new ControlApiError('STATION_IMAGE_SVG', 'SVG pictures are not used: they can contain scripts and links. Use PNG, JPG, WebP or GIF.', 415);
  const refused = requests({ files: [] }, svg);
  const result = await saveStationPicture(item, fileOf(), { ...options, request: refused.request });
  assert.deepEqual(result, { ok: false, text: svg.message });
  const lost = requests(new TypeError('Failed to fetch'));
  assert.equal((await saveStationPicture(item, fileOf(), { ...options, request: lost.request })).text,
    'The picture could not be saved: the app did not answer.');
  const unreadable = { size: 5, arrayBuffer: async () => { throw new Error('gone'); } };
  assert.equal((await saveStationPicture(item, unreadable, options)).text, 'The file could not be read.');
});

test('a large file is turned into base64 in pieces, byte for byte', async () => {
  const bytes = new Uint8Array(200_000).map((_, at) => (at * 7) % 256);
  assert.equal(await fileToBase64(fileOf(bytes)), Buffer.from(bytes).toString('base64'));
});

/* ============ Removing ============ */

test('Remove picture names the files it deletes, then deletes only those', async (t) => {
  withPictures(t, ['Radio One'], [['Radio One', ID_A], ['Jazz', ID_B]]);
  const item = fav('a', 'Radio One');
  const asked = [];
  const no = requests({ files: ['Radio One.png', 'radio one.gif'] });
  assert.equal((await removeStationPicture(item, {
    request: no.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return false; },
  })).cancelled, true);
  assert.deepEqual(asked, [
    'Remove the picture of Radio One? These files are deleted from the station-images folder: Radio One.png, radio one.gif',
  ]);
  assert.deepEqual(no.calls, [{ path: STATION_IMAGE_REMOVE_ROUTE, method: 'POST', body: { id: ID_A, preview: true } }],
    'a no deletes nothing');

  const yes = requests({ files: ['Radio One.png'] }, { removed: 1 });
  let reloads = 0;
  assert.deepEqual(await removeStationPicture(item, {
    request: yes.request, reload: async () => { reloads += 1; }, confirmImpl: (text) => { asked.push(text); return true; },
  }), { ok: true, text: 'Picture removed for Radio One.' });
  assert.equal(asked.at(-1), 'Remove the picture of Radio One? This file is deleted from the station-images folder: Radio One.png');
  assert.deepEqual(yes.calls.map((call) => call.body), [{ id: ID_A, preview: true }, { id: ID_A, files: ['Radio One.png'] }]);
  assert.equal(reloads, 1);
  assert.equal((await removeStationPicture(fav('c', 'Other'), { request: yes.request })).text,
    'Other has no picture of its own.');
  // The files changed between the question and the yes: nothing went.
  const changed = requests({ files: ['Radio One.png'] }, { removed: 0 });
  assert.match((await removeStationPicture(item, {
    request: changed.request, reload: async () => {}, confirmImpl: () => true,
  })).text, /nothing was removed/);
});

test('removing an ID picture keeps legacy pictures for their other owners', async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete globalThis.localStorage;
  });
  const radio = fav('radio:remove-id', 'News');
  const tv = fav('tv:legacy-owner', 'News', { type: 'tv' });
  const key = await prepareStationPictureKey(radio.id);
  withPictures(t, ['News'], [['News', ID_A], [key, ID_B]]);
  migrateLegacyStationPictures([radio, tv]);
  const removed = requests({ files: [key + '.png'] }, { removed: 1 });
  const result = await removeStationPicture(radio, {
    request: removed.request,
    confirmImpl: (prompt) => {
      assert.equal(prompt, 'Remove the picture of News?');
      return true;
    },
    reload: async () => applyStationImageList({ images: [{ key: 'news', id: ID_A, v: '1' }] }),
  });
  assert.equal(result.ok, true);
  assert.equal(removed.calls[1].body.id, ID_B);
  assert.equal(stationImageSourceFor(radio), '');
  assert.equal(stationImageSourceFor(tv), `station-image:${ID_A}:1`);
});

test('a renamed favorite\'s picture under the user\'s name is the one file named and removed', async (t) => {
  withPictures(t, ['Radio One', 'Morning'], [['Morning', ID_B], ['Radio One', ID_A]]);
  const item = fav('a', 'Morning', { __favoriteName: true, originalTitle: 'Radio One' });
  const asked = [];
  const yes = requests({ files: ['Morning.png'] }, { removed: 1 });
  const result = await removeStationPicture(item, {
    request: yes.request, reload: async () => {}, confirmImpl: (text) => { asked.push(text); return true; },
    currentSource: () => `station-image:${ID_B}:1`,
  });
  assert.equal(result.ok, true);
  assert.match(asked[0], /: Morning\.png$/);
  assert.deepEqual(yes.calls.map((call) => call.body), [{ id: ID_B, preview: true }, { id: ID_B, files: ['Morning.png'] }]);
});

/* ============ Dropping a picture ============ */

test('a dragged picture is told apart from a playlist by type; a dropped file by type or name', () => {
  const drag = (...types) => ({ types: ['Files'], items: types.map((type) => ({ kind: 'file', type })) });
  assert.equal(carriesPicture(drag('image/png')), true);
  assert.equal(carriesPicture(drag('image/png', 'audio/x-mpegurl')), false);
  assert.equal(carriesPicture(drag('application/json')), false);
  assert.equal(carriesPicture(drag('')), false);
  assert.equal(carriesPicture({ types: ['text/plain'], items: [{ kind: 'string', type: 'image/png' }] }), false);
  assert.equal(carriesPicture(null), false);
  assert.equal(isPictureFile({ name: 'x.bin', type: 'image/jpeg' }), true);
  assert.equal(isPictureFile({ name: 'Logo.SVG', type: '' }), true, 'the server says why an SVG is not used');
  assert.equal(isPictureFile({ name: 'notes.txt', type: 'text/plain' }), false);
  const png = { name: 'a.png' };
  assert.equal(pickPictureFile([{ name: 'a.txt' }, png]), png);
  assert.equal(pickPictureFile(null), null);
});

function dropHarness(options) {
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const body = new FakeElement();
  const documentImpl = { body, createElement: (tag) => new FakeElement('', tag) };
  const dispose = initPlaylistDrop({ ...options, target, documentImpl });
  const fire = (type, dataTransfer, extra = {}) => {
    const event = { dataTransfer, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
    listeners.get(type)(event);
    return event;
  };
  const [hint, announcement] = body.children;
  return { fire, hint, announcement, dispose };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pictureDrag = { types: ['Files'], items: [{ kind: 'file', type: 'image/png' }], files: [] };
const pictureDrop = { types: ['Files'], files: [{ name: 'logo.png', type: 'image/png' }] };
const highlight = 'is-picture-drop-target';

test('picture drags highlight only the target and refusals use a timed notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = new FakeElement();
  const second = new FakeElement();
  const imported = [];
  const pictures = [];
  const { fire, hint, announcement, dispose } = dropHarness({
    onPlaylist: (file) => imported.push(file),
    onPicture: async (file, where) => {
      pictures.push([file.name, where]);
      if (where === first) return { text: 'Picture saved for Jazz.' };
      if (where === second) return { text: 'The file could not be read.', rejected: true };
      return null;
    },
    getPictureTarget: (where) => (where === first || where === second ? where : null),
  });
  t.after(dispose);
  assert.equal(fire('dragover', pictureDrag, { target: first }).prevented, true);
  assert.equal(first.classList.contains(highlight), true);
  assert.equal(first.getAttribute('data-picture-drop-label'), "Drop to set this station's picture");
  assert.equal(hint.hidden, true);

  fire('dragover', pictureDrag, { target: second });
  assert.equal(first.classList.contains(highlight), false);
  assert.equal(first.hasAttribute('data-picture-drop-label'), false);
  assert.equal(second.classList.contains(highlight), true);
  fire('dragleave', pictureDrag, { relatedTarget: null });
  assert.equal(second.classList.contains(highlight), false);

  fire('dragover', pictureDrag, { target: first });
  assert.equal(fire('drop', pictureDrop, { target: first }).prevented, true);
  assert.equal(first.classList.contains(highlight), false);
  await settle();
  assert.deepEqual(pictures, [['logo.png', first]]);
  assert.equal(hint.hidden, true);
  assert.equal(announcement.className, 'sr-only');
  assert.equal(announcement.getAttribute('aria-live'), 'polite');
  assert.equal(announcement.textContent, 'Picture saved for Jazz.');

  fire('dragover', pictureDrag, { target: 'sidebar' });
  assert.equal(hint.hidden, true);
  assert.equal(fire('drop', pictureDrop, { target: 'sidebar' }).prevented, true);
  await settle();
  assert.equal(hint.hidden, true);
  assert.equal(announcement.textContent, '');

  fire('drop', pictureDrop, { target: second });
  await settle();
  assert.equal(hint.textContent, 'The file could not be read.');
  assert.equal(hint.classList.contains('is-rejected'), true);
  assert.equal(announcement.textContent, 'The file could not be read.');
  assert.equal(hint.getAttribute('aria-hidden'), 'true');
  t.mock.timers.tick(5999);
  assert.equal(hint.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(hint.hidden, true);
  assert.equal(announcement.textContent, '');

  fire('dragover', { types: ['Files'], items: [{ kind: 'file', type: 'audio/x-mpegurl' }] });
  assert.match(hint.textContent, /^Drop a playlist file/);
  fire('drop', { types: ['Files'], files: [{ name: 'logo.png' }, { name: 'list.m3u' }] }, { target: first });
  await settle();
  assert.deepEqual(imported.map((file) => file.name), ['list.m3u']);
  assert.equal(pictures.length, 3);
  fire('drop', { types: ['Files'], files: [{ name: 'notes.txt' }] });
  assert.match(hint.textContent, /^Only \.m3u/);
  fire('keydown', null, { key: 'Escape' });
  t.mock.timers.tick(3499);
  assert.equal(hint.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(hint.hidden, true);
});

test('a long picture refusal lasts eight seconds and dismisses on Escape or the next drag', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const message = 'SVG drawings are not allowed as station pictures. Use a PNG, JPG, WebP or GIF picture.';
  const { fire, hint, announcement, dispose } = dropHarness({
    onPicture: async () => ({ text: message, rejected: true }),
  });
  t.after(dispose);
  for (const dismiss of [
    () => { t.mock.timers.tick(7999); assert.equal(hint.hidden, false); t.mock.timers.tick(1); },
    () => fire('keydown', null, { key: 'Escape' }),
    () => fire('dragover', pictureDrag),
    () => fire('pointerdown'),
  ]) {
    fire('drop', pictureDrop);
    await settle();
    assert.equal(hint.hidden, false);
    assert.equal(announcement.textContent, message);
    dismiss();
    assert.equal(hint.hidden, true);
    assert.equal(announcement.textContent, '');
  }
  fire('drop', pictureDrop);
  fire('keydown', null, { key: 'Escape' });
  await settle();
  assert.equal(hint.hidden, true, 'a refusal that arrives after Escape stays dismissed');
});

function pictureTargets(t) {
  const state = withFavorites(t, [fav('fav:jazz', 'Jazz FM'), fav('fav:news', 'News FM'), fav('fav:invalid', '._')]);
  state.mode = 'library';
  const oldHost = ui.resultsHost;
  t.after(() => { ui.resultsHost = oldHost; });
  const cards = new Set();
  ui.resultsHost = { contains: (node) => cards.has(node) };
  const cardFor = (item, { inHost = true } = {}) => {
    const card = new FakeElement();
    const properties = new Map();
    card.__thumb = new FakeElement();
    card.__thumb.style = {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
    };
    card.__item = item;
    card.closest = () => card;
    if (inHost) cards.add(card);
    return { card, thumb: card.__thumb, preview: () => properties.get('--picture-drop-preview') };
  };
  return { state, cardFor };
}

test('only named, visible saved stations in the Library take a dropped picture', async (t) => {
  const { state, cardFor } = pictureTargets(t);
  const saved = cardFor(state.favorites[0]);
  assert.equal(pictureDropTarget(saved.card), saved.card);
  for (const target of [
    cardFor(fav('catalog:1', 'Not saved')).card,
    cardFor(state.favorites[0], { inHost: false }).card,
    cardFor({ ...state.favorites[0], __contentHidden: true }).card,
    cardFor(state.favorites[2]).card,
    null,
  ]) assert.equal(pictureDropTarget(target), null);
  assert.equal(await dropStationPicture({}, null, { validate: () => assert.fail('outside drop validated') }), null);
  state.mode = 'tuner';
  assert.equal(pictureDropTarget(saved.card), null);
});

test('drop validation rejects empty, oversized, SVG, bad dimensions and decode failures', async () => {
  const revoked = [];
  const options = {
    createUrl: (blob) => {
      assert.equal(blob.type, 'image/png');
      return 'blob:png';
    },
    decode: async () => [100, 50],
    revokeUrl: (url) => revoked.push(url),
  };
  assert.match((await validateDroppedPicture(fileOf(undefined, { size: 0 }), options)).text, /empty/);
  assert.equal((await validateDroppedPicture(fileOf(undefined, { size: STATION_IMAGE_MAX_BYTES + 1 }), options)).text,
    PICTURE_TOO_LARGE_TEXT);
  const svg = fileOf(new TextEncoder().encode('<?xml version="1.0"?><svg/>'), { name: 'fake.png' });
  assert.match((await validateDroppedPicture(svg, options)).text, /SVG drawings are not allowed/);
  const valid = await validateDroppedPicture(fileOf(undefined, { type: 'text/plain' }), options);
  assert.equal(valid.url, 'blob:png');
  valid.release();
  for (const dimensions of [[8193, 100], [8000, 8000], [0, 50]]) {
    assert.match((await validateDroppedPicture(fileOf(), { ...options, decode: async () => dimensions })).text,
      /not a picture the app can use/);
  }
  const decode = async () => { throw new Error('corrupt image'); };
  assert.match((await validateDroppedPicture(fileOf(), { ...options, decode })).text, /not a picture the app can use/);
  assert.equal(revoked.length, 5);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('validated previews show while saving, persist on a remount, and roll back on failure', async (t) => {
  const { state, cardFor } = pictureTargets(t);
  const item = state.favorites[0];
  const { card, thumb, preview } = cardFor(item);
  const validation = deferred();
  const saving = deferred();
  const released = [];
  let saves = 0;
  const result = dropStationPicture({}, card, {
    validate: () => validation.promise,
    save: async (_item, _file, options) => {
      saves += 1;
      assert.equal(options.confirmImpl(), true, 'the labeled drop replaces without a modal');
      return saving.promise;
    },
  });
  assert.equal(preview(), undefined);
  assert.equal(saves, 0);
  validation.resolve({ url: 'blob:optimistic', release: () => released.push('optimistic') });
  await settle();
  assert.equal(saves, 1);
  assert.equal(preview(), 'url("blob:optimistic")');
  assert.equal(thumb.classList.contains('is-picture-saving'), true);
  const remount = cardFor(item);
  mountPictureDropPreview(remount.thumb, item);
  assert.equal(remount.preview(), preview());

  saving.resolve({ ok: false, text: 'The picture could not be saved in the station-images folder.' });
  assert.deepEqual(await result, { text: 'The picture could not be saved in the station-images folder.', rejected: true });
  assert.equal(preview(), undefined, 'the underlying picture was never changed');
  assert.equal(remount.preview(), undefined);
  assert.equal(thumb.classList.contains('is-picture-saving'), false);
  assert.deepEqual(released, ['optimistic']);
});

test('same-name stations save independently and the latest drop wins on one station', async (t) => {
  const { state, cardFor } = pictureTargets(t);
  const jazz = cardFor(state.favorites[0]);
  const news = cardFor({ ...state.favorites[1], title: state.favorites[0].title, type: 'tv' });
  const first = deferred();
  const second = deferred();
  const calls = [];
  const released = [];
  const save = async (item, file) => {
    calls.push([item.id, file.name]);
    if (file.name === 'first') return first.promise;
    if (file.name === 'second') return second.promise;
    return { ok: true, text: 'News saved.' };
  };
  const drop = (name, card) => dropStationPicture({ name }, card, {
    validate: async () => ({ url: 'blob:' + name, release: () => released.push(name) }),
    save,
  });

  const old = drop('first', jazz.card);
  await settle();
  const latest = drop('second', jazz.card);
  assert.equal(jazz.preview(), 'url("blob:first")', 'the existing preview stays until the new image validates');
  const other = drop('news', news.card);
  assert.deepEqual(await other, { text: 'News saved.', rejected: false });
  assert.deepEqual(calls, [['fav:jazz', 'first'], ['fav:news', 'news']]);
  assert.equal(jazz.preview(), 'url("blob:second")');
  first.resolve({ ok: true, text: 'Old save.' });
  assert.equal(await old, null, 'an older result is silent');
  await settle();
  assert.deepEqual(calls.at(-1), ['fav:jazz', 'second']);
  assert.equal(jazz.preview(), 'url("blob:second")');
  second.resolve({ ok: true, text: 'Jazz saved.' });
  assert.deepEqual(await latest, { text: 'Jazz saved.', rejected: false });
  assert.equal(jazz.preview(), undefined);
  assert.deepEqual(released, ['first', 'news', 'second']);
});

test('a newer drop can save before a superseded file finishes validating', async (t) => {
  const { state, cardFor } = pictureTargets(t);
  const { card } = cardFor(state.favorites[0]);
  const validation = deferred();
  const old = dropStationPicture({}, card, {
    validate: () => validation.promise,
    save: () => assert.fail('superseded file saved'),
  });
  const latest = await dropStationPicture({}, card, {
    validate: async () => ({ url: 'blob:new', release() {} }),
    save: async () => ({ ok: true, text: 'Jazz saved.' }),
  });
  assert.deepEqual(latest, { text: 'Jazz saved.', rejected: false });
  let released = false;
  validation.resolve({ url: 'blob:old', release: () => { released = true; } });
  assert.equal(await old, null);
  assert.equal(released, true);
});

test('the Library wires picture targets and previews without a page scrim', async () => {
  const [main, library, render, css, libraryCss] = await Promise.all([
    read('src/main.js'), read('src/modes/library.js'), read('src/modes/library/render.js'),
    read('src/styles/base.css'), read('src/styles/library.css'),
  ]);
  assert.match(main, /onPicture: dropStationPicture,\s*getPictureTarget: pictureDropTarget,/);
  assert.match(library, /export \{ dropStationPicture, pictureDropTarget \} from '\.\/library\/picture-drop\.js';/);
  assert.match(render, /carriesFiles/);
  const rule = css.match(/\.drop-hint \{[^}]*\}/)[0];
  assert.match(rule, /width: max-content;[\s\S]*pointer-events: none;/);
  assert.doesNotMatch(rule, /inset:|height:/);
  assert.match(libraryCss, /\.is-picture-drop-target \{[^}]*outline: 2px solid var\(--accent\)/);
  assert.match(libraryCss, /\.is-picture-saving::before \{[^}]*var\(--picture-drop-preview\)/);
});

/* ============ The details panel ============ */

class Node extends FakeElement {
  constructor(nodeId = '', tag = 'div') {
    super(nodeId, tag);
    this.parentNode = null;
    this.className = '';
    this.clicks = 0;
  }
  get isConnected() {
    let node = this;
    while (node) { if (node.root) return true; node = node.parentNode; }
    return false;
  }
  set innerHTML(value) { if (value === '') for (const child of [...this.children]) this.removeChild(child); }
  get innerHTML() { return ''; }
  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  click() { this.clicks += 1; }
  focus() { globalThis.document.activeElement = this; }
  all() { return this.children.flatMap((child) => [child, ...(child.all?.() || [])]); }
  querySelector(selector) {
    const act = selector.match(/^\[data-act="([^"]+)"\]$/)?.[1];
    return act ? this.all().find((node) => node.getAttribute?.('data-act') === act) || null : null;
  }
}

function withPanel(t) {
  const previous = {
    root: ui.root, panel: ui.detailPanel, document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window,
  };
  globalThis.fetch = () => new Promise(() => {});
  globalThis.window = {};
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node('', tag),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  const root = new Node('', 'div');
  root.root = true;
  ui.root = root;
  ui.detailPanel = null;
  // The panel's artwork lookup is stopped when it closes; that is expected.
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    closeDetail();
    ui.root = previous.root;
    ui.detailPanel = previous.panel;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  });
  const find = (cls) => ui.detailPanel.all().find((node) => node.className === cls) || null;
  const act = (name) => ui.detailPanel.querySelector(`[data-act="${name}"]`);
  return { find, act };
}

test('details: a saved station has Choose picture, and Remove picture only while it has its own', (t) => {
  const state = withFavorites(t, [fav('fav:a', 'Radio One')]);
  state.mode = 'library';
  withPictures(t, ['Radio One'], []);
  const { find, act } = withPanel(t);
  openDetail(getState().favorites[0]);
  const surface = find('detail-picture-drop');
  const thumb = find('detail-thumb');
  thumb.closest = () => surface;
  assert.equal(thumb.hidden, false);
  assert.equal(thumb.style.display, 'none', 'the drop surface remains available without artwork');
  assert.equal(pictureDropTarget(thumb), surface);
  const choose = act('choose-station-picture');
  const remove = act('remove-station-picture');
  assert.equal(choose.textContent, 'Choose picture\u2026');
  assert.equal(choose.getAttribute('type'), 'button');
  assert.equal(remove.hidden, true);
  const input = find('detail-picture-input');
  assert.equal(input.getAttribute('type'), 'file');
  assert.equal(input.getAttribute('accept'), PICTURE_ACCEPT);
  assert.equal(input.hidden, true);
  // The buttons sit with Rename, with the result line next in the default layout.
  const actions = find('detail-actions');
  assert.ok(actions.children.includes(choose) && actions.children.includes(act('rename-favorite')));
  assert.ok(actions.children.includes(remove));
  const message = find('detail-picture-message');
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.hidden, true);
  const afterActions = ui.detailPanel.children.slice(ui.detailPanel.children.indexOf(actions) + 1);
  assert.equal(afterActions.find((node) => node === message || !node.hidden), message);
  choose.dispatchEvent(new Event('click'));
  assert.equal(input.clicks, 1, 'opens the file chooser');

  // A picture of its own arrives (the change event): Remove picture shows.
  applyStationImageList({ images: [{ key: 'radio one', id: ID_A, v: '1' }] });
  assert.equal(refreshDetailPictureControls(), true);
  assert.equal(remove.hidden, false);
  assert.equal(detailPictureControls().item.id, 'fav:a');
});

test('details: a station that is not saved has no picture controls', (t) => {
  withFavorites(t, [fav('fav:a', 'Radio One')]);
  const { act } = withPanel(t);
  openDetail(fav('catalog:x', 'Not saved'));
  assert.equal(act('choose-station-picture'), null);
  assert.equal(detailPictureControls(), null);
  assert.equal(refreshDetailPictureControls(), false);
});

test('details: "Did not play last time" is said in the panel and follows the mark', (t) => {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
  });
  forgetLoadedDidNotPlay();
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    forgetLoadedDidNotPlay();
  });
  withFavorites(t, [fav('fav:a', 'Radio One')]);
  const { find } = withPanel(t);
  markDidNotPlay('fav:a', Date.UTC(2026, 10, 20, 12));
  openDetail(getState().favorites[0]);
  const note = find('detail-trouble');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^Did not play last time \(.+2026\)\. It is tried again when you play it\.$/);
  assert.equal(note.getAttribute('role'), 'note');
  clearDidNotPlay('fav:a');
  assert.equal(refreshDetailTrouble(), true);
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  // Not for a station that is not saved.
  markDidNotPlay('catalog:x', Date.UTC(2026, 10, 20, 12));
  openDetail(fav('catalog:x', 'Not saved'));
  assert.equal(find('detail-trouble').hidden, true);
});

test('the picture controls fit the panel and use theme colors', async () => {
  const css = await read('src/styles/library.css');
  assert.match(css, /\.detail-picture-message\[data-state="error"\] \{[^}]*color: var\(--danger\)/);
  assert.match(css, /\.detail-actions > \.btn\[hidden\]/);
});
