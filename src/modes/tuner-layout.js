import { STATION_LIST_GAP, STATION_ROW_HEIGHTS } from './tuner-station-list.js';

const clamp = (min, value, max) => Math.max(min, Math.min(value, max));

function box(x, y, width, height, measure = width) {
  const sizeClass = measure < 300 ? 'compact' : measure < 480 ? 'regular' : 'large';
  return { x, y, width, height, sizeClass };
}

/** Stage-local CSS pixels. The instruments keep their own bank and midline.
 * Below the supported envelope, drop the list and tone as needed, then
 * scale the remaining dial and picture to fit. */
export function tunerStageLayout({
  width, height, stations = true, tone = false, band = 'radio', cardSize = 'small',
  reserved = false, hasVideo = false, large = false, count = Infinity, captionWidth = 0,
}) {
  const unit = Math.min(clamp(8, Math.min(width / 96, height / 48), 16), width / 12, height / 12);
  const margin = 2 * unit;
  const room = width - 2 * margin;
  const bankHeight = Math.min(800, height - 2 * margin);
  const wantsPicture = band === 'tv' && (hasVideo || reserved);
  const short = height < 600;
  const rowHeight = STATION_ROW_HEIGHTS[cardSize] || STATION_ROW_HEIGHTS.small;
  const pitch = rowHeight + STATION_LIST_GAP;
  const rowsHeight = n => Math.max(0, n * pitch - STATION_LIST_GAP);
  const rowMinimum = rowsHeight(short ? 2 : 3);
  const hasList = stations && bankHeight >= 200 && room >= 220 + 200 + 4 * unit;
  const gutter = 4 * unit;
  const available = room - gutter;
  const rightFloor = hasList ? 220 : 200;
  const right = available < rightFloor + 200 ? available / 2
    : clamp(rightFloor, available * (large ? 0.60 : 0.55), Math.min(896, available - 200));
  const hasRight = hasList || wantsPicture;
  const left = Math.min(560, hasRight ? available - right : room);
  // Allow the full names to extend beyond their circular controls. All
  // three names use the same width, including the shorter word "Bass".
  const knobWidth = clamp(48, Math.min(left / 4.5, bankHeight * 0.15), 112);
  const labelFont = clamp(14, knobWidth * 0.23, 22);
  const labelWidth = Math.max(knobWidth, 5.2 * labelFont);
  const labelHeight = labelFont * 1.25;
  const labelGap = Math.max(8, knobWidth * 0.12);
  const toneHeight = knobWidth + labelGap + labelHeight;
  const hasTone = tone && left >= 3 * labelWidth + 4 * unit
    && bankHeight >= 200 + 2 * unit + toneHeight;
  if (hasList && tone && !hasTone) {
    return tunerStageLayout({ width, height, stations: false, tone, band, cardSize, reserved, hasVideo, large, count, captionWidth });
  }
  const underDial = hasTone ? 2 * unit + toneHeight : 0;
  const diameter = Math.min(left, bankHeight - underDial);
  const groupWidth = Math.max(diameter, hasTone ? 3 * labelWidth + 4 * unit : 0);
  // Give the directory any width the instruments did not use. The outer
  // margins leave room for the list's 10px scrollport overhang.
  const regionWidth = hasList || short ? available - groupWidth : right;
  const widthLimit = Math.min(regionWidth, large ? 896 : 768);

  // Try one caption line first. A wrapped caption costs one more line in
  // the same height budget as the picture and the whole station rows.
  function fitDirectory(captionHeight) {
    const minimum = 112.5 + rowMinimum + captionHeight;
    const gap = Math.min(unit, Math.max(0, (height - minimum) / 4));
    const directoryHeight = hasList
      ? Math.min(height - 2 * gap, Math.max(bankHeight, minimum + 2 * gap)) : bankHeight;
    const videoRoom = hasList ? directoryHeight - captionHeight - 2 * gap - rowMinimum : bankHeight;
    const columnWidth = Math.min(widthLimit, Math.max(0, videoRoom) * 16 / 9);
    return { gap, directoryHeight, columnWidth, captionHeight };
  }
  let directory = fitDirectory(16);
  if (hasList && captionWidth > directory.columnWidth) directory = fitDirectory(32);
  const { gap, directoryHeight, columnWidth, captionHeight } = directory;
  if (hasList && height < 112.5 + rowMinimum + captionHeight) {
    return tunerStageLayout({ width, height, stations: false, tone, band, cardSize, reserved, hasVideo, large, count, captionWidth });
  }

  // Centre the visible pieces, including overhanging knob labels.
  const start = (width - groupWidth - gutter - columnWidth) / 2;
  const axis = hasRight ? start + groupWidth / 2 : width / 2;
  const x = start + groupWidth + gutter;
  const top = (height - directoryHeight) / 2;
  const pictureHeight = columnWidth * 9 / 16;
  const picture = wantsPicture ? box(x, hasList ? top : (height - pictureHeight) / 2, columnWidth, pictureHeight) : null;
  const dial = box(axis - diameter / 2, (height - diameter - underDial) / 2, diameter, diameter);
  const knobs = [];
  if (hasTone) {
    const y = dial.y + diameter + 2 * unit;
    for (const offset of [-1, 0, 1]) {
      const cx = axis + offset * (labelWidth + 2 * unit);
      knobs.push({
        knob: box(cx - knobWidth / 2, y, knobWidth, knobWidth, diameter),
        label: box(cx - labelWidth / 2, y + knobWidth + labelGap, labelWidth, labelHeight, diameter),
      });
    }
  }

  const columns = columnWidth >= 618 ? 2 : 1;
  const pictureSpace = pictureHeight + gap;
  const tvListSpace = directoryHeight - captionHeight - gap - pictureSpace;
  const tvCapacity = Math.max(0, Math.floor((tvListSpace + STATION_LIST_GAP + 1e-7) / pitch));
  // Reuse the picture slot and the TV list's whole rows.
  const capacity = picture ? tvCapacity : tvCapacity + Math.floor((pictureSpace + 1e-7) / pitch);
  const rows = hasList ? Math.min(capacity, Math.ceil(count / columns)) : 0;
  const listHeight = rowsHeight(rows);
  const messageHeight = count ? listHeight : rowsHeight(Math.min(3, capacity));
  // The list starts at the top of the column when no picture is visible.
  const listTop = picture ? top + pictureSpace : top;
  const list = hasList ? box(x, listTop, columnWidth, listHeight) : null;
  const empty = hasList && !count ? box(x, listTop, columnWidth, messageHeight) : null;
  const caption = hasList ? box(x, listTop + messageHeight + gap, columnWidth, captionHeight) : null;
  const placeholder = picture && !hasVideo ? picture : null;
  return { band, unit, margin, dial, knobs, labelFont, labelGap, list, rows, columns, empty, rowHeight, caption, picture, placeholder };
}

/** Absolute CSS boxes, with a local origin for a label inside its slider. */
export function placeTunerPart(node, rect, originX = 0, originY = 0) {
  node.dataset.size = rect.sizeClass;
  Object.assign(node.style, {
    left: `${rect.x - originX}px`, top: `${rect.y - originY}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
}
