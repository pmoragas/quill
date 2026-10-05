// In-app export panel: page preview, paper and margin choices, Save PDF or Print….

export type Paper = "a4" | "letter";
export type Margins = "narrow" | "normal" | "wide";

export interface ExportOptions {
  paper: Paper;
  landscape: boolean;
  margins: Margins;
  pageNumbers: boolean;
  light: boolean;
  embedsAsLinks: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  paper: "a4",
  landscape: false,
  margins: "normal",
  pageNumbers: true,
  light: true,
  embedsAsLinks: false,
};

export const MARGIN_MM: Record<Margins, number> = { narrow: 12, normal: 22, wide: 32 };
const PAPER_MM: Record<Paper, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
const PX_PER_MM = 96 / 25.4;

/** Paper size in millimetres, after orientation. */
export function pageMm(o: ExportOptions): { width: number; height: number } {
  const [w, h] = PAPER_MM[o.paper];
  return o.landscape ? { width: h, height: w } : { width: w, height: h };
}

/**
 * The @page rule for printing. WebKit clips pages when CSS margins are set, so it only
 * gets the size; its margins come from the print settings. Page numbers need Chromium.
 */
export function pageCss(o: ExportOptions, chromium: boolean): string {
  const { width, height } = pageMm(o);
  const size = `size: ${width}mm ${height}mm;`;
  if (!chromium) return `@page { ${size} }`;
  const numbers = o.pageNumbers
    ? `@bottom-center { content: counter(page) " / " counter(pages); font-family: "CMU Serif", serif; font-size: 9pt; color: #8b877f; }`
    : "";
  return `@page { ${size} margin: ${MARGIN_MM[o.margins]}mm; ${numbers} }`;
}

export interface ExportHooks {
  title: () => string;
  /** Where Save PDF writes, for display. */
  target: () => string;
  /** Renders the note into the preview element with these options. */
  renderPreview: (flow: HTMLElement, o: ExportOptions) => Promise<void>;
  savePdf: (o: ExportOptions) => Promise<void>;
  print: (o: ExportOptions) => void;
  chromium: boolean;
  load: () => ExportOptions;
  store: (o: ExportOptions) => void;
}

const PREVIEW_W = 250;
const PREVIEW_H = 340;

export function setupExportPanel(root: HTMLElement, hooks: ExportHooks) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $(".stage");
  const sheet = $(".sheet");
  const win = $(".window");
  const flow = $(".flow");
  const pageLabel = $(".page-label");
  const saveButton = $<HTMLButtonElement>(".save");
  let options = hooks.load();
  let page = 0;
  let pages = 1;
  let drawToken = 0;
  let busy = false;

  function geometry() {
    const { width, height } = pageMm(options);
    const margin = MARGIN_MM[options.margins] * PX_PER_MM;
    const pw = width * PX_PER_MM;
    const ph = height * PX_PER_MM;
    return { pw, ph, margin, cw: pw - 2 * margin, ch: ph - 2 * margin, gap: 2 * margin };
  }

  function layout() {
    const { pw, ph, margin, cw, ch, gap } = geometry();
    const scale = Math.min(PREVIEW_W / pw, PREVIEW_H / ph);
    stage.style.width = `${pw * scale}px`;
    stage.style.height = `${ph * scale}px`;
    Object.assign(sheet.style, { width: `${pw}px`, height: `${ph}px`, padding: `${margin}px`, transform: `scale(${scale})` });
    Object.assign(win.style, { width: `${cw}px`, height: `${ch}px` });
    Object.assign(flow.style, { width: `${cw}px`, height: `${ch}px`, columnWidth: `${cw}px`, columnGap: `${gap}px` });
    sheet.classList.toggle("force-light", options.light);
  }

  function showPage() {
    const { cw, gap } = geometry();
    pages = Math.max(1, Math.round((flow.scrollWidth + gap) / (cw + gap)));
    page = Math.min(page, pages - 1);
    flow.style.transform = `translateX(${-page * (cw + gap)}px)`;
    pageLabel.textContent = `Page ${page + 1} of ${pages}`;
  }

  async function redraw() {
    const token = ++drawToken;
    layout();
    await hooks.renderPreview(flow, options);
    if (token !== drawToken) return;
    await document.fonts.ready;
    showPage();
  }

  function drawControls() {
    for (const chip of root.querySelectorAll<HTMLButtonElement>("[data-set]")) {
      const [key, value] = chip.dataset.set!.split("=");
      const current = String(options[key as keyof ExportOptions]);
      chip.classList.toggle("on", current === value);
    }
    for (const box of root.querySelectorAll<HTMLInputElement>("input[data-option]")) {
      box.checked = Boolean(options[box.dataset.option as keyof ExportOptions]);
    }
    const numbers = $<HTMLInputElement>('input[data-option="pageNumbers"]');
    numbers.disabled = !hooks.chromium;
    numbers.closest("label")!.title = hooks.chromium ? "" : "Page numbers are not available on this system.";
    $(".where").textContent = `Saves to ${hooks.target()}`;
  }

  function update(change: Partial<ExportOptions>) {
    options = { ...options, ...change };
    hooks.store(options);
    drawControls();
    redraw();
  }

  for (const chip of root.querySelectorAll<HTMLButtonElement>("[data-set]")) {
    chip.addEventListener("click", () => {
      const [key, value] = chip.dataset.set!.split("=");
      update({ [key]: value === "true" ? true : value === "false" ? false : value } as Partial<ExportOptions>);
    });
  }
  for (const box of root.querySelectorAll<HTMLInputElement>("input[data-option]")) {
    box.addEventListener("change", () => update({ [box.dataset.option!]: box.checked } as Partial<ExportOptions>));
  }
  $(".prev").addEventListener("click", () => {
    page = Math.max(0, page - 1);
    showPage();
  });
  $(".next").addEventListener("click", () => {
    page = Math.min(pages - 1, page + 1);
    showPage();
  });

  function close() {
    if (busy) return;
    root.hidden = true;
    flow.replaceChildren();
  }

  async function save() {
    if (busy) return;
    busy = true;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    try {
      await hooks.savePdf(options);
    } finally {
      busy = false;
      saveButton.disabled = false;
      saveButton.textContent = "Save PDF";
    }
    close();
  }

  saveButton.addEventListener("click", save);
  $(".print").addEventListener("click", () => {
    close();
    hooks.print(options);
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      save();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      page = Math.max(0, Math.min(pages - 1, page + (e.key === "ArrowRight" ? 1 : -1)));
      showPage();
    }
  });

  return {
    open() {
      options = hooks.load();
      page = 0;
      $(".title").textContent = `Export “${hooks.title()}”`;
      drawControls();
      root.hidden = false;
      saveButton.focus();
      redraw();
    },
    close,
    isOpen: () => !root.hidden,
    options: () => options,
  };
}
