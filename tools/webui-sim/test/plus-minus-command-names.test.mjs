import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_BUTTONS, commandKey, matchCommand } from "../public/js/remote-layout.js";

/* IRDB names a Samsung TV's (Samsung/TV/7,7.csv) volume and channel keys
   "VOLUME +", "VOLUME -", "CHANNEL +" and "CHANNEL -". Keeping alphanumerics
   only turned both of each pair into the same key ("volume", "channel"), so
   none of the four reached the remote's Volume and Channel keys. */

const aliasesOf = (label) => REMOTE_BUTTONS.find((b) => b.label === label).aliases;
const cmds = (...names) => names.map((name, i) => ({ name, functionId: i }));

describe("trailing + and - in command names", () => {
  it("read as up and down after a letter", () => {
    assert.equal(commandKey("VOLUME +"), "volumeup");
    assert.equal(commandKey("VOLUME -"), "volumedown");
    assert.equal(commandKey("CHANNEL +"), "channelup");
    assert.equal(commandKey("CH-"), "chdown");
    assert.equal(commandKey("Vol+ "), "volup");
  });

  it("leave other names as they were", () => {
    assert.equal(commandKey("-"), "");
    assert.equal(commandKey("Dash"), "dash");
    assert.equal(commandKey("VolumeUp"), "volumeup");
    assert.equal(commandKey("HDMI 1"), "hdmi1");
    assert.equal(commandKey("3D"), "3d");
    assert.equal(commandKey("AD/SUBT"), "adsubt");
  });

  it("put IRDB's Samsung names on the Volume and Channel keys", () => {
    const tv = cmds("POWER", "VOLUME +", "VOLUME -", "MUTE", "CHANNEL -", "CHANNEL +", "CH LIST");
    assert.equal(matchCommand(tv, aliasesOf("Volume up"))?.name, "VOLUME +");
    assert.equal(matchCommand(tv, aliasesOf("Volume down"))?.name, "VOLUME -");
    assert.equal(matchCommand(tv, aliasesOf("Channel up"))?.name, "CHANNEL +");
    assert.equal(matchCommand(tv, aliasesOf("Channel down"))?.name, "CHANNEL -");
  });
});
