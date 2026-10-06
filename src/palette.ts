import { fuzzyScore } from "./switcher";

export type ActionGroup = "Note" | "View" | "Folder" | "Sync";

export interface Action {
  group: ActionGroup;
  label: string;
  /** Letter pressed together with Ctrl (Cmd on macOS). Actions without one are panel-only. */
  key?: string;
  shift?: boolean;
  run: () => unknown;
  /** Disabled actions are shown greyed out and cannot run. */
  enabled?: () => boolean;
}

const GROUPS: ActionGroup[] = ["Note", "View", "Folder", "Sync"];

export function isEnabled(action: Action): boolean {
  return action.enabled?.() ?? true;
}

/** Actions matching the query, best first, in group order when the query is empty. */
export function filterActions(query: string, actions: Action[]): Action[] {
  const q = query.trim();
  if (!q) return GROUPS.flatMap((g) => actions.filter((a) => a.group === g));
  return actions
    .map((action) => ({ action, score: fuzzyScore(q, action.label) }))
    .filter((m): m is { action: Action; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.action);
}

export function keysFor(action: Action, isMac: boolean): string[] {
  if (!action.key) return [];
  return [isMac ? "⌘" : "Ctrl", ...(action.shift ? ["⇧"] : []), action.key];
}

/** Wires the searchable actions panel. */
export function setupPalette(root: HTMLElement, actions: Action[], isMac: boolean) {
  const input = root.querySelector("input")!;
  const list = root.querySelector("ul")!;
  let shown: Action[] = [];
  let selected = 0;

  function row(action: Action, index: number) {
    const li = document.createElement("li");
    li.className = "action";
    li.classList.toggle("selected", index === selected);
    li.classList.toggle("disabled", !isEnabled(action));
    const label = document.createElement("span");
    label.textContent = action.label;
    const keys = document.createElement("span");
    keys.className = "keys";
    for (const k of keysFor(action, isMac)) {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      keys.append(kbd);
    }
    li.append(label, keys);
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run(action);
    });
    return li;
  }

  function draw() {
    const grouped = !input.value.trim();
    const items: HTMLElement[] = [];
    shown.forEach((action, i) => {
      if (grouped && (i === 0 || shown[i - 1].group !== action.group)) {
        const head = document.createElement("li");
        head.className = "group";
        head.textContent = action.group;
        items.push(head);
      }
      items.push(row(action, i));
    });
    list.replaceChildren(...items);
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }

  function firstEnabledFrom(start: number, step: 1 | -1): number {
    for (let n = 0; n < shown.length; n++) {
      const i = (start + n * step + shown.length * 2) % shown.length;
      if (isEnabled(shown[i])) return i;
    }
    return 0;
  }

  function update() {
    shown = filterActions(input.value, actions);
    selected = firstEnabledFrom(0, 1);
    draw();
  }

  function close() {
    root.hidden = true;
  }

  function run(action: Action) {
    if (!isEnabled(action)) return;
    close();
    action.run();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (shown.length) selected = firstEnabledFrom(selected + step, step);
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[selected]) run(shown[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  return {
    open() {
      root.hidden = false;
      input.value = "";
      update();
      input.focus();
    },
    close,
    isOpen: () => !root.hidden,
  };
}
