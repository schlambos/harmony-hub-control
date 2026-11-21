import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUTTON_KEY_BY_LABEL } from "../public/js/remote-layout.js";
import {
  BUTTON_SOURCE,
  deriveDefaultButtons,
  draftButtonsFromMap,
  reconcileWizardButtons,
  wizardButtonStats,
} from "../public/js/wizard-model.js";

/* The remote's Back key is assignable in the wizard, as in the app: real hubs
   store it as the PrevChannel ButtonKey. */

function device(id, names) {
  return {
    id: String(id),
    name: `Device ${id}`,
    commands: names.map((name, i) => ({ name, functionId: 200 + i })),
  };
}

const player = device(1, ["Play", "Back", "Select"]);
const returner = device(2, ["Play", "Return"]);
const roles = (deviceId) => [{ deviceId, roleType: "PlayMovieActivityRole" }];

describe("wizard Back key", () => {
  it("maps the Back label to PrevChannel", () => {
    assert.equal(BUTTON_KEY_BY_LABEL.Back, "PrevChannel");
  });

  it("suggests the player's Back or Return command for it", () => {
    assert.equal(deriveDefaultButtons(roles("1"), [player]).PrevChannel?.command?.name, "Back");
    assert.equal(deriveDefaultButtons(roles("2"), [returner]).PrevChannel?.command?.name, "Return");
  });

  it("counts Back among the 38 assignable keys", () => {
    assert.equal(wizardButtonStats({}).assignable, 38);
  });

  it("keeps an activity's own Back mapping over the suggestion", () => {
    const map = {
      Buttons: [{
        ButtonKey: "PrevChannel",
        ButtonAction: { "DeviceId-": 1, CommandName: "Select", "FunctionId-": 202 },
      }],
    };
    const buttons = reconcileWizardButtons(draftButtonsFromMap(map), roles("1"), [player]);
    assert.equal(buttons.PrevChannel.command.name, "Select");
    assert.equal(buttons.PrevChannel.source, BUTTON_SOURCE.existing);
  });
});
