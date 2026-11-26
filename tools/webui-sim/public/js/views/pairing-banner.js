/* The "needs pairing" banners on a page (the remote, a device's page). The
   page puts PAIRING_BANNER_SLOT in its markup and calls update() after each
   render; the banners also follow every change to the list on their own.
   deviceIds() names the page's devices. The slot isn't a live region: the
   failure that raised a banner is announced by the snackbar already, and a
   page shown again shouldn't announce it again. After a dismiss, focus moves
   to the next banner's button, else to focusAfter (a selector). */

import { clearPairingProblem, onPairingProblems, pairingProblemsFor } from "../pairing-problems.js";
import { pairingBannersMarkup } from "./send-problem-model.js";

export const PAIRING_BANNER_SLOT = `<div class="pairing-banners" data-pairing-banners></div>`;

export function mountPairingBanners(root, { deviceIds, nameOf, focusAfter = "" }) {
  let shown = null;
  function update() {
    const slot = root.querySelector("[data-pairing-banners]");
    if (!slot) return;
    const html = pairingBannersMarkup(pairingProblemsFor(deviceIds() ?? []), nameOf);
    // A fresh slot (the page re-rendered) is empty; an unchanged list is
    // left alone, so a focused Dismiss button keeps its focus.
    if (slot.dataset.shown === "1" && html === shown) return;
    slot.innerHTML = html;
    slot.dataset.shown = "1";
    shown = html;
  }
  root.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-pairing-dismiss]");
    if (!button || !root.contains(button)) return;
    clearPairingProblem(button.dataset.pairingDismiss);
    const next = root.querySelector("[data-pairing-dismiss]") ?? (focusAfter ? root.querySelector(focusAfter) : null);
    if (next) {
      if (!next.matches?.("button, a, input, [tabindex]")) next.setAttribute("tabindex", "-1");
      next.focus?.();
    }
  });
  onPairingProblems(update);
  return { update };
}
