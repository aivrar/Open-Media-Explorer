import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('primary navigation, Library cards, source status, and discovery controls expose keyboard state', async () => {
  const [html, main, cards, shell, sidebar, detail, grid, tuner, discovery] = await Promise.all([
    read('src/index.html'),
    read('src/main.js'),
    read('src/modes/library/render.js'),
    read('src/modes/library/shell.js'),
    read('src/modes/library/sidebar.js'),
    read('src/modes/library/detail.js'),
    read('src/modes/grid.js'),
    read('src/modes/tuner.js'),
    read('src/modes/discovery.js'),
  ]);

  assert.match(html, /<nav[^>]*id="modes-nav"[^>]*aria-label="Primary views"/);
  assert.match(html, /data-mode="library"[^>]*aria-current="page"/);
  assert.match(main, /setAttribute\('aria-current', 'page'\)/);
  assert.match(main, /removeAttribute\('aria-current'\)/);

  assert.match(cards, /className:\s*'card-open'[\s\S]*?type:\s*'button'[\s\S]*?'aria-label'/);
  assert.doesNotMatch(cards, /role:\s*'button'[\s\S]*?card-star/,
    'favorite action must not be nested in a synthetic button role');
  assert.match(cards, /'aria-pressed':\s*isFavorite/);
  assert.doesNotMatch(cards, /Discovery paused with items ready/);
  assert.doesNotMatch(cards, /className:\s*'source-status'/);
  assert.match(cards, /Collecting \$\{totals\.collecting\}[\s\S]*Waiting \$\{totals\.waiting\}[\s\S]*Done \$\{totals\.done\}/);
  assert.match(shell, /role:\s*'status'[\s\S]*?'aria-live':\s*'polite'/);

  assert.match(sidebar, /role:\s*'listbox'/);
  assert.match(sidebar, /role:\s*'option'/);
  assert.match(sidebar, /'data-role':\s*'source-health'/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
    assert.ok(sidebar.includes(key), `sidebar is missing ${key}`);
  }

  assert.match(detail, /aria-labelledby.*library-detail-title/);
  assert.match(detail, /event\.key !== 'Escape'/);
  assert.match(detail, /detailReturnFocus\?\.isConnected/);
  assert.match(detail, /'aria-pressed':\s*isFavorite/);

  assert.match(grid, /aria-pressed/);
  assert.match(grid, /restoreFocus:\s*true/);
  assert.match(grid, /aria-label.*Play/);
  assert.match(tuner, /Tuner dial\. Use arrow keys/);
  assert.match(tuner, /aria-pressed/);
  assert.match(discovery, /aria-pressed/);
});

test('dialogs, player state, status announcements, reduced motion, and forced colors remain connected', async () => {
  const [html, settings, eq, capture, player, shutdown, css, libraryCss] = await Promise.all([
    read('src/index.html'),
    read('src/lib/settings.js'),
    read('src/lib/eq-overlay.js'),
    read('src/lib/capture-ui.js'),
    read('src/lib/player.js'),
    read('src/lib/shutdown.js'),
    read('src/styles/base.css'),
    read('src/styles/library.css'),
  ]);

  assert.match(settings, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(settings, /event\.key|e\.key/);
  assert.match(settings, /e\.key === 'Escape'/);
  assert.match(settings, /app\.inert = true/);
  assert.match(settings, /previousFocus.*focus/);
  assert.match(eq, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(eq, /event\.key === 'Escape'/);
  assert.match(eq, /app\.inert = true/);
  assert.match(eq, /previousFocus\?\.focus/);

  assert.match(html, /id="player-play"[^>]*aria-label="Play"[^>]*aria-pressed="false"/);
  assert.match(html, /id="player-mute"[^>]*aria-label="Mute"[^>]*aria-pressed="false"/);
  assert.match(html, /id="player-capture-progress"[^>]*role="progressbar"/);
  assert.match(html, /id="player-capture-announcement"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(player, /setAttribute\('aria-pressed'/);
  assert.match(capture, /announces only state transitions/);
  assert.doesNotMatch(capture, /announcementKey[^\n]*progressBucket/);
  assert.match(shutdown, /aria-label.*Shutting down World Media/);

  assert.match(css, /\[role="button"\]:focus-visible/);
  assert.match(css, /\[role="option"\]:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /outline:\s*2px solid Highlight/);
  assert.match(css, /background:\s*CanvasText !important/);
  assert.match(libraryCss, /\.card-open:focus-visible/);
});
