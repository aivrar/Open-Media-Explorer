import test from 'node:test';
import assert from 'node:assert/strict';

import { ControlApiError } from '../src/lib/capture-client.js';
import { setMode } from '../src/lib/state.js';
import { mountComputerFolders } from '../src/modes/computer-folders.js';
import { renderComputer } from '../src/modes/computer.js';
import { FakeNodeEl } from './helpers/visualizer-fakes.js';

class FolderElement extends FakeNodeEl {
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      super.append(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }

  focus() {
    if (!this.disabled && visible(this)) this.ownerDocument.activeElement = this;
  }
}

const folder = (id, path, available = true) => ({ id, path, available });
const music = folder('music', 'D:\\Music');
const videos = folder('videos', '\\\\media\\shared\\Videos', false);
const settle = () => new Promise(setImmediate);
const byText = (host, text) => host.descendants().find((node) => node.textContent === text);
const byTag = (host, tag) => host.descendants().find((node) => node.tagName === tag);
const alertOf = (host) => host.descendants().find((node) => node.getAttribute('role') === 'alert');
const removeOf = (host, { path }) => host.descendants().find((node) => node.getAttribute('aria-label') === `Remove ${path}`);
const click = (node) => node.dispatchEvent(new Event('click'));
const visible = (node) => Boolean(node && !node.hidden && (!node.parentElement || visible(node.parentElement)));

function setup(t, overrides = {}) {
  const doc = {
    activeElement: null,
    createElement: (tag) => Object.assign(new FolderElement(tag), { ownerDocument: doc }),
  };
  const host = doc.createElement('main');
  const deps = {
    doc,
    listComputerFolders: t.mock.fn(async () => ({ folders: [] })),
    pickComputerFolder: t.mock.fn(async () => ({ path: '', available: false })),
    addComputerFolder: t.mock.fn(async () => ({ folders: [music] })),
    removeComputerFolder: t.mock.fn(async () => ({ folders: [] })),
    ...overrides,
  };
  return { doc, host, deps };
}

async function mount(t, overrides) {
  const ui = setup(t, overrides);
  const session = mountComputerFolders(ui.host, ui.deps);
  t.after(session.destroy);
  await settle();
  return { ...ui, ...session };
}

function pressKey(form, key) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
  // The fake DOM has no default action for Enter in a text box.
  if (form.dispatchEvent(event) && key === 'Enter') {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
}

test('an empty list shows its count and one main Add folder button', async (t) => {
  const { host, deps } = await mount(t);
  const empty = byText(host, 'No folders added yet.');
  const add = byText(host, 'Add folder...');
  assert.equal(deps.listComputerFolders.mock.callCount(), 1);
  assert.ok(visible(byText(host, 'Folders (0)')));
  assert.ok(visible(empty));
  assert.equal(add.parentElement, empty.parentElement);
  assert.equal(host.descendants().filter((node) => node.textContent === 'Add folder...').length, 1);
  assert.equal(byTag(host, 'UL').children.length, 0);
});

test('saved folders show the full path and the unavailable folder has a status', async (t) => {
  const longPath = folder('long', `D:\\Music\\${'Samples and recordings\\'.repeat(20)}<new>`);
  const { host } = await mount(t, {
    listComputerFolders: async () => ({ folders: [longPath, videos] }),
  });
  assert.ok(visible(byText(host, 'Folders (2)')));
  assert.equal(visible(byText(host, 'No folders added yet.')), false);
  const [first, second] = byTag(host, 'UL').children;
  assert.equal(byText(first, longPath.path).title, longPath.path);
  assert.equal(byText(second, videos.path).title, videos.path);
  assert.equal(byText(first, 'Not connected').getAttribute('aria-hidden'), 'true');
  assert.equal(byText(second, 'Not connected').getAttribute('aria-hidden'), null);
  assert.equal(byText(first, 'Locate...'), undefined);
  const locate = byText(second, 'Locate...');
  assert.equal(locate.tagName, 'BUTTON');
  assert.equal(locate.type, 'button');
  assert.equal(second.children.at(-2), locate);
  assert.equal(second.children.at(-1), removeOf(second, videos));
  assert.equal(removeOf(second, videos).textContent, 'Remove');
  assert.equal(removeOf(second, videos).title, 'Stop showing this folder. Files are not deleted.');
});

test('the native picker adds its chosen path and refreshes from the mutation response', async (t) => {
  const pick = t.mock.fn(async () => ({ path: music.path, available: true }));
  const { host, doc, deps } = await mount(t, { pickComputerFolder: pick });
  const add = byText(host, 'Add folder...');
  click(add);
  await settle();
  assert.equal(pick.mock.callCount(), 1);
  assert.equal(deps.addComputerFolder.mock.calls[0].arguments[0], music.path);
  assert.equal(deps.listComputerFolders.mock.callCount(), 1);
  assert.ok(visible(byText(host, 'Folders (1)')));
  assert.ok(visible(byText(host, music.path)));
  assert.equal(visible(byTag(host, 'FORM')), false);
  assert.equal(doc.activeElement, add);
});

test('Locate shows the row as busy and refreshes the list after the new folder is found', async (t) => {
  const selected = Promise.withResolvers();
  const relocated = Promise.withResolvers();
  const updated = folder(videos.id, 'E:\\Videos');
  const pick = t.mock.fn(() => selected.promise);
  const relocate = t.mock.fn(() => relocated.promise);
  const changed = t.mock.fn();
  const { host, doc } = await mount(t, {
    initialFolders: [music, videos], pickComputerFolder: pick, relocateComputerFolder: relocate,
    onFoldersChanged: changed,
  });
  const locate = byText(host, 'Locate...');
  const row = locate.parentElement;
  locate.focus();
  assert.equal(doc.activeElement, locate);
  click(locate);
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.ok(byText(row, 'Locating...'));
  assert.equal(locate.disabled, true);
  assert.equal(removeOf(row, videos).disabled, true);
  click(locate);
  assert.equal(pick.mock.callCount(), 1);

  selected.resolve({ path: updated.path, available: true });
  await settle();
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.deepEqual(relocate.mock.calls[0].arguments.slice(0, 2), [videos.id, updated.path]);
  relocated.resolve({ folder: updated, folders: [music, updated] });
  await settle();
  assert.deepEqual(changed.mock.calls[0].arguments, [[music, updated]]);
  assert.ok(byText(host, updated.path));
  assert.equal(byText(host, 'Locate...'), undefined);
  assert.equal(doc.activeElement, removeOf(host, updated));
  assert.equal(doc.activeElement.disabled, false);
  assert.equal(alertOf(host).textContent, '');
});

test('Locate reports a mismatch in the folder alert and ignores picker cancellation', async (t) => {
  const message = 'That folder does not look like the same collection.';
  const pick = t.mock.fn(async () => ({ path: '', available: true }));
  pick.mock.mockImplementationOnce(async () => ({ path: music.path, available: true }));
  const relocate = t.mock.fn(async () => {
    throw new ControlApiError('COMPUTER_FOLDER_MISMATCH', message, 409);
  });
  const changed = t.mock.fn();
  const { host, doc } = await mount(t, {
    initialFolders: [videos], pickComputerFolder: pick, relocateComputerFolder: relocate,
    onFoldersChanged: changed,
  });
  const locate = byText(host, 'Locate...');
  click(locate);
  await settle();
  assert.equal(alertOf(host).textContent, message);
  assert.equal(locate.parentElement.getAttribute('aria-busy'), null);
  assert.ok(byText(locate.parentElement, 'Not connected'));
  assert.equal(doc.activeElement, locate);
  assert.equal(locate.disabled, false);
  click(locate);
  await settle();
  assert.equal(relocate.mock.callCount(), 1);
  assert.equal(changed.mock.callCount(), 0);
  assert.equal(alertOf(host).textContent, message);
  assert.equal(doc.activeElement, locate);
});

test('cancelling the native picker does not add or change the list or show a message', async (t) => {
  const { host, doc, deps } = await mount(t, {
    pickComputerFolder: async () => ({ path: '', available: true }),
  });
  const add = byText(host, 'Add folder...');
  click(add);
  await settle();
  assert.equal(deps.addComputerFolder.mock.callCount(), 0);
  assert.equal(deps.listComputerFolders.mock.callCount(), 1);
  assert.ok(visible(byText(host, 'No folders added yet.')));
  assert.equal(visible(byTag(host, 'FORM')), false);
  assert.equal(alertOf(host).textContent, '');
  assert.equal(doc.activeElement, add);
});

test('a failed native picker announces the failure and focuses the manual path box', async (t) => {
  const { host, doc, deps } = await mount(t, {
    pickComputerFolder: async () => ({ path: '', available: true, failed: true }),
  });
  click(byText(host, 'Add folder...'));
  await settle();
  const form = byTag(host, 'FORM');
  const input = byTag(form, 'INPUT');
  assert.ok(visible(form));
  assert.equal(doc.activeElement, input);
  assert.equal(alertOf(host).textContent, 'The folder window could not be opened. Type the folder path instead.');
  assert.equal(deps.addComputerFolder.mock.callCount(), 0);

  input.value = music.path;
  pressKey(form, 'Enter');
  await settle();
  assert.equal(deps.addComputerFolder.mock.calls[0].arguments[0], music.path);
  assert.equal(alertOf(host).textContent, '');
  assert.equal(visible(form), false);
});

test('without the native bridge, Escape and Cancel close the path box and Enter adds', async (t) => {
  const { host, doc, deps } = await mount(t);
  const add = byText(host, 'Add folder...');
  const form = byTag(host, 'FORM');
  const input = byTag(form, 'INPUT');
  click(add);
  await settle();
  assert.ok(visible(form));
  assert.equal(input.parentElement.tagName, 'LABEL');
  assert.equal(byText(input.parentElement, 'Folder path').tagName, 'SPAN');
  assert.equal(doc.activeElement, input);

  input.value = videos.path;
  pressKey(form, 'Escape');
  assert.equal(visible(form), false);
  assert.equal(doc.activeElement, add);
  assert.equal(deps.addComputerFolder.mock.callCount(), 0);

  click(add);
  await settle();
  assert.equal(input.value, '');
  click(byText(form, 'Cancel'));
  assert.equal(visible(form), false);
  assert.equal(doc.activeElement, add);

  click(add);
  await settle();
  assert.equal(byText(form, 'Add').type, 'submit');
  input.value = music.path;
  pressKey(form, 'Enter');
  await settle();
  assert.equal(deps.addComputerFolder.mock.callCount(), 1);
  assert.equal(deps.addComputerFolder.mock.calls[0].arguments[0], music.path);
  assert.equal(visible(form), false);
  assert.equal(doc.activeElement, add);
  assert.ok(visible(byText(host, music.path)));
});

test('a refused add announces the server reason and a successful add clears the alert', async (t) => {
  const refused = 'That folder was not found.';
  const badPath = 'D:\\Missing';
  const addFolder = t.mock.fn(async (path) => {
    if (path === badPath) throw new ControlApiError('INVALID_COMPUTER_FOLDER', refused, 400);
    return { folders: [music] };
  });
  const { host, doc } = await mount(t, { addComputerFolder: addFolder });
  const add = byText(host, 'Add folder...');
  click(add);
  await settle();
  const form = byTag(host, 'FORM');
  const input = byTag(form, 'INPUT');
  input.value = badPath;
  pressKey(form, 'Enter');
  await settle();
  const alert = alertOf(host);
  assert.ok(visible(alert));
  assert.equal(alert.textContent, refused);
  assert.equal(host.children[1], alert, 'the alert follows the header');
  assert.ok(visible(form));
  assert.equal(input.value, badPath);
  assert.equal(doc.activeElement, input);

  input.value = music.path;
  pressKey(form, 'Enter');
  await settle();
  assert.equal(alert.textContent, '');
  assert.equal(visible(form), false);
  assert.equal(doc.activeElement, add);
});

test('a second click cannot add twice and other request buttons are disabled while busy', async (t) => {
  const chosen = Promise.withResolvers();
  const added = Promise.withResolvers();
  const pick = t.mock.fn(() => chosen.promise);
  const addFolder = t.mock.fn(() => added.promise);
  const { host, deps } = await mount(t, {
    listComputerFolders: async () => ({ folders: [videos] }),
    pickComputerFolder: pick,
    addComputerFolder: addFolder,
  });
  const add = byText(host, 'Add folder...');
  const remove = removeOf(host, videos);
  click(add);
  assert.equal(add.disabled, true);
  assert.equal(remove.disabled, true);
  click(add);
  click(remove);
  assert.equal(pick.mock.callCount(), 1);
  assert.equal(deps.removeComputerFolder.mock.callCount(), 0);

  chosen.resolve({ path: music.path, available: true });
  await settle();
  assert.equal(add.disabled, true);
  click(add);
  assert.equal(addFolder.mock.callCount(), 1);
  added.resolve({ folders: [videos, music] });
  await settle();
  assert.equal(add.disabled, false);
  assert.equal(removeOf(host, videos).disabled, false);
  assert.equal(addFolder.mock.callCount(), 1);
});

test('removing acts immediately and focuses the next Remove or Add folder', async (t) => {
  const removeFolder = t.mock.fn(async (id) => ({ folders: id === music.id ? [videos] : [] }));
  const { host, doc } = await mount(t, {
    listComputerFolders: async () => ({ folders: [music, videos] }),
    removeComputerFolder: removeFolder,
  });
  click(removeOf(host, music));
  assert.equal(removeFolder.mock.calls[0].arguments[0], music.id);
  await settle();
  assert.equal(removeOf(host, music), undefined);
  assert.equal(doc.activeElement, removeOf(host, videos));
  assert.ok(visible(byText(host, 'Folders (1)')));

  click(removeOf(host, videos));
  assert.equal(removeFolder.mock.calls[1].arguments[0], videos.id);
  await settle();
  assert.ok(visible(byText(host, 'No folders added yet.')));
  assert.equal(doc.activeElement, byText(host, 'Add folder...'));
});

test('a failed load shows Try again and a successful retry restores the list', async (t) => {
  const retried = Promise.withResolvers();
  const list = t.mock.fn(() => retried.promise);
  list.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  const { host, doc } = await mount(t, { listComputerFolders: list });
  assert.equal(alertOf(host).textContent, 'The folder list could not be loaded.');
  assert.equal(visible(byText(host, 'No folders added yet.')), false);
  const retry = byText(host, 'Try again');
  assert.ok(visible(retry));
  click(retry);
  assert.equal(retry.disabled, true);
  assert.equal(byText(host, 'Add folder...').disabled, true);
  click(retry);
  assert.equal(list.mock.callCount(), 2);
  retried.resolve({ folders: [videos] });
  await settle();
  assert.equal(visible(retry), false);
  assert.equal(alertOf(host).textContent, '');
  assert.ok(visible(byText(host, videos.path)));
  assert.equal(doc.activeElement, byText(host, 'Add folder...'));
});

test('destroy clears the host and ignores a late list answer', async (t) => {
  const loaded = Promise.withResolvers();
  const list = t.mock.fn(() => loaded.promise);
  const { host, deps } = setup(t, { listComputerFolders: list });
  const session = mountComputerFolders(host, deps);
  const heading = byText(host, 'Folders');
  session.destroy();
  assert.equal(list.mock.calls[0].arguments[0].signal.aborted, true);
  loaded.resolve({ folders: [music] });
  await settle();
  assert.equal(host.children.length, 0);
  assert.equal(heading.textContent, 'Folders');
  await session.refresh();
  assert.equal(list.mock.callCount(), 1);
});

test('a native picker answer after destroy cannot start an add', async (t) => {
  const chosen = Promise.withResolvers();
  const { host, deps, doc, destroy } = await mount(t, { pickComputerFolder: () => chosen.promise });
  click(byText(host, 'Add folder...'));
  destroy();
  chosen.resolve({ path: music.path, available: true });
  await settle();
  assert.equal(deps.addComputerFolder.mock.callCount(), 0);
  assert.equal(host.children.length, 0);
  assert.equal(doc.activeElement, null);
});

test('leaving Computer tears down the tab and reopening loads the list once', async (t) => {
  const loaded = Promise.withResolvers();
  const list = t.mock.fn(async () => ({ folders: [videos] }));
  list.mock.mockImplementationOnce(() => loaded.promise);
  const { host, deps } = setup(t, { listComputerFolders: list });
  t.after(() => setMode('library'));

  setMode('computer');
  renderComputer(host, deps);
  const [root] = host.children;
  assert.equal(root.className, 'computer-root');
  assert.equal(list.mock.callCount(), 1);
  setMode('computer');
  assert.equal(host.children[0], root);
  setMode('tuner');
  assert.equal(host.children.length, 0);
  assert.equal(list.mock.calls[0].arguments[0].signal.aborted, true);

  setMode('computer');
  renderComputer(host, deps);
  loaded.resolve({ folders: [music] });
  await settle();
  assert.equal(list.mock.callCount(), 2);
  assert.ok(visible(byText(host, videos.path)));
  assert.equal(byText(host, music.path), undefined);
  assert.equal(byText(root, music.path), undefined);
});
