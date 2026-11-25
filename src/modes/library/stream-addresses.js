import { MAX_BACKUP_STREAMS, stationStreamAddresses } from '../../lib/station-stream-addresses.js';
import { canEditStationStreams, saveStationStreams } from '../../lib/station-stream-edit.js';
import { subscribe } from '../../lib/state.js';
import { el } from './utils.js';

const FORM_ID = 'library-detail-stream-addresses';
const MAIN_ID = 'library-detail-main-stream-address';

function button(text, onClick, attrs = {}) {
  return el('button', { className: 'btn', text, attrs: { type: 'button', ...attrs }, on: { click: onClick } });
}

function addressInput(attrs) {
  return el('input', {
    className: 'detail-rename-input',
    attrs: { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: '4096', ...attrs },
  });
}

export function createStreamAddressEditor(item, { save = saveStationStreams, onSaved = () => {} } = {}) {
  const main = addressInput({ id: MAIN_ID });
  const list = el('div', { className: 'detail-backup-streams', attrs: { role: 'group', 'aria-label': 'Backup addresses' } });
  const message = el('p', { className: 'detail-rename-message', attrs: { role: 'alert' } });
  const saveButton = el('button', { className: 'btn btn-primary', text: 'Save', attrs: { type: 'submit' } });
  const restore = button('Restore original', () => {
    main.value = item.stream_url || '';
    main.focus();
  });
  const form = el('form', { className: 'detail-rename', attrs: { id: FORM_ID, 'aria-label': 'Stream addresses' } });
  let busy = null;
  let inputs = [];

  function close(focus = true) {
    busy?.abort();
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  }

  function readBackups() { return inputs.map((input) => input.value); }

  function renderBackups(values) {
    list.replaceChildren();
    inputs = values.map((value, index) => {
      const number = index + 1;
      const input = addressInput({ 'aria-label': `Backup address ${number}` });
      input.value = value;
      const move = (offset) => {
        const next = readBackups();
        const target = index + offset;
        [next[index], next[target]] = [next[target], next[index]];
        renderBackups(next);
        inputs[target].focus();
      };
      const up = button('\u2191', () => move(-1), { 'aria-label': `Move backup ${number} up`, title: 'Move up' });
      const down = button('\u2193', () => move(1), { 'aria-label': `Move backup ${number} down`, title: 'Move down' });
      const remove = button('Remove', () => {
        const next = readBackups();
        next.splice(index, 1);
        renderBackups(next);
        (inputs[index] || inputs[index - 1] || add).focus();
      }, { 'aria-label': `Remove backup ${number}`, title: 'Remove backup' });
      up.disabled = index === 0;
      down.disabled = number === values.length;
      const controls = el('div', { className: 'detail-backup-controls' }, up, down, remove);
      list.appendChild(el('div', { className: 'detail-rename-row' }, input, controls));
      return input;
    });
    add.disabled = values.length >= MAX_BACKUP_STREAMS;
  }

  const add = button('Add backup', () => {
    renderBackups([...readBackups(), '']);
    inputs.at(-1).focus();
  });
  const toggle = button('Stream address...', () => {
    if (!form.hidden) { close(); return; }
    const { main: savedMain, backups } = stationStreamAddresses(item);
    main.value = savedMain || item.stream_url || '';
    restore.hidden = !savedMain;
    renderBackups(backups);
    message.hidden = true;
    form.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    main.focus();
  }, { 'aria-expanded': 'false', 'aria-controls': FORM_ID });
  form.hidden = true;
  const fields = el('fieldset', { className: 'detail-stream-fields' },
    el('label', { className: 'detail-rename-label', text: 'Main address', attrs: { for: MAIN_ID } }),
    main, el('span', { className: 'detail-rename-label', text: 'Backup addresses' }), list,
    el('div', { className: 'detail-rename-row' }, add));
  form.appendChild(fields);
  form.appendChild(message);
  form.appendChild(el('div', { className: 'detail-rename-row' }, saveButton, button('Cancel', () => close()), restore));
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    busy = controller;
    fields.disabled = saveButton.disabled = restore.disabled = true;
    message.hidden = true;
    try {
      const changed = await save(item, { main: main.value, backups: readBackups() }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      busy = null;
      if (changed) onSaved();
      close();
    } catch (error) {
      if (controller.signal.aborted) return;
      message.textContent = error.message || 'Could not save the stream addresses.';
      message.hidden = false;
    } finally {
      busy = null;
      fields.disabled = saveButton.disabled = restore.disabled = false;
      if (!form.hidden) main.focus();
    }
  });
  const update = () => {
    toggle.hidden = !canEditStationStreams(item);
    if (toggle.hidden && !form.hidden) close(false);
  };
  const stops = [subscribe('favorites-change', update), subscribe('playlists-change', update)];
  update();
  return {
    button: toggle,
    form,
    destroy() {
      close(false);
      for (const stop of stops) stop();
    },
  };
}
