export function normalizeChapters(chapters = []) {
  const byStart = new Map();
  for (const chapter of chapters || []) {
    const { start, title } = chapter || {};
    if (!Number.isFinite(start) || start < 0) continue;
    if (!byStart.get(start)?.title) byStart.set(start, { start, title: title?.trim() || '' });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export function chapterIndexAt(chapters, time) {
  if (!Number.isFinite(time)) return -1;
  let start = 0;
  let end = chapters.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (chapters[middle].start <= time) start = middle + 1;
    else end = middle;
  }
  return start - 1;
}

export function chapterSteps(chapters, time) {
  const index = chapterIndexAt(chapters, time);
  const start = chapters[index]?.start;
  return {
    index,
    previous: time - start > 3 ? start : chapters[index - 1]?.start,
    next: Number.isFinite(time) ? chapters[index + 1]?.start : undefined,
  };
}
