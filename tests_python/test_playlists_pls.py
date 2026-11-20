from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worldmedia_playlists import MAX_PLAYLIST_BYTES, PlaylistStore, as_m3u, is_pls, parse_playlist, pls_to_m3u

SAMPLE = '''[playlist]
NumberOfEntries=2
File1=http://example.com/stream1
Title1=Station One
Length1=-1
File2=https://example.com/stream2
Title2=Station Two
Length2=-1
Version=2
'''


def parse_pls(text: str, default_type: str = 'tv', base_url: str = '') -> dict:
    return parse_playlist(pls_to_m3u(text), default_type, base_url)


class PlsTests(unittest.TestCase):
    def link_store(self, fetcher=None):
        store = PlaylistStore(Path('unused.json'), fetcher=fetcher)
        records = []
        store._read = lambda: records.copy()
        store._save = lambda entries: records.__setitem__(slice(None), entries)
        return store, records

    def test_sample_becomes_plain_m3u(self):
        self.assertEqual(pls_to_m3u(SAMPLE), (
            '#EXTM3U\n'
            '#EXTINF:-1,Station One\nhttp://example.com/stream1\n'
            '#EXTINF:-1,Station Two\nhttps://example.com/stream2\n'
        ))
        items = parse_pls(SAMPLE)['items']
        self.assertEqual([(item['title'], item['stream_url']) for item in items], [
            ('Station One', 'http://example.com/stream1'), ('Station Two', 'https://example.com/stream2'),
        ])

    def test_detection_is_by_content(self):
        self.assertTrue(is_pls(SAMPLE))
        self.assertTrue(is_pls('\ufeff\r\n; made by a radio site\r\n# another note\r\n  [PlayList]  \r\nFile1=https://example.org/a\r\n'))
        self.assertFalse(is_pls('#EXTM3U\n#EXTINF:-1,[playlist]\nhttps://example.org/a\n'))
        self.assertFalse(is_pls('https://example.org/a\n[playlist]\n'))
        self.assertFalse(is_pls(''))
        self.assertFalse(is_pls(None))
        m3u = '#EXTM3U\n#EXTINF:-1,Music\nhttps://example.org/live.m3u8\n'
        self.assertIs(as_m3u(m3u), m3u)
        self.assertTrue(is_pls('; comment\n;another\n[playlist]\nFile1=https://example.org/a\n'))
        self.assertTrue(is_pls('# comment\n#another\n[playlist]\nFile1=https://example.org/a\n'))

    def test_a_valid_m3u_is_never_read_as_pls(self):
        for m3u in ['#EXTM3U\n[playlist]\nhttps://example.org/live\n', '﻿\r\n  #extm3u\r\n[playlist]\r\nhttps://example.org/live\r\n']:
            with self.subTest(m3u=m3u):
                self.assertFalse(is_pls(m3u))
                self.assertIs(as_m3u(m3u), m3u)
                self.assertEqual([item['stream_url'] for item in parse_playlist(as_m3u(m3u))['items']], ['https://example.org/live'])

    def test_empty_file_message_names_pls(self):
        with self.assertRaisesRegex(ValueError, r'^Choose a non-empty M3U, M3U8, PLS, XSPF, JSON or CSV channel playlist\.$'):
            parse_playlist('', 'tv')

    def test_mixed_case_keys(self):
        items = parse_pls('[PLAYLIST]\nnumberofentries=1\nFILE1=https://example.org/a\ntItLe1=Mixed\n')['items']
        self.assertEqual([(item['title'], item['stream_url']) for item in items], [('Mixed', 'https://example.org/a')])

    def test_entries_follow_their_numbers_with_gaps_and_titles_without_files(self):
        text = ('[playlist]\nFile10=https://example.org/ten\nTitle3=Three\nFile1=https://example.org/one\n'
                'Title2=No file\nFile3=https://example.org/three\nTitle10=Ten\nTitle1=One\n')
        items = parse_pls(text)['items']
        self.assertEqual([item['title'] for item in items], ['One', 'Three', 'Ten'])

    def test_bom_crlf_blank_lines_comments_and_spaces_around_equals(self):
        text = '\ufeff[playlist]\r\n\r\n; comment\r\n# also a comment\r\n  File1  =  https://example.org/a  \r\n Title1 = Spaced \r\n\r\n'
        items = parse_pls(text)['items']
        self.assertEqual([(item['title'], item['stream_url']) for item in items], [('Spaced', 'https://example.org/a')])

    def test_missing_or_empty_title_uses_the_m3u_fallback(self):
        items = parse_pls('[playlist]\nFile1=https://example.org/a\nFile2=https://example.org/b\nTitle2=\n')['items']
        self.assertEqual([item['title'] for item in items], ['Channel 1', 'Channel 2'])

    def test_titles_keep_equals_signs_commas_and_quotes_as_text(self):
        text = '[playlist]\nFile1=https://example.org/a\nTitle1=News, Talk = "Live" radio="true" 100%\n'
        self.assertEqual(pls_to_m3u(text), '#EXTM3U\n#EXTINF:-1,News, Talk = "Live" radio="true" 100%\nhttps://example.org/a\n')
        item = parse_pls(text)['items'][0]
        self.assertEqual(item['title'], 'News, Talk = "Live" radio="true" 100%')
        self.assertEqual(item['type'], 'tv')  # The title cannot set M3U attributes.

    def test_titles_and_files_cannot_inject_m3u_lines(self):
        text = ('[playlist]\nTitle1=Name\u2028#EXTVLCOPT:http-user-agent=Injected\x0b#EXT-X-ENDLIST\x00\n'
                'File1=https://example.org/a\nFile2=#EXT-X-TARGETDURATION:10\nFile3=#EXTVLCOPT:http-user-agent=Injected\n')
        converted = pls_to_m3u(text)
        self.assertEqual([line for line in converted.splitlines() if line.startswith('#')], ['#EXTM3U', '#EXTINF:-1,Name'])
        result = parse_playlist(converted)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['capture_headers'], {})

    def test_duplicate_keys_and_junk_lines_do_not_raise(self):
        text = 'junk before\n[playlist]\nFile1=https://example.org/old\nFile1=https://example.org/new\nnot a key\n=\nFileX=https://example.org/x\n[other]\n'
        self.assertTrue(is_pls('[playlist]\n' + text))
        items = parse_pls(text)['items']
        self.assertEqual([item['stream_url'] for item in items], ['https://example.org/new'])

    def test_unsafe_entries_get_the_same_checks_as_m3u(self):
        bad = ['file:///c:/private.mp3', 'javascript:alert(1)', 'ftp://example.org/a', 'http://127.0.0.1/a', 'http://[::1]/a',
               'http://10.0.0.1/a', 'http://localhost/a', 'https://name:pass@example.org/a', 'C:\\Music\\a.mp3', '../relative.mp3',
               'https://example.org/a|User-Agent=x', 'https://example.org/a b']
        lines = ['[playlist]'] + [f'File{n}={url}' for n, url in enumerate(bad, 1)] + [f'File{len(bad) + 1}=https://example.org/ok']
        result = parse_pls('\n'.join(lines))
        self.assertEqual(result['skipped'], len(bad))
        self.assertEqual([item['stream_url'] for item in result['items']], ['https://example.org/ok'])

    def test_no_usable_entries_gives_the_empty_playlist_error(self):
        for text in ['[playlist]\n', '[playlist]\nNumberOfEntries=0\nVersion=2\n', '[playlist]\nTitle1=Only a title\n', '[playlist]\nFile1=file:///c:/a.mp3\n']:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'No supported public HTTP'):
                parse_pls(text)

    def test_size_limit_applies_before_conversion(self):
        text = '[playlist]\nFile1=https://example.org/a\nTitle1=' + 'x' * MAX_PLAYLIST_BYTES + '\n'
        with self.assertRaisesRegex(ValueError, '8 MiB'):
            pls_to_m3u(text)

    def test_type_follows_the_existing_rule(self):
        text = '[playlist]\nFile1=https://radio.example.org:8000/stream\nFile2=https://radio.example.org/live.mp3\n'
        tv = parse_pls(text, 'tv')['items']
        radio = parse_pls(text, 'radio')['items']
        self.assertEqual([(item['type'], item['stream_kind']) for item in tv], [('tv', 'video'), ('radio', 'audio')])
        self.assertEqual([(item['type'], item['stream_kind']) for item in radio], [('radio', 'audio'), ('radio', 'audio')])

    def test_imported_file_is_stored_as_m3u_in_the_old_format(self):
        store, records = self.link_store()
        # Detected by content, so a mislabelled file name still works.
        saved = store.import_file({'name': 'Stations.m3u', 'text': '\ufeff' + SAMPLE.replace('\n', '\r\n'), 'default_type': 'radio'})
        self.assertEqual(set(records[0]), {'id', 'name', 'text', 'default_type'})
        stored = records[0]['text']
        self.assertTrue(stored.startswith('#EXTM3U\n'))
        self.assertNotIn('[playlist]', stored.lower())
        # The stored text is ordinary M3U: parse_playlist alone gives the same items.
        reparsed = parse_playlist(stored, records[0]['default_type'])
        self.assertEqual(reparsed, {k: saved['playlist'][k] for k in ('items', 'skipped', 'duplicates')})
        self.assertEqual([(item['title'], item['type']) for item in reparsed['items']], [('Station One', 'radio'), ('Station Two', 'radio')])
        self.assertEqual(store.list()[0]['items'], reparsed['items'])

    def test_online_pls_link_is_converted_and_resolves_relative_entries(self):
        fetcher = mock.Mock()
        body = '[playlist]\r\nFile1=streams/live\r\nTitle1=Relative\r\nFile2=https://other.example.org/a.aac\r\n'.encode('utf-8')
        fetcher.fetch.return_value = SimpleNamespace(data=body, url='https://cdn.example.org/lists/radio.pls')
        store, records = self.link_store(fetcher)
        saved = store.import_link({'url': 'https://example.org/radio.pls', 'name': 'Radio', 'kind': 'playlist', 'default_type': 'tv'})
        self.assertIn('audio/x-scpls', fetcher.fetch.call_args.kwargs['allowed_types'])
        self.assertEqual([item['stream_url'] for item in saved['playlist']['items']],
                         ['https://cdn.example.org/lists/streams/live', 'https://other.example.org/a.aac'])
        self.assertTrue(records[0]['text'].startswith('#EXTM3U\n'))
        self.assertEqual(set(records[0]), {'id', 'name', 'text', 'default_type', 'base_url'})
        self.assertEqual(store.list()[0]['items'], saved['playlist']['items'])

    def test_pls_link_saved_as_a_single_channel_is_refused(self):
        store, records = self.link_store(mock.Mock())
        with self.assertRaisesRegex(ValueError, 'Choose Online playlist'):
            store.import_link({'url': 'https://example.org/radio.pls', 'name': '', 'kind': 'stream', 'default_type': 'radio'})
        self.assertEqual(records, [])


if __name__ == '__main__':
    unittest.main()
