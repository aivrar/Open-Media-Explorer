/**
 * Small DOM helper shared across the library mode files. Lifted verbatim
 * out of the old monolithic library.js — same behaviour, just here so
 * everyone can import it without re-declaring.
 */

export function el(tag, opts = {}, ...children) {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  if (opts.style) Object.assign(e.style, opts.style);
  if (opts.text != null) e.textContent = opts.text;
  if (opts.html != null) e.innerHTML = opts.html;
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) e.addEventListener(k, v);
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

export function setDescriptionReference(button, id, enabled) {
  if (!button || !id) return;
  const ids = new Set((button.getAttribute('aria-describedby') || '').match(/\S+/g));
  if (ids.has(id) === enabled) return;
  if (enabled) ids.add(id);
  else ids.delete(id);
  if (ids.size) button.setAttribute('aria-describedby', [...ids].join(' '));
  else button.removeAttribute('aria-describedby');
}
