import MarkdownIt from "markdown-it";
import katex from "katex";
import katexPluginModule from "@vscode/markdown-it-katex";
import { dirname, joinInVault } from "./paths";

// The plugin is CommonJS; depending on the bundler the function is either the
// default export itself or nested under `.default`.
const katexPlugin: typeof katexPluginModule =
  (katexPluginModule as unknown as { default?: typeof katexPluginModule }).default ?? katexPluginModule;

export interface RenderOptions {
  /** Theme to announce to local embeds, e.g. "light" when exporting. */
  theme?: "light" | "dark";
  /** Replace embeds with a line naming them, for paper. */
  embedsAsLinks?: boolean;
}

/** Turns a vault-relative path into a URL the webview can load. */
export type FileUrl = (vaultPath: string) => string;

const EMBED_RE = /^::embed\[([^\]]+)\]\s*$/;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isExternal(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

export function createRenderer(fileUrl: FileUrl) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
  // Pass our KaTeX so the HTML matches the version of the bundled stylesheet;
  // the plugin otherwise uses its own, older copy (hence the type cast).
  type PluginKatex = NonNullable<Parameters<typeof katexPlugin>[1]>["katex"];
  md.use(katexPlugin, { throwOnError: false, katex: katex as unknown as PluginKatex });

  // `::embed[path-or-url]` on its own line becomes a sandboxed iframe.
  md.block.ruler.before("paragraph", "embed", (state, startLine, _endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const match = EMBED_RE.exec(state.src.slice(start, state.eMarks[startLine]));
    if (!match) return false;
    if (silent) return true;
    const token = state.push("embed", "", 0);
    token.content = match[1].trim();
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  });

  // Mermaid blocks are left as placeholders and drawn after insertion (see mermaid.ts).
  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === "mermaid") {
      return `<div class="mermaid" data-source="${escapeAttr(token.content)}"></div>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    if (!isExternal(src)) {
      const resolved = joinInVault(noteDir(env), safeDecode(src));
      token.attrSet("src", resolved ? fileUrl(resolved) : "");
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  md.renderer.rules.embed = (tokens, idx, _options, env) => {
    const target = tokens[idx].content;
    if ((env as { embedsAsLinks?: boolean }).embedsAsLinks) {
      const label = /^https:\/\//i.test(target)
        ? `<a href="${escapeAttr(target)}">${escapeAttr(target)}</a>`
        : `<code>${escapeAttr(target)}</code> (open the note in Quill)`;
      return `<p class="embed-link">Interactive figure: ${label}</p>\n`;
    }
    let url: string | null = null;
    if (/^https:\/\//i.test(target)) {
      url = target;
    } else if (!isExternal(target)) {
      const resolved = joinInVault(noteDir(env), target);
      // Local embeds learn the theme Quill renders in (used when exporting), via the URL fragment.
      const theme = (env as { theme?: string }).theme;
      url = resolved ? fileUrl(resolved) + (theme ? `#quill-theme=${theme}` : "") : null;
    }
    if (!url) {
      return `<p class="embed-error">Cannot embed ${escapeAttr(target)}: use an https URL or a file inside the vault.</p>\n`;
    }
    return (
      `<figure class="embed"><iframe src="${escapeAttr(url)}" sandbox="allow-scripts" ` +
      `referrerpolicy="no-referrer" loading="lazy"></iframe></figure>\n`
    );
  };

  return (source: string, notePath: string, options: RenderOptions = {}): string =>
    md.render(source, { notePath, theme: options.theme, embedsAsLinks: options.embedsAsLinks });
}

/** Folder of the note being rendered; markdown-it passes it through as `env`. */
function noteDir(env: unknown): string {
  return dirname((env as { notePath: string }).notePath);
}

function safeDecode(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}
