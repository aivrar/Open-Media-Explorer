from __future__ import annotations

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worldmedia_playlist_tables import (
    MAX_TABLE_ENTRIES, looks_like_csv, looks_like_json, read_csv_playlist, read_json_playlist, read_table_playlist,
)
from worldmedia_playlists import MAX_PLAYLIST_BYTES, PlaylistStore, parse_playlist


def store_with(fetcher=None):
    store = PlaylistStore(Path('unused.json'), fetcher=fetcher)
    records = []
    store._read = lambda: records.copy()
    store._save = lambda entries: records.__setitem__(slice(None), entries)
    return store, records


def channels(table, default_type='tv'):
    return parse_playlist(table.text, default_type)['items']


RADIO_BROWSER = [
    {"changeuuid": "x", "stationuuid": "9617a958", "name": "Jazz FM, London", "url": "http://example.org/jazz.pls",
     "url_resolved": "https://stream.example.org/jazz.mp3", "homepage": "https://example.org/",
     "favicon": "https://example.org/jazz.png", "tags": "jazz,smooth jazz", "country": "United Kingdom",
     "countrycode": "GB", "language": "english", "codec": "MP3", "bitrate": 128},
    {"name": "News 24", "url_resolved": "https://tv.example.org/news/index.m3u8", "favicon": "", "tags": "",
     "countrycode": "", "language": ""},
]


class JsonTests(unittest.TestCase):
    def test_a_radio_browser_export_works_as_it_is(self):
        table = read_json_playlist(json.dumps(RADIO_BROWSER))
        self.assertEqual(table.dropped, 0)
        self.assertTrue(table.text.startswith('#EXTM3U\n'))
        jazz, news = channels(table, 'radio')
        self.assertEqual((jazz['title'], jazz['stream_url']), ('Jazz FM, London', 'https://stream.example.org/jazz.mp3'))
        self.assertEqual(jazz['_extra']['artworkUrl'], 'https://example.org/jazz.png')
        self.assertEqual((jazz['description'], jazz['country'], jazz['language']), ('jazz', 'GB', 'english'))
        self.assertEqual((jazz['type'], jazz['stream_kind']), ('radio', 'audio'))
        self.assertEqual((news['title'], news['stream_kind']), ('News 24', 'hls'))

    def test_shapes_a_list_an_object_with_a_list_one_station_and_plain_addresses(self):
        listed = {"name": "My Stations", "Channels": [{"Title": "One", "Stream URL": "https://a.example.org/1"}]}
        table = read_json_playlist(json.dumps(listed))
        self.assertEqual(table.title, 'My Stations')
        self.assertEqual([(c['title'], c['stream_url']) for c in channels(table)], [('One', 'https://a.example.org/1')])
        one = read_json_playlist('{"title": "Solo", "url": "https://a.example.org/solo"}')
        self.assertEqual([c['title'] for c in channels(one)], ['Solo'])
        plain = read_json_playlist('\ufeff["https://a.example.org/1", "https://a.example.org/2"]')
        self.assertEqual([c['stream_url'] for c in channels(plain)], ['https://a.example.org/1', 'https://a.example.org/2'])

    def test_json_backups_are_ordered_validated_and_survive_reload(self):
        store, _ = store_with()
        main = 'https://station.example/main.aac'
        backups = [f'https://station.example/backup{i}.aac' for i in range(6)]
        text = json.dumps([
            {'url': main, 'backups': [main, 'http://127.0.0.1/private', 'ftp://station.example/one',
                                      backups[0], backups[0], 'https://station.example/two\n#EXTM3U', *backups[1:]]},
            {'url': 'https://station.example/another.aac'},
        ])
        result = store.import_file({'name': 'test.json', 'text': text, 'default_type': 'radio'})
        first, second = result['playlist']['items']
        self.assertEqual(first['stream_url'], main)
        self.assertEqual(first['_extra']['backupStreamUrls'], backups[:5])
        self.assertNotIn('backupStreamUrls', second['_extra'])
        self.assertEqual(store.list()[0]['items'], result['playlist']['items'])

    def test_the_type_becomes_a_radio_mark_so_auto_still_works(self):
        stations = [{"name": "A", "url": "https://a.example.org/a", "type": "Radio"},
                    {"name": "B", "url": "https://a.example.org/b", "radio": True},
                    {"name": "C", "url": "https://a.example.org/c", "type": "tv"},
                    {"name": "D", "url": "https://a.example.org/d"}]
        table = read_json_playlist(json.dumps(stations))
        self.assertIn('#EXTINF:-1 radio="true",A', table.text)
        self.assertIn('#EXTINF:-1 radio="false",C', table.text)
        parsed = parse_playlist(table.text, 'auto')
        self.assertEqual((parsed['default_type'], parsed['auto']), ('radio', 'majority'))
        self.assertEqual([c['type'] for c in parsed['items']], ['radio', 'radio', 'tv', 'radio'])
        fallback = parse_playlist(read_json_playlist('[{"url": "https://a.example.org/x"}]').text, 'auto')
        self.assertEqual((fallback['default_type'], fallback['auto']), ('tv', 'fallback'))

    def test_values_can_never_add_lines_or_attributes(self):
        stations = [{"name": "Evil\n#EXTINF:-1,Injected\nhttps://evil.example.org/x\u2028more",
                     "url": "https://a.example.org/1", "group": 'Rock" tvg-logo="https://evil.example.org/l.png',
                     "logo": 'https://a.example.org/l.png" group-title="x', "language": "en\r\nhttps://evil.example.org/y"},
                    {"name": "Bad address", "url": "https://a.example.org/2\n#EXTM3U"}]
        table = read_json_playlist(json.dumps(stations))
        lines = table.text.splitlines()
        self.assertEqual(len(lines), 3, lines)
        items = channels(table)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['title'], 'Evil #EXTINF:-1,Injected https://evil.example.org/x more')
        self.assertEqual(items[0]['description'], "Rock' tvg-logo='https://evil.example.org/l.png")
        self.assertEqual(items[0]['_extra']['artworkUrl'], '')
        self.assertEqual(table.dropped, 1)

    def test_private_local_and_other_addresses_are_skipped_like_any_playlist(self):
        stations = [{"name": "Local", "url": "http://192.168.1.10/live"}, {"name": "File", "url": "file:///C:/x.mp3"},
                    {"name": "Fine", "url": "https://a.example.org/fine"}, 7, None, {"name": "No address"}]
        table = read_json_playlist(json.dumps(stations))
        self.assertEqual(table.dropped, 3)
        parsed = parse_playlist(table.text, 'tv')
        self.assertEqual(([c['title'] for c in parsed['items']], parsed['skipped']), (['Fine'], 2))

    def test_clear_messages_for_what_cannot_be_read(self):
        cases = {
            '': r'^This JSON playlist is empty\.$',
            '[{"url": "https://a.example.org/1",}]':
                r'^This JSON playlist could not be read\. The file is not valid JSON \(line 1, column 35\)\.$',
            '{"stations": [\n  {"url": "x"} oops\n]}':
                r'^This JSON playlist could not be read\. The file is not valid JSON \(line 2, column 16\)\.$',
            '[' * 100_000: r'^This JSON playlist could not be read\. The file is not valid JSON, or its lists',
            '{"version": 1}': r'^This JSON file has no list of stations\.',
            '"https://a.example.org/1"': r'^This JSON file has no list of stations\.',
            '[{"name": "x"}, 5]': r'^No entry in this JSON playlist has a stream address\.',
            json.dumps(['https://a.example.org/1'] * (MAX_TABLE_ENTRIES + 1)): r'more than 50,000 entries',
            '[' + ' ' * MAX_PLAYLIST_BYTES + ']': r'exceeds the 8 MiB import limit',
        }
        for text, message in cases.items():
            with self.subTest(text=text[:40]):
                with self.assertRaisesRegex(ValueError, message):
                    read_json_playlist(text)


class CsvTests(unittest.TestCase):
    def test_a_header_names_the_columns_with_comma_semicolon_or_tab(self):
        for sep in (',', ';', '\t'):
            with self.subTest(sep=repr(sep)):
                text = (f'Station Name{sep}Stream URL{sep}Logo{sep}Group{sep}Type\r\n'
                        f'"Jazz{sep} FM"{sep}https://a.example.org/jazz{sep}https://a.example.org/j.png{sep}Jazz{sep}radio\r\n'
                        f'\r\n'
                        f'News{sep}https://a.example.org/news.m3u8{sep}{sep}{sep}tv\r\n')
                table = read_csv_playlist(text)
                items = channels(table)
                self.assertEqual([(c['title'], c['type'], c['description']) for c in items],
                                 [(f'Jazz{sep} FM'.replace('\t ', ' '), 'radio', 'Jazz'), ('News', 'tv', '')])
                self.assertEqual(items[0]['_extra']['artworkUrl'], 'https://a.example.org/j.png')

    def test_quoted_line_breaks_stay_in_one_name_and_rows_without_an_address_are_counted(self):
        table = read_csv_playlist('name,url\n"Two\nlines",https://a.example.org/1\nNo address,\n')
        self.assertEqual([c['title'] for c in channels(table)], ['Two lines'])
        self.assertEqual(table.dropped, 1)

    def test_a_list_without_a_header_is_read_when_it_has_addresses(self):
        table = read_csv_playlist('Jazz,https://a.example.org/jazz\nRock,https://a.example.org/rock\n')
        self.assertEqual([(c['title'], c['stream_url']) for c in channels(table)],
                         [('Jazz', 'https://a.example.org/jazz'), ('Rock', 'https://a.example.org/rock')])

    def test_separators_inside_quotes_do_not_decide_the_separator(self):
        table = read_csv_playlist('"News, Weather, Traffic";https://example.com/live\n')
        self.assertEqual([(c['title'], c['stream_url']) for c in channels(table)],
                         [('News, Weather, Traffic', 'https://example.com/live')])
        header = read_csv_playlist('name;url\n"Rock, Pop, and more";https://a.example.org/1\nJazz;https://a.example.org/2\n')
        self.assertEqual([c['title'] for c in channels(header)], ['Rock, Pop, and more', 'Jazz'])

    def test_the_first_record_may_span_lines_and_the_separator_that_fits_every_row_wins(self):
        table = read_csv_playlist('"Morning,\nshow, news";https://a.example.org/1\nJazz;https://a.example.org/2\n')
        self.assertEqual([(c['title'], c['stream_url']) for c in channels(table)],
                         [('Morning, show, news', 'https://a.example.org/1'), ('Jazz', 'https://a.example.org/2')])
        # Tabs split every row the same way; the commas inside the names do not.
        tabbed = read_csv_playlist('name\turl\nA, B\thttps://a.example.org/1\nC\thttps://a.example.org/2\n')
        self.assertEqual([c['title'] for c in channels(tabbed)], ['A, B', 'C'])

    def test_clear_messages_for_what_cannot_be_read(self):
        cases = {
            '': r'^This CSV playlist is empty\.$',
            'name,logo\nJazz,https://a.example.org/l.png\n': r'^This CSV playlist has no column for the stream address\.',
            'Jazz,Rock\nPop,Soul\n': r'^This CSV playlist has no header row and no stream addresses\.',
            'name,url\nJazz,\n': r'^No row in this CSV playlist has a stream address\.$',
            'name,url\n"Jazz"x,https://a.example.org/1\n':
                r'^This CSV playlist could not be read\. Line 2 has a quotation mark out of place\. ',
            'name,url\n"Jazz,https://a.example.org/1\n':
                r'^This CSV playlist could not be read\. Near line 2, a value in quotation marks is never closed\. ',
            # Opened on line 3 and never closed: line 3 is named, not the last line.
            'name,url\nRock,https://a.example.org/0\n"Jazz,https://a.example.org/1\nPop,https://a.example.org/2\n':
                r'^This CSV playlist could not be read\. Near line 3, a value in quotation marks is never closed\. ',
            # After blank lines too.
            'name,url\n\n\n"Jazz,https://a.example.org/1\nPop,https://a.example.org/2\n':
                r'^This CSV playlist could not be read\. Near line 4, a value in quotation marks is never closed\. ',
            'name,url\n"' + 'x' * 200_000 + '",https://a.example.org/1\n':
                r'^This CSV playlist could not be read\. Line 2 has a value that is too long\.$',
            'url\n' + 'https://a.example.org/1\n' * (MAX_TABLE_ENTRIES + 1): r'more than 50,000 entries',
        }
        for text, message in cases.items():
            with self.subTest(text=text[:40]):
                with self.assertRaisesRegex(ValueError, message):
                    read_csv_playlist(text)


class ChoosingTheFormatTests(unittest.TestCase):
    def test_a_file_name_decides_and_the_text_decides_without_one(self):
        m3u = '#EXTM3U\n#EXTINF:-1,One\nhttps://a.example.org/1\n'
        self.assertIsNone(read_table_playlist(m3u, 'list.m3u'))
        self.assertIsNone(read_table_playlist('[playlist]\nFile1=https://a.example.org/1\n', 'list.pls'))
        self.assertIsNone(read_table_playlist('[playlist]\nFile1=https://a.example.org/1\n'))
        self.assertFalse(looks_like_json('[playlist]\nFile1=x\n'))
        self.assertTrue(looks_like_json(' \n{"stations": []}'))
        self.assertIsNone(read_table_playlist('<playlist/>'))
        with self.assertRaisesRegex(ValueError, r'^This JSON playlist could not be read'):
            read_table_playlist(m3u, 'Stations.JSON')
        with self.assertRaisesRegex(ValueError, r'no header row and no stream addresses'):
            read_table_playlist('just words\n', 'stations.csv')
        self.assertTrue(looks_like_csv('name;url\nA;https://a.example.org/1\n'))
        for text in (m3u, 'https://a.example.org/1,2\n', 'name,logo\n', 'url\nhttps://a.example.org/1\n'):
            self.assertFalse(looks_like_csv(text), text)


class ImportTests(unittest.TestCase):
    def test_import_file_stores_m3u_and_counts_entries_without_an_address(self):
        store, records = store_with()
        text = json.dumps([{"name": "One", "url": "https://a.example.org/1", "type": "radio"}, {"name": "None"}])
        result = store.import_file({'name': 'Stations.json', 'text': text, 'default_type': 'auto'})
        playlist = result['playlist']
        self.assertEqual([c['title'] for c in playlist['items']], ['One'])
        self.assertEqual((playlist['skipped'], playlist['default_type'], playlist['auto']), (1, 'radio', 'majority'))
        self.assertEqual(records[0]['name'], 'Stations.json')
        self.assertEqual(records[0]['default_type'], 'radio')
        self.assertTrue(records[0]['text'].startswith('#EXTM3U\n'))
        # What is stored reads back the same, as an M3U list (older versions too).
        self.assertEqual([c['title'] for c in store.list()[0]['items']], ['One'])
        csv_result = store.import_file({'name': 'more.CSV', 'text': 'name,url\nTwo,https://a.example.org/2\n',
                                        'default_type': 'tv'})
        self.assertEqual([c['title'] for c in csv_result['playlist']['items']], ['Two'])
        with self.assertRaisesRegex(ValueError, r'^This CSV playlist has no header row'):
            store.import_file({'name': 'bad.csv', 'text': 'nothing here\n', 'default_type': 'tv'})
        self.assertEqual(len(records), 2)

    def test_online_json_and_csv_lists_come_through_the_same_fetcher(self):
        body = json.dumps({"name": "Their list", "stations": [
            {"name": "One", "url": "https://a.example.org/1"},
            {"name": "Relative", "url": "two.mp3", "backups": ["two.mp3", "../backup.mp3"]}, {"x": 1}]})
        fetcher = mock.Mock()
        fetcher.fetch.return_value = SimpleNamespace(data=body.encode('utf-8'), url='https://lists.example.org/a/list')
        store, records = store_with(fetcher)
        result = store.import_link({'url': 'https://lists.example.org/a/list', 'name': '', 'default_type': 'auto',
                                    'kind': 'playlist'})
        kwargs = fetcher.fetch.call_args.kwargs
        for kind in ('application/json', 'text/csv'):
            self.assertIn(kind, kwargs['allowed_types'])
            self.assertIn(kind, kwargs['accept'])
        self.assertEqual(kwargs['max_decoded'], MAX_PLAYLIST_BYTES)
        playlist = result['playlist']
        self.assertEqual(playlist['name'], 'Their list')
        self.assertEqual([(c['title'], c['stream_url']) for c in playlist['items']],
                         [('One', 'https://a.example.org/1'), ('Relative', 'https://lists.example.org/a/two.mp3')])
        self.assertEqual(playlist['skipped'], 1)
        self.assertEqual(records[0]['base_url'], 'https://lists.example.org/a/list')
        self.assertEqual(playlist['items'][1]['_extra']['backupStreamUrls'], ['https://lists.example.org/backup.mp3'])
        fetcher.fetch.return_value = SimpleNamespace(data=b'Name;URL\nCSV one;https://a.example.org/c\n',
                                                     url='https://lists.example.org/b.csv')
        result = store.import_link({'url': 'https://lists.example.org/b.csv', 'name': 'Mine', 'default_type': 'tv',
                                    'kind': 'playlist'})
        self.assertEqual([c['title'] for c in result['playlist']['items']], ['CSV one'])
        self.assertEqual(fetcher.fetch.call_count, 2)

    def test_a_json_or_csv_link_is_not_a_single_channel(self):
        store, _ = store_with()
        for url in ('https://a.example.org/list.json', 'https://a.example.org/list.csv'):
            with self.assertRaisesRegex(ValueError, r'^This looks like a channel list\. Choose Online playlist instead\.$'):
                store.import_link({'url': url, 'name': '', 'default_type': 'tv', 'kind': 'stream'})


if __name__ == '__main__':
    unittest.main()
