/**
 * The host for Psychedelia's line-drawing scenes (Fourier Epicycles, Hopf
 * Fibration, Knots & Surfaces, Lissajous, Attractor Ribbons, 4D Polytopes,
 * Spirograph). Each builds its curve or trajectory on the processor every
 * frame as line segments and draws them with Psychedelia's GlowLines
 * (vendor/psychedelia/engine/glow-lines.js): additive quads into a
 * persistence target that fades a little each frame (its trails), then that
 * target over a background into the picture.
 *
 * They have a render() of their own, so the scene renderer draws them
 * through sim-host.js as it draws the simulations: everything a visit makes
 * (GlowLines' two programs and two buffers, its persistence texture and
 * framebuffer) is recorded there and freed when the scene goes, when the tab
 * closes and when the context is lost, and made again on the next visit; a
 * frame is given at most SIM_MAX_DT of time, a still frame none. What
 * GlowLines needs on top comes from here:
 *
 *   - its Renderer: the picture to draw into (the sim host's) and the size of
 *     its persistence target at the quality drawn now (LINE_QUALITY
 *     trailScale, a share of each side; an import patch reads it), so the
 *     step-down shrinks it with the rest of the picture;
 *   - a limit on the segments drawn a frame at that quality (LINE_QUALITY
 *     segments), never more than LINE_MAX_SEGMENTS: segments past it are not
 *     drawn. The scenes' own trail and detail settings are capped per quality
 *     too (line-scenes.js LINE_QUALITY_CAPS), so the processor builds fewer
 *     in the first place;
 *   - no near-white "Ink on Paper" background: the background is held at
 *     LINE_BACKGROUND_MOST or below.
 *
 * Nothing is made here per frame (the options the scene passes are changed
 * in place). With no line scene shown it costs nothing: GlowLines is loaded
 * with a line scene's own chunk, and makes nothing until a visit starts.
 */

/** Per quality: the persistence target's share of each side of the picture,
 *  and the most segments drawn a frame. */
export const LINE_QUALITY = Object.freeze({
  low: Object.freeze({ trailScale: 0.5, segments: 4000 }),
  medium: Object.freeze({ trailScale: 0.75, segments: 8000 }),
  high: Object.freeze({ trailScale: 1, segments: 12000 }),
});
/** The most segments any frame draws, whatever the quality. */
export const LINE_MAX_SEGMENTS = 12000;
/** The brightest background allowed (GlowLines.BACKGROUNDS: 0 Deep Space,
 *  1 Black, 2 Nebula Glow; 3, Ink on Paper, is near white). */
export const LINE_BACKGROUND_MOST = 2;

/** The limits at `quality` ('low', 'medium', 'high'); Medium's when it is
 *  not known yet. */
export function lineLimits(quality) {
  // (Very high draws with High's limits.)
  if (quality === 'very_high') return LINE_QUALITY.high;
  return LINE_QUALITY[quality] || LINE_QUALITY.medium;
}

// The stats of the line scene made last (for the measuring page).
let lastStats = null;

/** What the line scene made last drew ({ frames, segments, cut }), or null. */
export function lineStatsNow() {
  return lastStats;
}

/**
 * The GlowLines a line-drawing scene is given (through G), over a fresh copy
 * of Psychedelia's.
 * @param {object} G  what the scene renderer registers scenes with: the sim
 *   host's Renderer, and sceneQuality() (the quality drawn now)
 * @param {function} loadGlowLines  the vendored module's load(G)
 */
export function createLineGlowLines(G, loadGlowLines) {
  const host = G.Renderer;
  const qualityNow = typeof G.sceneQuality === 'function' ? G.sceneQuality : () => null;
  const Renderer = Object.freeze({
    getCanvas: () => host.getCanvas(),
    bindFramebuffer: (index) => host.bindFramebuffer(index),
    getTrailScale: () => lineLimits(qualityNow()).trailScale,
  });
  const { GlowLines } = loadGlowLines({ Renderer });
  // What was drawn (for tests): frames, the last frame's segments, and the
  // frames whose segments were cut to the limit.
  const stats = { frames: 0, segments: 0, cut: 0 };
  lastStats = stats;

  function create() {
    const lines = GlowLines.create();
    return {
      init: lines.init,
      cleanup: lines.cleanup,
      getSegments: lines.getSegments,
      hasResources: lines.hasResources,
      render(gl, segs, count, opts) {
        const most = Math.min(LINE_MAX_SEGMENTS, lineLimits(qualityNow()).segments);
        let n = count > 0 ? Math.floor(count) : 0;
        if (n > most) { n = most; stats.cut += 1; }
        if (opts && opts.background > LINE_BACKGROUND_MOST) opts.background = LINE_BACKGROUND_MOST;
        stats.frames += 1;
        stats.segments = n;
        lines.render(gl, segs, n, opts);
      },
    };
  }

  return Object.freeze({
    create,
    NATIVE_PALETTES: GlowLines.NATIVE_PALETTES,
    BACKGROUNDS: GlowLines.BACKGROUNDS,
    stats,
  });
}
