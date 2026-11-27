# Open Media Explorer v0.1.18

The redesigned Tuner puts a station list and TV picture beside the dial.
The **Picture** panel can choose a video quality level, and the player bar
fits narrow windows better. Library picture drops, Favorites reordering and
video channel changes work more smoothly.

- **Tuner.** The dial sits above the optional **Bass**, **Treble** and
  **Loudness** knobs. Point at a knob to see its level in dB. The list keeps
  the tuned station in view, with two columns when there is room. Click a
  station or use the arrow keys and Enter. A wheel notch moves one station
  and wraps at the ends. **Stations** and **Tone knobs** remember what you show.
- **TV on the Tuner.** The picture sits above the list. The channel's art or
  initials, name and **Loading…** or **Stopped** hold its place. Hide the list
  for a larger picture beside the dial. On Radio, hiding the list gives the
  dial more room in the center.
- **Player and top bars.** As the window narrows, the title gives up room
  first. Then the meter, time, **Record** label and second **EQ** line give
  way in that order before the bar uses two rows. The header and Tuner bar
  have even spacing. The **Tone knobs** icon is larger.
- **Visualizer.** The background behind the Tuner also works during TV
  and video playback. Set **Visualizer:** to 0 to turn it off.
- **Video quality.** With two or more available levels, **Quality** under
  **Fit** offers **Auto**, **Best available** and fixed levels such as
  **1080p · 5.86 Mbps**. **Auto** follows the picture size and connection.
  Save the choice **For this channel** or **For all video**. If a fixed
  level fails, the player returns to **Auto** for the session. The panel
  opens on the side where it covers the least of the video picture.
- **Fixes (issue #6).** A picture drag highlights the Library card under
  the pointer, and the new picture appears while it saves. Video controls
  have lighter shading and clearer icons. Dragging a Favorite near an edge
  scrolls the list. **Pick the best stream** explains each choice in a short
  list. Changing video channels keeps the scroll position in Library, Grid,
  About and Now Playing.

Thanks to TaxicabMessiah for the reports in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

## Download and update

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `WorldMediaWindows.exe` | 19,752,525 | `42DCAD5B65E5991E370217F408425D8116B7994DDDD04A224096081E0538654A` |
| `WorldMediaWindows-0.1.18-portable.zip` | 15,499,420 | `DB72BD6FACC0AAC7A8FCEACADE0C7C859FF4F8FC7914088B24E8465B47898364` |

The one-file EXE is unsigned. The ZIP is the complete portable folder with the
signed Python runtime launcher. Extract the entire package and keep its files
together. `SHA256SUMS.txt` lists checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the
single-file version, replace only the EXE and keep your data, downloads and
tools. [v0.1.17](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.17)
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
