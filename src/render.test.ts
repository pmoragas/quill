import { describe, expect, it } from "vitest";
import { createRenderer } from "./render";
import { joinInVault, relativeTo } from "./paths";

const render = createRenderer((p) => `asset://vault/${p}`);

describe("render", () => {
  it("renders inline and block math", () => {
    const html = render("Euler: $e^{i\\pi}+1=0$\n\n$$\\int_0^1 x\\,dx$$", "n.md");
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });

  it("resolves images relative to the note", () => {
    expect(render("![](../assets/a.png)", "sub/n.md")).toContain('src="asset://vault/assets/a.png"');
    expect(render("![](../../x.png)", "sub/n.md")).toContain('src=""');
  });

  it("renders sandboxed embeds", () => {
    const local = render("::embed[anim.html]", "sub/n.md");
    expect(local).toContain('src="asset://vault/sub/anim.html"');
    expect(local).toContain('sandbox="allow-scripts"');
    expect(render("::embed[https://example.com/x]", "n.md")).toContain('src="https://example.com/x"');
    expect(render("::embed[javascript:alert(1)]", "n.md")).toContain("embed-error");
    expect(render("::embed[http://example.com]", "n.md")).toContain("embed-error");
  });

  it("leaves mermaid blocks as placeholders", () => {
    expect(render("```mermaid\ngraph TD; A-->B\n```", "n.md")).toContain('class="mermaid" data-source="graph TD; A--&gt;B');
  });

  it("does not pass raw HTML through", () => {
    expect(render("<script>x()</script>", "n.md")).not.toContain("<script>");
  });
});

describe("paths", () => {
  it("joins within the vault", () => {
    expect(joinInVault("a/b", "../c.png")).toBe("a/c.png");
    expect(joinInVault("", "../c.png")).toBeNull();
    expect(joinInVault("", "/etc/passwd")).toBeNull();
  });

  it("computes relative paths", () => {
    expect(relativeTo("", "assets/x.png")).toBe("assets/x.png");
    expect(relativeTo("notes/math", "assets/x.png")).toBe("../../assets/x.png");
  });
});
