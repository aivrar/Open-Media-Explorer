/** Opt-in current-directory comparison through the production JS adapter. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createOwncastAdapter } from '../src/adapters/owncast.js';
import { validateItem } from '../src/lib/item-model.js';

const execFileAsync = promisify(execFile);

if (process.env.WORLDMEDIA_OWNCAST_LIVE !== '1') {
  console.error('Set WORLDMEDIA_OWNCAST_LIVE=1 to run the Owncast live smoke.');
  process.exit(2);
}

const bridge = new URL('../tests_python/owncast_live_snapshot_bridge.py', import.meta.url);
const { stdout } = await execFileAsync('python', [fileURLToPath(bridge)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
const envelope = JSON.parse(stdout);
if (!envelope.ok || !envelope.service_stopped) throw new Error(envelope.error || 'Bridge failed');
const payload = envelope.value;
let calls = 0;
const source = createOwncastAdapter({
  getOwncastSnapshot: async () => { calls += 1; return payload; },
  sha256Hex: async (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
  random: () => 0,
});
try {
  const safe = await source.refreshSnapshot();
  const all = await source.refreshSnapshot({ showExplicitContent: true });
  const rawSafe = payload.items.filter((item) => item.nsfw === false).length;
  const rawExplicit = payload.items.filter((item) => item.nsfw === true).length;
  const explicit = all.items.filter((item) => item.content_rating === 'explicit');
  if (safe.items.length !== rawSafe || all.items.length !== rawSafe + rawExplicit) {
    throw new Error('Frontend preference counts do not match the verified native snapshot.');
  }
  if (safe.items.some((item) => item.content_rating === 'explicit')) {
    throw new Error('Safe preference exposed a current explicit entry.');
  }
  if (explicit.length !== rawExplicit || explicit.some((item) => !item.tags.includes('Explicit'))) {
    throw new Error('Deliberately enabled current explicit entries are not exactly and visibly labeled.');
  }
  if (all.items.some((item) => validateItem(item).length > 0)) {
    throw new Error('A current Owncast item violated the unified item contract.');
  }
  const beforeLocalWork = calls;
  await source.search('owncast', { showExplicitContent: true });
  await source.random({ showExplicitContent: true, limit: 5 });
  if (calls !== beforeLocalWork) throw new Error('Current search/random unexpectedly refetched the directory.');
  console.log(JSON.stringify({
    raw: payload.items.length,
    safe: safe.items.length,
    explicit: explicit.length,
    all: all.items.length,
    native_calls_after_two_preference_views: calls,
    service_stopped: envelope.service_stopped,
    favorites_profile_opened: false,
  }));
} finally {
  source.dispose();
}
