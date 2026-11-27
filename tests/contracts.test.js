import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAdapter } from '../src/lib/sources.js';
import { catalogScheduler } from '../src/lib/catalog-scheduler.js';
import { EQ_GAIN_STEP_DB } from '../src/lib/eq-curve.js';
import { makeItem, validateItem } from '../src/lib/item-model.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = JSON.parse(await read('tests/fixtures/baseline-ui-contract.json'));

test('frozen player and settings DOM contract matches source markup', async () => {
  const html = await read('src/index.html');
  const settings = await read('src/lib/settings.js');
  const css = await read('src/styles/base.css');

  for (const id of [
    contract.player.root,
    ...contract.player.mediaElements,
    ...contract.player.metadata,
    ...contract.player.controls,
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const field of contract.settings.fields) {
    assert.match(settings, new RegExp(`data-field=["']${field}["']`));
  }
  for (const section of contract.settings.sections) {
    assert.match(settings, new RegExp(`<h3>${section}</h3>`));
  }
  assert.ok(css.includes('#player-bar[data-fit="' + contract.player.layouts.compact.fit + '"]'));
  assert.match(css, new RegExp(`@media\\s*\\(max-width:\\s*${contract.player.layouts.narrow.maxWidthPx}px\\)`));
  for (const area of contract.player.layouts.compact.areas) {
    assert.ok(css.includes(`"${area}"`), `missing compact player area ${area}`);
  }
  assert.match(html, /id="player-capture-announcement"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="player-capture-progress"[^>]*role="progressbar"/);
  assert.match(html, /id="player-eq"[^>]*aria-pressed="false"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.player-primary \{ display: contents; \}/);
  assert.match(settings, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(settings, /data-runtime-downloads/);
  assert.match(settings, /data-runtime-tools/);
  assert.match(settings, /data-runtime-writable/);
});

test('capture status is isolated from player title and source metadata', async () => {
  const capture = await read('src/lib/capture-ui.js');
  assert.equal(capture.includes('player-title'), false);
  assert.equal(capture.includes('player-source'), false);
  assert.match(capture, /player-capture-status-text/);
  assert.match(capture, /visibilitychange/);
  assert.match(capture, /mode-change/);
  assert.match(capture, /current-item/);
});

test('the player bar is one row: no status line under the buttons, and a lower bar', async () => {
  const css = (await read('src/styles/base.css')).replace(/\r\n/g, '\n');
  const html = (await read('src/index.html')).replace(/\r\n/g, '\n');
  const bar = css.match(/\n\.player-bar \{([^}]*)\}/)[1];
  assert.match(bar, /grid-template-areas: "meta controls actions progress volume";/);
  assert.match(bar, /grid-template-rows: minmax\(56px, auto\);/);
  assert.match(bar, /align-items: center;/);
  assert.match(bar, /gap: 0 8px;/);
  assert.doesNotMatch(css, /"status|status"/, 'no status area in any layout');
  // Desktop has one 56px row. The stacked bar keeps a second row for actions.
  assert.match(css, /--player-h: 74px;/);
  assert.match(css, /#app\.has-player:has\(\.player-bar\[data-fit="stack"\]\)[^{]*\{ --player-h: 120px; \}/);
  // The capture notice sits in the actions row, after Record, and its text
  // has room for descenders.
  const actions = html.match(/<div class="player-actions"[\s\S]*?<span id="player-capture-announcement"/)[0];
  assert.ok(actions.indexOf('id="player-capture"') < actions.indexOf('id="player-capture-status"'));
  assert.ok(actions.indexOf('id="player-capture-status"') < actions.indexOf('id="player-eq"'));
  const notice = css.match(/\n\.player-capture-status \{([^}]*)\}/)[1];
  assert.doesNotMatch(notice, /grid-area/);
  assert.match(notice, /min-width: 0;/);
  assert.match(notice, /max-width: 200px;/);
  const text = css.match(/#player-capture-status-text \{([^}]*)\}/)[1];
  assert.match(text, /overflow: hidden;/);
  assert.match(text, /text-overflow: ellipsis;/);
  assert.match(text, /line-height: 1\.4;/);
  // The Record button's hint is its description; there is no Open Settings action.
  assert.match(html, /id="player-capture"[^>]*aria-describedby="player-capture-hint"/);
  assert.match(html, /<span id="player-capture-hint" hidden><\/span>/);
  const capture = await read('src/lib/capture-ui.js');
  assert.doesNotMatch(capture, /Open Settings|'settings'|settings-btn/);
});

test('even 8 px gaps between the bar controls; Record and EQ keep fixed widths', async () => {
  const css = (await read('src/styles/base.css')).replace(/\r\n/g, '\n');
  for (const selector of ['.player-controls', '.player-actions', '.player-progress']) {
    const rule = css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{\\n  grid-area:([^}]*)\\}`))[1];
    assert.match(rule, /gap: 8px;/, selector);
  }
  assert.match(css, /\.player-action \{ flex: none; width: 126px; \}/);
  assert.match(css, /\[data-fit="record"\][^\n]*\.player-action,[^\n]*\n[^\n]*width: 38px; padding: 0;/);
  // (The first "\n.player-eq {" is the rule it shares with the Record button.)
  const eq = css.match(/\n\.player-eq \{\n  width: 68px;([^}]*)\}/);
  assert.ok(eq, 'EQ is 68 px wide');
  assert.match(css, /\.player-action, \.player-eq \{ flex-shrink: 0; \}/);
  assert.doesNotMatch(eq[1], /min-width/);
  // Record, its second action, EQ and Picture share the 36 px height.
  const buttons = css.match(/\n\.player-action,\n\.player-action-secondary,\n\.player-picture,\n\.player-eq \{([^}]*)\}/)[1];
  assert.match(buttons, /height: 36px;/);
});

test('the main header uses 32 px controls, even gaps, and fixed Sleep widths', async () => {
  const css = (await read('src/styles/base.css')).replace(/\r\n/g, '\n');
  const bar = css.match(/\n\.topbar \{([^}]*)\}/)[1];
  assert.match(bar, /--topbar-control-height: 32px;/);
  assert.match(bar, /--topbar-gap: 8px;/);
  assert.match(bar, /align-items: center;[^}]*gap: var\(--topbar-gap\);[^}]*padding: 0 18px;/);
  const controls = css.match(/\n\.mode-btn,\n\.topbar-tools > \.icon-btn,\n\.shutdown-btn,\n\.sleep-timer select \{([^}]*)\}/)[1];
  assert.match(controls, /height: var\(--topbar-control-height\);/);
  assert.match(controls, /border: 1px solid transparent;/);
  assert.match(controls, /border-radius: var\(--topbar-radius\);/);
  assert.match(controls, /line-height: var\(--topbar-line-height\);/);
  for (const selector of ['.brand', '.modes', '.topbar-tools', '.sleep-timer', '.sleep-timer label']) {
    const rule = css.split(`\n${selector} {`)[1].split('}')[0];
    assert.match(rule, /align-items: center;/, selector);
    assert.match(rule, /gap: var\(--topbar-gap\);/, selector);
  }
  assert.match(css, /\.topbar-tools \{[^}]*justify-self: end;/);
  assert.match(css, /\.modes \{[^}]*justify-self: center;[^}]*padding: 5px;/);
  const sleepLabel = css.match(/\n\.sleep-timer label \{([^}]*)\}/)[1];
  const sleepText = css.match(/\n\.sleep-timer label span \{([^}]*)\}/)[1];
  assert.match(sleepLabel, /justify-content: flex-end;/);
  assert.match(sleepLabel, /min-width: 104px;/);
  assert.doesNotMatch(sleepText, /\bwidth:/);
  assert.match(sleepText, /white-space: nowrap;[^}]*font-variant-numeric: tabular-nums;/);
  const narrow = css.split('@media (max-width: 560px) {')[1].split('\n}')[0];
  assert.match(narrow, /\.sleep-timer label \{ min-width: 0; \}/);
  assert.match(narrow, /\.sleep-timer label span \{ display: none; \}/);
  assert.match(css, /\.sleep-timer select \{[^}]*width: 88px;/);
  const html = await read('src/index.html');
  const tools = html.split('<div class="topbar-tools">')[1].split('</header>')[0];
  assert.equal([...tools.matchAll(/<svg[^>]*width="20" height="20"/g)].length, 3);
  const sleepTimer = await read('src/lib/sleep-timer.js');
  assert.match(sleepTimer, /<label for="sleep-select">\s*<svg[^>]*width="20" height="20"/);
});

test('the Tuner bar uses 34 px controls, even gaps, and a fixed Visualizer readout', async () => {
  const css = (await read('src/styles/tuner.css')).replace(/\r\n/g, '\n');
  const bar = css.match(/\n\.tuner-controls \{([^}]*)\}/)[1];
  assert.match(bar, /--tuner-control-height: 34px;/);
  assert.match(bar, /--tuner-control-gap: 8px;/);
  assert.match(bar, /grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(bar, /align-items: center;[^}]*padding: 14px 20px;[^}]*gap: var\(--tuner-control-gap\);/);
  assert.match(css, /\.tuner-band-switch,\n\.tuner-filter,\n\.tuner-tools,\n\.tuner-viz-level \{[^}]*align-items: center;[^}]*gap: var\(--tuner-control-gap\);/);
  const controls = css.match(/\n\.tuner-band-switch button,\n\.tuner-filter select,\n\.tuner-tools > \.tuner-toggle,\n\.tuner-viz-level > \.volume-stepper \{([^}]*)\}/)[1];
  assert.match(controls, /height: var\(--tuner-control-height\);/);
  assert.match(controls, /border: 1px solid var\(--border\);/);
  assert.match(controls, /border-radius: var\(--tuner-control-radius\);/);
  assert.match(css, /\.tuner-viz-level > \.volume-stepper \{[^}]*box-sizing: border-box;[^}]*border: 0;[^}]*box-shadow: inset 0 0 0 1px/);
  assert.match(css, /\.tuner-band-switch button \{[^}]*width: 68px;/);
  assert.match(css, /\.tuner-filter select \{[^}]*min-width: 0;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.tuner-filter select:last-of-type \{ width: 260px; \}/);
  assert.match(css, /\.tuner-tools \{ justify-self: end; \}/);
  assert.match(css, /\.tuner-tools > \.tuner-toggle \{[^}]*width: var\(--tuner-control-height\);/);
  assert.match(css, /\.tuner-toggle\[aria-pressed='true'\] \{[^}]*background: var\(--accent-soft\);[^}]*color: var\(--accent-strong\);/);
  assert.match(css, /\.tuner-viz-level \.volume-led \{[^}]*flex: none;[^}]*width: 36px;[^}]*font-variant-numeric: tabular-nums;/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.tuner-controls \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*padding: 10px 12px;[^}]*\}\s*\.tuner-band-switch \{ grid-column: 1 \/ -1; \}/);
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /'aria-label': 'Tone knobs',\s*title: 'Show Bass, Treble and Loudness knobs'/);
  assert.match(tuner, /'aria-label': 'Stations',\s*title: 'Show or hide the station list'/);
  assert.match(tuner, /tools\.appendChild\(ui\.stationsToggle\);\s*ui\.toneToggle = el\('button'/);
  const stations = tuner.match(/<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">([\s\S]*?)<\/svg>/)[1];
  assert.match(stations, /M7 5h10M7 10h10M7 15h10/);
  assert.equal([...stations.matchAll(/<circle /g)].length, 3);
  const knob = tuner.match(/<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor"[^>]*>([\s\S]*?)<\/svg>/)[1];
  assert.match(knob, /<path d="M13\.34 5\.63l[^"]+A5\.5 5\.5 [^"]+Z"\/>/);
  assert.doesNotMatch(knob, /stroke=|fill="none"/);
  const dots = Array.from(knob.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="0\.9"\/>/g),
    ([, x, y]) => [Number(x), Number(y)]);
  assert.equal(dots.length, 7);
  assert.ok(dots[0][0] < 10 && dots[0][1] > 10);
  assert.ok(dots[6][0] > 10 && dots[6][1] > 10);
  assert.ok(dots.slice(1, -1).every(([, y]) => y < 10));
});

test('Settings, EQ and Song Log scroll inside the space above the active player bar', async () => {
  const css = await read('src/styles/base.css');
  const html = await read('src/index.html');
  assert.match(html, /<audio id="audio-el" hidden><\/audio>\s*<\/div>\s*<div id="modal-host">/);
  assert.match(css, /#app\.has-player \+ #modal-host \.modal-backdrop \{\s*padding-block: 10px calc\(var\(--player-h\) \+ 10px\);/);
  assert.match(css, /\.modal \{[^}]*max-height: min\(85vh, 100%\);/);
  assert.match(css, /\.modal \{[^}]*max-height: min\(92vh, 100%\);/);
  assert.match(css, /\.eq-modal \{[^}]*max-height: min\(88vh, 760px, 100%\);/);
  assert.match(css, /\.eq-modal \{[^}]*max-height: min\(94vh, 100%\);/);
  assert.match(css, /\.modal-body \{[^}]*overflow: auto;/);
  assert.match(css, /\.eq-content \{[^}]*overflow: auto;/);
  assert.match(css, /#app\.has-player:has\([^\r\n]+\) \+ #modal-host \{ --player-h: 120px; \}/);
  assert.match(css, /#app\.has-capture-only \+ #modal-host,/);
  const songLog = await read('src/lib/song-log-panel.js');
  assert.match(songLog, /make\('div', 'modal-backdrop'\)/);
  assert.match(songLog, /make\('div', 'modal song-log-modal'\)/);
  assert.match(songLog, /make\('div', 'modal-body song-log-body'\)/);
});

test('the EQ graph shows "0 dB" above its flat line, not across it', async () => {
  const css = await read('src/styles/base.css');
  const label = css.match(/\.eq-response > span:nth-of-type\(2\) \{([^}]*)\}/)[1];
  assert.match(label, /bottom: calc\(50% \+ 3px\);/);
  assert.doesNotMatch(label, /top:/);
  assert.match(css, /\.eq-response \{[^}]*height: 116px;/);
});

test('EQ overlay contract exposes automatic, scoped, keyboard-accessible controls', async () => {
  const overlay = await read('src/lib/eq-overlay.js');
  const presets = await read('src/lib/eq-presets.js');
  const css = await read('src/styles/base.css');
  assert.match(overlay, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="eq-title"/);
  assert.match(overlay, /Changes apply immediately and save automatically/);
  assert.match(overlay, /data-eq-scope/);
  assert.match(overlay, /data-eq-favorite[^>]*aria-pressed="false"/);
  assert.match(overlay, /data-eq-bypass/);
  assert.match(overlay, /data-eq-response/);
  assert.equal(EQ_GAIN_STEP_DB, 0.5);
  assert.match(overlay, /class="eq-band-slider"[^>]*step="\$\{EQ_GAIN_STEP_DB\}"/);
  assert.match(overlay, /PERSIST_DEBOUNCE_MS\s*=\s*150/);
  assert.match(overlay, /event\.key === 'Escape'/);
  assert.match(overlay, /app\.inert = true/);
  assert.match(overlay, /eq-before-scope-change/);
  for (const name of ['Flat', 'Bass Boost', 'Treble Boost', 'Vocal', 'Spoken Word', 'Rock', 'Classical', 'Jazz', 'Electronic', 'Night']) {
    assert.ok(presets.includes(`'${name}'`), `missing built-in ${name}`);
  }
  assert.match(css, /\.eq-bands[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.eq-band-slider:focus-visible/);
});

test('Library mode tears down detached work and preserves detail identity across navigation', async () => {
  const library = await read('src/modes/library/index.js');
  const detail = await read('src/modes/library/detail.js');
  assert.match(library, /subscribe\(['"]mode-change['"][\s\S]*?mode\s*!==\s*['"]library['"][\s\S]*?tearDown\(\)/);
  assert.match(library, /closeDetail\(\{\s*preserveSelection:\s*true\s*\}\)/);
  assert.match(library, /getRestorableDetailItem\([\s\S]*?state\.currentItem/);
  assert.match(detail, /view\.detailItemId\s*=\s*item\.id/);
});

test('frozen adapter modules and normalized output contract are loadable without network access', async () => {
  for (const id of contract.adapters.ids) {
    const adapter = await loadAdapter(id);
    for (const name of contract.adapters.requiredExports) {
      assert.ok(name in adapter, `${id} missing export ${name}`);
    }
    assert.equal(adapter.id, id);
    assert.equal(typeof adapter.displayName, 'string');
    assert.ok(adapter.displayName.length > 0);
    assert.ok(Array.isArray(adapter.itemTypes) && adapter.itemTypes.length > 0);

    const type = adapter.itemTypes[0];
    const item = makeItem({
      id: `${id}:fixture`,
      title: `${adapter.displayName} fixture`,
      description: '',
      source: id,
      type,
      stream_url: 'https://media.example/fixture.mp3',
      stream_kind: type === 'video' || type === 'tv' ? 'video' : 'audio',
      thumbnail: '',
      country: '',
      language: '',
      license: 'Unknown',
      source_url: 'https://catalog.example/fixture',
      tags: [],
    });
    assert.deepEqual(validateItem(item), [], `${id} normalized output must validate`);
  }
});

test('new-source caller policies are installed in the shared scheduler', async () => {
  const expected = {
    'media-ccc': { maxConcurrent: 2, minIntervalMs: 500 },
    gpodder: { maxConcurrent: 4, minIntervalMs: 0 },
    peertube: { maxConcurrent: 2, minIntervalMs: 500 },
    owncast: { maxConcurrent: 1, minIntervalMs: 0 },
  };
  for (const [sourceId, policy] of Object.entries(expected)) {
    await loadAdapter(sourceId);
    assert.deepEqual(catalogScheduler.policies.get(sourceId), policy);
  }
});

test('frozen item model fields, API routes, and runtime folders match source', async () => {
  const model = await read('src/lib/item-model.js');
  const server = await read('worldmedia_server.py');
  const native = await read('worldmedia_native.py');

  for (const field of contract.itemModel.requiredStringFields) {
    assert.match(model, new RegExp(`['"]${field}['"]|\\b${field}\\b`), `missing item field ${field}`);
  }
  for (const route of contract.apiRoutes) assert.ok(server.includes(route), `missing route ${route}`);
  for (const folder of contract.runtime.stateFolders) {
    assert.match(native, new RegExp(`['"]${folder}['"]`), `missing runtime folder ${folder}`);
  }
  assert.match(native, /icon=str\(_root \/ "assets" \/ "worldmedia\.ico"\)/,
    'native window must retain the World Media icon with the signed launcher');
});
