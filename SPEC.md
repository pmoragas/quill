# Quill: Spec

A minimalist, cross-platform note-taking app. Notes read with the polish of a LaTeX document, are as easy to write as Markdown, and can embed images, diagrams and animations.

## Goals

- **Beautiful reading.** Typography close to a LaTeX document: serif body, good math, comfortable measure and spacing.
- **Easy to write.** Plain Markdown; no toolbar needed.
- **Easy to embed.** Images, diagrams and animations placed inline with one line of syntax.
- **Minimal UX.** The note fills the window. Everything else stays out of sight until needed.
- **Cross-platform.** macOS, Linux, Windows.

## Non-goals (v1)

- Cloud sync, accounts, collaboration.
- Mobile apps.
- Plugin system.
- Export beyond what is listed below.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview).
- **UI:** vanilla TypeScript + Vite (no framework).
- **Editor:** CodeMirror 6.
- **Rendering:** Markdown parsed to HTML (markdown-it), math via KaTeX.
- **Diagrams:** Mermaid, rendered from fenced code blocks.

## Note format

- A note is a single `.md` file in a user-chosen folder (the *vault*). No database; the files are the source of truth.
- Images and assets are stored in an `assets/` folder next to the notes and referenced by relative path.
- Syntax:
  - Standard Markdown (headings, lists, tables, code, links, images).
  - Math: `$inline$` and `$$block$$` (LaTeX syntax, rendered by KaTeX).
  - Diagrams: ```` ```mermaid ```` fenced blocks.
  - Embeds: `::embed[path-or-url]` renders a sandboxed iframe. Local `.html` files (e.g. an animation) and https URLs are supported.

## Features (v1)

1. **Open a vault folder** and list its notes.
2. **Edit/read toggle.** One keystroke switches a note between the Markdown source and the rendered view. The rendered view is the default when opening a note.
3. **Live math, diagram and image rendering** in the rendered view.
4. **Paste or drag an image** into the editor: it is saved to `assets/` and a link is inserted.
5. **Embeds** via `::embed[...]`, sandboxed (no access to the app).
6. **Quick switcher** (`Ctrl/Cmd+P`): fuzzy-find a note by filename. Typing a name that does not exist offers to create it.
7. **Focus mode** (`Ctrl/Cmd+Shift+F`, `Esc` to leave): hides the sidebar and makes the window fullscreen; only the note is visible.
8. **Light and dark themes**, following the system setting.
9. **Autosave.**

## UX

- Single column, centered, ~70 characters wide.
- Sidebar (note list) is hidden by default; toggled with `Ctrl/Cmd+B`.
- No visible toolbar or menu bar clutter; actions are keyboard-driven.
- Typeface: CMU Serif (Computer Modern) for body and CMU Typewriter for code and the editor. The fonts are bundled so rendering is identical on every OS.
- Paragraphs are justified and hyphenated using the system language.

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | All actions (searchable panel, also the `?` in the pill) |
| `Ctrl/Cmd+N` | New note |
| `Ctrl/Cmd+P` | Find or create a note |
| `Ctrl/Cmd+E` | Toggle reading / writing |
| `Ctrl/Cmd+S` | Save now (autosave also runs) |
| `Ctrl/Cmd+Shift+E` | Export as PDF |
| `Ctrl/Cmd+B` | Toggle the note list |
| `Ctrl/Cmd+Shift+F` | Focus mode |
| `Ctrl/Cmd+O` | Open a vault folder |
| `Ctrl/Cmd+H` | Back to the start screen |

Shortcuts never use Alt, because AltGr arrives as Ctrl+Alt on Windows (needed for `\` on Spanish and Catalan layouts).

### Window chrome

- On Windows and Linux the native title bar is replaced: a floating pill at the top centre (note list, title, save state, Read/Write toggle, all actions) appears when the pointer nears the top edge, flashes on mode change, and stays visible on the start screen or after a failed save. A small handle marks it at rest.
- Minimise, maximise and close sit faint in the top-right corner; the top 32 px strip drags the window. macOS keeps its native title bar.
- Save state: "Saving…", "Saved" (fades after 2 s), or "Couldn't save · Retry" (stays until resolved).
- The start screen lists up to five recent folders.

### Open folder

- `Ctrl/Cmd+O` opens an in-app panel in the switcher's style: a path field (type or paste), the subfolders of that path with their note counts, and recent folders.
- ↑↓ choose, → enter a folder, ← go up, ↵ open. After navigating nothing is selected, so ↵ opens the current folder; the footer says what ↵ will open.
- `Ctrl/Cmd+O` again hands over to the system folder browser (network drives, unusual places).

### Export

- `Ctrl/Cmd+Shift+E` opens the export panel: a live page preview (‹ › to page through), paper (A4, Letter, portrait, landscape), margins (narrow 12 mm, normal 22 mm, wide 32 mm), and options: page numbers, always light theme, include embeds as a link. Choices are remembered.
- **Save PDF** writes `<note>.pdf` next to the note without a dialog, using the webview's own engine: WebView2 `PrintToPdf` on Windows, WebKitGTK print-to-file on Linux. macOS falls back to the system dialog.
- **Print…** hands over to the system print dialog, for paper printers.
- WebKit clips content when CSS `@page` margins are set, so on WebKit margins come from the print settings and CSS only sets the paper size. Page numbers need Chromium (Windows).
- Export renders light by default: diagrams are redrawn light; local embeds load eagerly and receive `#quill-theme=light` in their URL so they can switch palette (embeds that ignore it print as they are).

## Security

- All file access goes through Rust commands confined to the open vault; paths with `..` or absolute paths are rejected.
- Embedded iframes use `sandbox="allow-scripts"` (no same-origin access, no access to the app). Local embeds must resolve to a file inside the vault.
- Raw HTML in Markdown is not rendered.
- A Content Security Policy blocks network requests except embedded https iframes.

## Milestones

All v1 milestones are implemented.

1. **M0, skeleton:** Tauri app builds on Linux, macOS and Windows (CI matrix).
2. **M1, reading:** open a vault, render Markdown + math + typography.
3. **M2, writing:** CodeMirror editor, edit/read toggle, autosave.
4. **M3, embeds:** images (paste/drag), Mermaid, `::embed`.
5. **M4, polish:** quick switcher, focus mode, themes, installers via the release workflow.

## Decisions

- UI is vanilla TypeScript.
- The editor is source-only, with the read/write toggle (no live preview).
- No front-matter in v1.
