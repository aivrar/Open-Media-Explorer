# Sources and channels

World Media currently registers eleven adapters. Each adapter converts a public
provider response into the same item shape (stable ID, title, type, stream or
download capability, artwork, metadata, tags, and rights note). The source is
queried directly by the adapter through the local server's approved catalog
boundary; the app never pretends that a provider's directory is its own content.

The source list is dynamic. A source can add, remove, rename, rate-limit, or
temporarily lose a station/channel without a World Media release. Use the
provider's **Source** link for authoritative rights, schedule, and availability.

## Source reference

| Source | What appears in World Media | Live/on-demand behavior | Download/record behavior | Important caveat |
|---|---|---|---|---|
| [Radio Browser](https://www.radio-browser.info/) | Community internet-radio stations with country, language, tags, click rank, and optional favicon | Live audio; mirror is resolved and re-resolved if a mirror fails | Record audio; no finite download is claimed for a station stream | Community entries can be offline, malformed, or missing artwork |
| [iptv-org](https://iptv-org.github.io/) | Publicly listed TV channels joined from streams, channels, and logos data | Live video; up to eight validated stream candidates are retained per channel | Record video; HLS candidates are probed and fail over | Directory presence does not prove the broadcaster is reachable |
| [Internet Archive](https://archive.org/) | Archive films and audio from curated collections and search | On-demand; per-item metadata resolves the playable derivative lazily | Download finite original/derivative when the item exposes one | Rights vary by item; Archive search and metadata can be transiently unavailable |
| [NASA Image and Video Library](https://images.nasa.gov/) | NASA mission video and audio records with descriptions, dates, and assets | On-demand | Download when a playable finite asset resolves | NASA work is generally public domain in the U.S.; item guidance still applies |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Searchable free-licensed/public-domain audio and video files | On-demand | Download the file URL when available | Every file carries its own license and attribution requirements |
| [LibriVox](https://librivox.org/) | Public-domain audiobook records and chapter/track media | On-demand audio | Download chapter audio or the available full-audiobook archive | RSS, cover, or older mirror endpoints may fail independently |
| [media.ccc.de](https://media.ccc.de/) / C3VOC | Technical talks, event recordings, and current conference live rooms | VOD recordings plus independently refreshed live snapshots | Download VOD; record live C3VOC audio/video | An empty live snapshot between events is valid and does not end VOD collection |
| [Library of Congress](https://www.loc.gov/) | U.S. cultural-heritage audio and film/video records and resources | On-demand when a usable resource is found | Conditional; only exposed after rights/resource validation | Shared one-request/6-second pacing; CAPTCHA or 429 enters a long cooldown |
| [gPodder Podcasts](https://gpodder.net/) | Podcast directory shows resolved through publisher RSS/Atom feeds | On-demand episodes plus feeds that declare a current live enclosure | Download finite episodes; record only explicitly live items | Dead/slow/malformed publisher feeds are isolated; publisher terms apply |
| [PeerTube](https://joinpeertube.org/) | Federated video indexed by public SepiaSearch and resolved at exact origins | On-demand and live HLS video | Conditional download; record live video | Independent instances vary in rate limits, licenses, and uptime |
| [Owncast](https://owncast.online/) | Verified independent self-hosted live video directory entries | Live video snapshots refreshed about every two minutes | Record live video | Entries without an exact rating join fail closed; servers can disappear |

## Provider pacing and caching

The shared catalog scheduler allows independent source progress while respecting
adapter policies:

| Adapter | Same-source policy in code | Cache/refresh highlights |
|---|---:|---|
| Radio Browser | Default one lane | Mirror and results coalesced for the session |
| iptv-org | Default one lane | Joined streams/channels/logos snapshot once per session |
| Internet Archive | Default one lane plus a 5-request/sec metadata gate | Curated browse cursors rotate collections; item metadata is session-cached |
| NASA | Default one lane | Search pages are finite; assets resolve lazily |
| Wikimedia Commons | Default one lane | Audio/video searches are paged independently and may run in parallel |
| LibriVox | Default one lane | Audiobook pages finite; RSS and cover resolution cached in session |
| media.ccc.de | Two lanes, at least 500 ms between starts | Recent/search ~5 minutes, details ~1 hour, live ~10 seconds; live refresh about every minute |
| Library of Congress | One lane, at least 6 seconds between starts | Catalog ~30 minutes, details ~6 hours; CAPTCHA/429 keeps the cursor and cools down |
| gPodder | Four lanes | Directory/feed data ~30 minutes; searches ~5 minutes; at most four feeds active globally and one per host |
| PeerTube | Two lanes, at least 500 ms between starts | Index ~5 minutes, origin details ~10 minutes; `Retry-After` is honored |
| Owncast | One lane | Verified snapshot refresh about every 2 minutes; last-known-good data can be stale |

These are provider-protection policies, not an item cap. The Library can keep
collecting while a source has more authoritative pages. A short or empty page is
not treated as exhaustion unless the adapter returns an explicit end marker.

## Live snapshots versus finite catalogs

C3VOC and Owncast are snapshot sources. They can legitimately return an empty
live set and later return new rooms/servers. The snapshot manager tracks fresh,
refreshing, stale, retrying, and live states independently of the finite browse
cursor. A `Done` label applies only to a finite catalog lane; it does not mean a
live snapshot will never change.

## Content ratings

PeerTube, gPodder, iptv-org, and Owncast normalize provider ratings. The global
setting is the only authority that reveals marked content. Filtering happens in
Library, Grid, Tuner, Discovery, and favorites views. Enabling the setting never
permits unsafe URLs or unverified dynamic origins.

## Rights and channel responsibility

World Media passes through public metadata and streams. It does not grant a
license, bypass DRM, or verify that a broadcaster has permission to transmit a
program. Before downloading or recording, open the source page and follow its
license, attribution, broadcaster terms, and local law.

For exact endpoint allowlists, response limits, cache TTLs, retry semantics, and
the implementation evidence behind the five newer sources, see
[docs/PROVIDERS.md](../PROVIDERS.md) and the linked research/execution logs.
