import { describe, expect, it } from "vitest";
import { conflictNotes, firstSyncMessage, pillLabel, type Summary } from "./sync";

const summary = (s: Partial<Summary>): Summary => ({
  firstTime: true, upload: 0, download: 0, deleteRemote: 0, deleteLocal: 0, compare: 0, skipped: [], ...s,
});

describe("sync status", () => {
  it("shows nothing while sync is off", () => {
    expect(pillLabel({ kind: "off" }, 0).text).toBe("");
  });

  it("shows the state, and conflicts when everything else is fine", () => {
    expect(pillLabel({ kind: "idle" }, 0)).toEqual({ text: "Synced", status: "idle" });
    expect(pillLabel({ kind: "idle" }, 1).text).toBe("1 conflict");
    expect(pillLabel({ kind: "idle" }, 3).text).toBe("3 conflicts");
    expect(pillLabel({ kind: "syncing" }, 3).text).toBe("Syncing…");
    expect(pillLabel({ kind: "offline" }, 0).text).toBe("Offline");
    expect(pillLabel({ kind: "unauthorized" }, 0).status).toBe("error");
    expect(pillLabel({ kind: "failed", message: "x" }, 0).text).toBe("Sync failed · Retry");
  });

  it("finds conflict copies by name", () => {
    const notes = ["a.md", "Notes/a (conflict, phone, 2026-10-06).md", "b (conflict, pc, 2026-10-06 2).md", "conflict.md"];
    expect(conflictNotes(notes)).toEqual([notes[1], notes[2]]);
  });
});

describe("first sync message", () => {
  it("says what will be copied, in plain words", () => {
    expect(firstSyncMessage(summary({ upload: 12 }))).toBe(
      "This is the first sync of this folder. Quill will upload 12 files from this folder to the cloud.",
    );
    expect(firstSyncMessage(summary({ upload: 1, download: 2, compare: 1 }))).toContain(
      "upload 1 file from this folder to the cloud, and download 2 files from the cloud into this folder, and compare 1 file",
    );
    expect(firstSyncMessage(summary({}))).toContain("find nothing to copy");
  });
});
