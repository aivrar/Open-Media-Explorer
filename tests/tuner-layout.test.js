import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDialSvg, fitDialReadout, setDialStationName } from '../src/modes/tuner-dial.js';
import { FakeElement } from './helpers/fake-dom.js';
import { mountTunerStationList, stationListWindow, tunedScrollTop } from '../src/modes/tuner-station-list.js';
import { tunerStageLayout } from '../src/modes/tuner-layout.js';

const EPS = 1e-7;
const near = (a, b) => assert.ok(Math.abs(a - b) < EPS, `${a} ≠ ${b}`);
const center = rect => rect.x + rect.width / 2;
const bottom = rect => rect.y + rect.height;
const rectangles = r => [r.dial, r.list, r.caption, r.picture, ...r.knobs.flatMap(k => [k.knob, k.label])].filter(Boolean);
const range = (n, min, max) => assert.ok(n >= min - EPS && n <= max + EPS, `${n} outside ${min}–${max}`);

function checkGeometry(r, { width, height, stations, tone, hasVideo, reserved, large, band }) {
  const { unit, margin, dial, knobs, list, caption, picture, labelFont, labelGap } = r;
  const parts = rectangles(r);
  const leftEdge = Math.min(dial.x, ...knobs.map(k => k.label.x));
  const groupWidth = 2 * (center(dial) - leftEdge);
  near(margin, 2 * unit);
  range(unit, 8, 16);
  assert.equal(Boolean(list), stations);
  assert.equal(Boolean(caption), stations);
  assert.equal(knobs.length, tone ? 3 : 0);
  assert.equal(Boolean(picture), band === 'tv' && (hasVideo || reserved));
  for (const [i, a] of parts.entries()) {
    assert.ok(['compact', 'regular', 'large'].includes(a.sizeClass));
    range(a.x, margin, width - margin - a.width);
    const yMargin = list && [list, caption, picture].includes(a) ? 4 : margin;
    range(a.y, yMargin, height - a.height - yMargin);
    for (const b of parts.slice(i + 1)) {
      assert.ok(a.x + a.width <= b.x + EPS || b.x + b.width <= a.x + EPS
        || bottom(a) <= b.y + EPS || bottom(b) <= a.y + EPS, 'intersecting parts');
    }
  }
  range(dial.width, 200, 560);
  near(dial.width, dial.height);
  near(dial.y, height - bottom(knobs.at(-1)?.label || dial));
  if (list) {
    range(list.width, 200, 896);
    near(list.height, r.rows * (r.rowHeight + 8) - 8);
    assert.equal(r.columns, list.width >= 618 ? 2 : 1);
    near(caption.x, list.x);
    near(caption.width, list.width);
    near(caption.height, 16);
    range(caption.y - bottom(list), 0, unit);
    if (picture) {
      near(picture.x, list.x);
      near(picture.width, list.width);
      range(list.y - bottom(picture), 0, unit);
      const minimum = height < 600 ? 2 : 3;
      assert.ok(r.rows >= minimum);
      const widthLimit = Math.min(large ? 896 : 768, width - 2 * margin - 4 * unit - groupWidth);
      const gap = list.y - bottom(picture);
      const rowMinimum = minimum * (r.rowHeight + 8) - 8;
      const videoRoom = height - 2 * picture.y - caption.height - 2 * gap - rowMinimum;
      near(picture.width, Math.min(widthLimit, videoRoom * 16 / 9));
      if (picture.width < widthLimit - EPS) {
        assert.equal(r.rows, minimum);
        near(bottom(caption), height - picture.y);
      }
    }
  }
  if (picture) {
    near(picture.height, picture.width * 9 / 16);
    range(picture.width, 200, large ? 896 : 768);
    assert.deepEqual(r.placeholder, reserved && !hasVideo ? picture : null);
    if (!list) near(picture.y, height - bottom(picture));
  }
  if (!list && !picture) {
    near(center(dial), width / 2);
    const underDial = bottom(knobs.at(-1)?.label || dial) - bottom(dial);
    near(dial.width, Math.min(560, width - 2 * margin, Math.min(800, height - 2 * margin) - underDial));
  } else {
    const column = list || picture;
    const rightMargin = width - column.x - column.width;
    range(Math.abs(leftEdge - rightMargin), 0, 1);
    if (list) assert.ok(rightMargin >= 10 - EPS, 'the scrollport stays inside the stage');
    const gap = column.x - leftEdge - groupWidth;
    near(gap, 4 * unit);
    range(gap, 24, 64);
  }
  if (tone) {
    near(center(knobs[1].knob), center(dial));
    range(labelFont, 14, 22);
    for (const [i, { knob, label }] of knobs.entries()) {
      range(knob.width, 48, 112);
      near(knob.width, knob.height);
      near(knob.y - bottom(dial), 2 * unit);
      near(center(knob), center(label));
      near(label.y - bottom(knob), labelGap);
      near(labelGap, Math.max(8, knob.width * .12));
      near(label.height, labelFont * 1.25);
      if (i) near(label.x - knobs[i - 1].label.x - label.width, 2 * unit);
    }
  }
}

test('every 20 CSS pixels, every switch, both video sizes and live/stopped bands', () => {
  const cases = [
    ['radio', false, false], ['tv', false, false], ['tv', true, false],
    ['tv', false, true], ['radio', true, false], ['tv', true, true],
    ['radio', false, true], ['radio', true, true],
  ];
  const heights = [...Array.from({ length: 49 }, (_, i) => 330 + 20 * i), 1300];
  for (const cardSize of ['small', 'medium', 'large']) for (const stations of [false, true])
    for (const tone of [false, true]) for (const large of [false, true]) {
    const lastWidth = new Map();
    for (let width = 700; width <= 2560; width += 20) {
      const lastHeight = new Map();
      for (const height of heights) {
        const common = { width, height, stations, tone, large, cardSize };
        const tv = tunerStageLayout({ ...common, band: 'tv', reserved: true });
        const radio = tunerStageLayout(common);
        for (const [band, hasVideo, reserved] of cases) {
          const inputs = { ...common, band, hasVideo, reserved };
          const r = tunerStageLayout(inputs);
          checkGeometry(r, inputs);
          const parts = rectangles(r);
          const reference = r.list || r.picture ? tv : radio;
          assert.deepEqual(r.dial, reference.dial);
          assert.deepEqual(r.knobs, reference.knobs);
          if (r.list) {
            assert.equal(r.list.x, tv.picture.x);
            assert.equal(r.list.x + r.list.width, tv.picture.x + tv.picture.width);
            if (!r.picture) {
              assert.equal(r.list.y, tv.picture.y);
              const spare = bottom(tv.list) - bottom(r.list);
              assert.ok(spare >= -EPS && spare < r.rowHeight + 8);
            }
          }
          if (r.picture) assert.deepEqual(parts, rectangles(tv));
          const key = [band, hasVideo, reserved].join('/');
          const columnKey = key + '/' + height;
          for (const previous of [lastWidth.get(columnKey), lastHeight.get(key + (height < 600))]) {
            if (!previous) continue;
            parts.forEach((p, i) => {
              // 20 vertical pixels can supply up to 20 × 16/9 of picture width.
              range(Math.abs(p.width - previous[i].width), 0, 36);
              range(Math.abs(p.height - previous[i].height), 0, p === r.list ? r.rowHeight + 8 : 36);
            });
          }
          lastHeight.set(key + (height < 600), parts);
          lastWidth.set(columnKey, parts);
        }
      }
    }
  }
});

test('the four window compositions pin the faces, picture, whole rows and caption', () => {
  // Stage height excludes the header (105px when tabs wrap), 63px controls and 74px player.
  const samples = [
    // window, stage height, band, dial, three knob x + y + size, picture, list, caption y, rows, columns
    [1920, 887, 'radio', [264, 71, 560], [342, 488, 634, 663, 112], null, [888, 44, 768, 632], 692, 10, 2],
    [1920, 887, 'tv', [264, 71, 560], [342, 488, 634, 663, 112], [888, 44, 768, 432], [888, 492, 768, 312], 820, 5, 2],
    [1280, 607, 'radio', [114, 25, 414], [154, 279, 404, 464, 83], null, [578, 25, 589, 504], 542, 8, 1],
    [1280, 607, 'tv', [114, 25, 414], [154, 279, 404, 464, 83], [578, 25, 589, 331], [578, 369, 589, 184], 566, 3, 1],
    [1024, 447, 'radio', [115, 19, 304], [144, 236, 328, 341, 61], null, [456, 19, 454, 376], 404, 6, 1],
    [1024, 447, 'tv', [115, 19, 304], [144, 236, 328, 341, 61], [456, 19, 454, 255], [456, 283, 454, 120], 412, 2, 1],
    [967, 382, 'radio', [164, 16, 256], [176, 265, 354, 288, 53], null, [452, 16, 352, 312], 336, 5, 1],
    [967, 382, 'tv', [164, 16, 256], [176, 265, 354, 288, 53], [452, 16, 352, 198], [452, 222, 352, 120], 350, 2, 1],
  ];
  const rect = ({ x, y, width, height }) => [x, y, width, height].map(Math.round);
  for (const [width, height, band, dial, knobs, picture, list, captionY, rows, columns] of samples) {
    const r = tunerStageLayout({ width, height, band, tone: true, hasVideo: true, count: band === 'tv' ? 17 : 19 });
    assert.deepEqual(rect(r.dial), [...dial, dial[2]]);
    r.knobs.forEach(({ knob }, i) => assert.deepEqual(rect(knob), [knobs[i], knobs[3], knobs[4], knobs[4]]));
    assert.deepEqual(r.picture && rect(r.picture), picture);
    assert.deepEqual(rect(r.list), list);
    assert.deepEqual(rect(r.caption), [list[0], captionY, list[2], 16]);
    assert.deepEqual([r.rows, r.columns], [rows, columns]);
  }
});

test('a 1280px stage keeps the enlarged TV picture centred beside the instruments', () => {
  const inputs = { width: 1280, height: 607, band: 'tv', tone: true, large: true, reserved: true };
  const withList = tunerStageLayout(inputs);
  const { picture, placeholder, dial } = tunerStageLayout({ ...inputs, stations: false });
  assert.equal(Math.round(picture.width), 707);
  assert.ok(picture.width > withList.picture.width);
  near(dial.x, 1280 - picture.x - picture.width);
  assert.deepEqual(placeholder, picture);
});

test('station rows span the picture and caption with or without a scrollable gutter', t => {
  const list = new FakeElement();
  const content = new FakeElement();
  content.replaceChildren = (...nodes) => { content.children = nodes; };
  const view = mountTunerStationList(list, content, {
    makeOption: () => new FakeElement(), tune() {}, onRender() {}, onScroll() {},
  });
  t.after(view.destroy);
  for (const [width, height] of [[967, 382], [1024, 447], [1280, 607], [1920, 887]]) {
    for (const band of ['tv', 'radio']) for (const count of [2, 80]) {
      const r = tunerStageLayout({ width, height, band, count, tone: true, hasVideo: true });
      view.update(Array(count).fill({}), 0, r.list.height, 'small', true, r.columns);
      assert.equal(parseFloat(content.style.height) > r.list.height, count === 80);
      const [first, second] = content.children;
      // The content inherits the explicit item width; the gutter is in the
      // scrollport padding (tuner.css, checked by issue6-steady-dial).
      if (r.columns === 1) {
        assert.equal(first.style.width, undefined); // .station-pill fills 100%.
        assert.equal(first.style.left, undefined);
      } else {
        assert.equal(first.style.left, '0');
        assert.equal(second.style.left, 'calc(50% + 4px)');
        assert.equal(first.style.width, 'calc(50% - 4px)');
        assert.equal(second.style.width, first.style.width);
      }
      for (const edge of [r.picture, r.caption].filter(Boolean)) {
        near(r.list.x, edge.x);
        near(r.list.x + r.list.width, edge.x + edge.width);
      }
    }
  }
});

test('a second caption line fits beside the same whole-row budget across the 600px threshold', () => {
  for (const height of [330, 382, 447, 599, 600, 601]) for (const cardSize of ['small', 'medium', 'large']) {
    for (const band of ['radio', 'tv']) {
      const inputs = { width: 1024, height, band, reserved: true, cardSize, tone: true };
      const first = tunerStageLayout(inputs);
      near(tunerStageLayout({ ...inputs, captionWidth: first.list.width }).caption.height, 16);
      const r = tunerStageLayout({ ...inputs, captionWidth: first.list.width + 1 });
      near(r.caption.height, 32);
      assert.ok(bottom(r.caption) <= height + EPS);
      near(r.list.x, r.caption.x);
      near(r.list.width, r.caption.width);
      near(r.list.height, r.rows * (r.rowHeight + 8) - 8);
      if (r.picture) {
        near(r.list.x, r.picture.x);
        near(r.list.width, r.picture.width);
        assert.ok(r.rows >= (height < 600 ? 2 : 3));
      }
    }
  }
});

test('the dial keeps hyphenated words together without changing the station text', () => {
  const tooltip = 'Christmas FM Non-stop!';
  const name = {
    title: tooltip,
    ownerDocument: { createElement: tagName => ({ tagName }) },
    replaceChildren(...parts) { this.parts = parts; },
    set textContent(text) { this.parts = [text]; },
    get textContent() { return this.parts.map(part => part.textContent ?? part).join(''); },
  };
  setDialStationName(name, tooltip);
  assert.deepEqual(name.parts, [
    'Christmas', ' ', 'FM', ' ', { tagName: 'span', className: 'dial-name-word', textContent: 'Non-stop!' },
  ]);
  assert.equal(name.textContent, tooltip);
  assert.equal(name.title, tooltip);

  setDialStationName(name, '\u2605\u00a0Non\u2010stop Live-stream');
  assert.deepEqual(name.parts.filter(part => typeof part !== 'string').map(part => part.textContent),
    ['\u2605\u00a0Non\u2010stop', 'Live-stream']);
  setDialStationName(name, 'No station');
  assert.deepEqual(name.parts, ['No station']);

  const css = readFileSync(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  const word = css.match(/\.tuner-frequency \.dial-name-word \{([^}]+)\}/)[1];
  assert.match(word, /display: inline-block;/);
  assert.match(word, /white-space: nowrap;/);
  assert.match(word, /max-width: 100%;/);
  assert.match(word, /overflow: hidden;\s*text-overflow: ellipsis;/);
});

test('the name uses its padded chord and the needle clears the visible text through a full turn', t => {
  const css = readFileSync(new URL('../src/styles/tuner.css', import.meta.url), 'utf8');
  const rule = selector => css.split('\n' + selector + ' {')[1].split('}')[0];
  const property = (body, key) => body.match(new RegExp('(?:^|\\s)' + key + ': ([^;]+);'))[1];
  const readoutRule = rule('.tuner-frequency');
  assert.match(readoutRule, /width: var\(--dial-name-width, 32cqw\);/);
  assert.match(readoutRule, /display: grid;/);
  assert.match(readoutRule, /left: 50%;\s*top: 50%;\s*transform: translate\(-50%, -50%\);/);
  assert.match(rule('.tuner-frequency .station-name'), /-webkit-line-clamp: 2;[\s\S]*overflow-wrap: anywhere;/);
  assert.match(rule('.tuner-dial svg'), /scale: calc\(400 \/ 382\);/);

  const body = buildDialSvg().split('<g class="dial-body"')[1].split('</g>')[0];
  const rim = Number(body.match(/<circle cx="200" cy="200" r="(\d+)"/)[1]);
  const [, start, stroke] = body.match(/<line class="tuner-dial-needle" x1="200" y1="(\d+)"[^>]*stroke-width="(\d+)" stroke-linecap="round"/).map(Number);
  assert.ok(200 - start + stroke / 2 < rim, 'the outer cap is inside the inner rim');

  const previousStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node.computedStyle;
  t.after(() => {
    if (previousStyle) globalThis.getComputedStyle = previousStyle;
    else delete globalThis.getComputedStyle;
  });

  const samples = [
    [200, 77.81, 68.97, 20],
    [256, 101.54, 93.78, 25.6],
    [304, 121.78, 114.58, 30.4],
    [380, 154.06, 146.45, 38],
    [414, 168.55, 160.46, 41.4],
    [560, 232.07, 223.51, 56],
  ];
  for (const [diameter, singleWidth, doubleWidth, fullLength] of samples) {
    const px = value => {
      assert.match(value, /^\d+(?:\.\d+)?(?:px|cqw)$/);
      return parseFloat(value) * (value.endsWith('cqw') ? diameter / 100 : 1);
    };
    const lineHeight = part => {
      const style = rule('.tuner-frequency .' + part);
      const size = property(style, 'font-size');
      const [, operation, values] = size.match(/^(clamp|min)\(([^)]+)\)$/);
      const [a, b, c] = values.split(', ').map(px);
      const font = operation === 'min' ? Math.min(a, b) : Math.max(a, Math.min(b, c));
      return font * Number(property(style, 'line-height'));
    };

    const number = lineHeight('freq-num');
    const unit = lineHeight('freq-unit');
    const name = lineHeight('station-name');
    const gap = px(property(readoutRule, 'gap'));
    const centerX = 17 + diameter / 2;
    const centerY = 25 + diameter / 2;
    const rect = (width, top, height) => ({
      left: centerX - width / 2, right: centerX + width / 2,
      top, bottom: top + height, width, height,
    });

    for (const [textWidth, expectedLines, expectedWidth] of [
      [diameter * 0.12, 1, singleWidth],
      [diameter * 0.22, 1, singleWidth],
      [singleWidth - 0.02, 1, singleWidth],
      [singleWidth + 0.02, 2, doubleWidth],
    ]) {
      const widthWrites = [];
      const width = () => widthWrites.at(-1);
      const lines = () => textWidth > width() ? 2 : 1;
      const height = () => number + unit + 2 * gap + lines() * name;
      const top = () => centerY - height() / 2;
      const nameTop = () => top() + number + unit + 2 * gap;
      const numberNode = {
        getBoundingClientRect: () => rect(0.32 * diameter, top(), number),
        textRects: () => [rect(0.06 * diameter, top(), number)],
      };
      const unitNode = {
        getBoundingClientRect: () => rect(0.32 * diameter, top() + number + gap, unit),
        textRects: () => [rect(0.1 * diameter, top() + number + gap, unit)],
      };
      const nameNode = {
        computedStyle: { display: '-webkit-box', lineHeight: String(name) },
        getBoundingClientRect: () => rect(width(), nameTop(), lines() * name),
        textRects: () => lines() === 1
          ? [rect(textWidth, nameTop(), name)]
          : [rect(width() / 2, nameTop(), name), rect(width(), nameTop() + name, name),
            rect(diameter, nameTop() + 2 * name - 1, name)],
      };
      const readout = {
        computedStyle: { rowGap: String(gap) },
        style: { setProperty(key, value) {
          assert.equal(key, '--dial-name-width');
          widthWrites.push(parseFloat(value));
        } },
        children: [numberNode, unitNode, nameNode],
        ownerDocument: { createRange() {
          let node;
          return { selectNodeContents(part) { node = part; }, getClientRects() { return node.textRects(); } };
        } },
      };
      const dial = { getBoundingClientRect: () => ({ left: 17, top: 25, width: diameter }) };
      let end;
      fitDialReadout(dial, readout, { setAttribute(key, value) { assert.equal(key, 'y2'); end = value; } });

      assert.equal(widthWrites.length, expectedLines);
      assert.equal(lines(), expectedLines);
      near(Math.round(width() * 100) / 100, expectedWidth);
      near(Math.hypot(width() / 2, height() / 2) + 0.04 * diameter, rim * diameter / 382);

      const visible = [numberNode, unitNode, nameNode].flatMap(node => node.textRects())
        .slice(0, 2 + expectedLines);
      const radius = Math.max(...visible.map(box => Math.hypot(box.width / 2,
        Math.max(centerY - box.top, box.bottom - centerY))));
      const scale = diameter / 382;
      const clearance = (200 - end - stroke / 2) * scale - radius;
      const length = (end - start + stroke) * scale;
      assert.ok(clearance >= 4 - EPS, 'the round cap clears every visible line by at least 4 px');
      near(length, Math.max(stroke * scale, Math.min(fullLength,
        (200 - start + stroke / 2) * scale - radius - 6)));
      if (textWidth === diameter * 0.12) near(length, fullLength);
      if (diameter === 200 && expectedLines === 2) near(end, start);
      if ((diameter === 380 || diameter === 414) && textWidth === singleWidth - 0.02) near(clearance, 6);
    }
  }
});

test('each directory shrinks to its rows, keeps the caption attached and reveals any tuned station', () => {
  for (const [width, height] of [[1920, 887], [1280, 607], [1024, 447], [967, 382], [700, 330]]) {
    for (const band of ['radio', 'tv']) for (const cardSize of ['small', 'medium', 'large']) {
      const inputs = { width, height, band, hasVideo: band === 'tv', cardSize, tone: true };
      const capacity = tunerStageLayout(inputs).rows;
      for (let count = 0; count <= 50; count++) {
        const { list, empty, rows, rowHeight, columns, caption, unit } = tunerStageLayout({ ...inputs, count });
        const { stride, total } = stationListWindow(count, rowHeight, list.height, 0, columns);
        assert.equal(rows, Math.min(capacity, Math.ceil(count / columns)));
        near(list.height, Math.max(0, rows * stride - 8));
        range(caption.y - bottom(empty || list), 0, unit);
        if (!count) assert.ok(empty && !total);
        for (let index = 0; index < count; index++) {
          const scroll = tunedScrollTop(index, columns, stride, list.height, total);
          const top = Math.floor(index / columns) * stride - scroll;
          range(top, 0, list.height - rowHeight);
          near(scroll % stride, 0);
          if (!index) near(scroll, 0);
          if (index === count - 1) near(scroll + list.height, total);
        }
      }
    }
  }
});

test('the narrowest stage that fits the list leaves space for its scrollport', () => {
  const inputs = { width: 484, height: 330 };
  for (const band of ['radio', 'tv']) {
    const r = tunerStageLayout({ ...inputs, band, reserved: true });
    const rightMargin = inputs.width - r.list.x - r.list.width;
    near(r.dial.x, rightMargin);
    assert.ok(rightMargin >= 10);
    assert.equal(tunerStageLayout({ ...inputs, width: 483, band, reserved: true }).list, null);
  }
});

test('below the envelope the dial and TV picture share the available width', () => {
  for (const width of [400, 266, 195]) {
    const inputs = { width, height: 330, tone: true };
    const radio = tunerStageLayout(inputs);
    const tv = tunerStageLayout({ ...inputs, band: 'tv', reserved: true });
    near(center(radio.dial), width / 2);
    const underDial = bottom(radio.knobs.at(-1)?.label || radio.dial) - bottom(radio.dial);
    near(radio.dial.width, Math.min(width - 2 * radio.margin, 330 - 2 * radio.margin - underDial));
    assert.equal(radio.knobs.length, width === 400 ? 3 : 0);
    assert.equal(tv.list, null);
    assert.equal(radio.list, null);
    assert.equal(tv.knobs.length, 0);
    near(tv.dial.width, tv.picture.width);
    near(tv.dial.x, tv.margin);
    near(tv.picture.x - tv.dial.x - tv.dial.width, 4 * tv.unit);
    near(tv.picture.x + tv.picture.width, width - tv.margin);
  }
});
