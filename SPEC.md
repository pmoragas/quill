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
- **UI:** TypeScript + Vite. Framework choice (Svelte or vanilla) is decided at implementation; keep it small.
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
5. **Embeds** via `::embed[...]`, sandboxed (no access to the vault or the app).
6. **Quick switcher** (`Ctrl/Cmd+P`): fuzzy-find a note by filename.
7. **Focus mode:** hides the sidebar and all chrome; only the note is visible.
8. **Light and dark themes**, following the system setting.
9. **Autosave.**

## UX

- Single column, centered, ~70 characters wide.
- Sidebar (note list) is hidden by default; toggled with `Ctrl/Cmd+\`.
- No visible toolbar or menu bar clutter; actions are keyboard-driven.
- Typeface: a Latin Modern or Computer Modern-style serif for body and a matching monospace for code. Bundle the fonts so rendering is identical on every OS.

## Security

- Embedded iframes use the `sandbox` attribute with scripts allowed but no same-origin access, and are blocked from reaching local files outside the note's own folder.
- No network calls except to load an explicitly embedded https URL.

## Milestones

1. **M0, skeleton:** Tauri app builds and runs on Linux, macOS and Windows (CI matrix).
2. **M1, reading:** open a vault, render Markdown + math + typography.
3. **M2, writing:** CodeMirror editor, edit/read toggle, autosave.
4. **M3, embeds:** images (paste/drag), Mermaid, `::embed`.
5. **M4, polish:** quick switcher, focus mode, themes, packaged installers.

## Open questions

- Svelte or vanilla TypeScript for the UI?
- Should the editor be source-only, or live-preview (like Obsidian)? v1 assumes source-only with the toggle above.
- Should notes support a front-matter block (title, tags)? Not in v1.
