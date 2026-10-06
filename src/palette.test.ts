import { describe, expect, it } from "vitest";
import { filterActions, isEnabled, keysFor, type Action } from "./palette";

const noop = () => {};
const actions: Action[] = [
  { group: "Folder", key: "O", label: "Open a folder of notes", run: noop },
  { group: "Note", key: "N", label: "New note", run: noop, enabled: () => false },
  { group: "View", key: "F", shift: true, label: "Focus mode", run: noop },
];

describe("palette", () => {
  it("lists actions in group order when the query is empty", () => {
    expect(filterActions("", actions).map((a) => a.group)).toEqual(["Note", "View", "Folder"]);
    const withSync = [...actions, { group: "Sync" as const, label: "Sync now", run: noop }];
    expect(filterActions("", withSync).map((a) => a.group).at(-1)).toBe("Sync");
  });

  it("searches labels", () => {
    expect(filterActions("focus", actions).map((a) => a.label)).toEqual(["Focus mode"]);
    expect(filterActions("zzz", actions)).toEqual([]);
  });

  it("reports disabled actions and shortcut keys", () => {
    expect(isEnabled(actions[1])).toBe(false);
    expect(isEnabled(actions[0])).toBe(true);
    expect(keysFor(actions[2], false)).toEqual(["Ctrl", "⇧", "F"]);
    expect(keysFor(actions[0], true)).toEqual(["⌘", "O"]);
    expect(keysFor({ group: "Sync", label: "Sync now", run: noop }, false)).toEqual([]);
  });
});
