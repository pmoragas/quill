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
import { basename, dirname, joinInVault, relativeTo } from "./paths";
import { createRenderer } from "./render";
import { setupSwitcher, type SwitcherChoice } from "./switcher";

type Mode = "read" | "edit";

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

// localStorage only remembers the last vault and note; it may be unavailable.
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

// ---------- saving ----------

async function flush() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.path) return;
  state.dirty = false;
  try {
    await invoke("write_note", { path: state.path, content: state.text });
  } catch (error) {
    state.dirty = true;
    notify(`Could not save: ${error}`);
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

async function renderDoc() {
  if (!state.path) return;
  doc.innerHTML = render(state.text, state.path);
  await drawDiagrams(doc);
}

async function setMode(mode: Mode) {
  if (!state.path) return;
  state.mode = mode;
  if (mode === "read") {
    await flush();
    await renderDoc();
    show("read");
  } else {
    show("edit");
    editor.focus();
  }
}

function showWelcome() {
  welcomeText.textContent = state.vault
    ? `${state.notes.length} notes in ${basename(state.vault.replace(/\\/g, "/"))}. Press ${modLabel("P")} to open one.`
    : `Open a folder of Markdown notes to begin.`;
  show("welcome");
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
      button.append(basename(path).replace(/\.md$/, ""));
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
  await appWindow.setTitle(`${basename(path).replace(/\.md$/, "")} — Quill`);
  await setMode(mode);
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
  const title = basename(path).replace(/\.md$/, "");
  try {
    await invoke("write_note", { path, content: `# ${title}\n\n` });
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
    notify(String(error));
    return false;
  }
  state.vault = await invoke<string>("vault_path");
  state.path = null;
  remember.set("vault", path);
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

// ---------- keyboard ----------

const openSwitcher = setupSwitcher(
  $("switcher"),
  () => state.notes,
  (choice: SwitcherChoice) => (choice.kind === "open" ? openNote(choice.path) : createNote(choice.path)),
);

function modLabel(key: string) {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

async function toggleFocus() {
  state.focus = !state.focus;
  document.body.classList.toggle("focus", state.focus);
  await appWindow.setFullscreen(state.focus);
}

// One list drives the keyboard shortcuts, the welcome screen and the actions modal.
interface Action {
  key: string;
  shift?: boolean;
  label: string;
  run: () => unknown;
}

const actions: Action[] = [
  { key: "O", label: "Open a folder of notes", run: pickVault },
  { key: "P", label: "Find or create a note", run: () => state.vault && openSwitcher() },
  { key: "H", label: "Back to start screen", run: goHome },
  { key: "E", label: "Switch between reading and writing", run: () => setMode(state.mode === "read" ? "edit" : "read") },
  { key: "\\", label: "Show or hide the note list", run: () => document.body.classList.toggle("sidebar-open") },
  { key: "F", shift: true, label: "Focus mode (Esc to leave)", run: toggleFocus },
  { key: "S", label: "Save now", run: flush },
];

function shortcutLabel(action: Action) {
  return `${isMac ? "⌘" : "Ctrl "}${action.shift ? "⇧ " : ""}${action.key}`;
}

function actionRow(action: Action, tag: "li" | "div", shortcutFirst = false) {
  const row = document.createElement(tag);
  const label = document.createElement("span");
  label.textContent = action.label;
  const kbd = document.createElement("kbd");
  kbd.textContent = shortcutLabel(action);
  if (shortcutFirst) row.append(kbd, label);
  else row.append(label, kbd);
  return row;
}

$("welcome-shortcuts").replaceChildren(...actions.map((a) => actionRow(a, "div", true)));

const actionsModal = $("actions");
const actionsList = actionsModal.querySelector("ul")!;
actionsList.replaceChildren(
  ...actions.map((action) => {
    const row = actionRow(action, "li");
    row.addEventListener("click", () => {
      closeActions();
      action.run();
    });
    return row;
  }),
);

function openActions() {
  actionsModal.hidden = false;
}

function closeActions() {
  actionsModal.hidden = true;
}

$("actions-button").addEventListener("click", openActions);
actionsModal.addEventListener("click", (event) => {
  if (event.target === actionsModal) closeActions();
});

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && !actionsModal.hidden) {
      event.preventDefault();
      closeActions();
      return;
    }
    if (event.key === "Escape" && state.focus && $("switcher").hidden) {
      event.preventDefault();
      toggleFocus();
      return;
    }
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toUpperCase();
    const action = actions.find((a) => a.key === key && !!a.shift === event.shiftKey);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      closeActions();
      action.run();
    }
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
