# v0.1.18 release verification - 2026-11-26

This release redesigns the Tuner, adds video quality choices, improves the
player bar in narrow windows and fixes issues reported by TaxicabMessiah in
issue #6. See the [release notes](RELEASE_NOTES_0.1.18.md).

## What changed and why

- **Tuner.** The dial, optional tone knobs and station list have their own
  space. Radio and TV share the layout. A loading or stopped channel holds
  its picture area, and the list keeps the tuned station in view.
- **Bars.** The player bar gives up room in a fixed order as the window
  narrows. The header and Tuner bar use even gaps and matching control
  heights within each bar.
- **Picture and Visualizer.** **Quality** follows the size of the picture and
  the connection in **Auto**, or uses a level you choose. The Visualizer
  behind the Tuner also runs during TV and video playback.
- **Issue #6.** Picture drops highlight the target card and preview the
  image while it saves. Video controls use lighter shading and icon shadows.
  Favorites scroll during a drag near the edge. **Pick the best stream**
  explains its three choices in a list. The room for video is held during
  a channel change so the scrolled view stays in place.

## Evidence

- `npm test` reported 1,979 passing JavaScript tests. Python unit tests
  reported 743 passing tests and 8 skips for Windows symlink permissions.
  `ruff check --select F,E9` passed.
- In the application window on the test machine, the Tuner layout was checked
  at 1024 × 640, 1280 × 800, 1920 × 1080 and the smallest window size, in
  both themes, on Radio and TV and with every toggle combination.
- Keyboard and wheel controls were checked on the dial and list, along with
  the TV picture and the placeholder after Stop.
- Picture quality was switched on a public test channel. On the test
  machine and test connection, fixed 1080p appeared in about 5 seconds
  and 360p in about 2 seconds. **Auto** stepped up in about 5 seconds and
  down in about 1 second.
- A picture was dropped on a Library card, and the video controls' shading
  was checked. Drag auto-scroll was checked with 72 favorites. The
  **Pick the best stream** text and the Library scroll position through a
  channel change were also checked.
- The release EXE and the extracted portable ZIP were each started without a
  window: the health check, the start page, all 131 front-end files byte for
  byte, the token check and a clean shutdown passed. Each also opened its
  window with every file marked as downloaded from the internet, and closed
  with exit code 0.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,752,525 | `42DCAD5B65E5991E370217F408425D8116B7994DDDD04A224096081E0538654A` |
| `WorldMediaWindows-0.1.18-portable.zip` | 15,499,420 | `DB72BD6FACC0AAC7A8FCEACADE0C7C859FF4F8FC7914088B24E8465B47898364` |

## Boundaries

- The stream supplies the available quality levels. **Quality** appears
  when there are at least two levels to choose from.
- FLAM3 Density Lab, IFS / L-System Lab, Attractor Density Lab and Hypercomplex
  Slice Flight remain held back.
