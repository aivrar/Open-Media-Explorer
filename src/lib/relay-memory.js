/** Remembers the playback relay registration across a page reload.
 *
 * A reload forgets the player's in-memory relay id while the backend keeps the
 * registration until it expires. The id is kept in sessionStorage so the next
 * page can release what the previous one left behind. Storage is optional:
 * every access is guarded and the player works without it.
 *
 * The backend answers a release of an unknown or already-expired id with
 * success too (POST /api/v1/media/<id>/expire returns {expired: true}), so a
 * successful reply is the only proof an id is gone. An error reply (an
 * invalid session token, a busy server) or a lost request proves nothing, and
 * the id is kept.
 */

export const ACTIVE_RELAY_KEY = 'worldmedia.relay.active';
// The backend's media id format (see the /api/v1/media/<id>/expire route).
const RELAY_ID = /^[A-Za-z0-9_-]{22,128}$/;

function defaultStorage() {
  try { return globalThis.sessionStorage || null; } catch (_) { return null; }
}

export function createRelayMemory({ storage = defaultStorage, release } = {}) {
  const store = () => {
    try { return (typeof storage === 'function' ? storage() : storage) || null; } catch (_) { return null; }
  };
  const read = () => {
    try { return String(store()?.getItem(ACTIVE_RELAY_KEY) || ''); } catch (_) { return ''; }
  };
  let leftoverHandled = false;
  return {
    /** Record the active playback relay id; an empty id clears it. */
    remember(mediaId) {
      const target = store();
      if (!target) return;
      try {
        if (mediaId && RELAY_ID.test(mediaId)) target.setItem(ACTIVE_RELAY_KEY, mediaId);
        else target.removeItem(ACTIVE_RELAY_KEY);
      } catch (_) { /* storage is a convenience only */ }
    },
    forget() { this.remember(''); },
    /** Clear the stored id only if it is still this one (a newer id survives). */
    forgetIf(mediaId) {
      if (!mediaId || read() !== mediaId) return false;
      try { store()?.removeItem(ACTIVE_RELAY_KEY); } catch (_) { return false; }
      return true;
    },
    /**
     * Release an id left by the previous page. Tried once per page. The id is
     * removed only after the release succeeded, and only if storage still
     * holds that same id; otherwise it stays for the next page start.
     * Resolves to the leftover id, or '' when there was none.
     */
    async releaseLeftover() {
      if (leftoverHandled) return '';
      leftoverHandled = true;
      const leftover = read();
      if (!RELAY_ID.test(leftover)) {
        if (leftover) this.forget(); // not an id this app writes
        return '';
      }
      try {
        await release?.(leftover);
      } catch (_) {
        return leftover;
      }
      this.forgetIf(leftover);
      return leftover;
    },
  };
}
