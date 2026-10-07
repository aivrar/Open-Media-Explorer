// Persistent, accessible warnings: never report a failed save as success.
const warnings = new Map();
let notice = null;

function render() {
  if (!notice) return;
  notice.textContent = [...warnings.values()].join(' ');
  notice.hidden = warnings.size === 0;
}

export function reportPersistenceFailure(key, message) {
  warnings.set(key, message);
  render();
}

export function clearPersistenceFailure(key) {
  warnings.delete(key);
  render();
}

export function getPersistenceWarnings() { return [...warnings.values()]; }

export function initPersistenceNotice(documentImpl = globalThis.document) {
  if (notice || !documentImpl?.body) return;
  notice = documentImpl.createElement('div');
  notice.className = 'persistence-notice';
  notice.setAttribute('role', 'alert');
  notice.setAttribute('aria-live', 'assertive');
  documentImpl.body.appendChild(notice);
  render();
}
