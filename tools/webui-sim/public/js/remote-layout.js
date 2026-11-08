/* Remote keys and their command aliases, ported from codex_webui.c
 * (IR_REMOTE_BUTTONS, ir_command_key, ir_alias_match, ir_find_remote_command).
 * The order matches the C array. The C table also places each key on the
 * remote photo; the web UI draws its own keypad, so only labels and aliases
 * come across.
 */

export const REMOTE_BUTTONS = [
  { label: "Power off", aliases: "poweroff|power off|standby|shutdown|off|powertoggle|power toggle|power" },
  { label: "Music", aliases: "music|audio" },
  { label: "TV", aliases: "tv|television|watchtv|display" },
  { label: "Movie", aliases: "movie|video|media" },
  { label: "Rewind", aliases: "rewind|rev|skipback|previous track" },
  { label: "Play", aliases: "play" },
  { label: "Forward", aliases: "fastforward|forward|ffwd|next track|skipforward" },
  { label: "Record", aliases: "record|rec" },
  { label: "Pause", aliases: "pause" },
  { label: "Stop", aliases: "stop" },
  { label: "Red", aliases: "red" },
  { label: "Green", aliases: "green" },
  { label: "Yellow", aliases: "yellow" },
  { label: "Blue", aliases: "blue" },
  { label: "DVR", aliases: "dvr|recordings" },
  { label: "Guide", aliases: "guide|epg" },
  { label: "Info", aliases: "info|information|displayinfo|settings|setting|setup|option|options" },
  { label: "Exit", aliases: "exit|clear|cancel" },
  { label: "Menu", aliases: "menu" },
  { label: "Up", aliases: "up|directionup|arrowup|cursorup" },
  { label: "Left", aliases: "left|directionleft|arrowleft|cursorleft" },
  { label: "Right", aliases: "right|directionright|arrowright|cursorright" },
  { label: "Down", aliases: "down|directiondown|arrowdown|cursordown" },
  { label: "OK", aliases: "ok|select|enter" },
  { label: "Volume up", aliases: "volumeup|volup|vol up|vol_up|volume up" },
  { label: "Volume down", aliases: "volumedown|voldown|voldn|vol down|vol_down|vol_dn|volume down" },
  { label: "Channel up", aliases: "channelup|chup|chnext|ch_next|ch up|channel next|channelnext|pageup|pgup" },
  { label: "Channel down", aliases: "channeldown|chdown|chdn|chprev|ch_prev|ch down|ch_dn|channel prev|channel previous|channel down|channelprev|channeldn|pagedown|pgdown" },
  { label: "Mute", aliases: "mute" },
  { label: "Back", aliases: "back|return|previous" },
  { label: "1", aliases: "1|digit1|number1|num1" },
  { label: "2", aliases: "2|digit2|number2|num2" },
  { label: "3", aliases: "3|digit3|number3|num3" },
  { label: "4", aliases: "4|digit4|number4|num4" },
  { label: "5", aliases: "5|digit5|number5|num5" },
  { label: "6", aliases: "6|digit6|number6|num6" },
  { label: "7", aliases: "7|digit7|number7|num7" },
  { label: "8", aliases: "8|digit8|number8|num8" },
  { label: "9", aliases: "9|digit9|number9|num9" },
  { label: "Dash", aliases: "dash|hyphen|separator|dot|period|minus" },
  { label: "0", aliases: "0|digit0|number0|num0" },
  { label: "Enter", aliases: "enter|e" },
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

/* ir_find_remote_command: first device command whose name matches any alias,
 * except that a name equal to an alias beats an earlier one that only
 * contains it (owner-approved 2026-10-21; C and the app still take the first
 * match). Otherwise OK finds "CenterDown" before "Enter" and Back finds
 * "PreviousTrack" before "Return". */
export function matchCommand(commands, aliases) {
  const exact = new Set(String(aliases ?? "").split("|").map(commandKey).filter(Boolean));
  const list = commands ?? [];
  return list.find((command) => exact.has(commandKey(command.name)))
    ?? list.find((command) => aliasMatch(commandKey(command.name), aliases))
    ?? null;
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
  // The physical remote's Back key is stored as PrevChannel in real MapLists.
  Back: "PrevChannel",
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
