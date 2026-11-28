import { computerItemId, fileName } from '../lib/computer-catalog.js';
import { makeComputerItem } from '../lib/computer-play.js';
import { addFavorite, addFavorites, isFavorite, removeFavorite, removeFavorites, withComputerStars } from '../lib/state.js';

const shortcuts = new WeakMap();
const starIcon = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 2 14.81 8.63 22 9.24l-5.46 4.73L18.18 21 12 17.27 5.82 21l1.64-7.03L2 9.24l7.19-.61Z"/></svg>';

function star(doc, title, pressed, toggle, owner) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'card-star computer-star';
  button.title = owner ? 'Favorite (F)' : 'Favorite';
  button.innerHTML = starIcon;
  function sync(nextTitle = title) {
    const titleChanged = nextTitle !== title;
    title = nextTitle;
    const active = pressed();
    const value = String(active);
    if (!titleChanged && button.getAttribute('aria-pressed') === value) return;
    button.classList.toggle('is-fav', active);
    button.setAttribute('aria-pressed', value);
    button.setAttribute('aria-label', active ? `Remove ${title} from favorites` : `Add ${title} to favorites`);
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  button.addEventListener('dblclick', (event) => event.stopPropagation());
  if (owner) {
    shortcuts.set(owner, toggle);
    shortcuts.set(button, toggle);
    button.setAttribute('aria-keyshortcuts', 'F');
  }
  sync();
  return { button, sync };
}

export function computerFileStar(owner, entry, title = entry.title || fileName(entry)) {
  let id = computerItemId(entry);
  const control = star(owner.ownerDocument, title, () => isFavorite(id), () => {
    const selected = entry;
    const selectedId = id;
    return withComputerStars(() => {
      if (isFavorite(selectedId)) removeFavorite(selectedId);
      else addFavorite(makeComputerItem(selected));
    });
  }, owner);
  return {
    ...control,
    update(next, label = next.title || fileName(next)) {
      if (next === entry && label === title) return;
      entry = next;
      title = label;
      id = computerItemId(next);
      control.sync(label);
    },
  };
}

export function computerGroupStar(doc, entries, label) {
  const ids = entries.map(computerItemId);
  const pressed = () => ids.every(isFavorite);
  return star(doc, label, pressed, () => withComputerStars(() => {
    if (pressed()) removeFavorites(ids);
    else addFavorites(entries.map(makeComputerItem), { allOrNothing: true });
  }));
}

export function toggleFocusedComputerFavorite(target) {
  const toggle = shortcuts.get(target);
  if (!toggle) return false;
  toggle();
  return true;
}
