// In-app "Open folder" panel: type or paste a path, or browse with the arrow keys.
import { invoke } from "@tauri-apps/api/core";

interface Folder {
  name: string;
  path: string;
  notes: number;
}

interface Listing {
  path: string;
  parent: string | null;
  folders: Folder[];
}

type Row = { kind: "folder"; folder: Folder } | { kind: "recent"; path: string };

const NOTE_COUNT_CAP = 500;
const TYPE_DELAY_MS = 150;

export interface FolderPickerHooks {
  /** Opens the folder as the vault. */
  open: (path: string) => void;
  /** Opens the system folder browser instead. */
  browse: () => void;
  recent: () => string[];
  /** Where to start: the parent of the open vault, else Documents. */
  start: () => Promise<string | null>;
}

function notesLabel(n: number): string {
  if (n === 0) return "no notes";
  if (n >= NOTE_COUNT_CAP) return `${NOTE_COUNT_CAP}+ notes`;
  return n === 1 ? "1 note" : `${n} notes`;
}

function splitPath(path: string): [string, string] {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return [path.slice(0, cut), path.slice(cut + 1)];
}

export function setupFolderPicker(root: HTMLElement, hooks: FolderPickerHooks) {
  const input = root.querySelector("input")!;
  const list = root.querySelector("ul")!;
  const target = root.querySelector<HTMLElement>(".target")!;
  let listing: Listing | null = null;
  let rows: Row[] = [];
  let selected = 0;
  let typeTimer = 0;

  function draw(error?: string) {
    const items: HTMLElement[] = [];
    const head = (text: string) => {
      const li = document.createElement("li");
      li.className = "group";
      li.textContent = text;
      items.push(li);
    };
    const folders = rows.filter((r) => r.kind === "folder");
    const recents = rows.filter((r) => r.kind === "recent");
    if (error) {
      const li = document.createElement("li");
      li.className = "message";
      li.textContent = error;
      items.push(li);
    }
    if (folders.length) head("Folders here");
    else if (listing && !error) {
      const li = document.createElement("li");
      li.className = "message";
      li.textContent = "No folders here. Press ↵ to open this one.";
      items.push(li);
    }
    rows.forEach((row, i) => {
      if (row.kind === "recent" && row === recents[0]) head("Recent");
      const li = document.createElement("li");
      li.className = "row" + (i === selected ? " selected" : "");
      const name = document.createElement("span");
      const meta = document.createElement("span");
      meta.className = "meta";
      if (row.kind === "folder") {
        name.textContent = row.folder.name;
        meta.textContent = notesLabel(row.folder.notes);
      } else {
        const [dir, base] = splitPath(row.path);
        name.textContent = base;
        meta.textContent = dir;
      }
      li.append(name, meta);
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selected = i;
        draw();
      });
      li.addEventListener("dblclick", () => choose());
      items.push(li);
    });
    list.replaceChildren(...items);
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    const path = chosenPath();
    target.textContent = path ? `↵ open ${splitPath(path)[1] || path}` : "";
  }

  /** Loads a folder. After navigating nothing is selected, so ↵ opens the folder itself. */
  async function load(path: string, keepInput = false, selectFirst = false) {
    try {
      listing = await invoke<Listing>("list_folder", { path });
    } catch (error) {
      listing = null;
      rows = recentRows();
      selected = -1;
      draw(String(error));
      return;
    }
    if (!keepInput) input.value = withSeparator(listing.path);
    rows = [...listing.folders.map((folder): Row => ({ kind: "folder", folder })), ...recentRows()];
    selected = selectFirst && rows.length ? 0 : -1;
    draw();
  }

  function recentRows(): Row[] {
    return hooks.recent().map((path): Row => ({ kind: "recent", path }));
  }

  function withSeparator(path: string): string {
    const sep = path.includes("\\") ? "\\" : "/";
    return path.endsWith(sep) ? path : path + sep;
  }

  function close() {
    root.hidden = true;
  }

  function current(): string {
    return listing?.path ?? input.value.trim();
  }

  /** The selected folder, or the folder in the path field when nothing is selected. */
  function chosenPath(): string {
    const row = rows[selected];
    return row ? (row.kind === "folder" ? row.folder.path : row.path) : current();
  }

  function choose() {
    const path = chosenPath();
    if (!path) return;
    close();
    hooks.open(path);
  }

  input.addEventListener("input", () => {
    clearTimeout(typeTimer);
    typeTimer = window.setTimeout(() => load(input.value.trim(), true), TYPE_DELAY_MS);
  });

  input.addEventListener("keydown", (e) => {
    const row = rows[selected];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Cycle through the rows and "nothing selected" (= the current folder).
      const n = rows.length + 1;
      selected = ((selected + 1 + (e.key === "ArrowDown" ? 1 : n - 1)) % n) - 1;
      draw();
    } else if (e.key === "ArrowRight" && row?.kind === "folder" && input.selectionStart === input.value.length) {
      e.preventDefault();
      load(row.folder.path);
    } else if (e.key === "ArrowLeft" && listing?.parent && input.selectionStart === input.value.length) {
      e.preventDefault();
      load(listing.parent);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  return {
    async open() {
      root.hidden = false;
      input.focus();
      const start = await hooks.start();
      if (start) await load(start, false, true);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    close,
    isOpen: () => !root.hidden,
    /** Ctrl+O inside the panel: hand over to the system browser. */
    browse() {
      close();
      hooks.browse();
    },
  };
}
