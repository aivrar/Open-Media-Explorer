# Open Media Explorer v0.1.15

Channels, stations and episodes load faster and keep loading through a poor
connection, and more podcast episodes and recordings are listed and play.

- **Radio stations load much faster.** The Library asks Radio Browser for 300
  stations at a time where it asked for 30: 14,700 stations in 104 seconds on
  the test connection, where v0.1.14 collected about 690.
- **Lists are sent compressed.** The TV list is 2.5 MB on the wire where it
  was 17.9 MB.
- **A server with a dead or slow address no longer holds things up.** The app
  tries all of a server's addresses together and uses the first that connects.
  A podcast file that did not start within a minute now starts in about seven
  seconds.
- **After the connection drops,** the sources that failed are asked again by
  themselves when it comes back, in the Library, the Tuner and the Grid. A
  source that stays silent says so ("LibriVox is not answering") and is tried
  again every few minutes; **Retry now** tries at once.
- **Owncast and the media.ccc.de live rooms** are listed from the start,
  whichever Library view is open. Before, they stayed at 0 until a view that
  includes them was opened.
- **More podcast episodes.** Episodes published as M4A, AAC, Ogg, Opus, FLAC,
  WAV, WebM, M4V and MOV are listed and play; before, only MP3, MP4 and HLS
  were. A show that publishes only such files now has episodes.
- **More recordings play:** media.ccc.de talks that exist only as WebM, Opus
  or a translation, Wikimedia Commons FLAC and Opus files, and Internet
  Archive items where an old Theora file was picked over an MP4.
- **Downloads:** an M4A that its server labels as video is no longer refused.
- The README and the wiki have new screenshots and four short GIF demos.

Everything else is as in
[v0.1.14](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.14).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.15-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.14
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
