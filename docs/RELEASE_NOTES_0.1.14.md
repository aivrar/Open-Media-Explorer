# Open Media Explorer v0.1.14

One fix: stations on an old Shoutcast server play.

- **Old Shoutcast stations:** some stations did not play in the app although
  their address worked in a browser or another player. They run on an old
  Shoutcast server (version 1), which starts its answer with "ICY 200 OK"
  where a web server says "HTTP/1.0 200 OK", and the app refused that first
  line. It now reads that answer like any other: the station plays, shows its
  song titles, and can be recorded.

Everything else is as in
[v0.1.13](https://github.com/aivrar/Open-Media-Explorer/releases/tag/v0.1.13).

Thanks to TaxicabMessiah for the report in
[issue #6](https://github.com/aivrar/Open-Media-Explorer/issues/6).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.14-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.13
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
