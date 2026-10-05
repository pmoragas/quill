import { describe, expect, it } from "vitest";
import { choices, fuzzyScore } from "./switcher";

const notes = ["algebra/groups.md", "calculus.md", "linear-algebra.md"];

describe("switcher", () => {
  it("matches subsequences and ranks word starts higher", () => {
    expect(fuzzyScore("xyz", "calculus.md")).toBeNull();
    const ranked = choices("la", notes).filter((c) => c.kind === "open").map((c) => c.path);
    expect(ranked[0]).toBe("linear-algebra.md");
  });

  it("offers to create a note when there is no exact match", () => {
    expect(choices("topology", notes).at(-1)).toEqual({ kind: "create", path: "topology.md" });
    expect(choices("calculus", notes).some((c) => c.kind === "create")).toBe(false);
    expect(choices("", notes).length).toBe(3);
  });

  it("only offers the new note in create mode", () => {
    expect(choices("topology", notes, "create")).toEqual([{ kind: "create", path: "topology.md" }]);
    expect(choices("Calculus", notes, "create")).toEqual([{ kind: "open", path: "calculus.md" }]);
    expect(choices("  ", notes, "create")).toEqual([]);
  });
});
