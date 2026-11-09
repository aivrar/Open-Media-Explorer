# Open Media Explorer v0.1.5

A fix for the portable ZIP.

- **Portable ZIP opens again:** since v0.1.2 the portable ZIP started its
  background server but never opened a window. The ZIP was missing two
  window-component runtime folders that the app checks for at startup, and
  Windows refused to load the app's bundled .NET files after the ZIP was
  extracted from a download. Both are fixed.
- **Clean exit on startup failure:** if the portable version can't open its
  window, it now closes and writes the reason to
  `WorldMediaWindows-data\logs\native.log` instead of staying hidden in the
  background.
- The single-file EXE was not affected and has no other changes in this release.

Thanks to TaxicabMessiah for the clear report in
[issue #3](https://github.com/aivrar/Open-Media-Explorer/issues/3).

## Download and update

- `WorldMediaWindows.exe`: classic single-file portable application (unsigned).
- `WorldMediaWindows-0.1.5-portable.zip`: complete portable folder, with the signed
  Python runtime launcher. Extract the entire package and keep its files together.
- `SHA256SUMS.txt`: checksums for both downloads.

Close the old app and back up **WorldMediaWindows-data** first. For the single-file
version, replace only the EXE; keep your data, downloads, and tools. v0.1.4
remains available for rollback.

[User wiki](https://github.com/aivrar/Open-Media-Explorer/wiki)
and [full changelog](https://github.com/aivrar/Open-Media-Explorer/blob/main/CHANGELOG.md).
