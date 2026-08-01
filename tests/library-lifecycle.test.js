import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDetail, getRestorableDetailItem, openDetail,
} from '../src/modes/library/detail.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { view } from '../src/modes/library/state.js';
import { FakeElement } from './helpers/fake-dom.js';

function mountFakeDetail(itemId) {
  view.detailItemId = itemId;
  ui.root = new FakeElement('library-root');
  ui.root.classList.add('has-detail');
  ui.detailPanel = new FakeElement('detail-panel', 'aside');
}

test('Library teardown removes stale panel DOM but preserves its selected item', () => {
  mountFakeDetail('archive:selected');

  closeDetail({ preserveSelection: true });

  assert.equal(ui.detailPanel, null);
  assert.equal(ui.root.classList.contains('has-detail'), false);
  assert.equal(view.detailItemId, 'archive:selected');

  const selected = { id: 'archive:selected', title: 'Selected media' };
  assert.equal(
    getRestorableDetailItem(selected, new Map(), []),
    selected,
  );
});

test('an explicit detail close clears restoration while fallback lookup survives player stop', () => {
  const selected = { id: 'archive:selected', title: 'Selected media' };
  mountFakeDetail(selected.id);
  assert.equal(
    getRestorableDetailItem(null, new Map([[selected.id, selected]]), []),
    selected,
  );

  closeDetail();

  assert.equal(view.detailItemId, null);
  assert.equal(getRestorableDetailItem(selected, new Map(), [selected]), null);
});

test('Library remount restores the selected detail identity instead of an unrelated player item', () => {
  const selected = { id: 'archive:selected', title: 'Selected detail' };
  const playing = { id: 'radio:playing', title: 'Unrelated player item' };
  mountFakeDetail(selected.id);

  assert.equal(
    getRestorableDetailItem(playing, new Map([[selected.id, selected]]), []),
    selected,
  );
  closeDetail();
});

test('turning policy off closes a nonfavorite explicit detail instead of retaining a placeholder', () => {
  mountFakeDetail('owncast:explicit');
  openDetail({
    id: 'owncast:explicit', source: 'owncast', type: 'tv',
    content_rating: 'explicit', title: 'Sensitive title',
  });
  assert.equal(ui.detailPanel, null);
  assert.equal(view.detailItemId, null);
});
