import "computer-modern/cmu-serif.css";
import "computer-modern/cmu-typewriter-text.css";
import "katex/dist/katex.min.css";
import "./styles.css";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { createEditor } from "./editor";
import { drawDiagrams } from "./mermaid";
import { setupPalette, type Action } from "./palette";
import { basename, dirname, joinInVault, relativeTo } from "./paths";
import { setupPill } from "./pill";
import { createRenderer } from "./render";
import { setupSwitcher, type SwitcherChoice } from "./switcher";

type Mode = "read" | "edit";
type SaveStatus = "idle" | "saving" | "saved" | "error";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $("scroller");
const welcome = $("welcome");
const welcomeText = $("welcome-text");
const doc = $("doc");
const editorEl = $("editor");
const noteList = $("note-list");
const toast = $("toast");
const appWindow = getCurrentWindow();

const isMac = navigator.userAgent.includes("Mac");
const SAVE_DELAY_MS = 500;
const SAVED_VISIBLE_MS = 2000;
const MAX_RECENT = 5;

const state = {
  vault: null as string | null,
  notes: [] as string[],
  path: null as string | null,
  text: "",
  mode: "read" as Mode,
  dirty: false,
  saveTimer: 0,
  focus: false,
};

// localStorage only remembers conveniences (last vault and note, recent folders); it may be unavailable.
const remember = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not essential */
    }
  },
};

function fileUrl(vaultRelative: string): string {
  const sep = state.vault?.includes("\\") ? "\\" : "/";
  return convertFileSrc(state.vault + sep + vaultRelative.split("/").join(sep));
}

const render = createRenderer(fileUrl);

let toastTimer = 0;
function notify(message: string) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
}

const noteName = (path: string) => basename(path).replace(/\.md$/, "");

// ---------- pill ----------

const pill = setupPill($("pill"));
const pillTitle = $("pill-title");
const pillSave = $("pill-save");
let savedTimer = 0;

function setSaveStatus(status: SaveStatus) {
  clearTimeout(savedTimer);
  const labels: Record<SaveStatus, string> = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    error: "Couldn’t save · Retry",
  };
  pillSave.textContent = labels[status];
  pillSave.dataset.status = status;
  pillSave.tabIndex = status === "error" ? 0 : -1;
  document.body.classList.toggle("save-error", status === "error");
  pill.pin(status === "error" || !state.path);
  if (status === "saved") savedTimer = window.setTimeout(() => setSaveStatus("idle"), SAVED_VISIBLE_MS);
}

function drawPill() {
  pillTitle.textContent = state.path ? noteName(state.path) : "";
  $("pill-list").hidden = !state.vault;
  $("pill-mode").hidden = !state.path;
  $("pill-read").classList.toggle("current", state.mode === "read");
  $("pill-write").classList.toggle("current", state.mode === "edit");
  pill.pin(!state.path || pillSave.dataset.status === "error");
}

pillSave.addEventListener("click", () => {
  if (pillSave.dataset.status === "error") flush();
});
$("pill-read").addEventListener("click", () => setMode("read"));
$("pill-write").addEventListener("click", () => setMode("edit"));
$("pill-list").addEventListener("click", toggleSidebar);

// ---------- window controls (custom title bar on Windows and Linux) ----------

if (!isMac) {
  $("drag-strip").hidden = false;
  $("window-controls").hidden = false;
  $("win-min").addEventListener("click", () => appWindow.minimize());
  $("win-max").addEventListener("click", () => appWindow.toggleMaximize());
  $("win-close").addEventListener("click", () => appWindow.close());
}

// ---------- saving ----------

async function flush() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.path) return;
  state.dirty = false;
  setSaveStatus("saving");
  try {
    await invoke("write_note", { path: state.path, content: state.text });
    setSaveStatus("saved");
  } catch (error) {
    state.dirty = true;
    setSaveStatus("error");
    console.error("save failed", error);
  }
}

const editor = createEditor(editorEl, {
  onChange(text) {
    state.text = text;
    state.dirty = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
  },
  async onImages(files, pos) {
    if (!state.path) return;
    const noteDir = dirname(state.path);
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await invoke<string>("save_asset", bytes, {
          headers: { "x-name": encodeURIComponent(file.name || "pasted.png") },
        });
        const link = `![](${encodeURI(relativeTo(noteDir, saved))})\n`;
        editor.insert(link, pos);
        pos += link.length;
      } catch (error) {
        notify(`Could not save image: ${error}`);
      }
    }
  },
});

// ---------- views ----------

function show(view: "welcome" | "read" | "edit") {
  welcome.hidden = view !== "welcome";
  doc.hidden = view !== "read";
  editorEl.hidden = view !== "edit";
}

/** Resolves when the embeds of the last render have loaded (or after a timeout). */
let embedsReady: Promise<void> = Promise.resolve();

function whenLoaded(frames: HTMLIFrameElement[], timeoutMs = 3000): Promise<void> {
  const loads = frames.map((f) => new Promise<void>((resolve) => f.addEventListener("load", () => resolve(), { once: true })));
  return Promise.race([Promise.all(loads).then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

async function renderDoc() {
  if (!state.path) return;
  const forced = document.documentElement.dataset.theme === "light" ? "light" : undefined;
  doc.innerHTML = render(state.text, state.path, { theme: forced });
  const frames = [...doc.querySelectorAll("iframe")];
  // Exporting needs every embed drawn, not only the ones on screen.
  if (forced) for (const f of frames) f.loading = "eager";
  embedsReady = whenLoaded(frames);
  await drawDiagrams(doc);
}

async function setMode(mode: Mode) {
  if (!state.path) return;
  const changed = mode !== state.mode;
  state.mode = mode;
  drawPill();
  if (changed) pill.flash();
  if (mode === "read") {
    await flush();
    await renderDoc();
    show("read");
  } else {
    show("edit");
    editor.focus();
  }
}

function toggleSidebar() {
  if (state.vault) document.body.classList.toggle("sidebar-open");
}

// ---------- recent folders ----------

function recentFolders(): string[] {
  try {
    const list = JSON.parse(remember.get("recentVaults") ?? "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberFolder(path: string, add: boolean) {
  const rest = recentFolders().filter((p) => p !== path);
  remember.set("recentVaults", JSON.stringify(add ? [path, ...rest].slice(0, MAX_RECENT) : rest));
}

function drawRecent() {
  const folders = recentFolders().filter((p) => p !== state.vault);
  const box = $("recent");
  box.hidden = folders.length === 0;
  box.querySelector("ul")!.replaceChildren(
    ...folders.map((path) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      // Split on either separator but show the path as the OS writes it.
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const name = document.createElement("span");
      name.textContent = path.slice(cut + 1);
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = path.slice(0, Math.max(cut, 0));
      button.append(name, where);
      button.title = path;
      button.addEventListener("click", () => openVault(path));
      li.append(button);
      return li;
    }),
  );
}

function showWelcome() {
  welcomeText.textContent = state.vault
    ? `${state.notes.length} notes in ${basename(state.vault.replace(/\\/g, "/"))}. Press ${isMac ? "⌘" : "Ctrl+"}P to open one.`
    : `Open a folder of Markdown notes to begin.`;
  drawRecent();
  show("welcome");
  drawPill();
}

function drawNoteList() {
  noteList.replaceChildren(
    ...state.notes.map((path) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const folder = dirname(path);
      if (folder) {
        const span = document.createElement("span");
        span.className = "folder";
        span.textContent = `${folder}/`;
        button.append(span);
      }
      button.append(noteName(path));
      button.classList.toggle("current", path === state.path);
      button.addEventListener("click", () => openNote(path));
      li.append(button);
      return li;
    }),
  );
}

// ---------- notes ----------

async function openNote(path: string, mode: Mode = "read") {
  await flush();
  try {
    state.text = await invoke<string>("read_note", { path });
  } catch (error) {
    notify(String(error));
    return;
  }
  state.path = path;
  state.dirty = false;
  editor.load(state.text);
  remember.set("lastNote", path);
  drawNoteList();
  setSaveStatus("idle");
  await appWindow.setTitle(`${noteName(path)} — Quill`);
  await setMode(mode);
  drawPill();
  scroller.scrollTop = 0;
}

/** Saves and closes the current note, returning to the start screen. */
async function goHome() {
  await flush();
  state.path = null;
  state.mode = "read";
  remember.set("lastNote", "");
  drawNoteList();
  await appWindow.setTitle("Quill");
  showWelcome();
  scroller.scrollTop = 0;
}

async function createNote(path: string) {
  try {
    await invoke("write_note", { path, content: `# ${noteName(path)}\n\n` });
    state.notes = await invoke<string[]>("list_notes");
  } catch (error) {
    notify(String(error));
    return;
  }
  await openNote(path, "edit");
}

async function openVault(path: string) {
  await flush();
  try {
    state.notes = await invoke<string[]>("open_vault", { path });
  } catch (error) {
    rememberFolder(path, false);
    if (!state.path) drawRecent();
    notify(String(error));
    return false;
  }
  state.vault = await invoke<string>("vault_path");
  state.path = null;
  remember.set("vault", path);
  rememberFolder(path, true);
  drawNoteList();
  await appWindow.setTitle("Quill");
  showWelcome();
  return true;
}

async function pickVault() {
  const folder = await open({ directory: true, title: "Open a folder of notes" });
  if (typeof folder === "string") await openVault(folder);
}

$("open-folder").addEventListener("click", pickVault);

// ---------- links in the rendered note ----------

doc.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest("a");
  const href = link?.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  event.preventDefault();
  if (/^(https?|mailto):/i.test(href)) {
    openUrl(href);
  } else if (state.path) {
    const target = joinInVault(dirname(state.path), decodeURIComponent(href));
    if (target && state.notes.includes(target)) openNote(target);
  }
});

// ---------- actions ----------

const openSwitcher = setupSwitcher(
  $("switcher"),
  () => state.notes,
  (choice: SwitcherChoice) => (choice.kind === "open" ? openNote(choice.path) : createNote(choice.path)),
);

async function toggleFocus() {
  state.focus = !state.focus;
  document.body.classList.toggle("focus", state.focus);
  await appWindow.setFullscreen(state.focus);
}

/** Prints the note in the light theme; the system dialog offers "Save as PDF". */
async function exportPdf() {
  if (!state.path) return;
  await flush();
  const previousMode = state.mode;
  const previousTitle = document.title;
  const root = document.documentElement;

  root.dataset.theme = "light";
  if (previousMode === "read") await renderDoc();
  else await setMode("read");
  await embedsReady;
  await new Promise((r) => setTimeout(r, 400)); // let embeds draw their first frames

  window.addEventListener(
    "afterprint",
    async () => {
      delete root.dataset.theme;
      document.title = previousTitle;
      if (previousMode === "edit") await setMode("edit");
      else await renderDoc();
    },
    { once: true },
  );
  // The browser suggests the document title as the PDF file name.
  document.title = noteName(state.path);
  window.print();
}

const hasVault = () => !!state.vault;
const hasNote = () => !!state.path;

// One list drives the keyboard shortcuts, the actions panel and the start screen.
const actions: Action[] = [
  { group: "Note", key: "N", label: "New note", run: () => openSwitcher("create"), enabled: hasVault },
  { group: "Note", key: "P", label: "Find or create a note", run: () => openSwitcher(), enabled: hasVault },
  { group: "Note", key: "E", label: "Switch between reading and writing", run: () => setMode(state.mode === "read" ? "edit" : "read"), enabled: hasNote },
  { group: "Note", key: "S", label: "Save now", run: flush, enabled: hasNote },
  { group: "Note", key: "E", shift: true, label: "Export as PDF", run: exportPdf, enabled: hasNote },
  { group: "View", key: "B", label: "Show or hide the note list", run: toggleSidebar, enabled: hasVault },
  { group: "View", key: "F", shift: true, label: "Focus mode (Esc to leave)", run: toggleFocus },
  { group: "Folder", key: "O", label: "Open a folder of notes", run: pickVault },
  { group: "Folder", key: "H", label: "Back to start screen", run: goHome, enabled: hasNote },
];

const palette = setupPalette($("palette"), actions, isMac);
const ALL_ACTIONS_KEY = "K";
$("pill-help").addEventListener("click", () => palette.open());
$("palette-hint").textContent = `${isMac ? "⌘" : "Ctrl"} ${ALL_ACTIONS_KEY} or ?`;

// The start screen shows only the two entry points; everything else lives in the panel.
$("welcome-shortcuts").replaceChildren(
  ...[
    ["O", "Open a folder"],
    [ALL_ACTIONS_KEY, "All actions"],
  ].map(([key, label]) => {
    const row = document.createElement("div");
    const kbd = document.createElement("kbd");
    kbd.textContent = `${isMac ? "⌘" : "Ctrl"} ${key}`;
    const span = document.createElement("span");
    span.textContent = label;
    row.append(kbd, span);
    return row;
  }),
);

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && state.focus && !palette.isOpen() && $("switcher").hidden) {
      event.preventDefault();
      toggleFocus();
      return;
    }
    const mod = isMac ? event.metaKey : event.ctrlKey;
    // AltGr arrives as Ctrl+Alt on Windows, so Alt combinations are never shortcuts.
    if (!mod || event.altKey) return;
    const key = event.key.toUpperCase();
    if (key === ALL_ACTIONS_KEY && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (palette.isOpen()) palette.close();
      else palette.open();
      return;
    }
    const action = actions.find((a) => a.key === key && !!a.shift === event.shiftKey);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    palette.close();
    if (action.enabled?.() === false) {
      notify(hasVault() ? "Open a note first." : `Open a folder first (${isMac ? "⌘" : "Ctrl+"}O).`);
      return;
    }
    action.run();
  },
  true,
);

// Hyphenation (which justified text needs) follows the system language.
document.documentElement.lang = navigator.language || "en";

// Re-draw diagrams when the system theme changes.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.mode === "read") renderDoc();
});

// Save before the window closes.
appWindow.onCloseRequested(flush);

// ---------- start ----------

(async () => {
  const lastVault = remember.get("vault");
  if (lastVault && (await openVault(lastVault))) {
    const lastNote = remember.get("lastNote");
    if (lastNote && state.notes.includes(lastNote)) await openNote(lastNote);
  } else {
    showWelcome();
  }
})();
