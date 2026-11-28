import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterIndexAt, chapterSteps, normalizeChapters } from '../src/modes/computer-chapters.js';

test('chapter starts are sorted and deduplicated, retaining the first useful title', () => {
  const input = [
    { start: 20, title: ' ' }, { start: 5, title: 'First' }, { start: 20, title: ' Second ' },
    { start: -1 }, null, { start: 20, title: 'Duplicate' }, { start: NaN }, { start: '30' },
    { start: 60 },
  ];
  assert.deepEqual(normalizeChapters(input), [
    { start: 5, title: 'First' }, { start: 20, title: 'Second' }, { start: 60, title: '' },
  ]);
  assert.deepEqual(normalizeChapters(), []);
  assert.equal(input[0].title, ' ');
});

test('chapter steps handle the prelude, exact markers, the 3 second threshold and the end', () => {
  const chapters = normalizeChapters([{ start: 60 }, { start: 5 }, { start: 20 }, { start: 20 }]);
  for (const [time, index, previous, next] of [
    [NaN, -1], [Infinity, -1], [0, -1, undefined, 5], [4.999, -1, undefined, 5],
    [5, 0, undefined, 20], [8, 0, undefined, 20], [8.001, 0, 5, 20],
    [20, 1, 5, 60], [23, 1, 5, 60], [23.001, 1, 20, 60],
    [60, 2, 20], [300, 2, 60],
  ]) {
    assert.equal(chapterIndexAt(chapters, time), index, String(time));
    assert.deepEqual(chapterSteps(chapters, time), { index, previous, next }, String(time));
  }
  assert.deepEqual(chapterSteps([], 4), { index: -1, previous: undefined, next: undefined });
  assert.deepEqual(chapterSteps([{ start: 0 }], 4), { index: 0, previous: 0, next: undefined });
});
