/**
 * About — what World Media is, where its content comes from, and the
 * isolation/privacy guarantees the build makes.
 *
 * Pure DOM, no fetches. Information here is curated, not crawled — counts
 * shown are reference values; live counts live in Library's sidebar.
 */

import { SOURCES, getSourceColor } from '../lib/sources.js';
import { PROCESSOR_EXTRAS_RELEASED } from '../lib/processor-budget.js';

const VERSION = '0.1.12';
const PROJECT_URL = 'https://github.com/aivrar/Open-Media-Explorer';

export function renderAbout(host) {
  host.innerHTML = `
    <div class="about-root">
      <div class="about-page">

        <header class="about-hero">
          <h1>World Media</h1>
          <p class="about-tagline">
            Radio, live TV, podcasts, public archives, and independent media in one portable player.
          </p>
          <a class="about-project-link" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer">
            View World Media on GitHub <span aria-hidden="true">↗</span>
          </a>
        </header>

        <section class="about-section">
          <h2>What this is</h2>
          <p>
            Explore internet radio, live TV, podcasts, public-domain films, space media,
            cultural archives, audiobooks, conference recordings, and independent streams
            from ten public sources. Search across them, save favorites, browse the live
            Grid, spin the Tuner, or let Discovery choose something unexpected.
            Import your own M3U, M3U8, PLS, XSPF, JSON or CSV channel lists or paste a direct
            stream link in Library's My Playlists, and organize Favorites by media
            type, your own order and your own categories.
          </p>
          <p>
            The app does not host content. Its local Windows runtime relays media
            to the built-in player through short-lived opaque identifiers, while
            preserving headers required by the upstream provider. Playback includes a
            ten-band EQ, finite-media downloads, and optional recording for live streams.
            If a station or video goes offline at the source, it goes offline here too.
          </p>
        </section>

        <section class="about-section">
          <h2>Where the content comes from</h2>
          <p class="about-section-intro">
            Each source below is queried live when you search or browse.
            Click the home link to visit the source directly.
          </p>
          <div class="about-sources">
            ${SOURCES.map(s => `
              <article class="about-source" data-source="${s.id}">
                <div class="about-source-head">
                  <span class="about-source-dot" style="background:${getSourceColor(s.id)}"></span>
                  <h3>${escape(s.displayName)}</h3>
                </div>
                <div class="about-source-types">${escape(s.types.join(' / '))} · ${escape(s.capabilities.join(' · '))}</div>
                <p class="about-source-blurb">${escape(s.description)}</p>
                <dl class="about-source-meta">
                  <dt>Home</dt><dd><a href="${s.homepage}" target="_blank" rel="noopener">${escape(stripScheme(s.homepage))}</a></dd>
                  <dt>Rights</dt><dd>${escape(s.rightsNote)}</dd>
                </dl>
              </article>
            `).join('')}
          </div>
        </section>

        <section class="about-section">
          <h2>Privacy &amp; isolation</h2>
          <ul class="about-bullets">
            <li><strong>No accounts.</strong> Nothing to sign up for. There is no remote World Media account service.</li>
            <li><strong>No telemetry.</strong> The app does not phone home. It does not collect usage data.</li>
            <li><strong>No API keys.</strong> All listed sources are accessed using public, anonymous endpoints.</li>
            <li>
              <strong>Bounded same-origin relays.</strong> Catalog metadata crosses an HTTPS-only,
              DNS-pinned allowlist boundary. Artwork, playback, EQ, HLS, DASH, downloads, and recording use
              separate opaque, expiring local identifiers so required headers can be preserved without exposing
              upstream URLs to other localhost callers. Redirects, response sizes, and dynamic hosts are validated.
            </li>
            <li>
              <strong>Local runtime.</strong> The app's Python proxy and HTTP server bind only to 127.0.0.1
              and keep the portable profile, cache, settings, favorites, and logs beside the launcher.
            </li>
          </ul>
        </section>

        <section class="about-section">
          <h2>Licenses</h2>
          <p>
            The World Media app itself is open source under the MIT license.
            Content from the listed sources retains its original license — check each
            item’s metadata for specifics. The app surfaces license info on every
            card via the source badge and the detail panel.
          </p>
          <p>
            MPEG-DASH playback uses
            <a href="https://github.com/Dash-Industry-Forum/dash.js" target="_blank" rel="noreferrer">dash.js</a>
            5.2.0, provided by the DASH Industry Forum under the
            <a href="https://github.com/Dash-Industry-Forum/dash.js/blob/v5.2.0/LICENSE.md" target="_blank" rel="noreferrer">BSD 3-Clause license</a>.
          </p>
          <p>
            HLS playback uses vendored
            <a href="https://github.com/video-dev/hls.js/tree/v1.5.13" target="_blank" rel="noreferrer">hls.js 1.5.13</a>
            under the
            <a href="https://github.com/video-dev/hls.js/blob/v1.5.13/LICENSE" target="_blank" rel="noreferrer">Apache License 2.0</a>.
            <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">Packaged third-party notices</a>
            identify all distributed runtime components.
          </p>
          <details>
            <summary>dash.js BSD 3-Clause notice</summary>
            <p>Copyright (c) 2015, Dash Industry Forum. All rights reserved.</p>
            <p>Redistribution and use in source and binary forms, with or without
              modification, are permitted provided that the following conditions are met:</p>
            <ul>
              <li>Redistributions of source code must retain the above copyright notice,
                this list of conditions and the following disclaimer.</li>
              <li>Redistributions in binary form must reproduce the above copyright notice,
                this list of conditions and the following disclaimer in the documentation
                and/or other materials provided with the distribution.</li>
              <li>Neither the name of the Dash Industry Forum nor the names of its
                contributors may be used to endorse or promote products derived from this
                software without specific prior written permission.</li>
            </ul>
            <p>THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
              “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
              LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
              A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
              HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
              SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
              TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
              PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
              LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
              NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
              SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.</p>
          </details>
          <p>
            Optional recording support can use a separately downloaded
            <a href="https://ffmpeg.org/" target="_blank" rel="noreferrer">FFmpeg</a>
            GPL build supplied by
            <a href="https://github.com/FFmpeg-Builds/FFmpeg-Builds" target="_blank" rel="noreferrer">FFmpeg-Builds/FFmpeg-Builds</a>.
            World Media verifies the GitHub SHA-256 digest and retains the downloaded
            package's license material, manifest, and source link. See
            <a href="https://ffmpeg.org/legal.html" target="_blank" rel="noreferrer">FFmpeg legal information</a>.
          </p>
        </section>

        <section class="about-section" id="about-processor-use" tabindex="-1">
          <h2>Processor use</h2>
          <p>
            World Media is designed to stay light: it plays sound with little work and its
            Visualizer lowers its own picture quality when the computer cannot keep up.
            That is the <strong>Low</strong> setting, and it is the default.
            Settings &gt; Processor use lets you allow more.
          </p>
          <p>
            <strong>Low</strong> works as it always has: the Visualizer steps down when frames
            come late and does not step back up by itself, and the app does not check how busy
            the processor is. A picture drawn without a graphics card starts at Low quality.
          </p>
          <p>
            <strong>Balanced</strong> and <strong>High</strong> let the Visualizer use more of the
            processor, up to the limit you set (a share of the whole processor, all cores together;
            Balanced starts at 40%, High at 60%). While the Visualizer plays, the app checks every
            few seconds how much of the processor it and its window use. Over the limit for a few
            seconds, the picture quality steps down; with plenty of room for a while, it steps back
            up, slowly. The limit is a target the app steers by, not a hard cap: other work, such as
            playing the sound, is never held back to meet it. Without a graphics card pictures are
            drawn by the processor; at these levels they start at the quality you chose instead of Low.
            With a graphics card the Visualizer usually needs only a small share of the processor, so the limit matters most on computers without one or with few cores.
          </p>
          <p>
            At the higher levels the computer may get warmer and its fans louder, a laptop's battery
            may last less, and other programs may slow down. If the computer is overloaded the sound
            can stutter, and the picture's quality may drop again by itself when the limit is reached.
            The flash and brightness safety limits of the Visualizer are the same at every level.
          </p>
          ${processorExtrasParagraph()}
          <p>
            To go back, choose <strong>Low</strong> in Settings &gt; Processor use. It takes effect
            at once.
          </p>
        </section>

        <div data-about-credits-slot></div>

        <section class="about-section">
          <h2>Version</h2>
          <p class="about-version">
            World Media v${VERSION}<br>
            Windows-native desktop build.<br>
            <a href="${PROJECT_URL}/releases" target="_blank" rel="noopener noreferrer">Release history and downloads</a><br>
            <span class="about-build-line">Runtime: bundled Python + localhost HTTP server + WebView2 shell.</span>
          </p>
        </section>

      </div>
    </div>
  `;
  showVisualizerCredits(host);
}

/** What Balanced and High add to the Visualizer, said only once it is on
 *  (lib/processor-budget.js PROCESSOR_EXTRAS_RELEASED), so the page never
 *  promises what is off. */
export const PROCESSOR_EXTRAS_TEXT = Object.freeze([
  'At Balanced and High the Visualizer can also draw a Very high picture quality on large screens such as '
    + '2560 x 1440 (the heaviest scenes stay at High). At High, three of the simulations also start at a larger size '
    + 'at High quality.',
  'No level shows more effects or overlays at once. It stays at three of each, because only combinations '
    + 'of up to three have been checked for flashes and brightness, and each one added multiplies the ways they '
    + 'can brighten together.',
]);

export function processorExtrasParagraph(released = PROCESSOR_EXTRAS_RELEASED) {
  if (!released) return '';
  return PROCESSOR_EXTRAS_TEXT.map((line) => `<p data-about-processor-extras>${escape(line)}</p>`).join('');
}

/** Said in the slot when the credits could not be loaded (opening About
 *  again tries again). The notices are named as the Licenses section does. */
export const CREDITS_FAILED_TEXT = 'The Visualizer credits could not be loaded. They are also in the ';
export const NOTICES_LINK_TEXT = 'packaged third-party notices';

/** The Visualizer credits (about-credits.js), built from the vendored
 *  manifest when the page is shown: their own chunk, nothing at start-up.
 *  If they cannot be loaded, one plain line says so in their place. */
export function showVisualizerCredits(host, {
  load = () => import('./about-credits-load.js'),
  doc = typeof document === 'undefined' ? null : document,
} = {}) {
  const slot = host.querySelector('[data-about-credits-slot]');
  if (!slot || !doc) return Promise.resolve();
  return Promise.resolve()
    .then(load)
    .then(({ visualizerCredits }) => {
      if (slot.isConnected) slot.replaceWith(visualizerCredits(doc));
    })
    .catch((error) => {
      console.error('about: visualizer credits:', error);
      const section = doc.createElement('section');
      section.className = 'about-section';
      section.setAttribute('data-about-credits-failed', '');
      const line = doc.createElement('p');
      const lead = doc.createElement('span');
      lead.textContent = CREDITS_FAILED_TEXT;
      const link = doc.createElement('a');
      link.setAttribute('href', '/THIRD_PARTY_NOTICES.txt');
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
      link.textContent = NOTICES_LINK_TEXT;
      const end = doc.createElement('span');
      end.textContent = '.';
      line.append(lead, link, end);
      section.append(line);
      slot.replaceChildren(section);
    });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripScheme(url) {
  return String(url).replace(/^https?:\/\//, '');
}
