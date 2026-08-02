/**
 * About — what World Media is, where its content comes from, and the
 * isolation/privacy guarantees the build makes.
 *
 * Pure DOM, no fetches. Information here is curated, not crawled — counts
 * shown are reference values; live counts live in Library's sidebar.
 */

import { SOURCES, getSourceColor } from '../lib/sources.js';

const VERSION = '0.1.2';
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
            from eleven public sources. Search across them, save favorites, browse the live
            Grid, spin the Tuner, or let Discovery choose something unexpected.
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
            <a href="https://github.com/BtbN/FFmpeg-Builds" target="_blank" rel="noreferrer">BtbN/FFmpeg-Builds</a>.
            World Media verifies the GitHub SHA-256 digest and retains the downloaded
            package's license material, manifest, and source link. See
            <a href="https://ffmpeg.org/legal.html" target="_blank" rel="noreferrer">FFmpeg legal information</a>.
          </p>
        </section>

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
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripScheme(url) {
  return String(url).replace(/^https?:\/\//, '');
}
