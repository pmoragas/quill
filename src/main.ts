import "computer-modern/cmu-serif.css";
import "computer-modern/cmu-typewriter-text.css";
import "katex/dist/katex.min.css";
import "./styles.css";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { createEditor } from "./editor";
import { DEFAULT_OPTIONS, MARGIN_MM, pageCss, setupExportPanel, type ExportOptions } from "./export-panel";
import { setupFolderPicker } from "./folder-picker";
import { drawDiagrams } from "./mermaid";
import { setupPalette, type Action } from "./palette";
import { basename, dirname, joinInVault, relativeTo } from "./paths";
import { setupPill } from "./pill";
import { appWindow, isMobile } from "./platform";
import { createRenderer } from "./render";
import { createSync, type Report } from "./sync";
import { setupSyncSettings } from "./sync-settings";
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

const isMac = navigator.userAgent.includes("Mac");
const SAVE_DELAY_MS = 500;
const SAVED_VISIBLE_MS = 2000;
const MAX_RECENT = 5;
const TAP_REVEAL_MS = 5000;

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

if (!isMac && !isMobile) {
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
    syncUi.afterSave();
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

/** Options of the export in progress; the note renders for paper while it is set. */
let exporting: ExportOptions | null = null;

async function renderDoc() {
  if (!state.path) return;
  const light = exporting?.light ? "light" : undefined;
  doc.innerHTML = render(state.text, state.path, { theme: light, embedsAsLinks: exporting?.embedsAsLinks });
  const frames = [...doc.querySelectorAll("iframe")];
  // Exporting needs every embed drawn, not only the ones on screen.
  if (exporting) for (const f of frames) f.loading = "eager";
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
  if (isMobile) {
    welcomeText.textContent = state.notes.length
      ? `${state.notes.length} ${state.notes.length === 1 ? "note" : "notes"}. Tap ☰ at the top to open one.`
      : "No notes here yet. Set up sync to bring your notes from your computer.";
  } else {
    welcomeText.textContent = state.vault
      ? `${state.notes.length} notes in ${basename(state.vault.replace(/\\/g, "/"))}. Press ${isMac ? "⌘" : "Ctrl+"}P to open one.`
      : `Open a folder of Markdown notes to begin.`;
  }
  drawRecent();
  show("welcome");
  drawPill();
}

function drawNoteList() {
  syncUi.update();
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
      button.addEventListener("click", () => {
        // On a phone the note list covers the note, so it closes once you have chosen.
        if (isMobile) document.body.classList.remove("sidebar-open");
        openNote(path);
      });
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
  syncUi.refreshConfig().then(() => syncUi.run());
  return true;
}

/** The system folder browser, for network drives and unusual places. */
async function pickVault() {
  const folder = await open({ directory: true, title: "Open a folder of notes" });
  if (typeof folder === "string") await openVault(folder);
}

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

const folderPicker = setupFolderPicker($("folders"), {
  open: (path) => openVault(path),
  browse: pickVault,
  recent: () => recentFolders().filter((p) => p !== state.vault),
  start: async () => (state.vault ? parentOf(state.vault) : await invoke<string | null>("default_folder")),
});
$("folders-hint").textContent = `${isMac ? "⌘" : "Ctrl"} O again: system browser…`;
$("open-folder").addEventListener("click", () => folderPicker.open());

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

// ---------- sync ----------

const pillSync = $("pill-sync");

/** Brings the interface up to date after a sync changed files on disk. */
async function syncChanged(report: Report) {
  state.notes = await invoke<string[]>("list_notes");
  drawNoteList();
  const open = state.path;
  if (!open) return;
  if (report.deleted.includes(open)) {
    notify(`“${noteName(open)}” was deleted on another device.`);
    await goHome();
  } else if (report.downloaded.includes(open) && !state.dirty) {
    // Another device edited the note that is open here.
    state.text = await invoke<string>("read_note", { path: open });
    editor.load(state.text);
    if (state.mode === "read") await renderDoc();
  }
}

const syncUi = createSync({
  notes: () => state.notes,
  flush,
  confirm: (message) => ask(message, { title: "Quill sync", kind: "info", okLabel: "Start sync", cancelLabel: "Not now" }),
  notify,
  onChanged: syncChanged,
  onState(label) {
    pillSync.textContent = label.text;
    pillSync.dataset.status = label.status;
    pillSync.tabIndex = label.text ? 0 : -1;
    document.body.classList.toggle("sync-attention", label.status === "error");
  },
});

// No pointer to hover with: tapping the handle at the top shows the pill for a few seconds.
$("grip").addEventListener("pointerdown", () => pill.flash(TAP_REVEAL_MS));
$("welcome-sync").addEventListener("click", () => syncSettings.open());

pillSync.addEventListener("click", () => {
  if (pillSync.dataset.status === "conflict") openSwitcher("find", "(conflict");
  else syncUi.run(true);
});

const syncSettings = setupSyncSettings($("sync-settings"), {
  folderName: () => (state.vault ? basename(state.vault.replace(/\\/g, "/")) : null),
  changed: () => syncUi.refreshConfig().then(() => syncUi.run(true)),
});

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

// ---------- export ----------

const isChromium = /Chrome\//.test(navigator.userAgent);
const root = document.documentElement;
if (isChromium) root.classList.add("chromium");
const pageStyle = document.createElement("style");
pageStyle.textContent = pageCss(DEFAULT_OPTIONS, isChromium);
document.head.append(pageStyle);
let modeBeforeExport: Mode = "read";

/** Renders the note for paper: page rule, theme, embeds loaded. */
async function prepareExport(o: ExportOptions) {
  await flush();
  exporting = o;
  modeBeforeExport = state.mode;
  pageStyle.textContent = pageCss(o, isChromium);
  if (o.light) root.dataset.theme = "light";
  if (state.mode === "read") await renderDoc();
  else await setMode("read");
  await embedsReady;
  await new Promise((r) => setTimeout(r, 400)); // let embeds draw their first frames
}

async function finishExport() {
  exporting = null;
  delete root.dataset.theme;
  root.classList.remove("dialog-print");
  if (modeBeforeExport === "edit") await setMode("edit");
  else await renderDoc();
}

/** Writes "<note>.pdf" next to the note without a dialog (system dialog on macOS). */
async function savePdf(o: ExportOptions) {
  if (!state.path) return;
  await prepareExport(o);
  try {
    const out = await invoke<string>("export_pdf", {
      path: state.path,
      options: { paper: o.paper, landscape: o.landscape, marginMm: MARGIN_MM[o.margins] },
    });
    await finishExport();
    notify(`Saved ${out}`);
  } catch (error) {
    await finishExport();
    if (String(error) === "unsupported") printWithDialog(o);
    else notify(`Could not export: ${error}`);
  }
}

const RESTORE_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** Hands the page to the system print dialog, for paper printers. */
async function printWithDialog(o: ExportOptions) {
  if (!state.path) return;
  await prepareExport(o);
  // WebKit takes its margins from the dialog; pad the sides for a readable measure.
  if (!isChromium) root.classList.add("dialog-print");
  const previousTitle = document.title;
  // Restore on the next deliberate input, not on "afterprint": WebKit fires that before it has
  // finished drawing the pages, and re-rendering mid-print corrupts them.
  const restore = () => {
    for (const type of RESTORE_EVENTS) window.removeEventListener(type, restore, true);
    finishExport();
  };
  window.addEventListener(
    "afterprint",
    () => {
      document.title = previousTitle;
      for (const type of RESTORE_EVENTS) window.addEventListener(type, restore, true);
    },
    { once: true },
  );
  // The browser suggests the document title as the PDF file name.
  document.title = noteName(state.path);
  window.print();
}

function exportTarget(): string {
  if (!state.vault || !state.path) return "";
  const sep = state.vault.includes("\\") ? "\\" : "/";
  const full = [state.vault, ...state.path.replace(/\.md$/, ".pdf").split("/")].join(sep);
  return full.split(/[\\/]/).slice(-3).join(sep);
}

const exportPanel = setupExportPanel($("export"), {
  title: () => (state.path ? noteName(state.path) : ""),
  target: exportTarget,
  async renderPreview(flow, o) {
    if (!state.path) return;
    flow.innerHTML = render(state.text, state.path, { theme: o.light ? "light" : undefined, embedsAsLinks: o.embedsAsLinks });
    await drawDiagrams(flow, { light: o.light });
  },
  savePdf,
  print: printWithDialog,
  chromium: isChromium,
  load: () => {
    try {
      return { ...DEFAULT_OPTIONS, ...JSON.parse(remember.get("exportOptions") ?? "{}") };
    } catch {
      return DEFAULT_OPTIONS;
    }
  },
  store: (o) => remember.set("exportOptions", JSON.stringify(o)),
});

async function openExport() {
  if (!state.path) return;
  await flush();
  exportPanel.open();
}

const hasVault = () => !!state.vault;
const hasNote = () => !!state.path;

// One list drives the keyboard shortcuts, the actions panel and the start screen.
const allActions: Action[] = [
  { group: "Note", key: "N", label: "New note", run: () => openSwitcher("create"), enabled: hasVault },
  { group: "Note", key: "P", label: "Find or create a note", run: () => openSwitcher(), enabled: hasVault },
  { group: "Note", key: "E", label: "Switch between reading and writing", run: () => setMode(state.mode === "read" ? "edit" : "read"), enabled: hasNote },
  { group: "Note", key: "S", label: "Save now", run: flush, enabled: hasNote },
  { group: "Note", key: "E", shift: true, label: "Export as PDF", run: openExport, enabled: hasNote, desktopOnly: true },
  { group: "View", key: "B", label: "Show or hide the note list", run: toggleSidebar, enabled: hasVault },
  { group: "View", key: "F", shift: true, label: "Focus mode (Esc to leave)", run: toggleFocus },
  { group: "Folder", key: "O", label: "Open a folder of notes", run: () => folderPicker.open(), desktopOnly: true },
  { group: "Folder", key: "H", label: "Back to start screen", run: goHome, enabled: hasNote },
  { group: "Sync", label: "Sync now", run: () => syncUi.run(true), enabled: () => syncUi.enabledHere() },
  { group: "Sync", label: "Sync settings…", run: () => syncSettings.open() },
];
const actions = allActions.filter((action) => !(isMobile && action.desktopOnly));

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
    const panelOpen =
      palette.isOpen() || folderPicker.isOpen() || exportPanel.isOpen() || syncSettings.isOpen() || !$("switcher").hidden;
    if (event.key === "Escape" && state.focus && !panelOpen) {
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
    // Ctrl+O inside the folder panel hands over to the system browser.
    if (key === "O" && !event.shiftKey && folderPicker.isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      folderPicker.browse();
      return;
    }
    const action = actions.find((a) => a.key === key && !!a.shift === event.shiftKey);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    palette.close();
    folderPicker.close();
    exportPanel.close();
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
  // A phone has one notes folder inside the app, filled by sync; a computer reopens the last folder.
  const lastVault = isMobile ? await invoke<string>("default_vault") : remember.get("vault");
  if (lastVault && (await openVault(lastVault))) {
    const lastNote = remember.get("lastNote");
    if (lastNote && state.notes.includes(lastNote)) await openNote(lastNote);
  } else {
    showWelcome();
  }
  syncUi.start();
})();
