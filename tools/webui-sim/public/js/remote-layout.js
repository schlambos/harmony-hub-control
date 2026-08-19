/* Virtual remote geometry + alias matching, ported from codex_webui.c
 * (IR_REMOTE_BUTTONS, ir_command_key, ir_alias_match, ir_find_remote_command).
 *
 * Positions are percentages of the remote body: { x, y, w, h } map to
 * left/top/width/height on an absolutely positioned key. DOM order matches
 * the C array so overlapping d-pad keys stack the same way (OK is drawn
 * last and wins the center).
 */

export const REMOTE_BUTTONS = [
  { label: "Power off", aliases: "poweroff|power off|standby|shutdown|off|powertoggle|power toggle|power", x: 13.55, y: 0.45, w: 18.60, h: 3.35 },
  { label: "Music", aliases: "music|audio", x: 8.80, y: 6.85, w: 26.75, h: 5.10 },
  { label: "TV", aliases: "tv|television|watchtv|display", x: 35.50, y: 6.85, w: 27.10, h: 5.10 },
  { label: "Movie", aliases: "movie|video|media", x: 62.60, y: 6.85, w: 27.10, h: 5.10 },
  { label: "Rewind", aliases: "rewind|rev|skipback|previous track", x: 8.80, y: 14.90, w: 27.95, h: 5.25 },
  { label: "Play", aliases: "play", x: 41.45, y: 15.00, w: 16.25, h: 5.40 },
  { label: "Forward", aliases: "fastforward|forward|ffwd|next track|skipforward", x: 62.45, y: 14.85, w: 27.95, h: 5.30 },
  { label: "Record", aliases: "record|rec", x: 8.95, y: 21.80, w: 27.90, h: 5.35 },
  { label: "Pause", aliases: "pause", x: 41.45, y: 21.80, w: 16.25, h: 5.35 },
  { label: "Stop", aliases: "stop", x: 62.45, y: 21.80, w: 27.95, h: 5.35 },
  { label: "Red", aliases: "red", x: 9.30, y: 30.00, w: 18.60, h: 3.75 },
  { label: "Green", aliases: "green", x: 30.10, y: 30.00, w: 18.95, h: 3.75 },
  { label: "Yellow", aliases: "yellow", x: 51.80, y: 30.00, w: 18.15, h: 3.75 },
  { label: "Blue", aliases: "blue", x: 73.25, y: 30.00, w: 17.45, h: 3.75 },
  { label: "DVR", aliases: "dvr|recordings", x: 9.00, y: 36.95, w: 27.40, h: 5.05 },
  { label: "Guide", aliases: "guide|epg", x: 36.40, y: 36.95, w: 26.40, h: 5.05 },
  { label: "Info", aliases: "info|information|displayinfo|settings|setting|setup|option|options", x: 62.80, y: 36.95, w: 26.75, h: 5.05 },
  { label: "Exit", aliases: "exit|clear|cancel", x: 9.10, y: 45.45, w: 36.05, h: 4.95 },
  { label: "Menu", aliases: "menu|home", x: 53.95, y: 45.45, w: 35.70, h: 4.95 },
  { label: "Up", aliases: "up|directionup|arrowup|cursorup", x: 36.40, y: 49.85, w: 27.60, h: 6.30 },
  { label: "Left", aliases: "left|directionleft|arrowleft|cursorleft", x: 28.80, y: 54.70, w: 14.90, h: 12.10 },
  { label: "Right", aliases: "right|directionright|arrowright|cursorright", x: 56.30, y: 54.70, w: 14.90, h: 12.10 },
  { label: "Down", aliases: "down|directiondown|arrowdown|cursordown", x: 36.40, y: 64.55, w: 27.60, h: 6.20 },
  { label: "OK", aliases: "ok|select|enter", x: 40.10, y: 56.10, w: 19.80, h: 9.10 },
  { label: "Volume up", aliases: "volumeup|volup|vol up|vol_up|volume up", x: 9.30, y: 52.20, w: 19.30, h: 8.85 },
  { label: "Volume down", aliases: "volumedown|voldown|voldn|vol down|vol_down|vol_dn|volume down", x: 9.30, y: 61.05, w: 19.30, h: 9.05 },
  { label: "Channel up", aliases: "channelup|chup|chnext|ch_next|ch up|channel next|channelnext|pageup|pgup", x: 70.20, y: 52.20, w: 19.15, h: 8.85 },
  { label: "Channel down", aliases: "channeldown|chdown|chdn|chprev|ch_prev|ch down|ch_dn|channel prev|channel previous|channel down|channelprev|channeldn|pagedown|pgdown", x: 70.20, y: 61.05, w: 19.15, h: 9.05 },
  { label: "Mute", aliases: "mute", x: 9.30, y: 71.70, w: 36.20, h: 5.30 },
  { label: "Back", aliases: "back|return|previous", x: 54.15, y: 71.70, w: 35.55, h: 5.30 },
  { label: "1", aliases: "1|digit1|number1|num1", x: 9.30, y: 80.45, w: 27.10, h: 3.45 },
  { label: "2", aliases: "2|digit2|number2|num2", x: 36.40, y: 80.45, w: 26.25, h: 3.45 },
  { label: "3", aliases: "3|digit3|number3|num3", x: 62.60, y: 80.45, w: 27.05, h: 3.45 },
  { label: "4", aliases: "4|digit4|number4|num4", x: 9.30, y: 85.55, w: 27.10, h: 3.40 },
  { label: "5", aliases: "5|digit5|number5|num5", x: 36.40, y: 85.55, w: 26.25, h: 3.40 },
  { label: "6", aliases: "6|digit6|number6|num6", x: 62.60, y: 85.55, w: 27.05, h: 3.40 },
  { label: "7", aliases: "7|digit7|number7|num7", x: 9.30, y: 90.60, w: 27.10, h: 3.35 },
  { label: "8", aliases: "8|digit8|number8|num8", x: 36.40, y: 90.60, w: 26.25, h: 3.35 },
  { label: "9", aliases: "9|digit9|number9|num9", x: 62.60, y: 90.60, w: 27.05, h: 3.35 },
  { label: "Dash", aliases: "dash|hyphen|separator|dot|period|minus", x: 9.30, y: 95.70, w: 27.10, h: 3.35 },
  { label: "0", aliases: "0|digit0|number0|num0", x: 36.40, y: 95.70, w: 26.25, h: 3.35 },
  { label: "Enter", aliases: "enter|e", x: 62.60, y: 95.70, w: 27.05, h: 3.35 },
];

/* ir_command_key: lowercase, keep alphanumerics only. */
export function commandKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* ir_alias_match: exact key match, or the alias (when longer than 4 chars)
 * appears as a substring of the command key — same as the C strstr check. */
export function aliasMatch(cmdKey, aliases) {
  if (!cmdKey) return false;
  for (const raw of String(aliases ?? "").split("|")) {
    const key = commandKey(raw);
    if (!key) continue;
    if (key === cmdKey) return true;
    if (key.length > 4 && cmdKey.includes(key)) return true;
  }
  return false;
}

/* ir_find_remote_command: first device command whose name matches any alias. */
export function matchCommand(commands, aliases) {
  for (const command of commands ?? []) {
    if (aliasMatch(commandKey(command.name), aliases)) return command;
  }
  return null;
}

/* Tints for the A/B/C/D color row, keyed by label. */
export const KEY_TINTS = {
  Red: "tint-red",
  Green: "tint-green",
  Yellow: "tint-yellow",
  Blue: "tint-blue",
};

/* Canonical firmware ButtonKey names (as they appear in genuine MapList
   entries) for every hard key the setup wizard lets users map. Keys absent
   here are power or activity shortcuts, which activity maps do not carry. */
export const BUTTON_KEY_BY_LABEL = {
  Rewind: "Rewind",
  Play: "Play",
  Forward: "FastForward",
  Record: "Record",
  Pause: "Pause",
  Stop: "Stop",
  Red: "Red",
  Green: "Green",
  Yellow: "Yellow",
  Blue: "Blue",
  DVR: "Dvr",
  Guide: "Guide",
  Info: "Info",
  Exit: "Exit",
  Menu: "Menu",
  Up: "DirectionUp",
  Left: "DirectionLeft",
  Right: "DirectionRight",
  Down: "DirectionDown",
  OK: "Select",
  "Volume up": "VolumeUp",
  "Volume down": "VolumeDown",
  Mute: "VolumeMute",
  "Channel up": "ChannelUp",
  "Channel down": "ChannelDown",
  1: "Number1",
  2: "Number2",
  3: "Number3",
  4: "Number4",
  5: "Number5",
  6: "Number6",
  7: "Number7",
  8: "Number8",
  9: "Number9",
  0: "Number0",
};
