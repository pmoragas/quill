// The "Sync settings" panel: server address, device token, device name, which folder syncs.
import { invoke } from "@tauri-apps/api/core";
import type { ConfigView } from "./sync";

export interface SettingsHooks {
  /** Name of the folder that is open, or null if none. */
  folderName: () => string | null;
  /** Called after settings were saved or sync was stopped. */
  changed: () => void;
}

export function setupSyncSettings(root: HTMLElement, hooks: SettingsHooks) {
  const form = root as HTMLElement;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const status = form.querySelector<HTMLElement>(".status")!;
  const note = form.querySelector<HTMLElement>(".note")!;
  const test = form.querySelector<HTMLButtonElement>(".test")!;
  const stop = form.querySelector<HTMLButtonElement>(".stop")!;
  const save = form.querySelector<HTMLButtonElement>(".save")!;
  let config: ConfigView | null = null;

  function say(text: string, kind: "" | "ok" | "error" = "") {
    status.textContent = text;
    status.className = "status" + (kind ? ` ${kind}` : "");
  }

  function close() {
    root.hidden = true;
  }

  function draw() {
    if (!config) return;
    field("url").value = config.url;
    field("token").value = "";
    field("token").placeholder = config.hasToken ? "Saved (leave empty to keep it)" : "Paste the token for this device";
    field("device").value = config.device || "desktop";
    const folder = hooks.folderName();
    form.querySelector(".folder-name")!.textContent = folder ?? "none open";
    field("enable").disabled = !folder;
    field("enable").checked = config.enabledHere || (!!folder && !config.enabledElsewhere);
    note.textContent = config.enabledElsewhere
      ? "Sync is on for a different folder. Saving with this box ticked moves it to this folder; the cloud copy is shared, so only do this for the same notes."
      : "";
    stop.hidden = !config.enabledHere;
  }

  async function submit(event: Event) {
    event.preventDefault();
    save.disabled = true;
    say("Saving…");
    try {
      config = await invoke<ConfigView>("sync_set_config", {
        url: field("url").value,
        token: field("token").value || null,
        device: field("device").value,
        enableHere: field("enable").checked && !field("enable").disabled,
      });
      hooks.changed();
      close();
    } catch (error) {
      say(String(error), "error");
    } finally {
      save.disabled = false;
    }
  }

  async function checkConnection() {
    test.disabled = true;
    say("Connecting…");
    try {
      // Save first: the check uses the saved settings.
      config = await invoke<ConfigView>("sync_set_config", {
        url: field("url").value,
        token: field("token").value || null,
        device: field("device").value,
        enableHere: false,
      });
      const files = await invoke<number>("sync_check");
      say(files === 0 ? "Connected. The cloud is empty." : `Connected. ${files} files in the cloud.`, "ok");
      field("token").value = "";
      field("token").placeholder = "Saved (leave empty to keep it)";
    } catch (error) {
      say(String(error), "error");
    } finally {
      test.disabled = false;
    }
  }

  form.addEventListener("submit", submit);
  test.addEventListener("click", checkConnection);
  stop.addEventListener("click", async () => {
    config = await invoke<ConfigView>("sync_disable");
    hooks.changed();
    close();
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  return {
    async open() {
      config = await invoke<ConfigView>("sync_get_config");
      say("");
      draw();
      root.hidden = false;
      field(config.url ? "token" : "url").focus();
    },
    close,
    isOpen: () => !root.hidden,
  };
}
