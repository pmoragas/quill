// Where Quill is running. Phones have no window to move, resize or print, and no folder picker.
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

export const isMobile = /Android/i.test(navigator.userAgent);
if (isMobile) document.documentElement.classList.add("mobile");

/** The app window; on a phone every call is a no-op because the app always fills the screen. */
export const appWindow: Window = isMobile
  ? ({
      setTitle: async () => {},
      setFullscreen: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      onCloseRequested: async () => () => {},
    } as unknown as Window)
  : getCurrentWindow();
