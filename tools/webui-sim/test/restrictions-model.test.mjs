import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WINDOWS,
  clockMinutes,
  crossesMidnight,
  describeDays,
  describeRestrictions,
  describeWindow,
  endForInput,
  endFromInput,
  isRestrictableId,
  newWindow,
  normalizeWindow,
  normalizeWindows,
  restrictedAt,
  startFailureText,
} from "../public/js/views/restrictions-model.js";

describe("time restrictions model", () => {
  it("reads HH:MM, with 24:00 only as an end", () => {
    assert.equal(clockMinutes("06:00"), 360);
    assert.equal(clockMinutes("23:59"), 1439);
    assert.equal(clockMinutes("24:00"), null);
    assert.equal(clockMinutes("24:00", { isEnd: true }), 1440);
    assert.equal(clockMinutes("24:01", { isEnd: true }), null);
    for (const bad of ["6:00", "06:60", "0600", "06:00:00", "", null, 600]) assert.equal(clockMinutes(bad), null, String(bad));
  });

  it("restricts activities by their digit ids, never PowerOff", () => {
    assert.ok(isRestrictableId("32923238"));
    assert.ok(isRestrictableId(100));
    for (const bad of ["-1", "", "12a", "1".repeat(21), null]) assert.ok(!isRestrictableId(bad), String(bad));
  });

  it("puts days in week order without repeats", () => {
    assert.deepEqual(normalizeWindow({ days: ["sun", "sat", "sat"], start: "06:00", end: "09:00" }),
      { window: { days: ["sat", "sun"], start: "06:00", end: "09:00" } });
  });

  it("names the time that is wrong", () => {
    const err = (list) => normalizeWindows(list).error;
    assert.equal(err([newWindow(), { days: [], start: "06:00", end: "09:00" }]), "Pick at least one day for time 2.");
    assert.equal(err([{ days: ["Mon"], start: "06:00", end: "09:00" }]), "Time 1 has a day that isn't mon, tue, wed, thu, fri, sat or sun.");
    assert.equal(err([{ days: ["mon"], start: "6:00", end: "09:00" }]), "Time 1 needs a start and an end, as HH:MM.");
    assert.equal(err([{ days: ["mon"], start: "24:00", end: "09:00" }]), "Time 1 needs a start and an end, as HH:MM.");
    assert.equal(err([{ days: ["mon"], start: "07:00", end: "07:00" }]), "Time 1 starts and ends at the same time.");
    assert.equal(err([{ start: "07:00", end: "08:00" }]), "Time 1 needs its days.");
    assert.equal(err("nope"), "Send the activity's times as a list.");
    assert.equal(err(Array.from({ length: MAX_WINDOWS + 1 }, newWindow)), `An activity can have up to ${MAX_WINDOWS} times.`);
    assert.deepEqual(normalizeWindows([]), { windows: [] });
  });

  it("shows an end at midnight as 00:00 and saves it as 24:00", () => {
    assert.equal(endForInput("24:00"), "00:00");
    assert.equal(endForInput("09:00"), "09:00");
    assert.equal(endFromInput("00:00"), "24:00");
    assert.equal(endFromInput("09:00"), "09:00");
    // 00:00 to 00:00 in the sheet is the whole day
    assert.ok(normalizeWindow({ days: ["sun"], start: "00:00", end: endFromInput("00:00") }).window);
  });

  it("describes days the short way", () => {
    assert.equal(describeDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), "Every day");
    assert.equal(describeDays(["sat", "sun"]), "Weekends");
    assert.equal(describeDays(["mon", "tue", "wed", "thu", "fri"]), "Weekdays");
    assert.equal(describeDays(["mon", "tue", "wed", "thu"]), "Mon–Thu");
    assert.equal(describeDays(["mon", "wed", "fri"]), "Mon, Wed, Fri");
    assert.equal(describeDays(["fri", "sat"]), "Fri, Sat");
  });

  it("describes windows, including past midnight and the whole day", () => {
    assert.equal(describeWindow({ days: ["sat", "sun"], start: "06:00", end: "09:00" }), "Weekends · 06:00–09:00");
    assert.equal(describeWindow({ days: ["fri"], start: "22:00", end: "02:00" }), "Fri · 22:00–02:00 the next day");
    assert.equal(describeWindow({ days: ["mon"], start: "20:00", end: "24:00" }), "Mon · 20:00–midnight");
    assert.equal(describeWindow({ days: ["sun"], start: "00:00", end: "24:00" }), "Sun · all day");
    assert.ok(crossesMidnight({ start: "22:00", end: "02:00" }));
    assert.ok(!crossesMidnight({ start: "20:00", end: "24:00" }));
  });

  it("knows when a start is restricted, like the hub's hook", () => {
    // Date.getDay(): 0 = Sunday … 5 = Friday, 6 = Saturday
    const weekend = [{ days: ["sat", "sun"], start: "06:00", end: "09:00" }];
    assert.ok(restrictedAt(weekend, 6, 6 * 60));
    assert.ok(!restrictedAt(weekend, 6, 9 * 60), "end is exclusive");
    assert.ok(!restrictedAt(weekend, 5, 7 * 60), "Friday is free");
    assert.ok(restrictedAt(weekend, 0, 8 * 60 + 59));
    const friNight = [{ days: ["fri"], start: "22:00", end: "02:00" }];
    assert.ok(restrictedAt(friNight, 5, 23 * 60));
    assert.ok(restrictedAt(friNight, 6, 60), "past midnight into Saturday");
    assert.ok(!restrictedAt(friNight, 5, 60), "the night before Friday is free");
    assert.ok(!restrictedAt(friNight, 6, 2 * 60));
    const sunNight = [{ days: ["sun"], start: "22:00", end: "02:00" }];
    assert.ok(restrictedAt(sunNight, 1, 30), "Sunday night runs into Monday");
    assert.ok(restrictedAt([{ days: ["mon"], start: "00:00", end: "24:00" }], 1, 1439));
    assert.ok(!restrictedAt(undefined, 1, 0));
  });

  it("words a refused start", () => {
    assert.equal(startFailureText("Play a game", { message: "x", data: { restricted: true } }),
      "“Play a game” can't be started now: it has time restrictions.");
    assert.equal(startFailureText("TV", { message: "HTTP 502" }), "Couldn't start TV — HTTP 502");
    assert.equal(startFailureText("TV", null), "Couldn't start TV — hub error");
  });

  it("sums up an activity's restrictions for its row", () => {
    assert.equal(describeRestrictions([]), "");
    assert.equal(describeRestrictions(undefined), "");
    assert.equal(describeRestrictions([newWindow()]), "Can't start Weekends · 06:00–09:00");
    assert.equal(describeRestrictions([newWindow(), newWindow()]), "Can't start at 2 times");
  });
});
