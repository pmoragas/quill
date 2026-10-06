export type SwitcherChoice = { kind: "open"; path: string } | { kind: "create"; path: string };
export type SwitcherMode = "find" | "create";

const PLACEHOLDERS: Record<SwitcherMode, string> = {
  find: "Find or create a note…",
  create: "Name of the new note…",
};

/** Subsequence match; higher is better, null if not all characters are found in order. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, last + 1);
    if (i < 0) return null;
    if (i === last + 1) score += 3; // consecutive
    if (i === 0 || "/ -_".includes(t[i - 1])) score += 2; // start of a word
    score -= (i - last - 1) * 0.1; // gaps
    last = i;
  }
  return score - t.length * 0.01;
}

function notePathFor(query: string): string | null {
  const name = query.trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
  return name ? `${name}.md` : null;
}

/** In "create" mode only the new note is offered (or the existing note of that name). */
export function choices(query: string, notes: string[], mode: SwitcherMode = "find"): SwitcherChoice[] {
  if (mode === "create") {
    const path = notePathFor(query);
    if (!path) return [];
    const existing = notes.find((n) => n.toLowerCase() === path.toLowerCase());
    return [existing ? { kind: "open", path: existing } : { kind: "create", path }];
  }
  const matches: SwitcherChoice[] = (
    query.trim()
      ? notes
          .map((path) => ({ path, score: fuzzyScore(query.trim(), path) }))
          .filter((m): m is { path: string; score: number } => m.score !== null)
          .sort((a, b) => b.score - a.score)
      : notes.map((path) => ({ path }))
  )
    .slice(0, 50)
    .map((m) => ({ kind: "open", path: m.path }));

  const newPath = notePathFor(query);
  if (newPath && !notes.some((n) => n.toLowerCase() === newPath.toLowerCase())) {
    matches.push({ kind: "create", path: newPath });
  }
  return matches;
}

function choiceLabel(choice: SwitcherChoice, mode: SwitcherMode): string {
  const name = choice.path.replace(/\.md$/, "");
  if (choice.kind === "create") return `New note: ${choice.path}`;
  return mode === "create" ? `Open existing: ${name}` : name;
}

/** Wires the quick-switcher overlay. Returns a function that opens it. */
export function setupSwitcher(
  root: HTMLElement,
  getNotes: () => string[],
  onChoose: (choice: SwitcherChoice) => void,
): (mode?: SwitcherMode, query?: string) => void {
  const input = root.querySelector("input")!;
  const list = root.querySelector("ul")!;
  let current: SwitcherChoice[] = [];
  let selected = 0;
  let mode: SwitcherMode = "find";

  function draw() {
    list.replaceChildren(
      ...current.map((choice, i) => {
        const li = document.createElement("li");
        li.textContent = choiceLabel(choice, mode);
        li.className = (i === selected ? "selected " : "") + choice.kind;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(i);
        });
        return li;
      }),
    );
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }

  function update() {
    current = choices(input.value, getNotes(), mode);
    selected = 0;
    draw();
  }

  function close() {
    root.hidden = true;
  }

  function choose(i: number) {
    const choice = current[i];
    close();
    if (choice) onChoose(choice);
  }

  input.addEventListener("input", update);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = current.length;
      if (n) selected = (selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  return (openMode: SwitcherMode = "find", query = "") => {
    mode = openMode;
    input.placeholder = PLACEHOLDERS[mode];
    root.hidden = false;
    input.value = query;
    update();
    input.focus();
  };
}
