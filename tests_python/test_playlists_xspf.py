from __future__ import annotations

import time
import tracemalloc
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worldmedia_playlists import (MAX_PLAYLIST_BYTES, PlaylistStore, as_m3u, is_pls, is_xml, parse_playlist,
                                  read_xspf, xspf_to_m3u)

NOT_A_PLAYLIST = r'^This file is XML or a web page, not an M3U, PLS or XSPF playlist\.$'
LINK_NOT_A_LIST = r'^That URL did not return an M3U, PLS or XSPF channel list\.'

SAMPLE = '''<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>My Stations</title>
  <trackList>
    <track>
      <location>http://example.com/stream1</location>
      <title>Station One</title>
      <image>https://example.com/one.png</image>
    </track>
    <track>
      <location>https://example.com/stream2</location>
      <title>Station Two</title>
    </track>
  </trackList>
</playlist>
'''


def parse_xspf(text: str, default_type: str = 'tv', base_url: str = '') -> dict:
    return parse_playlist(xspf_to_m3u(text), default_type, base_url)


def tracks(body: str, namespace: bool = True) -> str:
    xmlns = ' xmlns="http://xspf.org/ns/0/"' if namespace else ''
    return f'<playlist version="1"{xmlns}><trackList>{body}</trackList></playlist>'


class XspfTests(unittest.TestCase):
    def link_store(self, fetcher=None):
        store = PlaylistStore(Path('unused.json'), fetcher=fetcher)
        records = []
        store._read = lambda: records.copy()
        store._save = lambda entries: records.__setitem__(slice(None), entries)
        return store, records

    def test_namespaced_sample_becomes_plain_m3u(self):
        self.assertEqual(read_xspf(SAMPLE), ('My Stations', (
            '#EXTM3U\n'
            '#EXTINF:-1 tvg-logo="https://example.com/one.png",Station One\nhttp://example.com/stream1\n'
            '#EXTINF:-1,Station Two\nhttps://example.com/stream2\n'
        )))
        items = parse_xspf(SAMPLE)['items']
        self.assertEqual([(item['title'], item['stream_url']) for item in items], [
            ('Station One', 'http://example.com/stream1'), ('Station Two', 'https://example.com/stream2'),
        ])

    def test_no_namespace_and_prefixed_namespace_are_accepted(self):
        bare = tracks('<track><location>https://example.org/a</location><title>Bare</title></track>', namespace=False)
        prefixed = ('<x:playlist xmlns:x="http://xspf.org/ns/0/"><x:trackList><x:track>'
                    '<x:location>https://example.org/a</x:location><x:title>Prefixed</x:title></x:track></x:trackList></x:playlist>')
        for text, title in [(bare, 'Bare'), (prefixed, 'Prefixed')]:
            with self.subTest(title=title):
                self.assertTrue(is_xml(text))
                self.assertEqual([item['title'] for item in parse_xspf(text)['items']], [title])

    def test_other_namespaces_and_extension_elements_are_ignored(self):
        text = ('<playlist xmlns="http://xspf.org/ns/0/" xmlns:e="urn:ext"><trackList>'
                '<e:track><location>https://example.org/hidden</location></e:track>'
                '<track><e:location>https://example.org/hidden2</e:location><location>https://example.org/a</location>'
                '<extension application="urn:ext"><title>Not this</title></extension><title>Real</title></track>'
                '</trackList></playlist>')
        items = parse_xspf(text)['items']
        self.assertEqual([(item['title'], item['stream_url']) for item in items], [('Real', 'https://example.org/a')])
        with self.assertRaisesRegex(ValueError, NOT_A_PLAYLIST):
            xspf_to_m3u('<playlist xmlns="urn:other"><trackList/></playlist>')

    def test_missing_titles_fall_back_to_creator_then_the_m3u_fallback(self):
        text = tracks('<track><location>https://example.org/a</location><creator>Only Creator</creator></track>'
                      '<track><location>https://example.org/b</location><title>  </title></track>'
                      '<track><location>https://example.org/c</location><creator>Artist</creator><title>Song</title></track>')
        self.assertEqual([item['title'] for item in parse_xspf(text)['items']], ['Only Creator', 'Channel 2', 'Song'])

    def test_first_public_web_location_wins_and_other_schemes_are_skipped(self):
        text = tracks('<track><location>file:///c:/music/a.mp3</location><location>http://127.0.0.1/a</location>'
                      '<location>https://example.org/second</location><location>https://example.org/third</location></track>'
                      '<track><location>file:///c:/music/b.mp3</location></track>'
                      '<track><location>ftp://example.org/c</location><location>javascript:alert(1)</location></track>'
                      '<track><title>No location</title></track>')
        result = parse_xspf(text)
        self.assertEqual([item['stream_url'] for item in result['items']], ['https://example.org/second'])
        self.assertEqual(result['skipped'], 2)  # The two tracks with only non-web locations.
        with self.assertRaisesRegex(ValueError, 'No supported public HTTP'):
            parse_xspf(tracks('<track><location>file:///c:/a.mp3</location></track>'))

    def test_image_becomes_artwork_only_when_it_is_a_web_link(self):
        text = tracks('<track><location>https://example.org/a</location><image> https://example.org/a%20b.png?x=1,2 </image></track>'
                      '<track><location>https://example.org/b</location><image>file:///c:/b.png</image></track>'
                      '<track><location>https://example.org/c</location><image>https://example.org/"c.png</image></track>'
                      '<track><location>https://example.org/d</location><image>http://10.0.0.1/d.png</image></track>')
        artwork = [item['_extra']['artworkUrl'] for item in parse_xspf(text)['items']]
        self.assertEqual(artwork, ['https://example.org/a%20b.png?x=1,2', '', '', ''])

    def test_character_references_whitespace_and_percent_encoding(self):
        text = tracks('<track><location>\n  https://example.org/caf%C3%A9?a=1&amp;b=2  \n</location>'
                      '<title>\n  Caf&#xe9; &amp; Bar&#10;Live\t </title></track>')
        item = parse_xspf(text)['items'][0]
        self.assertEqual(item['title'], 'Caf\xe9 & Bar Live')
        self.assertEqual(item['stream_url'], 'https://example.org/caf%C3%A9?a=1&b=2')

    def test_titles_and_locations_cannot_inject_m3u_lines(self):
        text = tracks('<track><location>https://example.org/a</location>'
                      '<title>Name&#x2028;#EXTVLCOPT:http-user-agent=Injected&#x85;#EXT-X-ENDLIST&#13;x</title>'
                      '<image>https://example.org/i.png" radio="true</image></track>'
                      '<track><location>#EXT-X-TARGETDURATION:10</location></track>'
                      '<track><location>https://example.org/b&#x2028;#EXTVLCOPT:http-user-agent=Injected</location></track>')
        converted = xspf_to_m3u(text)
        self.assertEqual([line for line in converted.splitlines() if line.startswith('#')][:1], ['#EXTM3U'])
        self.assertEqual(len(converted.splitlines()), 3)
        result = parse_playlist(converted)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['capture_headers'], {})
        self.assertEqual(result['items'][0]['type'], 'tv')

    def test_empty_track_list_gives_the_empty_playlist_error(self):
        for text in [tracks(''), '<playlist xmlns="http://xspf.org/ns/0/"/>', tracks('<track/>')]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'No supported public HTTP'):
                parse_playlist(as_m3u(text))

    def test_malformed_xml_is_a_clean_import_error(self):
        for text in ['<playlist><trackList><track>', '<playlist><title>a</titl></playlist>', '<playlist>&nbsp;</playlist>',
                     '<playlist></playlist><playlist/>', '<playlist>\x00</playlist>']:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, r'^This XSPF playlist is not valid XML\.$'):
                as_m3u(text)

    def test_dtd_entity_and_external_reference_attacks_are_refused_quickly(self):
        laughs = ('<?xml version="1.0"?><!DOCTYPE playlist [<!ENTITY a "aaaaaaaaaa">'
                  + ''.join(f'<!ENTITY {n} "{("&" + p + ";") * 10}">' for p, n in zip('abcdefgh', 'bcdefghi'))
                  + ']><playlist><title>&i;</title></playlist>')
        external = ('<?xml version="1.0"?><!DOCTYPE playlist [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]>'
                    '<playlist><title>&x;</title></playlist>')
        remote_dtd = '<!DOCTYPE playlist SYSTEM "http://example.org/x.dtd"><playlist/>'
        for text in [laughs, external, remote_dtd]:
            with self.subTest(text=text[:60]):
                self.assertTrue(is_xml(text))
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, 'DTD or entity declarations'):
                    as_m3u(text)
                self.assertLess(time.monotonic() - started, 1)

    def test_deep_nesting_is_refused(self):
        text = '<playlist>' + '<a>' * 200 + '</a>' * 200 + '</playlist>'
        with self.assertRaisesRegex(ValueError, 'nested too deeply'):
            as_m3u(text)

    def test_size_limit_applies_before_parsing(self):
        text = tracks('<track><location>https://example.org/a</location><title>' + 'x' * MAX_PLAYLIST_BYTES + '</title></track>')
        with mock.patch('worldmedia_playlists.DefusedXMLParser') as parser, self.assertRaisesRegex(ValueError, '8 MiB'):
            as_m3u(text)
        parser.assert_not_called()

    def test_detection_is_by_content(self):
        self.assertTrue(is_xml(SAMPLE))
        self.assertTrue(is_xml('\ufeff\r\n<!-- exported -->\n<?xml-stylesheet href="x"?>\n<playlist/>'))
        self.assertTrue(is_xml(' \t\r\n<playlist\n version="1">'))
        for text in ['#EXTM3U\n<playlist>\n', '[playlist]\nFile1=https://example.org/a\n', 'https://example.org/a\n<playlist>',
                     '\ufeff#EXTM3U\n', '', '   ', None]:
            with self.subTest(text=text):
                self.assertFalse(is_xml(text))
        self.assertFalse(is_pls(SAMPLE))
        for m3u in ['#EXTM3U\n#EXTINF:-1,<playlist>\nhttps://example.org/live.m3u8\n', 'https://example.org/a\n<b>\n']:
            self.assertIs(as_m3u(m3u), m3u)

    def test_any_text_that_starts_like_xml_is_converted_or_refused_never_read_as_m3u(self):
        evil = '\nhttps://example.org/evil\n'
        refused = {
            'other root': '<playlists/>' + evil,
            'nested playlist': '<rss><playlist/></rss>' + evil,
            'unterminated comment': '<!-- unterminated <playlist>' + evil,
            'long processing instruction': '<?xml-stylesheet ' + 'x' * 70000 + '?>' + evil,
            'long comment then junk': '<!--' + 'x' * 70000 + '-->' + evil,
            'html page': '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Radio</title></head>'
                         '<body><a href="https://example.org/evil">Listen</a>' + evil + '</body></html>',
            'html without doctype': '  <html><body><p>Not found<br></body></html>' + evil,
            'not xml at all': '<<<' + evil,
        }
        for label, text in refused.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, NOT_A_PLAYLIST):
                as_m3u(text)

    def test_long_leading_comment_or_processing_instruction_still_parses_as_xspf(self):
        body = tracks('<track><location>https://example.org/a</location><title>A</title></track>')
        for prefix in ['<!--' + 'x' * 100000 + '-->', '<?xml version="1.0"?><?note ' + 'y' * 100000 + '?>']:
            with self.subTest(prefix=prefix[:12]):
                self.assertEqual([item['title'] for item in parse_xspf(prefix + body)['items']], ['A'])

    def test_dtd_after_a_long_comment_is_refused_and_not_stored(self):
        store, records = self.link_store()
        for doctype, message in [('<!DOCTYPE playlist [<!ENTITY a "b">]>', 'DTD or entity declarations'),
                                 ('<!DOCTYPE html>', NOT_A_PLAYLIST)]:
            text = '<!--' + 'x' * 70000 + '-->' + doctype + '\nhttps://example.org/evil\n<playlist/>'
            with self.subTest(doctype=doctype), self.assertRaisesRegex(ValueError, message):
                store.import_file({'name': 'evil.m3u', 'text': text, 'default_type': 'tv'})
        self.assertEqual(records, [])

    def test_html_page_from_a_link_gives_the_plain_not_a_channel_list_error(self):
        page = (b'<!DOCTYPE html><html><head><title>Login</title></head><body>'
                b'<form action="https://example.org/login"></form>\nhttps://example.org/evil\n</body></html>')
        for body in [page, b'\xef\xbb\xbf\r\n  <html><body>https://example.org/evil</body></html>', b'<?xml version="1.0"?><rss/>']:
            fetcher = mock.Mock()
            fetcher.fetch.return_value = SimpleNamespace(data=body, url='https://example.org/radio')
            store, records = self.link_store(fetcher)
            with self.subTest(body=body[:20]), self.assertRaisesRegex(ValueError, LINK_NOT_A_LIST):
                store.import_link({'url': 'https://example.org/radio', 'name': '', 'kind': 'playlist', 'default_type': 'tv'})
            self.assertEqual(records, [])

    def test_many_empty_tracks_use_little_memory_and_finish_quickly(self):
        # 300,000 tracks without a location in 2.4 MiB: none is kept.
        text = tracks('<track/>' * 150000 + '<track><title>No location</title></track>' * 150000, namespace=False)
        started = time.monotonic()
        tracemalloc.start()
        try:
            converted = xspf_to_m3u(text)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual(converted, '#EXTM3U\n')
        self.assertLess(peak, 48 * 1024 * 1024)
        self.assertLess(time.monotonic() - started, 30)
        with self.assertRaisesRegex(ValueError, 'No supported public HTTP'):
            parse_playlist(converted)

    def test_a_track_keeps_one_location_however_many_it_lists(self):
        locations = '<location>file:///c:/a.mp3</location>' * 20000 + '<location>https://example.org/a</location>' * 20000
        converted = xspf_to_m3u(tracks(f'<track>{locations}</track>'))
        self.assertEqual(converted, '#EXTM3U\n#EXTINF:-1,\nhttps://example.org/a\n')

    def test_hls_manifest_guard_still_applies_to_m3u_text(self):
        with self.assertRaisesRegex(ValueError, 'HLS playback manifest'):
            parse_playlist(as_m3u('#EXTM3U\n#EXT-X-TARGETDURATION:10\nhttps://example.org/a.ts\n'))
        # An XSPF title that looks like an HLS tag stays a name, never a directive.
        items = parse_xspf(tracks('<track><location>https://example.org/a</location><title>#EXT-X-ENDLIST</title></track>'))['items']
        self.assertEqual(items[0]['title'], '#EXT-X-ENDLIST')

    def test_legacy_encoding_declaration_is_ignored_for_decoded_text(self):
        text = '<?xml version="1.0" encoding="ISO-8859-1"?>' + tracks('<track><location>https://example.org/a</location><title>Caf\xe9</title></track>')
        self.assertEqual(parse_xspf(text)['items'][0]['title'], 'Caf\xe9')

    def test_imported_file_is_stored_as_m3u_in_the_old_format(self):
        store, records = self.link_store()
        # Detected by content, so a mislabelled file name still works.
        saved = store.import_file({'name': 'Stations.m3u', 'text': '\ufeff' + SAMPLE.replace('\n', '\r\n'), 'default_type': 'radio'})
        self.assertEqual(set(records[0]), {'id', 'name', 'text', 'default_type'})
        self.assertEqual(records[0]['name'], 'Stations.m3u')
        stored = records[0]['text']
        self.assertTrue(stored.startswith('#EXTM3U\n'))
        self.assertNotIn('<', stored)
        reparsed = parse_playlist(stored, records[0]['default_type'])
        self.assertEqual(reparsed, {k: saved['playlist'][k] for k in ('items', 'skipped', 'duplicates')})
        self.assertEqual([(item['title'], item['type']) for item in reparsed['items']], [('Station One', 'radio'), ('Station Two', 'radio')])
        self.assertEqual(reparsed['items'][0]['_extra']['artworkUrl'], 'https://example.com/one.png')
        self.assertEqual(store.list()[0]['items'], reparsed['items'])

    def test_bad_file_is_not_stored(self):
        store, records = self.link_store()
        with self.assertRaisesRegex(ValueError, 'DTD'):
            store.import_file({'name': 'a.xspf', 'text': '<!DOCTYPE playlist><playlist/>', 'default_type': 'tv'})
        self.assertEqual(records, [])

    def test_online_xspf_link_without_extension_is_detected_and_resolves_relative_entries(self):
        fetcher = mock.Mock()
        body = SAMPLE.replace('http://example.com/stream1', 'streams/live').replace('https://example.com/one.png', 'img/one.png')
        fetcher.fetch.return_value = SimpleNamespace(data=body.encode('utf-8'), url='https://cdn.example.org/lists/get?id=7')
        store, records = self.link_store(fetcher)
        saved = store.import_link({'url': 'https://example.org/get?id=7', 'name': '', 'kind': 'playlist', 'default_type': 'radio'})
        self.assertIn('application/xspf+xml', fetcher.fetch.call_args.kwargs['allowed_types'])
        self.assertIn('application/xspf+xml', fetcher.fetch.call_args.kwargs['accept'])
        items = saved['playlist']['items']
        self.assertEqual([item['stream_url'] for item in items], ['https://cdn.example.org/lists/streams/live', 'https://example.com/stream2'])
        self.assertEqual(items[0]['_extra']['artworkUrl'], 'https://cdn.example.org/lists/img/one.png')
        # With no name typed, the playlist's own title is used instead of the host name.
        self.assertEqual(saved['playlist']['name'], 'My Stations')
        self.assertTrue(records[0]['text'].startswith('#EXTM3U\n'))
        self.assertEqual(set(records[0]), {'id', 'name', 'text', 'default_type', 'base_url'})
        self.assertEqual(store.list()[0]['items'], items)

    def test_typed_name_beats_the_xspf_title(self):
        fetcher = mock.Mock()
        fetcher.fetch.return_value = SimpleNamespace(data=SAMPLE.encode('utf-8'), url='https://example.org/a.xspf')
        store, _ = self.link_store(fetcher)
        saved = store.import_link({'url': 'https://example.org/a.xspf', 'name': 'Mine', 'kind': 'playlist', 'default_type': 'tv'})
        self.assertEqual(saved['playlist']['name'], 'Mine')

    def test_malicious_online_xspf_is_a_clean_error_and_not_stored(self):
        fetcher = mock.Mock()
        fetcher.fetch.return_value = SimpleNamespace(data=b'<!DOCTYPE playlist [<!ENTITY a "x">]><playlist/>', url='https://example.org/a')
        store, records = self.link_store(fetcher)
        with self.assertRaisesRegex(ValueError, 'DTD or entity declarations'):
            store.import_link({'url': 'https://example.org/a', 'name': '', 'kind': 'playlist', 'default_type': 'tv'})
        self.assertEqual(records, [])

    def test_xspf_link_saved_as_a_single_channel_is_refused(self):
        store, records = self.link_store(mock.Mock())
        with self.assertRaisesRegex(ValueError, 'Choose Online playlist'):
            store.import_link({'url': 'https://example.org/radio.XSPF', 'name': '', 'kind': 'stream', 'default_type': 'radio'})
        self.assertEqual(records, [])


if __name__ == '__main__':
    unittest.main()
