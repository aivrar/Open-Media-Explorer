const dialGradients = `<defs>
        <radialGradient id="bezelGrad" cx="0.35" cy="0.35" r="0.8">
          <stop offset="0%" stop-color="#3a3f4d"/>
          <stop offset="55%" stop-color="#1a1c22"/>
          <stop offset="100%" stop-color="#0a0b0e"/>
        </radialGradient>
        <radialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0%" stop-color="#262a33"/>
          <stop offset="80%" stop-color="#101216"/>
        </radialGradient>
        <radialGradient id="knobGrad" cx="0.35" cy="0.3" r="0.7">
          <stop offset="0%" stop-color="#24464b"/>
          <stop offset="62%" stop-color="#14232a"/>
          <stop offset="100%" stop-color="#080d12"/>
        </radialGradient>
      </defs>`;

const DIAL_FACE = 382; // The 400-unit SVG scales to the bezel's outside edge.
const DIAL_CENTER = 200;
const INNER_RADIUS = 100;
const NAME_RIM_PADDING = 0.04; // Fraction of the dial diameter, measured radially.
const NEEDLE_START = 103;
const NEEDLE_STROKE = 3;
const NEEDLE_CLEARANCE_PX = 6;
const NEEDLE_END = NEEDLE_START + DIAL_FACE * 0.1 - NEEDLE_STROKE;

function nameChord(diameter, readoutHeight) {
  const radius = diameter * (INNER_RADIUS / DIAL_FACE - NAME_RIM_PADDING);
  // The name ends at the bottom of the centered readout. Use that edge
  // so the entire line box clears the padded rim.
  return 2 * Math.sqrt(Math.max(0, radius ** 2 - (readoutHeight / 2) ** 2));
}

function visibleTextRadius(readout, x, y) {
  const range = readout.ownerDocument.createRange();
  let radius = 0;
  for (const part of readout.children) {
    const box = part.getBoundingClientRect();
    range.selectNodeContents(part);
    for (const line of range.getClientRects()) {
      // A hidden line's font box can overlap the last visible line box.
      if ((line.top + line.bottom) / 2 >= box.bottom) continue;
      const left = Math.max(box.left, line.left);
      const right = Math.min(box.right, line.right);
      const top = Math.max(box.top, line.top);
      const bottom = Math.min(box.bottom, line.bottom);
      if (left >= right || top >= bottom) continue;
      radius = Math.max(radius, Math.hypot(
        Math.max(x - left, right - x),
        Math.max(y - top, bottom - y),
      ));
    }
  }
  return radius;
}

export function setDialStationName(name, text) {
  const hyphen = /[-\u2010]/;
  if (!hyphen.test(text)) {
    name.textContent = text;
    return;
  }
  // Keep each hyphenated word intact without changing the underlying text.
  const parts = text.split(/([ \t\r\n\f]+)/).map(part => {
    if (!hyphen.test(part)) return part;
    const word = name.ownerDocument.createElement('span');
    word.className = 'dial-name-word';
    word.textContent = part;
    return word;
  });
  name.replaceChildren(...parts);
}

export function fitDialReadout(dial, readout, needle) {
  const { left, top, width: diameter } = dial.getBoundingClientRect();
  if (!diameter) return;

  const [number, unit, name] = readout.children;
  const nameStyle = getComputedStyle(name);
  if (nameStyle.display !== 'none') {
    const lineHeight = parseFloat(nameStyle.lineHeight);
    const fixedHeight = number.getBoundingClientRect().height + unit.getBoundingClientRect().height
      + 2 * parseFloat(getComputedStyle(readout).rowGap);
    const setNameWidth = height => readout.style.setProperty('--dial-name-width', nameChord(diameter, height) + 'px');
    setNameWidth(fixedHeight + lineHeight);
    // Let the browser break the text at its one-line limit first. A second
    // line moves the bottom edge farther out and needs its own chord.
    const nameHeight = name.getBoundingClientRect().height;
    if (nameHeight > lineHeight + 0.5) setNameWidth(fixedHeight + nameHeight);
  }

  const radius = visibleTextRadius(readout, left + diameter / 2, top + diameter / 2);
  // Convert the text radius and clearance to SVG units, then allow for the round cap.
  const limit = DIAL_CENTER - (radius + NEEDLE_CLEARANCE_PX) * DIAL_FACE / diameter - NEEDLE_STROKE / 2;
  needle.setAttribute('y2', Math.max(NEEDLE_START, Math.min(NEEDLE_END, limit)));
}

export function buildDialSvg(tone = false) {
  // Outer bezel + radial ticks + rotating inner disc with pointer.
  const ticks = [];
  const steps = tone ? 24 : 100;
  for (let i = 0; i <= steps; i++) {
    const center = tone && i === steps / 2;
    const major = i % (tone ? 4 : 10) === 0;
    const angle = tone ? (i / steps) * 270 - 225 : (i / steps) * 360 - 90;
    const r1 = 158;
    const r2 = center ? 126 : major ? 138 : 146;
    const x1 = 200 + r1 * Math.cos(angle * Math.PI / 180);
    const y1 = 200 + r1 * Math.sin(angle * Math.PI / 180);
    const x2 = 200 + r2 * Math.cos(angle * Math.PI / 180);
    const y2 = 200 + r2 * Math.sin(angle * Math.PI / 180);
    ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)'}" stroke-width="${center ? 8 : tone ? (major ? 5 : 3) : (major ? 2 : 1)}" />`);
  }
  return `
    <svg viewBox="${tone ? '9 9 382 382' : '0 0 400 400'}" xmlns="http://www.w3.org/2000/svg"${tone ? ' aria-hidden="true"' : ''}>
      ${tone ? '' : dialGradients}
      <circle cx="200" cy="200" r="190" class="tuner-bezel"/>
      <circle cx="200" cy="200" r="172" fill="url(#bodyGrad)" stroke="rgba(255,255,255,0.05)"/>
      ${ticks.join('')}
      <g class="dial-body" transform="rotate(0 200 200)">
        <circle cx="200" cy="200" r="${INNER_RADIUS}" fill="url(#knobGrad)" stroke="rgba(255,255,255,0.05)"/>
        <circle cx="200" cy="200" r="${INNER_RADIUS}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="2"/>
        <line${tone ? '' : ' class="tuner-dial-needle"'} x1="200" y1="${tone ? 110 : NEEDLE_START}" x2="200" y2="${tone ? 150 : NEEDLE_END}" stroke="var(--accent)" stroke-width="${tone ? 8 : NEEDLE_STROKE}" stroke-linecap="round"/>
      </g>
      <polygon class="tuner-pointer" points="${tone ? '200,16 190,44 210,44' : '200,16 196,32 204,32'}" />
    </svg>
  `;
}

/** Shortest signed turn, including a drag across the angle discontinuity. */
export function dialTurn(fromDeg, toDeg) {
  let delta = (toDeg - fromDeg) % 360;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return delta;
}

const WHEEL_NOTCH_PX = 100;

/** Whole station steps for one wheel event. Mouse wheels send about 100 px
 *  per notch and touchpads send many small values, so movement is pooled in
 *  `pool.px` and one step is taken per notch-sized amount. A sideways
 *  gesture (tilt wheel, touchpad swipe) counts too: whichever of deltaX and
 *  deltaY is larger, right or down being the next station. */
export function wheelSteps(pool, event, pixelsPerLine = 33) {
  const unit = event.deltaMode === 1 ? pixelsPerLine : event.deltaMode === 2 ? 100 : 1;
  const across = Number(event.deltaX) || 0;
  const down = Number(event.deltaY) || 0;
  const delta = Math.abs(across) > Math.abs(down) ? across : down;
  // Some wheels send 120 pixels per detent. Pooling their extra 20 pixels
  // produces a spurious second station on every fifth event.
  if (!event.deltaMode && delta % 120 === 0 && delta % WHEEL_NOTCH_PX !== 0) {
    pool.px = 0;
    return delta / 120;
  }
  pool.px += delta * unit;
  const steps = Math.trunc(pool.px / WHEEL_NOTCH_PX);
  pool.px -= steps * WHEEL_NOTCH_PX;
  return steps;
}
