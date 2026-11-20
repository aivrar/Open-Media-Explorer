/**
 * The About page's Visualizer credits, built from the vendored manifest's
 * `borrowed` list (src/visualizer/vendor/psychedelia/manifest.json, written
 * by scripts/import_psychedelia.mjs), so they cannot drift from what is
 * imported. Plain DOM, built when the About page is shown
 * (about-credits-load.js loads this with the manifest's few keys it needs,
 * as its own chunk: nothing of it at start-up).
 *
 * One entry per borrowed piece (every row of a piece has the same author,
 * link and licence: the manifest repeats them per scene), with the scenes
 * that use it; held scenes too, since their files ship. The licence is shown
 * as the manifest states it; a share-alike piece carries its own licence
 * label, a piece whose source states no licence is marked so, in the words
 * of CREDITS.md and THIRD_PARTY_NOTICES.txt. A link that is not http(s) is
 * shown as text. External links open as the About page's others do.
 */

export const PSYCHEDELIA_URL = 'https://github.com/aivrar/psychedelia-studio';

/** What each piece is (the manifest names it by id). One the manifest
 *  gains without a name here is shown by its id. */
export const PIECE_LABELS = Object.freeze({
  'webgl-noise': '3D simplex noise',
  'hocevar-hsv': 'RGB to HSV and HSV to RGB conversion',
  'iq-palette': 'Cosine palette',
  'narkowicz-aces': 'ACES filmic tone-mapping curve fit',
  'hoskins-hash': 'Hash without Sine',
  'dobryakov-fluid': 'Fluid solver passes (splat, curl, vorticity, divergence, pressure, gradient)',
  'iq-distance-functions': 'Distance functions (box, torus, octahedron, 2D box, capsule, capped cylinder)',
  'iq-smin': 'Polynomial smooth minimum',
  'iq-normals': 'Tetrahedron technique for numerical normals',
  'iq-soft-shadows': 'Soft shadows from a distance field',
  'iq-domain-warp': 'Domain warping',
  'iq-apollonian': 'Apollonian sphere-packing distance estimator',
  'knighty-pseudo-kleinian': 'Pseudo-Kleinian fold',
  oklab: 'Oklab color space matrices',
  'bids-colormaps': 'Viridis, Magma, Inferno and Plasma palettes',
  turbo: 'Turbo palette',
  twilight: 'Twilight palette',
  cubehelix: 'Cubehelix palette',
});

/** The marks, in the words of CREDITS.md and THIRD_PARTY_NOTICES.txt. */
export const CREDIT_TEXT = Object.freeze({
  title: 'Visualizer credits',
  summary: (count) => `Borrowed shader code (${count} pieces)`,
  noLicence: 'No license stated',
  noLicenceNote: "Used with credit; it remains under its author's terms.",
  shareAlikeNote: (label) => `This part stays under ${label}. It is not covered by the MIT license above.`,
  everyScene: 'Every scene',
  postEffects: 'Post effects',
});

/** A share-alike licence's own label ('CC BY-NC-SA 3.0'), or null. */
export function shareAlikeLabel(licence) {
  const text = String(licence || '');
  if (!/ShareAlike|\bBY(?:-NC)?-SA\b/i.test(text)) return null;
  const short = text.match(/\bCC BY(?:-NC)?-SA \d(?:\.\d)?\b/);
  return short ? short[0] : text.split(' (')[0];
}

/** `link` as an http(s) URL, or null (shown as text then). */
export function webLink(link) {
  if (typeof link !== 'string' || !link) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

/** Where a row's piece is used: a scene's name, or the shared files' reach. */
function placeOf(row, sceneName) {
  if (row.scene !== '*') return sceneName(row.scene) || row.scene;
  // The post FX library and the palettes (its Palette Map pass only).
  return /(post-fx-library|palettes)\.js$/.test(String(row.file || '')) ? CREDIT_TEXT.postEffects : CREDIT_TEXT.everyScene;
}

/** The borrowed rows grouped per piece and credit, in the manifest's order:
 *  [{ piece, label, author, link, linkNote, licence, noLicenceStated,
 *  shareAlike, places: [..], rows }]. Rows of one piece with another
 *  author, link, licence or flag are a credit of their own (never shown
 *  under the first row's). */
export function creditEntries(borrowed, sceneName = () => null) {
  const byPiece = new Map();
  for (const row of Array.isArray(borrowed) ? borrowed : []) {
    if (!row || !row.piece) continue;
    const key = JSON.stringify([
      row.piece, row.author || '', row.link || null, row.linkNote || '', row.licence || '',
      row.noLicenceStated === true, row.nonCommercial === true,
    ]);
    let entry = byPiece.get(key);
    if (!entry) {
      entry = {
        piece: row.piece,
        label: PIECE_LABELS[row.piece] || row.piece,
        author: row.author || '',
        link: row.link || null,
        linkNote: row.linkNote || '',
        licence: row.licence || '',
        noLicenceStated: row.noLicenceStated === true,
        shareAlike: shareAlikeLabel(row.licence),
        places: [],
        rows: 0,
      };
      byPiece.set(key, entry);
    }
    entry.rows += 1;
    const place = placeOf(row, sceneName);
    if (!entry.places.includes(place)) entry.places.push(place);
  }
  return [...byPiece.values()];
}

/**
 * The section: a line on Psychedelia Studio, then the borrowed pieces behind
 * a details/summary (collapsed).
 * @param {Document} doc
 * @param {{ origin?: string, license?: string, copyright?: string, borrowed: object[] }} manifest
 * @param {(id: string) => string|null} sceneName
 */
export function buildVisualizerCredits(doc, manifest, sceneName = () => null) {
  const el = (tag, className = '', text = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
  };
  const link = (href, text) => {
    const a = el('a', '', text);
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
    return a;
  };
  const section = el('section', 'about-section about-credits');
  section.setAttribute('data-about-credits', '');
  section.append(el('h2', '', CREDIT_TEXT.title));

  const origin = manifest?.origin || 'Psychedelia Studio';
  const intro = el('p');
  intro.append(
    el('span', '', 'The Visualizer is ported from '),
    link(PSYCHEDELIA_URL, origin),
    el('span', '', `, by the same author (${manifest?.copyright || 'Copyright (c) 2026 aivrar'}), under the ${manifest?.license || 'MIT'} license. `
      + 'Some of its shader code is borrowed from others and keeps its own license, as listed below.'),
  );
  section.append(intro);

  const entries = creditEntries(manifest?.borrowed, sceneName);
  const details = el('details', 'about-credits-details');
  details.append(el('summary', '', CREDIT_TEXT.summary(entries.length)));
  const list = el('div', 'about-sources about-credits-list');
  for (const entry of entries) {
    const card = el('article', 'about-source about-credit');
    card.setAttribute('data-piece', entry.piece);
    const head = el('div', 'about-source-head');
    head.append(el('h3', '', entry.label));
    if (entry.shareAlike) {
      const flag = el('span', 'about-credit-flag', entry.shareAlike);
      flag.setAttribute('data-flag', 'share-alike');
      head.append(flag);
    }
    if (entry.noLicenceStated) {
      const flag = el('span', 'about-credit-flag', CREDIT_TEXT.noLicence);
      flag.setAttribute('data-flag', 'no-licence');
      head.append(flag);
    }
    card.append(head);
    const meta = el('dl', 'about-source-meta about-credit-meta');
    const row = (term, ...value) => {
      const dd = el('dd');
      dd.append(...value);
      meta.append(el('dt', '', term), dd);
    };
    row('Scenes', el('span', '', entry.places.join(', ')));
    row('Author', el('span', '', entry.author));
    const href = webLink(entry.link);
    if (href) row('Source', link(href, href.replace(/^https?:\/\//, '')));
    else row('Source', el('span', 'about-credit-text', entry.link || entry.linkNote || 'not given'));
    const licence = [el('span', '', entry.licence)];
    if (entry.shareAlike) licence.push(el('span', 'about-credit-note', CREDIT_TEXT.shareAlikeNote(entry.shareAlike)));
    if (entry.noLicenceStated) licence.push(el('span', 'about-credit-note', CREDIT_TEXT.noLicenceNote));
    row('License', ...licence);
    card.append(meta);
    list.append(card);
  }
  details.append(list);
  section.append(details);
  return section;
}
