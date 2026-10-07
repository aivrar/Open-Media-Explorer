"""Prepare the GitHub wiki checkout from version-controlled docs (no push)."""
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/wiki'
REPO = 'https://github.com/aivrar/Open-Media-Explorer'
PAGES = {
    'README.md': 'Home',
    '01-installation-and-portable-data.md': 'Installation-and-Portable-Data',
    '02-using-the-application.md': 'Using-the-Application',
    '03-sources-and-channels.md': 'Sources-and-Channels',
    '04-playback-eq-downloads-recording.md': 'Playback-EQ-Downloads-and-Recording',
    '05-data-cache-and-portability.md': 'Data-Cache-and-Portability',
    '06-troubleshooting.md': 'Troubleshooting',
    '07-developer-and-release-guide.md': 'Developer-and-Release-Guide',
    '08-architecture-and-runtime-reference.md': 'Architecture-and-Runtime-Reference',
}

def prepare(destination: Path):
    if not (destination / '.git').is_dir():
        raise ValueError('Destination must be an existing wiki Git checkout')
    (destination / 'images').mkdir(exist_ok=True)
    def image_link(match):
        path = (SOURCE / match.group(1)).resolve()
        if not path.is_relative_to(ROOT / 'screenshots'):
            raise ValueError('Unexpected screenshot path')
        shutil.copy2(path, destination / 'images' / path.name)
        return '(<images/' + path.name + '>)'
    for filename, page in PAGES.items():
        text = (SOURCE / filename).read_text(encoding='utf-8')
        text = re.sub(r'\(<(../../screenshots/[^>]+)>\)', image_link, text)
        for original, name in PAGES.items():
            text = text.replace('(' + original + ')', '(' + name + ')')
            text = text.replace('(' + original + '#', '(' + name + '#')
        text = re.sub(r'\(\.\./(?!\.\./)([^\s)]+)\)', lambda m: '(' + REPO + '/blob/main/docs/' + m.group(1) + ')', text)
        text = re.sub(r'\(\.\./\.\./([^\s)]+)\)', lambda m: '(' + REPO + '/blob/main/' + m.group(1) + ')', text)
        (destination / (page + '.md')).write_text(text, encoding='utf-8')
    (destination / '_Sidebar.md').write_text('**Open Media Explorer**\n\n' + ''.join(
        f'- [{name.replace("-", " ")}]({name})\n' for name in PAGES.values()), encoding='utf-8')
    (destination / '_Footer.md').write_text(
        f'[Repository]({REPO}) · [Latest release]({REPO}/releases/latest) · Open Media Explorer 0.1.3\n', encoding='utf-8')
    print(f'Prepared {len(PAGES)} wiki pages in {destination}')

if __name__ == '__main__':
    prepare(Path(sys.argv[1]).resolve())
