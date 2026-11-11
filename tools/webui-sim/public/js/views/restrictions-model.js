/* Activity time restrictions: the times an activity can't be started. The hub
   keeps them in /data/codex/activity-restrictions.json and its boot script
   (netservicestarter.lua) refuses a start inside one of them, from any remote
   or app. A window is { days, start, end }: days by name, times as HH:MM in
   the hub's time zone, end exclusive and possibly "24:00". An end before the
   start runs past midnight and belongs to the day it starts.

   codex_webui.c checks a save the same way (restriction_parse_window); the
   sim's /api/activity-restrictions uses this file. */

/* Monday first, as the sheet shows them; the hub's file uses the same keys. */
export const DAYS = [
  { key: "mon", short: "Mon", long: "Monday" },
  { key: "tue", short: "Tue", long: "Tuesday" },
  { key: "wed", short: "Wed", long: "Wednesday" },
  { key: "thu", short: "Thu", long: "Thursday" },
  { key: "fri", short: "Fri", long: "Friday" },
  { key: "sat", short: "Sat", long: "Saturday" },
  { key: "sun", short: "Sun", long: "Sunday" },
];

export const MAX_WINDOWS = 8;
export const MAX_ACTIVITIES = 64;

const DAY_KEYS = DAYS.map((d) => d.key);

/* A new window: the weekend morning the feature was made for. */
export function newWindow() {
  return { days: ["sat", "sun"], start: "06:00", end: "09:00" };
}

/* "HH:MM" -> minutes since midnight, or null. "24:00" only as an end. */
export function clockMinutes(text, { isEnd = false } = {}) {
  const m = /^(\d\d):([0-5]\d)$/.exec(String(text ?? ""));
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 1440 || (isEnd && minutes === 1440) ? minutes : null;
}

/* Activity ids are digits; PowerOff (-1) is never restricted. */
export function isRestrictableId(id) {
  return /^\d{1,20}$/.test(String(id ?? ""));
}

/* One window in the hub's form (days in week order, no repeats), or an error
   naming it by its place in the list (1-based). */
export function normalizeWindow(raw, number = 1) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.days)) {
    return { error: `Time ${number} needs its days.` };
  }
  if (raw.days.some((d) => !DAY_KEYS.includes(d))) {
    return { error: `Time ${number} has a day that isn't mon, tue, wed, thu, fri, sat or sun.` };
  }
  const days = DAY_KEYS.filter((k) => raw.days.includes(k));
  if (!days.length) return { error: `Pick at least one day for time ${number}.` };
  const from = clockMinutes(raw.start);
  const to = clockMinutes(raw.end, { isEnd: true });
  if (from === null || to === null) return { error: `Time ${number} needs a start and an end, as HH:MM.` };
  if (from === to) return { error: `Time ${number} starts and ends at the same time.` };
  return { window: { days, start: raw.start, end: raw.end } };
}

/* An activity's whole list, or the first error in it. */
export function normalizeWindows(list) {
  if (!Array.isArray(list)) return { error: "Send the activity's times as a list." };
  if (list.length > MAX_WINDOWS) return { error: `An activity can have up to ${MAX_WINDOWS} times.` };
  const windows = [];
  for (let i = 0; i < list.length; i += 1) {
    const { window, error } = normalizeWindow(list[i], i + 1);
    if (error) return { error };
    windows.push(window);
  }
  return { windows };
}

/* A time input can't show 24:00: the sheet shows an end at midnight as 00:00
   and saves 00:00 as 24:00, so 22:00–00:00 runs until midnight and
   00:00–00:00 is the whole day. */
export function endForInput(end) {
  return end === "24:00" ? "00:00" : end;
}

export function endFromInput(value) {
  return value === "00:00" ? "24:00" : value;
}

/* True when the window runs past midnight into the next day. */
export function crossesMidnight(window) {
  const from = clockMinutes(window.start);
  const to = clockMinutes(window.end, { isEnd: true });
  return from !== null && to !== null && to < from;
}

/* "Weekends", "Mon–Fri", "Mon, Wed, Fri", "Every day". */
export function describeDays(days) {
  const on = DAY_KEYS.map((k) => days.includes(k));
  const count = on.filter(Boolean).length;
  if (count === 7) return "Every day";
  if (count === 0) return "No days";
  if (count === 2 && on[5] && on[6]) return "Weekends";
  if (count === 5 && on.slice(0, 5).every(Boolean)) return "Weekdays";
  // One unbroken run of three or more days reads as a range.
  const first = on.indexOf(true);
  const last = on.lastIndexOf(true);
  if (count >= 3 && last - first + 1 === count) return `${DAYS[first].short}–${DAYS[last].short}`;
  return DAYS.filter((_, i) => on[i]).map((d) => d.short).join(", ");
}

/* "Weekends · 06:00–09:00", "Fri · 22:00–02:00 the next day",
   "Mon · 20:00–midnight", "Sun · all day". */
export function describeWindow(window) {
  let times = `${window.start}–${window.end}`;
  if (window.end === "24:00") times = window.start === "00:00" ? "all day" : `${window.start}–midnight`;
  else if (crossesMidnight(window)) times += " the next day";
  return `${describeDays(window.days)} · ${times}`;
}

/* True when a start at local weekday `wday` (0 = Sunday, as Date.getDay())
   and `minutes` since midnight falls in one of the windows. Mirrors
   windowCovers() in netservicestarter.lua: end exclusive, and a window past
   midnight covers its start day from start and the next day until end. */
export function restrictedAt(windows, wday, minutes) {
  const key = (d) => DAY_KEYS[(d + 6) % 7]; // Date's Sunday-first to mon..sun
  return (windows ?? []).some((w) => {
    const from = clockMinutes(w.start);
    const to = clockMinutes(w.end, { isEnd: true });
    if (from === null || to === null || from === to) return false;
    if (from < to) return w.days.includes(key(wday)) && minutes >= from && minutes < to;
    return (w.days.includes(key(wday)) && minutes >= from) ||
      (w.days.includes(key((wday + 6) % 7)) && minutes < to);
  });
}

/* The snackbar text for a start that failed; the hub answers a start inside
   the activity's time restrictions with { restricted: true }. */
export function startFailureText(name, error) {
  if (error?.data?.restricted) return `“${name}” can't be started now: it has time restrictions.`;
  return `Couldn't start ${name} — ${error?.message || "hub error"}`;
}

/* The row summary for an activity: its windows, or "" for none. */
export function describeRestrictions(windows) {
  if (!windows?.length) return "";
  if (windows.length === 1) return `Can't start ${describeWindow(windows[0])}`;
  return `Can't start at ${windows.length} times`;
}
