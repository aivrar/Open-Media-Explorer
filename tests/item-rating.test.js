import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_RATINGS, makeItem, normalizeContentRating, safeExternalUrl, validateItem,
} from '../src/lib/item-model.js';

function fixture(rating) {
  return makeItem({
    id: `fixture:${rating ?? 'legacy'}`,
    title: 'Fixture',
    description: '',
    source: 'fixture',
    type: 'audio',
    stream_url: 'https://media.example/fixture.mp3',
    stream_kind: 'audio',
    delivery: 'on-demand',
    content_rating: rating,
  });
}

test('content ratings normalize to one backward-compatible three-value contract', () => {
  assert.deepEqual(CONTENT_RATINGS, ['explicit', 'not-explicit', 'unrated']);
  for (const rating of CONTENT_RATINGS) {
    const item = fixture(rating);
    assert.equal(item.content_rating, rating);
    assert.deepEqual(validateItem(item), []);
  }
  assert.equal(fixture(undefined).content_rating, 'unrated');
  assert.equal(fixture('NSFW').content_rating, 'unrated');
  assert.equal(normalizeContentRating(true), 'unrated');
});

test('validation rejects an unnormalized rating supplied outside makeItem', () => {
  const item = fixture('not-explicit');
  item.content_rating = 'unknown-provider-value';
  assert.match(validateItem(item).join('\n'), /bad content_rating/);
});

test('external source links accept only canonical credential-free HTTP(S) URLs', () => {
  assert.equal(safeExternalUrl(' https://Example.test/watch?id=1 '), 'https://example.test/watch?id=1');
  assert.equal(safeExternalUrl('http://archive.example.test/item'), 'http://archive.example.test/item');
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///C:/secret.txt',
    'https://user:password@example.test/',
    'https:\\example.test\\ambiguous',
    'https://example.test/\nunsafe',
  ]) {
    assert.equal(safeExternalUrl(unsafe), '', unsafe);
  }

  const sanitized = makeItem({
    id: 'fixture:unsafe-link', title: 'Fixture', source: 'fixture', type: 'audio',
    stream_kind: 'audio', source_url: 'javascript:alert(1)',
  });
  assert.equal(sanitized.source_url, '');
  assert.deepEqual(validateItem(sanitized), []);

  sanitized.source_url = 'javascript:alert(1)';
  assert.match(validateItem(sanitized).join('\n'), /canonical public HTTP\(S\) URL/);
});
