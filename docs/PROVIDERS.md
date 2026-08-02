# Catalog Providers

Open Media Explorer uses eleven public, anonymous catalogs. None requires an
API key. This file records the production endpoints, refresh/cache behavior,
and user-visible limits represented by the shipped adapters.

All fixed metadata requests cross the HTTPS-only, DNS-pinned catalog allowlist.
Dynamic podcast, PeerTube, Owncast, artwork, and media origins cross narrow
semantic routes with public-address validation; there is no wildcard proxy.
Catalog cache records are bounded to 256 total and 64 per provider, 2 MiB per
entry and 64 MiB total. Artwork registrations expire after six hours and the
artwork cache is bounded separately. Settings **Clear cache** removes these
records, never favorites, EQ state, downloads, recordings, or settings.

| Source | Public endpoint(s) used | Cache / refresh behavior | User-visible limitations |
|---|---|---|---|
| Radio Browser | `https://all.api.radio-browser.info/json/servers`, then the selected public mirror's `/json/stations/...` routes | Mirror selection and results are coalesced for the session; a failed mirror is discarded and resolved once more | Individual stations are community entries and can be offline or malformed |
| iptv-org | `https://iptv-org.github.io/api/streams.json`, `channels.json`, and `logos.json` | The joined snapshot is fetched once per app session | Directory presence does not guarantee that a broadcaster's live stream is reachable |
| Internet Archive | `https://archive.org/advancedsearch.php`, `/metadata/{identifier}`, `/services/img/{identifier}`, and `/download/{identifier}/{file}` | Browse cursors rotate curated collections; item metadata resolves lazily and is cached for the session | Collection/search connections can fail transiently; retry never converts that failure into completion |
| NASA | `https://images-api.nasa.gov/search` and `/asset/{nasa_id}` | Search pages are finite; playable/download assets resolve lazily | Rights are generally public-domain U.S. government work, but item guidance still applies |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php` | Audio and video searches are paged independently | Files retain their per-file attribution and license terms |
| LibriVox | `https://librivox.org/api/feed/audiobooks` and each returned public RSS URL | Audiobook pages are finite; RSS media resolution and cover information are cached for the session | Some old RSS/cover endpoints fail; recordings remain public domain in the United States |
| media.ccc.de / C3VOC | `GET https://api.media.ccc.de/public/events/recent?page=N`, `GET .../public/events/{guid}`, `POST https://media.ccc.de/graphql`, `GET https://streaming.media.ccc.de/streams/v2.json` | Recent/search pages cache 5 minutes, details 1 hour; live data caches 10 seconds and refreshes about every minute | A valid empty live array between events is normal and does not complete the VOD archive |
| Library of Congress | `GET https://www.loc.gov/audio/?fo=json&at=results,pagination&c=30&sp=N`, `GET https://www.loc.gov/film-and-videos/?...`, `GET https://www.loc.gov/item/{id}/?fo=json&at=item,resources` | Catalog pages cache 30 minutes, details 6 hours; one shared request every 6 seconds | 429/CAPTCHA HTML triggers cooldown with the same cursor. Rights/download access vary per item; deep paging beyond the provider limit is not attempted |
| gPodder Podcasts | `GET https://gpodder.net/toplist/100.json`, `GET https://gpodder.net/search.json?q=...`, then public publisher RSS/Atom feeds | Directory/feed data caches 30 minutes, searches 5 minutes; at most four feeds globally and one per host are active | Dead, slow, and malformed publisher feeds are isolated; a short page is not treated as exhaustion |
| PeerTube | `GET https://sepiasearch.org/api/v1/search/videos`, then `GET https://{exact-watch-origin}/api/v1/videos/{uuid}` and `/api/v1/videos/licences` | Index results cache 5 minutes and origin details 10 minutes; rate headers and `Retry-After` are honored | The global index is effectively unbounded. Only public/published items resolve; download appears only when the origin explicitly enables it and provides a file |
| Owncast | `GET https://directory.owncast.online/api/iptv` joined with `GET https://owncast.directory/api/home` | One rating-verified snapshot refreshes about every 2 minutes; last-known-good data may be shown as stale | The M3U has no NSFW flag, so entries without an exact JSON rating join fail closed. Independent servers can disappear at any time |

## Discovery, Retry, And Content Rules

- Global metadata concurrency permits all eleven sources to make independent
  progress, with provider-specific limits and fair rotation. Library collection
  has no application item ceiling; only the mounted DOM window is bounded.
- Network, timeout, 408, 429, 5xx, malformed JSON/XML/M3U, GraphQL errors, and
  CAPTCHA HTML retain the same cursor and retry after a bounded cooldown.
  Only an authoritative no-next/end marker completes a finite catalog.
- C3VOC and Owncast live results are snapshots. They refresh independently of
  finite pages; empty live data never completes a finite archive.
- **Show explicit/NSFW content** defaults off and can only be changed directly
  in Settings. PeerTube, gPodder, iptv-org, and Owncast ratings are normalized
  and filtered in every mode. Enabling it never permits unsafe URLs, private
  addresses, malformed schemas, or unverified Owncast entries.
- Opt-in live probes are diagnostic because public providers change. A live
  failure is recorded separately from deterministic fixture/test failures.

See `docs/FIVE_NEW_SOURCES_RESEARCH.md` for the official-source research and
`docs/FIVE_NEW_SOURCES_EXECUTION_LOG.md` for the implementation evidence.
