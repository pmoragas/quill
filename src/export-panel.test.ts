import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, pageCss, pageMm } from "./export-panel";

describe("export options", () => {
  it("swaps paper sides in landscape", () => {
    expect(pageMm(DEFAULT_OPTIONS)).toEqual({ width: 210, height: 297 });
    expect(pageMm({ ...DEFAULT_OPTIONS, paper: "letter", landscape: true })).toEqual({ width: 279.4, height: 215.9 });
  });

  it("gives Chromium margins and page numbers", () => {
    const css = pageCss(DEFAULT_OPTIONS, true);
    expect(css).toContain("size: 210mm 297mm;");
    expect(css).toContain("margin: 22mm;");
    expect(css).toContain("counter(page)");
    expect(pageCss({ ...DEFAULT_OPTIONS, pageNumbers: false, margins: "wide" }, true)).not.toContain("counter(page)");
  });

  it("gives WebKit only the page size", () => {
    expect(pageCss(DEFAULT_OPTIONS, false)).toBe("@page { size: 210mm 297mm; }");
  });
});
