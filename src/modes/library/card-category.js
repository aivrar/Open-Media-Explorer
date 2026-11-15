/**
 * The small category button on each Favorites card and the menu it opens:
 * every category (the current one marked), "None", and "New category..."
 * (which makes a category and puts the favorite in it in one step).
 *
 * The menu lives at the end of the page body, not inside the card, so the
 * card's clipping (overflow, content-visibility) cannot cut it off; it is
 * placed next to the button and kept inside the window. It works from the
 * keyboard (arrow keys, Home, End, Escape), closes on a click elsewhere, and
 * never reaches the card's own click, which opens and plays the item. Like a
 * standard menu it closes whenever focus leaves it: Tab and Shift+Tab (from
 * anywhere in it, the new-category form too) close it and focus moves on
 * from its button as it would have without the menu.
 *
 * Category names are the user's own text: textContent and attributes only.
 */

import {
  assignFavoriteToGroup, createFavoriteGroup, favoriteGroupsSnapshot, MAX_FAVORITE_GROUPS,
} from '../../lib/favorite-groups.js';
import { el } from './utils.js';
import { ui } from './shell-refs.js';

// A tag outline; fixed markup, never built from data.
const TAG_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.6"/></svg>';

const ITEM_ROLES = new Set(['menuitem', 'menuitemradio']);

let open = null; // { element, button, card, favoriteId, title, form, input, message, cleanup }

function itemOf(card, fallback) { return card?.__item || fallback; }

/** A Favorites card's category button. */
export function buildCategoryButton(card, item) {
  const button = el('button', {
    className: 'card-category',
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    html: TAG_ICON,
  });
  button.addEventListener('click', (event) => {
    event.stopPropagation?.();
    if (open?.button === button) { closeCategoryMenu(); return; }
    openCategoryMenu(button, card, itemOf(card, item));
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    openCategoryMenu(button, card, itemOf(card, item), { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
  });
  return button;
}

/** Name the button after the favorite and its category ("...: none"). */
export function updateCategoryButton(button, item, groups = favoriteGroupsSnapshot()) {
  const title = item?.title || 'Untitled';
  const name = groups.nameOf(groups.groupOf(item?.id));
  const label = `Category for ${title}: ${name || 'none'}`;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  const tip = name ? `Category: ${name}` : 'No category. Choose one';
  if (button.title !== tip) button.title = tip;
  button.classList.toggle('is-set', Boolean(name));
}

function menuItems() {
  if (!open) return [];
  return [...open.element.children].filter((node) => ITEM_ROLES.has(node.getAttribute?.('role'))
    && node.getAttribute('aria-disabled') !== 'true');
}

function focusItem(which) {
  const items = menuItems();
  if (items.length === 0) return;
  const active = globalThis.document?.activeElement;
  const index = items.indexOf(active);
  let next = 0;
  if (which === 'last') next = items.length - 1;
  else if (which === 'next') next = index < 0 ? 0 : (index + 1) % items.length;
  else if (which === 'previous') next = index <= 0 ? items.length - 1 : index - 1;
  else if (which === 'checked') next = Math.max(0, items.findIndex((node) => node.getAttribute('aria-checked') === 'true'));
  items[next].focus?.();
}

function showMessage(text) {
  if (!open) return;
  open.message.textContent = text;
  open.message.hidden = !text;
  if (open.input) {
    if (text) open.input.setAttribute('aria-invalid', 'true');
    else open.input.removeAttribute('aria-invalid');
  }
}

/** After a change the card may have left the view (a category filter is on):
 *  focus goes back to its button, or to the card now in its place. */
function restoreFocus(button, card, index) {
  if (button.isConnected !== false && button.parentNode) {
    button.focus?.();
    return;
  }
  const host = ui.resultsHost;
  const cards = host?.children ? [...host.children] : [];
  const near = cards[index] || cards[index - 1] || null;
  const target = near?.__categoryButton
    || [...(ui.categoryChips?.children || [])].find((node) => node.getAttribute?.('aria-pressed') === 'true')
    || null;
  target?.focus?.();
}

function finish(action) {
  if (!open) return;
  const { button, card } = open;
  const host = ui.resultsHost;
  const index = host?.children ? [...host.children].indexOf(card) : -1;
  const result = action();
  if (!result.ok) { showMessage(result.error); return; }
  closeCategoryMenu({ restoreFocus: false });
  restoreFocus(button, card, Math.max(0, index));
}

function choose(groupId) {
  const favoriteId = open?.favoriteId;
  finish(() => assignFavoriteToGroup(favoriteId, groupId));
}

function showNewForm() {
  if (!open || open.form) return;
  const favoriteId = open.favoriteId;
  const input = el('input', { className: 'category-menu-input', attrs: {
    type: 'text', maxlength: '120', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Category name', 'aria-label': 'Name of the new category',
  } });
  const add = el('button', { className: 'btn', text: 'Add', attrs: { type: 'submit' } });
  const cancel = el('button', { className: 'btn', text: 'Cancel', attrs: { type: 'button' } });
  const form = el('form', { className: 'category-menu-form', attrs: { 'aria-label': 'New category' } }, input, add, cancel);
  const hideForm = () => {
    // Focus moves first, so it never drops out of the menu with the form.
    open.newItem?.focus?.();
    form.remove();
    open.form = null;
    open.input = null;
    showMessage('');
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    finish(() => createFavoriteGroup(input.value, { assign: favoriteId }));
  });
  cancel.addEventListener('click', () => hideForm());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    hideForm();
  });
  open.form = form;
  open.input = input;
  open.hideForm = hideForm;
  if (typeof open.element.insertBefore === 'function') open.element.insertBefore(form, open.message);
  else open.element.appendChild(form);
  input.focus?.();
}

function menuEntry(role, text, { checked = null, disabled = false, title = '', onChoose }) {
  const node = el('button', {
    className: 'category-menu-item',
    attrs: { type: 'button', role, tabindex: '-1', ...(title ? { title } : {}) },
  }, el('span', { className: 'category-menu-name', text }));
  if (checked != null) node.setAttribute('aria-checked', checked ? 'true' : 'false');
  if (disabled) node.setAttribute('aria-disabled', 'true');
  node.addEventListener('click', (event) => {
    event.stopPropagation?.();
    if (node.getAttribute('aria-disabled') === 'true') return;
    onChoose();
  });
  return node;
}

/** Where the menu goes: below the button, right edges lined up; above it
 *  when there is no room below; always at least 8px inside the window. */
export function menuPosition(anchor, menu, viewport) {
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.right - menu.width, viewport.width - menu.width - margin));
  let top = anchor.bottom + 4;
  if (top + menu.height > viewport.height - margin) {
    const above = anchor.top - menu.height - 4;
    top = above >= margin ? above : Math.max(margin, viewport.height - menu.height - margin);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

function place(element, anchor) {
  const rect = anchor.getBoundingClientRect?.();
  if (!rect || !element.style) return;
  const doc = globalThis.document?.documentElement;
  const { left, top } = menuPosition(rect, {
    width: element.offsetWidth || 0, height: element.offsetHeight || 0,
  }, {
    width: Number(globalThis.innerWidth) || doc?.clientWidth || 0,
    height: Number(globalThis.innerHeight) || doc?.clientHeight || 0,
  });
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function onMenuKeydown(event) {
  if (!open) return;
  const inForm = Boolean(open.form) && event.target?.closest?.('form') === open.form;
  if (event.key === 'Escape') {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (inForm) open.hideForm?.();
    else closeCategoryMenu();
    return;
  }
  if (event.key === 'Tab') {
    // Not prevented: focus goes to the button first and the browser's own
    // Tab (or Shift+Tab) then moves on from there, past the closed menu.
    const { button } = open;
    button.focus?.();
    closeCategoryMenu({ restoreFocus: false });
    return;
  }
  if (inForm) return;
  const moves = { ArrowDown: 'next', ArrowUp: 'previous', Home: 'first', End: 'last' };
  if (!moves[event.key]) return;
  event.preventDefault?.();
  focusItem(moves[event.key]);
}

/** Open the menu for one card's favorite. */
export function openCategoryMenu(button, card, item, { focus = 'checked' } = {}) {
  closeCategoryMenu({ restoreFocus: false });
  const doc = globalThis.document;
  if (!doc?.body || !item?.id) return false;
  const groups = favoriteGroupsSnapshot();
  const currentId = groups.groupOf(item.id);
  const title = item.title || 'Untitled';
  const element = el('div', {
    className: 'category-menu',
    // Focusable (not in the Tab order) so a click on its blank parts keeps
    // focus inside it rather than dropping it to the page.
    attrs: { role: 'menu', 'aria-label': `Category for ${title}`, tabindex: '-1' },
  });
  open = { element, button, card, favoriteId: item.id, title, form: null, input: null, message: null, newItem: null };
  for (const group of groups.groups) {
    element.appendChild(menuEntry('menuitemradio', group.name, {
      checked: group.id === currentId, title: group.name, onChoose: () => choose(group.id),
    }));
  }
  element.appendChild(menuEntry('menuitemradio', 'None', { checked: !groups.has(currentId), onChoose: () => choose('') }));
  element.appendChild(el('div', { className: 'category-menu-separator', attrs: { role: 'separator' } }));
  const full = groups.groups.length >= MAX_FAVORITE_GROUPS;
  open.newItem = menuEntry('menuitem', 'New category\u2026', {
    disabled: full || groups.locked,
    title: groups.locked ? 'Categories were saved by a newer version of World Media.'
      : full ? `You have ${MAX_FAVORITE_GROUPS} categories, the most there can be.` : '',
    onChoose: () => showNewForm(),
  });
  element.appendChild(open.newItem);
  open.message = el('div', { className: 'category-menu-message', attrs: { role: 'status', 'aria-live': 'polite' } });
  open.message.hidden = true;
  element.appendChild(open.message);
  element.addEventListener('keydown', onMenuKeydown);
  // Clicks inside the menu stay in the menu.
  element.addEventListener('click', (event) => event.stopPropagation?.());
  doc.body.appendChild(element);
  place(element, button);
  button.setAttribute('aria-expanded', 'true');

  const state = open;
  const onPointerDown = (event) => {
    const target = event.target;
    if (element.contains?.(target) || button.contains?.(target)) return;
    if (open === state) closeCategoryMenu({ restoreFocus: false });
  };
  const onViewportChange = (event) => {
    if (event?.type === 'scroll' && element.contains?.(event.target)) return;
    if (open === state) closeCategoryMenu({ restoreFocus: false });
  };
  // Focus never stays outside an open menu: when it leaves, the menu closes.
  // Focus that goes nowhere (relatedTarget null) is checked once it settles;
  // the window losing focus (another app) leaves the menu open.
  let focusTimer = null;
  const onFocusOut = (event) => {
    if (open !== state) return;
    const next = event.relatedTarget;
    if (next) {
      if (!element.contains?.(next)) closeCategoryMenu({ restoreFocus: false });
      return;
    }
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = null;
      if (open !== state || doc.hasFocus?.() === false) return;
      if (!element.contains?.(doc.activeElement)) closeCategoryMenu({ restoreFocus: false });
    }, 0);
  };
  element.addEventListener('focusout', onFocusOut);
  doc.addEventListener?.('pointerdown', onPointerDown, true);
  doc.addEventListener?.('scroll', onViewportChange, true);
  globalThis.addEventListener?.('resize', onViewportChange);
  state.cleanup = () => {
    clearTimeout(focusTimer);
    focusTimer = null;
    element.removeEventListener('focusout', onFocusOut);
    element.removeEventListener('keydown', onMenuKeydown);
    doc.removeEventListener?.('pointerdown', onPointerDown, true);
    doc.removeEventListener?.('scroll', onViewportChange, true);
    globalThis.removeEventListener?.('resize', onViewportChange);
  };
  focusItem(focus);
  return true;
}

/** Close the menu; by default focus goes back to the button that opened it. */
export function closeCategoryMenu({ restoreFocus: refocus = true } = {}) {
  if (!open) return false;
  const { element, button, cleanup } = open;
  open = null;
  cleanup?.();
  element.remove?.();
  button.setAttribute('aria-expanded', 'false');
  if (refocus) button.focus?.();
  return true;
}

/** Close the menu when its card is no longer on the page. */
export function closeDetachedCategoryMenu() {
  if (open && (open.button.isConnected === false || !open.button.parentNode)) closeCategoryMenu({ restoreFocus: false });
}

/** For tests: the open menu element, or null. */
export function openCategoryMenuElement() { return open?.element || null; }
