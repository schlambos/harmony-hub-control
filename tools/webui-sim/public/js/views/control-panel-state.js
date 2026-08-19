/** Pure open-state rules for the Control side panels (unit-tested). */

/**
 * @param {{ mode: string, commandsPref: string|null, legacyInspectorPref: string|null }} p
 * @returns {boolean}
 */
export function commandsPanelShouldOpen({ mode, commandsPref, legacyInspectorPref }) {
  if (commandsPref === "open") return true;
  if (commandsPref === "closed") return false;
  if (legacyInspectorPref === "open") return true;
  return mode === "devices";
}
