import {
  addComputerFolder, listComputerFolders, pickComputerFolder, relocateComputerFolder, removeComputerFolder,
} from '../lib/computer-client.js';

export function mountComputerFolders(host, {
  doc = host.ownerDocument,
  initialFolders,
  onFoldersChanged,
  listComputerFolders: listFolders = listComputerFolders,
  addComputerFolder: addFolder = addComputerFolder,
  removeComputerFolder: removeFolder = removeComputerFolder,
  relocateComputerFolder: relocateFolder = relocateComputerFolder,
  pickComputerFolder: pickFolder = pickComputerFolder,
} = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  const options = { signal };
  let busy = false;
  let locatingId;
  let rowControls = [];
  let displayedFolders;

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text, className = 'btn') {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }

  const header = element('div', 'row computer-folders-header');
  const heading = element('h3', '', 'Folders');
  const addButton = button('Add folder...', 'btn btn-primary computer-folder-add');
  header.append(heading, addButton);

  const alert = element('div', 'computer-folders-alert');
  alert.setAttribute('role', 'alert');
  const loading = element('div', 'computer-folders-loading', 'Loading folders...');
  loading.setAttribute('role', 'status');
  const retry = button('Try again');
  retry.hidden = true;
  retry.addEventListener('click', () => refresh(true));

  const form = element('form', 'computer-folder-form');
  form.hidden = true;
  const label = element('label', 'computer-folder-field');
  const input = element('input', 'computer-folder-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  label.append(element('span', '', 'Folder path'), input);
  const submit = button('Add', 'btn btn-primary');
  submit.type = 'submit';
  const cancel = button('Cancel');
  form.append(label, submit, cancel);

  const empty = element('div', 'computer-folders-empty');
  empty.hidden = true;
  empty.append(element('div', '', 'No folders added yet.'));
  const list = element('ul', 'computer-folder-list');
  host.replaceChildren(header, alert, form, loading, retry, empty, list);

  function syncControls() {
    for (const control of [addButton, retry, submit, cancel]) control.disabled = busy;
    for (const { id, row, status, remove, locate } of rowControls) {
      remove.disabled = busy;
      if (!locate) continue;
      locate.disabled = busy;
      const locating = id === locatingId;
      if (locating) row.setAttribute('aria-busy', 'true');
      else row.removeAttribute('aria-busy');
      status.textContent = locating ? 'Locating...' : 'Not connected';
    }
    input.readOnly = busy;
  }

  async function run(request, onSuccess, onError) {
    if (busy || signal.aborted) return;
    busy = true;
    syncControls();
    let focus;
    try {
      const data = await request();
      if (!signal.aborted) focus = onSuccess(data);
    } catch (error) {
      if (!signal.aborted) focus = onError(error);
    } finally {
      if (!signal.aborted) {
        busy = false;
        locatingId = undefined;
        syncControls();
        focus?.focus();
      }
    }
  }

  function locateFocus(id) {
    const controls = rowControls.find((entry) => entry.id === id);
    return controls?.locate || controls?.remove || addButton;
  }

  function showFolders({ folders }) {
    const previous = displayedFolders;
    if (previous?.length === folders.length && previous.every((folder, index) => (
      folder.id === folders[index].id && folder.path === folders[index].path
        && folder.available === folders[index].available
    ))) return;
    displayedFolders = folders;
    rowControls = [];
    const rows = folders.map(({ id, path, available }, index) => {
      const row = element('li', 'row computer-folder-row');
      const pathText = element('div', 'computer-folder-path', path);
      pathText.title = path;
      const status = element('span', 'computer-folder-status', 'Not connected');
      if (available !== false) status.setAttribute('aria-hidden', 'true');

      const remove = button('Remove');
      remove.setAttribute('aria-label', `Remove ${path}`);
      remove.title = 'Stop showing this folder. Files are not deleted.';
      remove.addEventListener('click', () => run(
        () => removeFolder(id, options),
        (data) => {
          applyChange(data);
          return rowControls[index]?.remove || addButton;
        },
        (error) => showError(error, 'The folder could not be removed.', remove),
      ));
      row.append(pathText, status);
      let locate;
      if (available === false) {
        locate = button('Locate...');
        locate.setAttribute('aria-label', `Locate ${path}`);
        locate.addEventListener('click', () => run(
          async () => {
            locatingId = id;
            syncControls();
            const picked = await pickFolder();
            if (signal.aborted) return;
            if (!picked.available || picked.failed) throw new Error('The folder window could not be opened.');
            if (picked.path) return relocateFolder(id, picked.path, options);
          },
          (data) => {
            if (data) applyChange(data);
            return locateFocus(id);
          },
          (error) => showError(error, 'The folder could not be located.', locateFocus(id)),
        ));
        row.append(locate);
      }
      row.append(remove);
      rowControls.push({ id, row, status, remove, locate });
      return row;
    });
    list.replaceChildren(...rows);
    syncControls();

    heading.textContent = `Folders (${folders.length})`;
    loading.hidden = true;
    retry.hidden = true;
    alert.textContent = '';
    const hasFolders = folders.length > 0;
    if (empty.hidden !== hasFolders) {
      empty.hidden = hasFolders;
      (hasFolders ? header : empty).appendChild(addButton);
    }
  }

  function applyChange(data) {
    alert.textContent = '';
    showFolders(data);
    onFoldersChanged?.(data.folders);
  }

  function showError(error, fallback, focus) {
    alert.textContent = error?.message || fallback;
    return focus;
  }

  function refresh(restoreFocus = false) {
    const previous = displayedFolders;
    return run(
      () => listFolders(options),
      (data) => {
        if (previous === displayedFolders) showFolders(data);
        if (restoreFocus) return form.hidden ? addButton : input;
      },
      () => {
        if (previous !== displayedFolders) return;
        loading.hidden = true;
        retry.hidden = false;
        alert.textContent = 'The folder list could not be loaded.';
        if (restoreFocus) return retry;
      },
    );
  }

  function closeForm() {
    form.hidden = true;
    input.value = '';
    return addButton;
  }

  function cancelEntry() {
    if (!busy && !signal.aborted) {
      alert.textContent = '';
      closeForm().focus();
    }
  }

  addButton.addEventListener('click', () => {
    if (busy || signal.aborted) return;
    if (!form.hidden) {
      input.focus();
      return;
    }
    return run(
      async () => {
        const picked = await pickFolder();
        if (signal.aborted || !picked.available || picked.failed || !picked.path) return picked;
        return { data: await addFolder(picked.path, options) };
      },
      ({ data, available, failed }) => {
        if (data) applyChange(data);
        if (available === false || failed) {
          if (failed) alert.textContent = 'The folder window could not be opened. Type the folder path instead.';
          form.hidden = false;
          return input;
        }
        return addButton;
      },
      (error) => showError(error, 'The folder could not be added.', addButton),
    );
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const path = input.value;
    if (!path.trim()) return;
    return run(
      () => addFolder(path, options),
      (data) => {
        applyChange(data);
        return closeForm();
      },
      (error) => showError(error, 'The folder could not be added.', input),
    );
  });
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    cancelEntry();
  });
  cancel.addEventListener('click', cancelEntry);

  if (initialFolders) showFolders({ folders: initialFolders });
  else refresh();
  return {
    refresh,
    setFolders(folders) { if (!signal.aborted) showFolders({ folders }); },
    destroy() {
      if (signal.aborted) return;
      controller.abort();
      host.replaceChildren();
    },
  };
}
