import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { view } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import {
  isSlowRetryStatus, notAnsweringText, updateSentinelStatus, viewHasPendingSources, viewSlowRetrySources,
} from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const SLOW = {
  state: 'retrying', count: 0, error: 'Timed out after 22000 ms', notice: '', retryAt: Date.now() + 60_000, slow: true,
};
const QUICK = { ...SLOW, retryAt: Date.now() + 1_500, slow: false };

/** Runs `body` with the Library looking at `activeSource` and the given
 *  source statuses, then puts the shared view and shell nodes back. */
function withView(activeSource, statuses, body, { lastQuery = '', exhausted = [] } = {}) {
  const keys = ['activeSource', 'query', 'lastQuery', 'items', 'exhausted', 'sourceStatus'];
  const before = Object.fromEntries(keys.map((key) => [key, view[key]]));
  const previousUi = { sentinelStatus: ui.sentinelStatus, sentinelButton: ui.sentinelButton };
  try {
    view.activeSource = activeSource;
    view.query = lastQuery;
    view.lastQuery = lastQuery;
    view.items = [];
    view.exhausted = new Set(exhausted);
    view.sourceStatus = new Map(Object.entries(statuses));
    ui.sentinelStatus = { textContent: '', innerHTML: '' };
    ui.sentinelButton = { textContent: '', style: {}, dataset: {} };
    return body();
  } finally {
    Object.assign(view, before);
    Object.assign(ui, previousUi);
  }
}

test('a slow retry is a retrying source marked slow, nothing else', () => {
  assert.equal(isSlowRetryStatus(SLOW), true);
  assert.equal(isSlowRetryStatus(QUICK), false);
  assert.equal(isSlowRetryStatus({ ...SLOW, state: 'rate-limited' }), false);
  assert.equal(isSlowRetryStatus({ ...SLOW, state: 'loading' }), false, 'a stale mark under another state');
  assert.equal(isSlowRetryStatus(undefined), false);
});

test('the wording names one source and counts several', () => {
  assert.equal(notAnsweringText(['librivox']), 'LibriVox is not answering');
  assert.equal(notAnsweringText(['librivox', 'nasa']), '2 sources are not answering');
  assert.equal(notAnsweringText(['no-such-source']), 'This source is not answering');
});

test('a single-source view whose source went slow says so and offers Retry now', () => {
  withView('librivox', { librivox: SLOW }, () => {
    assert.deepEqual(viewSlowRetrySources(), ['librivox']);
    assert.equal(viewHasPendingSources(), true, 'still coming, by itself');
    updateSentinelStatus();
    assert.equal(ui.sentinelStatus.textContent,
      '0 items · LibriVox is not answering; trying again every few minutes');
    assert.equal(ui.sentinelButton.textContent, 'Retry now');
    assert.equal(ui.sentinelButton.dataset.action, 'retry');
    assert.equal(ui.sentinelButton.dataset.restartExhausted, 'false', 'the cursor is kept');
    assert.equal(ui.sentinelButton.style.display, 'inline-flex');
  });
});

test('a quick retry keeps the old line and is not reported as not answering', () => {
  withView('librivox', { librivox: QUICK }, () => {
    assert.deepEqual(viewSlowRetrySources(), []);
    updateSentinelStatus();
    assert.equal(ui.sentinelStatus.textContent, '0 items · 1 source retrying');
    assert.equal(ui.sentinelButton.textContent, 'Retry now');
  });
});

test('the message waits while another source of the view is still coming, and never shows during a search', () => {
  // Audio is served by several sources: one slow, one still loading.
  withView('type:audio', { librivox: SLOW, 'internet-archive': { state: 'more', count: 30 } }, () => {
    assert.deepEqual(viewSlowRetrySources(['librivox', 'internet-archive']), []);
  });
  // The other one has nothing more: the slow one is all the view waits for.
  withView('type:audio', { librivox: SLOW, 'internet-archive': { state: 'complete', count: 30 } }, () => {
    assert.deepEqual(viewSlowRetrySources(['librivox', 'internet-archive']), ['librivox']);
  }, { exhausted: ['internet-archive'] });
  withView('type:audio', { librivox: SLOW, 'internet-archive': { state: 'disabled', count: 0 } }, () => {
    assert.deepEqual(viewSlowRetrySources(['librivox', 'internet-archive']), ['librivox']);
  });
  withView('librivox', { librivox: SLOW }, () => {
    assert.deepEqual(viewSlowRetrySources(), [], 'the visible status belongs to the search');
  }, { lastQuery: 'sherlock' });
  withView('favorites', { librivox: SLOW }, () => {
    assert.deepEqual(viewSlowRetrySources(['librivox']), [], 'a personal view');
  });
});

test('a held source beside a slow one does not hide the message; a search keeps the plain line', () => {
  const HELD = {
    state: 'rate-limited', count: 0, error: 'HTTP 429', notice: 'PeerTube asked the app to wait.',
    retryAt: Date.now() + 3_600_000,
  };
  withView('type:video', { nasa: SLOW, peertube: HELD }, () => {
    assert.deepEqual(viewSlowRetrySources(['nasa', 'peertube']), ['nasa']);
  });
  // The hold is over: that source is about to be asked, so nothing is said yet.
  withView('type:video', { nasa: SLOW, peertube: { ...HELD, retryAt: Date.now() - 1 } }, () => {
    assert.deepEqual(viewSlowRetrySources(['nasa', 'peertube']), []);
  });
  // A browse status left under a search: the old wording, not "not answering".
  withView('librivox', { librivox: SLOW }, () => {
    updateSentinelStatus();
    assert.equal(ui.sentinelStatus.textContent, '0 items · 1 source retrying');
  }, { lastQuery: 'sherlock' });
});

test('the empty page and the sidebar use the slow-retry wording; the chain marks the status', async () => {
  const render = await read('src/modes/library/render.js');
  assert.match(render, /const slowSources = onlyHolds \? \[\] : viewSlowRetrySources\(\);/);
  assert.match(render, /slowSources\.length > 0 \? notAnsweringText\(slowSources\) : 'No matching items'/);
  assert.match(render, /World Media tries again by itself every few minutes\. Retry now, below, tries at once\./);
  assert.match(render, /Not answering; tried again every few minutes/);
  const chain = await read('src/modes/library/chain.js');
  assert.match(chain, /slow: isSlowRetryProgress\(progress\),/);
});
