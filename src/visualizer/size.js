/**
 * The size the picture is drawn at. The canvas element always fills the tab
 * (CSS); its drawing buffer is the tab's size in device pixels times the
 * quality's scale, capped at the quality's pixel count and at the largest
 * side the GL context can make, and the browser stretches it to fit. Every
 * pass then works at that one size.
 */

export const MIN_SIDE = 16;

const sideLimit = (value) => (Number(value) > 0 ? Number(value) : Number.POSITIVE_INFINITY);

/** Drawing-buffer size for a box of `deviceWidth` x `deviceHeight` device
 *  pixels under `preset` ({ scale, maxPixels }) and the context's `limits`
 *  ({ maxWidth, maxHeight }, optional). Keeps the box's shape: a very wide,
 *  short window is shrunk as a whole until its long side fits. */
export function drawingSize(deviceWidth, deviceHeight, preset, limits) {
  const w0 = Math.max(0, Number(deviceWidth) || 0);
  const h0 = Math.max(0, Number(deviceHeight) || 0);
  if (!(w0 > 0 && h0 > 0)) return { width: 0, height: 0 };
  const scale = Number(preset?.scale) > 0 ? Math.min(1, Number(preset.scale)) : 1;
  let width = w0 * scale;
  let height = h0 * scale;
  const cap = Number(preset?.maxPixels) || Number.POSITIVE_INFINITY;
  if (width * height > cap) {
    const shrink = Math.sqrt(cap / (width * height));
    width *= shrink;
    height *= shrink;
  }
  const maxWidth = sideLimit(limits?.maxWidth);
  const maxHeight = sideLimit(limits?.maxHeight);
  const fit = Math.min(1, maxWidth / width, maxHeight / height);
  if (fit < 1) {
    width *= fit;
    height *= fit;
  }
  return {
    width: Math.min(maxWidth, Math.max(MIN_SIDE, Math.floor(width))),
    height: Math.min(maxHeight, Math.max(MIN_SIDE, Math.floor(height))),
  };
}

/** Device-pixel size from a ResizeObserver entry (the exact device box when
 *  the browser gives it, otherwise CSS size times devicePixelRatio). */
export function deviceSizeFromEntry(entry, devicePixelRatio = 1) {
  const device = entry?.devicePixelContentBoxSize?.[0];
  if (device) return { width: device.inlineSize, height: device.blockSize };
  const dpr = Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1;
  const box = entry?.contentBoxSize?.[0];
  const width = box ? box.inlineSize : entry?.contentRect?.width || 0;
  const height = box ? box.blockSize : entry?.contentRect?.height || 0;
  return { width: Math.round(width * dpr), height: Math.round(height * dpr) };
}
