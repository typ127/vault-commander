# Changelog

All notable changes to **Vault Commander** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-07-12

First feature update since the initial release. Adds a file viewer with paging,
a file clipboard, an in-app configuration screen, screen savers, and a set of
retro tools and games — plus a round of correctness fixes.

### Added
- **F3 file viewer** with Prev/Next paging through the panel's files (folders and
  unviewable files are skipped), a blue Markdown theme, and syntax highlighting.
- **File clipboard** — Copy / Cut / Paste with `Ctrl/Cmd+C` · `X` · `V`. Paste
  accepts the commander's own clipboard, files copied in the OS file manager, and
  a raster image on the clipboard (saved as a new PNG). Edit menus expose the same
  actions.
- **Rename in place** with `Ctrl+R`.
- **Clickable path header** — each segment of a panel's breadcrumb navigates to
  that folder.
- **Configuration screen** — in-app settings for the plugin.
- **Screen savers** — several animated savers (matrix, starfield, lines, …) that
  start after an idle period.
- **Tools & games** (Turbo-Vision styled, keyboard-navigable): Calculator,
  Calendar, 15-Puzzle, and Tetris (with mobile touch controls).
- **ASCII chart** and **Symbols chart** with a copy button.
- **Confirmation dialogs** for delete and for edit actions.

### Changed
- The panel background now updates while browsing files in the viewer.

### Fixed
- **Rename no longer overwrites an existing file.** Renaming an entry onto the
  name of an existing sibling is refused with a notice instead of silently
  clobbering it (case-only renames on case-insensitive filesystems still work).
- **Copy → paste into the same folder now creates a duplicate**
  (`file` → `file copy`, `file copy 2`, …) instead of prompting to overwrite the
  file with itself.
- **`Ctrl/Cmd+C` no longer hijacks text selection.** Copying selected text in the
  Quick View / Info / Tree panes now performs a normal text copy; the file
  clipboard only triggers when no text is selected.
- **Panel path is no longer blank at the vault root** — the header shows `/` again.
- **Tetris no longer keeps running after the view is closed.** Its timer and
  touch listeners are torn down when the pane closes, fixing background CPU use
  and stray touch input.
- **Screen savers can be dismissed by keyboard, mouse movement, or a click** (and
  immediately after the "Test" button), not only by moving the pointer out and
  back in.
- **The F3 viewer no longer moves the panel cursor** while paging, so your
  position in the listing is preserved after closing it.
- **Calculator** now shows `Error` for division by zero instead of `0`.
- **Info panel no longer freezes on large folders.** The recursive folder-size
  calculation now runs in the background, is debounced until the cursor settles,
  and is cancelled as soon as you move on — so pointing the other panel at a huge
  directory tree no longer hangs the app.

[1.1.0]: https://github.com/typ127/vault-commander/compare/1.0.0...1.1.0
