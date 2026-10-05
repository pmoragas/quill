// Mermaid is large, so it is only loaded the first time a note contains a diagram.
let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let counter = 0;

export async function drawDiagrams(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>("div.mermaid[data-source]");
  if (blocks.length === 0) return;

  mermaidModule ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidModule;
  // Exporting forces the light theme (data-theme="light") whatever the system uses.
  const forcedLight = document.documentElement.dataset.theme === "light";
  const dark = !forcedLight && matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    fontFamily: '"CMU Serif", serif',
  });

  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`mermaid-${++counter}`, block.dataset.source ?? "");
      block.innerHTML = svg;
    } catch (error) {
      block.classList.add("diagram-error");
      block.textContent = String(error);
    }
  }
}
