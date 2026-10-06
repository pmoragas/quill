// Cloud sync in the interface: status in the pill, when to sync, and the first-sync confirmation.
// The sync itself runs in Rust (src-tauri/src/sync); this file decides when to call it.
import { invoke } from "@tauri-apps/api/core";

export interface ConfigView {
  url: string;
  device: string;
  hasToken: boolean;
  enabledHere: boolean;
  enabledElsewhere: boolean;
}

export interface Report {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  conflicts: string[];
  skipped: string[];
}

export interface Summary {
  firstTime: boolean;
  upload: number;
  download: number;
  deleteRemote: number;
  deleteLocal: number;
  compare: number;
  skipped: string[];
}

interface RunResult {
  report: Report;
  error: "offline" | "unauthorized" | "failed" | null;
  message: string | null;
}

export type SyncState =
  | { kind: "off" }
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "offline" }
  | { kind: "unauthorized" }
  | { kind: "failed"; message: string };

const CONFLICT_RE = /\(conflict, [^)]*\)/;
const AUTO_INTERVAL_MS = 5 * 60 * 1000;
const AFTER_SAVE_DELAY_MS = 3000;
const REFOCUS_MIN_GAP_MS = 30 * 1000;
/** Automatic syncs closer together than this are skipped (save, refocus and timer can coincide). */
const MIN_GAP_MS = 5 * 1000;

/** Notes that are conflict copies, so they are easy to find and merge by hand. */
export function conflictNotes(notes: string[]): string[] {
  return notes.filter((path) => CONFLICT_RE.test(path));
}

export function pillLabel(state: SyncState, conflicts: number): { text: string; status: string } {
  if (state.kind === "off") return { text: "", status: "off" };
  if (state.kind === "syncing") return { text: "Syncing…", status: "syncing" };
  if (state.kind === "offline") return { text: "Offline", status: "offline" };
  if (state.kind === "unauthorized") return { text: "Check sync token", status: "error" };
  if (state.kind === "failed") return { text: "Sync failed · Retry", status: "error" };
  if (conflicts > 0) return { text: conflicts === 1 ? "1 conflict" : `${conflicts} conflicts`, status: "conflict" };
  return { text: "Synced", status: "idle" };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The text of the first-sync confirmation. */
export function firstSyncMessage(s: Summary): string {
  const parts: string[] = [];
  if (s.upload) parts.push(`upload ${count(s.upload, "file")} from this folder to the cloud`);
  if (s.download) parts.push(`download ${count(s.download, "file")} from the cloud into this folder`);
  if (s.compare) parts.push(`compare ${count(s.compare, "file")} that exist in both places`);
  if (s.deleteLocal || s.deleteRemote) parts.push("remove nothing");
  const what = parts.length ? parts.join(", and ") : "find nothing to copy";
  return `This is the first sync of this folder. Quill will ${what}.`;
}

export interface SyncHooks {
  notes: () => string[];
  /** Saves the open note, so the sync sees the latest text. */
  flush: () => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Files changed on disk: refresh the note list and the open note. */
  onChanged: (report: Report) => Promise<void>;
  onState: (label: { text: string; status: string }) => void;
}

export function createSync(hooks: SyncHooks) {
  let config: ConfigView | null = null;
  let state: SyncState = { kind: "off" };
  let running = false;
  let declined = false;
  let lastRun = 0;
  let afterSaveTimer = 0;

  function set(next: SyncState) {
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    hooks.onState(pillLabel(state, conflictNotes(hooks.notes()).length));
    return changed;
  }

  async function refreshConfig(): Promise<ConfigView> {
    config = await invoke<ConfigView>("sync_get_config");
    if (!config.enabledHere) set({ kind: "off" });
    else if (state.kind === "off") set({ kind: "idle" });
    return config;
  }

  const enabledHere = () => !!config?.enabledHere;

  async function run(manual = false): Promise<void> {
    if (running) return;
    if (!config) await refreshConfig();
    if (!enabledHere()) return;
    if (declined && !manual) return;
    if (!manual && Date.now() - lastRun < MIN_GAP_MS) return;
    running = true;
    const before = state;
    set({ kind: "syncing" });
    try {
      await hooks.flush();
      let confirmed = false;
      for (;;) {
        try {
          const result = await invoke<RunResult>("sync_run", { confirmed });
          lastRun = Date.now();
          declined = false;
          await finish(result, manual, before);
          return;
        } catch (error) {
          if (String(error) !== "confirmation_required") throw error;
          const summary = await invoke<Summary>("sync_plan");
          if (!(await hooks.confirm(firstSyncMessage(summary)))) {
            declined = true;
            set({ kind: "idle" });
            hooks.notify("Sync paused. Choose “Sync now” when you want to start.");
            return;
          }
          confirmed = true;
        }
      }
    } catch (error) {
      const text = String(error);
      if (text === "busy") return;
      if (text === "not_enabled") {
        await refreshConfig();
        return;
      }
      set({ kind: "failed", message: text });
      if (manual || before.kind !== "failed") hooks.notify(`Sync failed: ${text}`);
    } finally {
      running = false;
    }
  }

  async function finish(result: RunResult, manual: boolean, before: SyncState) {
    const { report } = result;
    if (report.downloaded.length || report.deleted.length || report.conflicts.length) await hooks.onChanged(report);
    if (report.conflicts.length) {
      hooks.notify(`Conflict: kept both versions of ${report.conflicts.length === 1 ? "a note" : `${report.conflicts.length} notes`}. Look for “(conflict”.`);
    }
    if (result.error === "offline") {
      set({ kind: "offline" });
      if (manual) hooks.notify("Offline: your notes are safe here and will sync when you are back online.");
    } else if (result.error === "unauthorized") {
      set({ kind: "unauthorized" });
      if (manual || before.kind !== "unauthorized") hooks.notify("The sync server refused this device's token. Check it in Sync settings.");
    } else if (result.error) {
      set({ kind: "failed", message: result.message ?? "unknown error" });
      if (manual) hooks.notify(`Sync stopped: ${result.message}`);
    } else {
      set({ kind: "idle" });
      if (manual && !report.uploaded.length && !report.downloaded.length && !report.deleted.length) hooks.notify("Everything is up to date.");
    }
  }

  return {
    run,
    refreshConfig,
    enabledHere,
    /** Recomputes the label, for example after the note list changed. */
    update: () => hooks.onState(pillLabel(state, conflictNotes(hooks.notes()).length)),
    afterSave() {
      if (!enabledHere()) return;
      clearTimeout(afterSaveTimer);
      afterSaveTimer = window.setTimeout(() => run(), AFTER_SAVE_DELAY_MS);
    },
    /**
     * Keeps syncing: every few minutes, when the window returns, and when back online.
     * The first sync is started by opening the folder, not here.
     */
    start() {
      window.setInterval(() => run(), AUTO_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastRun > REFOCUS_MIN_GAP_MS) run();
      });
      window.addEventListener("online", () => run());
    },
    state: () => state,
  };
}
