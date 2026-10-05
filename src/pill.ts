// The floating pill at the top of the window. It stays out of the way while
// reading and appears when the pointer nears the top edge.

const REVEAL_ZONE_PX = 56;
const HIDE_DELAY_MS = 400;

export function setupPill(pill: HTMLElement) {
  let near = false;
  let hovered = false;
  let pinned = false;
  let flashUntil = 0;
  let hideTimer = 0;
  let flashTimer = 0;

  function update() {
    const visible = pinned || near || hovered || pill.contains(document.activeElement) || Date.now() < flashUntil;
    clearTimeout(hideTimer);
    if (visible) {
      document.body.classList.add("pill-visible");
    } else {
      hideTimer = window.setTimeout(() => document.body.classList.remove("pill-visible"), HIDE_DELAY_MS);
    }
  }

  document.addEventListener("mousemove", (e) => {
    const isNear = e.clientY < REVEAL_ZONE_PX;
    if (isNear !== near) {
      near = isNear;
      update();
    }
  });
  document.documentElement.addEventListener("mouseleave", () => {
    near = false;
    update();
  });
  pill.addEventListener("mouseenter", () => {
    hovered = true;
    update();
  });
  pill.addEventListener("mouseleave", () => {
    hovered = false;
    update();
  });
  pill.addEventListener("focusout", () => setTimeout(update));

  return {
    /** Keeps the pill visible (start screen, failed save). */
    pin(value: boolean) {
      pinned = value;
      update();
    },
    /** Shows the pill briefly, e.g. after switching mode. */
    flash(ms = 1500) {
      flashUntil = Date.now() + ms;
      update();
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(update, ms);
    },
  };
}
