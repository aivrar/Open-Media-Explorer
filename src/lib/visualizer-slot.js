/**
 * One live Visualizer moves between the tab and the Tuner. A mode change
 * announces the old view's departure before main.js renders the next view
 * in the same turn. Keep the mount (or pending import) through that handoff.
 */

let active = null;

function close(entry) {
  if (active !== entry) return;
  active = null;
  const session = entry.session;
  entry.session = null;
  try { session?.destroy(); } catch (error) { console.error('visualizer teardown failed:', error); }
  entry.root.remove?.();
}

export function hostVisualizer(host, { owner, doc, load, options, onError }) {
  const view = { owner, onError };
  let entry = active;
  if (entry?.view.leaving && !entry.failed && entry.view.owner !== owner) {
    entry.view = view;
    const background = owner === 'tuner';
    if (background) {
      if (entry.session) entry.session.setBackground?.(true);
      else entry.root.replaceChildren?.();
    }
    host.append(entry.root);
    if (!background) entry.session?.setBackground?.(false);
  } else {
    if (entry) close(entry);
    const root = doc.createElement('div');
    root.className = 'visualizer-root';
    if (owner === 'tab') root.innerHTML = '<div class="boot-state"><p>Loading the visualizer...</p></div>';
    host.append(root);
    entry = { root, view, session: null };
    active = entry;
    load().then(({ mountVisualizer }) => {
      if (active !== entry || entry.view.leaving) return;
      root.replaceChildren?.();
      const session = mountVisualizer(root, { ...options(), background: entry.view.owner === 'tuner' });
      if (active !== entry) {
        session.destroy();
        return;
      }
      entry.session = session;
    }).catch((error) => {
      if (active !== entry || entry.view.leaving) return;
      entry.failed = true;
      console.error('visualizer failed to load:', error);
      entry.view.onError?.(root);
    });
  }

  return (handoff = false) => {
    const release = () => { if (entry.view === view) close(entry); };
    if (!handoff) { release(); return; }
    view.leaving = true;
    queueMicrotask(release);
  };
}

export function visualizerHolder() { return active?.session ? active.view.owner : null; }
