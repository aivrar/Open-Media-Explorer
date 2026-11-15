/**
 * The Favorites categories row: a second row of chips under the type and sort
 * buttons. "All categories", one chip per category (in the order they were
 * made, with how many favorites each holds), "Uncategorized" once there is a
 * category, and "+ New category". The chosen chip filters the Favorites view
 * together with the type buttons, the search box and both sort orders; it is
 * kept for the session in view.personalFilters.favorites.category.
 *
 * Category names are the user's own text: they are only ever set with
 * textContent and attributes, never as HTML.
 */

import {
  createFavoriteGroup, deleteFavoriteGroup, favoriteGroupCounts,
  favoriteGroupsSnapshot, MAX_FAVORITE_GROUPS, renameFavoriteGroup, UNCATEGORIZED,
} from '../../lib/favorite-groups.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';
import { view } from './state.js';
import { renderResults, renderStatus, updateSentinelStatus } from './render.js';

function refresh() { renderResults(); renderStatus(); updateSentinelStatus(); }

function filters() { return view.personalFilters.favorites; }

/** The chosen category: '' (all), a category id, or UNCATEGORIZED. */
export function selectedFavoriteCategory() { return filters()?.category || ''; }

function activeElement() { return globalThis.document?.activeElement || null; }

function plural(count) { return `${count} ${count === 1 ? 'favorite' : 'favorites'}`; }

// What the open form is for: null, { mode: 'create' } or { mode: 'rename', id }.
let formState = null;
let confirmImpl = (text) => globalThis.confirm(text);

/** Tests replace window.confirm through this. */
export function setCategoryConfirm(fn) { confirmImpl = typeof fn === 'function' ? fn : (text) => globalThis.confirm(text); }

function setStatus(text) {
  if (ui.categoryStatus) ui.categoryStatus.textContent = text;
}

function setFormMessage(text) {
  if (ui.categoryFormMessage) ui.categoryFormMessage.textContent = text;
  if (!ui.categoryInput) return;
  if (text) ui.categoryInput.setAttribute('aria-invalid', 'true');
  else ui.categoryInput.removeAttribute('aria-invalid');
}

function chooseCategory(value) {
  if (selectedFavoriteCategory() === value) return;
  filters().category = value;
  syncFavoriteCategories();
  refresh();
}

function chip(value, name, count, selected) {
  const counted = count != null;
  const button = el('button', {
    className: `chip category-chip${selected ? ' is-active' : ''}`,
    attrs: {
      type: 'button',
      'data-category': value,
      'aria-pressed': selected ? 'true' : 'false',
      title: counted ? `${name} (${plural(count)})` : name,
      ...(counted ? { 'aria-label': `${name}, ${plural(count)}` } : {}),
    },
    on: { click: () => chooseCategory(value) },
  }, el('span', { className: 'category-chip-name', text: name }));
  if (counted) button.appendChild(el('span', { className: 'category-chip-count', text: String(count), attrs: { 'aria-hidden': 'true' } }));
  return button;
}

function openForm(mode, group = null) {
  formState = mode === 'rename' ? { mode, id: group.id } : { mode: 'create' };
  const form = ui.categoryForm;
  form.hidden = false;
  ui.categoryInput.value = mode === 'rename' ? group.name : '';
  ui.categoryInput.setAttribute('aria-label', mode === 'rename' ? `New name for the category ${group.name}` : 'Name of the new category');
  ui.categorySubmit.textContent = mode === 'rename' ? 'Save' : 'Add';
  setFormMessage('');
  ui.categoryNew.setAttribute('aria-expanded', mode === 'create' ? 'true' : 'false');
  ui.categoryInput.focus?.();
  ui.categoryInput.select?.();
}

function closeForm({ restoreFocus = true } = {}) {
  const was = formState;
  formState = null;
  if (!ui.categoryForm) return;
  ui.categoryForm.hidden = true;
  setFormMessage('');
  ui.categoryNew.setAttribute('aria-expanded', 'false');
  if (!restoreFocus) return;
  const back = was?.mode === 'rename' && !ui.categoryRename.hidden ? ui.categoryRename : ui.categoryNew;
  back.focus?.();
}

function submitForm() {
  if (!formState) return;
  if (formState.mode === 'rename') {
    const before = favoriteGroupsSnapshot().nameOf(formState.id);
    const result = renameFavoriteGroup(formState.id, ui.categoryInput.value);
    if (!result.ok) { setFormMessage(result.error); return; }
    const after = favoriteGroupsSnapshot().nameOf(formState.id) || before;
    closeForm();
    setStatus(after === before ? 'The name was not changed.' : `Renamed "${before}" to "${after}".`);
    return;
  }
  const result = createFavoriteGroup(ui.categoryInput.value);
  if (!result.ok) { setFormMessage(result.error); return; }
  closeForm();
  setStatus(`Category "${result.group.name}" added. Use the category button on a favorite to put it there.`);
}

function onDelete() {
  const id = selectedFavoriteCategory();
  const groups = favoriteGroupsSnapshot();
  if (!groups.has(id)) return;
  const name = groups.nameOf(id);
  const count = favoriteGroupCounts().counts.get(id) || 0;
  const kept = count === 0
    ? 'Your favorites are not changed.'
    : `Its ${plural(count)} ${count === 1 ? 'stays' : 'stay'} in Favorites, without a category.`;
  if (!confirmImpl(`Delete the category "${name}"? ${kept}`)) return;
  const result = deleteFavoriteGroup(id);
  if (!result.ok) { setStatus(result.error); return; }
  // The Library listens for the change; make sure the view falls back now.
  syncFavoriteCategories();
  refresh();
  setStatus(`Category "${name}" deleted. Its favorites were kept.`);
  ui.categoryChips?.children?.[0]?.focus?.();
}

export function buildFavoriteCategories() {
  ui.categoryChips = el('div', {
    className: 'category-chips',
    attrs: { role: 'group', 'aria-label': 'Show favorites in a category' },
  });
  ui.categoryRename = el('button', { className: 'chip category-tool', text: 'Rename', attrs: { type: 'button' },
    on: { click: () => {
      const id = selectedFavoriteCategory();
      const groups = favoriteGroupsSnapshot();
      if (groups.has(id)) openForm('rename', { id, name: groups.nameOf(id) });
    } } });
  ui.categoryDelete = el('button', { className: 'chip category-tool', text: 'Delete', attrs: { type: 'button' },
    on: { click: onDelete } });
  ui.categoryNew = el('button', {
    className: 'chip category-new', text: '+ New category',
    attrs: { type: 'button', 'aria-expanded': 'false', title: 'Make a category, such as Rock or Talk' },
    on: { click: () => {
      if (formState?.mode === 'create') closeForm();
      else openForm('create');
    } },
  });
  ui.categoryInput = el('input', { className: 'chip category-input', attrs: {
    type: 'text', maxlength: '120', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Category name', 'aria-describedby': 'favorite-category-form-message',
  } });
  ui.categorySubmit = el('button', { className: 'btn', text: 'Add', attrs: { type: 'submit' } });
  const cancel = el('button', { className: 'btn', text: 'Cancel', attrs: { type: 'button' },
    on: { click: () => closeForm() } });
  ui.categoryFormMessage = el('span', { className: 'category-form-message', attrs: {
    id: 'favorite-category-form-message', role: 'status', 'aria-live': 'polite',
  } });
  ui.categoryForm = el('form', { className: 'category-form', attrs: { 'aria-label': 'Category name' } },
    ui.categoryInput, ui.categorySubmit, cancel, ui.categoryFormMessage);
  ui.categoryForm.hidden = true;
  ui.categoryForm.addEventListener('submit', (event) => { event.preventDefault?.(); submitForm(); });
  ui.categoryInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    closeForm();
  });
  ui.categoryStatus = el('span', { className: 'category-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const tools = el('div', { className: 'category-tools' },
    ui.categoryRename, ui.categoryDelete, ui.categoryNew, ui.categoryForm, ui.categoryStatus);
  ui.favoriteCategories = el('div', { className: 'favorite-categories' }, ui.categoryChips, tools);
  formState = null;
  syncFavoriteCategories();
  return ui.favoriteCategories;
}

/** Bring the row in line with the saved categories and the chosen one. A
 *  chosen category that was deleted falls back to "All categories" (and
 *  "Uncategorized" to it once no category is left). Rebuilds the chips only
 *  when something they show changed, and keeps focus on the same chip. */
export function syncFavoriteCategories() {
  if (!ui.favoriteCategories || !ui.categoryChips) return;
  const groups = favoriteGroupsSnapshot();
  const selected = selectedFavoriteCategory();
  if (filters() && selected && (selected === UNCATEGORIZED ? groups.groups.length === 0 : !groups.has(selected))) {
    filters().category = '';
  }
  const current = selectedFavoriteCategory();
  const { counts, none } = favoriteGroupCounts();
  const signature = JSON.stringify([groups.groups, [...counts], none, current]);
  if (ui.categoryChips.dataset.signature !== signature) {
    ui.categoryChips.dataset.signature = signature;
    const focused = activeElement();
    const focusedValue = focused && focused.parentNode === ui.categoryChips ? focused.getAttribute('data-category') : null;
    const chips = [chip('', 'All categories', null, current === '')];
    for (const group of groups.groups) chips.push(chip(group.id, group.name, counts.get(group.id) || 0, current === group.id));
    if (groups.groups.length > 0) chips.push(chip(UNCATEGORIZED, 'Uncategorized', none, current === UNCATEGORIZED));
    ui.categoryChips.replaceChildren(...chips);
    if (focusedValue != null) {
      const again = chips.find((node) => node.getAttribute('data-category') === focusedValue) || chips[0];
      again.focus?.({ preventScroll: true });
    }
  }
  const named = groups.has(current);
  const name = named ? groups.nameOf(current) : '';
  ui.categoryRename.hidden = !named;
  ui.categoryDelete.hidden = !named;
  if (named) {
    ui.categoryRename.setAttribute('aria-label', `Rename the category ${name}`);
    ui.categoryRename.title = `Rename "${name}"`;
    ui.categoryDelete.setAttribute('aria-label', `Delete the category ${name}`);
    ui.categoryDelete.title = `Delete "${name}" (its favorites are kept)`;
  }
  const full = groups.groups.length >= MAX_FAVORITE_GROUPS;
  ui.categoryNew.disabled = full || groups.locked;
  ui.categoryNew.title = groups.locked
    ? 'Categories were saved by a newer version of World Media.'
    : full ? `You have ${MAX_FAVORITE_GROUPS} categories, the most there can be.` : 'Make a category, such as Rock or Talk';
  // A rename form for a category that is gone has nothing left to do.
  if (formState?.mode === 'rename' && !groups.has(formState.id)) closeForm({ restoreFocus: false });
  if (formState?.mode === 'create' && ui.categoryNew.disabled) closeForm({ restoreFocus: false });
}
