/* Issue #224: saving an activity on a hub with realistic (~340 KB) resources
   must not starve /var/watchdog/luaworks or block luaworks websocket polls.

   The hub runs single-threaded cooperative Lua 5.1.4 on a 400 MHz MIPS 24Kc
   without a hardware FPU, supervised by /usr/bin/watchdog which reboots the
   hub if /var/watchdog/luaworks goes untouched for > 15 s.
   `fnv1a32` in codexactivity.lua ran a pure-Lua bit-by-bit XOR loop (~117
   soft-float ops and ~122 VM instructions per byte) with zero yields and zero
   tiggleWatchDog calls, rebooting the hub on every Save.

   These tests run the real codexactivity.lua under `luajit -joff` (interpreter
   mode, no JIT) against the 340 KB hub-emu seed resources and verify:
   1. Both the hub's native `bit` path and the pure-Lua fallback match
      codex_webui.c's resource_hash() byte-for-byte, including hashes >= 2^31
      under the hub's saturating 32-bit %x conversion.
   2. currentActivityRevision() stays fast (bounded Lua VM instructions) and
      repeatedly tickles the watchdog and yields cooperatively so pending
      /api/state polls and tasks/watchdog/main.lua run mid-hash.
   3. commitActivityResources() yields and tickles the watchdog across its
      hash, snapshot, validate, and save phases, and rejects a stale
      baseRevision before doing unnecessary resourceSnapshot work. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const luaPath = new URL("../../../payload/activity/codexactivity.lua", import.meta.url).pathname;
const seedDir = new URL("../../hub-emu/seed/resources/", import.meta.url).pathname;

function cHash(text) {
  let h = 2166136261;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function readSeed(name) {
  return readFileSync(`${seedDir}${name}`, "utf8");
}

function runLuaProbe({ disableBit = false, mode = "revision", files, staleBase = false }) {
  const script = `
    local disableBit = ${disableBit ? "true" : "false"}
    local mode = ${JSON.stringify(mode)}
    local staleBase = ${staleBase ? "true" : "false"}

    if disableBit then
      package.loaded["bit"] = nil
      package.preload["bit"] = function() error("bit disabled for fallback test") end
      local realRequire = require
      require = function(name)
        if name == "bit" then error("bit disabled for fallback test") end
        return realRequire(name)
      end
    end

    -- Reproduce the hub's 32-bit signed-long %x clamp (PR #225).
    local realFormat = string.format
    string.format = function(fmt, ...)
      local args = { ... }
      local i = 0
      for spec in fmt:gmatch("%%[-0-9.]*(%a)") do
        i = i + 1
        if spec == "x" and type(args[i]) == "number" and args[i] > 2147483647 then
          args[i] = 2147483647
        end
      end
      return realFormat(fmt, unpack(args, 1, select("#", ...)))
    end

    local files = {
      ["/data/codex/cloud_blocker.conf"] = "1\\n",
      ["/data/resources/ActivityList.json"] = ${JSON.stringify(files.act)},
      ["/data/resources/MapList.json"] = ${JSON.stringify(files.map)},
      ["/data/resources/FunctionList.json"] = ${JSON.stringify(files.fn)},
    }
    local realIoOpen = io.open
    io.open = function(p, m)
      if files[p] ~= nil then
        return { read = function() return files[p] end, close = function() end }
      end
      return realIoOpen(p, m)
    end

    local watchdogTicks = 0
    local yieldCount = 0
    local pollRuns = 0
    local hookTicks = 0
    local sinceWatchdog = 0
    local maxBetweenWatchdog = 0
    local sinceYield = 0
    local maxBetweenYield = 0
    local snapshotCalls = 0
    local saveCalls = 0

    local function noteWatchdog()
      watchdogTicks = watchdogTicks + 1
      if sinceWatchdog > maxBetweenWatchdog then maxBetweenWatchdog = sinceWatchdog end
      sinceWatchdog = 0
    end

    local function noteYield()
      yieldCount = yieldCount + 1
      if sinceYield > maxBetweenYield then maxBetweenYield = sinceYield end
      sinceYield = 0
      coroutine.yield("worker-yield")
    end

    package.preload["system"] = function()
      return {
        isMessageRegistered = function() return true end,
        sendMessage = function() return true end,
        addTask = function(_, fn)
          fn()
          return { status = "dead" }
        end,
        taskStatus = function() return "dead" end,
        jiffies = function() return { tomillis = function() return 1000 end } end,
        uuid = function() return "00000000-0000-4000-8000-000000000001" end,
        tiggleWatchDog = noteWatchdog,
        yield = noteYield,
        blockingSleep = function() noteYield() end,
        sleep = function() noteYield() end,
      }
    end
    package.preload["json"] = function()
      return {
        decode = function() return {} end,
        encode = function() return "{}" end,
      }
    end
    package.preload["log"] = function()
      return { logger = function() return { notice = function() end, error = function() end, warning = function() end } end }
    end
    local emptyResources = {
      ActivityList = { Activities = {} },
      MapList = { ButtonMaps = {} },
      FunctionList = { FunctionMaps = {} },
      DeviceList = { DevicesWithFeatures = {} },
    }
    local savedEtags = {}
    package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
      return {
        getResource = function(name)
          snapshotCalls = snapshotCalls + 1
          return "200", savedEtags[name] or '"e1"', emptyResources[name] or {}
        end,
        getHubEtag = function() return "1" end,
        isAnySyncInProgress = function() return false end,
        saveResource = function(_, etag, val, name)
          saveCalls = saveCalls + 1
          savedEtags[name] = etag
          emptyResources[name] = val
          return true
        end,
      }
    end
    package.preload["tasks.harmonywebservices.core.statedigest"] = function()
      return { instance = function() return { configVersion = 1, stateVersion = 1, saveStateDigest = function() end } end }
    end
    package.preload["tasks.connectserver.core.utils"] = function()
      return { broadcastEvent = function() end, createResponse = function() return {} end }
    end

    local src = assert(realIoOpen(${JSON.stringify(luaPath)}, "r")):read("*a")
    src = src
      :gsub("local function currentActivityRevision", "function currentActivityRevision")
      :gsub("local function commitActivityResources", "function commitActivityResources")
    local chunk = assert(loadstring(src))
    chunk("codexactivity")

    local resultRev = ""
    local commitOk = ""
    local commitConflict = ""

    local worker = coroutine.create(function()
      if mode == "revision" then
        resultRev = _G.codexactivity.currentActivityRevision() or ""
      elseif mode == "commit" then
        local base = staleBase and "00000000-00000000-00000000" or _G.codexactivity.currentActivityRevision()
        -- Reset counters after computing baseline so we measure the commit itself.
        watchdogTicks, yieldCount, pollRuns = 0, 0, 0
        hookTicks, sinceWatchdog, maxBetweenWatchdog = 0, 0, 0
        sinceYield, maxBetweenYield = 0, 0
        snapshotCalls, saveCalls = 0, 0
        local res = _G.codexactivity.commitActivityResources({
          baseRevision = base,
          activityList = { Activities = {} },
          mapList = { ButtonMaps = {} },
          functionList = { FunctionMaps = {} },
        })
        commitOk = tostring(res.ok)
        commitConflict = tostring(res.conflict or false)
        resultRev = tostring(res.revision or base or "")
      end
    end)

    debug.sethook(worker, function()
      hookTicks = hookTicks + 1
      sinceWatchdog = sinceWatchdog + 1
      sinceYield = sinceYield + 1
    end, "", 10000)

    while coroutine.status(worker) ~= "dead" do
      local ok, why = coroutine.resume(worker)
      assert(ok, tostring(why))
      if why == "worker-yield" then
        -- Simulate another cooperative luaworks task (HA /api/state poll) getting CPU.
        pollRuns = pollRuns + 1
      end
    end

    if sinceWatchdog > maxBetweenWatchdog then maxBetweenWatchdog = sinceWatchdog end
    if sinceYield > maxBetweenYield then maxBetweenYield = sinceYield end

    io.write(realFormat(
      "rev=%s\\nhookTicks=%d\\nwatchdogTicks=%d\\nyieldCount=%d\\npollRuns=%d\\nmaxBetweenWatchdog=%d\\nmaxBetweenYield=%d\\nsnapshotCalls=%d\\nsaveCalls=%d\\ncommitOk=%s\\ncommitConflict=%s\\n",
      resultRev, hookTicks, watchdogTicks, yieldCount, pollRuns,
      maxBetweenWatchdog, maxBetweenYield, snapshotCalls, saveCalls, commitOk, commitConflict
    ))
  `;

  const out = execFileSync("luajit", ["-joff", "-e", script], { encoding: "utf8" });
  const parsed = {};
  for (const line of out.trim().split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      const k = line.slice(0, idx);
      const v = line.slice(idx + 1);
      parsed[k] = /^-?\d+$/.test(v) ? Number(v) : v;
    }
  }
  return parsed;
}

describe("issue #224: codexactivity save revision hash & watchdog liveness", () => {
  const act = readSeed("ActivityList.json");
  const map = readSeed("MapList.json");
  const fn = readSeed("FunctionList.json");
  const expectedSeedRev = `${cHash(act)}-${cHash(map)}-${cHash(fn)}`;

  it("matches codex_webui.c resource_hash() on the 340 KB seed resources in both bit and pure-Lua fallback paths", () => {
    // Seed resources include top-bit-set hashes (>= 2^31) that triggered #225.
    assert.ok(parseInt(cHash(map), 16) >= 2 ** 31, "seed MapList hash should exercise >= 2^31");
    assert.ok(parseInt(cHash(fn), 16) >= 2 ** 31, "seed FunctionList hash should exercise >= 2^31");

    const withBit = runLuaProbe({ disableBit: false, mode: "revision", files: { act, map, fn } });
    assert.equal(withBit.rev, expectedSeedRev, "bit path must match C resource_hash()");

    const fallback = runLuaProbe({ disableBit: true, mode: "revision", files: { act, map, fn } });
    assert.equal(fallback.rev, expectedSeedRev, "pure-Lua fallback path must match C resource_hash()");
  });

  it("matches codex_webui.c on empty, all 256 byte values (0x00..0xff), and UTF-8 inputs in both paths", () => {
    const cases = [
      { act: "", map: "a", fn: "hub" },
      { act: '{"Activities":[]}', map: "0123456789abcdef".repeat(64), fn: "hub-edge-case-rev" },
      { act: "\u00e9\u00e0\u00fc\u2014", map: '{"ButtonMaps":[{"TextOnRemote":"D\u00e9marrer"}]}', fn: '{"FunctionMaps":[]}' },
    ];
    for (const c of cases) {
      const expected = `${cHash(c.act)}-${cHash(c.map)}-${cHash(c.fn)}`;
      assert.equal(runLuaProbe({ disableBit: false, mode: "revision", files: c }).rev, expected);
      assert.equal(runLuaProbe({ disableBit: true, mode: "revision", files: c }).rev, expected);
    }

    // Exercise all 256 raw byte values (0x00..0xff) directly against C FNV-1a-32.
    const all256 = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    let expected256 = 2166136261;
    for (const b of all256) {
      expected256 ^= b;
      expected256 = Math.imul(expected256, 16777619) >>> 0;
    }
    const expected256Hex = expected256.toString(16).padStart(8, "0");
    for (const disableBit of [false, true]) {
      const out = execFileSync("luajit", ["-joff", "-e", `
        if ${disableBit ? "true" : "false"} then
          package.loaded["bit"] = nil
          package.preload["bit"] = function() error("no bit") end
          local rr = require
          require = function(n) if n == "bit" then error("no bit") end return rr(n) end
        end
        local all = {}
        for i = 0, 255 do all[i + 1] = string.char(i) end
        local raw = table.concat(all)
        local realOpen = io.open
        io.open = function(p, m)
          if p == "/data/resources/ActivityList.json" or p == "/data/resources/MapList.json" or p == "/data/resources/FunctionList.json" then
            return { read = function() return raw end, close = function() end }
          end
          return realOpen(p, m)
        end
        package.preload["system"] = function() return { isMessageRegistered = function() return true end, sendMessage = function() return true end } end
        package.preload["json"] = function() return { decode = function() return {} end, encode = function() return "{}" end } end
        package.preload["log"] = function() return { logger = function() return { notice = function() end, error = function() end, warning = function() end } end } end
        package.preload["tasks.harmonywebservices.core.resourcemanager"] = function() return { getResource = function() return "200", '"e1"', {} end, getHubEtag = function() return "1" end, isAnySyncInProgress = function() return false end, saveResource = function() return true end } end
        package.preload["tasks.harmonywebservices.core.statedigest"] = function() return { instance = function() return { configVersion = 1, saveStateDigest = function() end } end } end
        package.preload["tasks.connectserver.core.utils"] = function() return { createResponse = function() return {} end } end
        local src = assert(realOpen(${JSON.stringify(luaPath)}, "r")):read("*a")
        local chunk = assert(loadstring((src:gsub("local function currentActivityRevision", "function currentActivityRevision"))))
        chunk("codexactivity")
        io.write(_G.codexactivity.currentActivityRevision())
      `], { encoding: "utf8" }).trim();
      assert.equal(out, `${expected256Hex}-${expected256Hex}-${expected256Hex}`);
    }
  });

  it("uses native bit acceleration and yields/tickles watchdog during 340 KB revision hashing", () => {
    const res = runLuaProbe({ disableBit: false, mode: "revision", files: { act, map, fn } });
    assert.equal(res.rev, expectedSeedRev);
    // Before fix: ~4146 ticks (41.5M VM ops) with 0 yields and 0 watchdog tickles -> hub reboots on Save.
    assert.ok(
      res.hookTicks < 1000,
      `expected < 1000 x10k VM ticks with bit acceleration, got ${res.hookTicks}`,
    );
    assert.ok(
      res.watchdogTicks >= 15,
      `expected watchdog tickles across 340 KB hash, got ${res.watchdogTicks}`,
    );
    assert.ok(
      res.yieldCount >= 15 && res.pollRuns >= 15,
      `expected cooperative yields so /api/state polls run mid-hash, got yields=${res.yieldCount} polls=${res.pollRuns}`,
    );
    assert.ok(
      res.maxBetweenWatchdog <= 80,
      `uninterrupted VM work between watchdog tickles too high: ${res.maxBetweenWatchdog} x10k`,
    );
    assert.ok(
      res.maxBetweenYield <= 80,
      `uninterrupted VM work between cooperative yields too high: ${res.maxBetweenYield} x10k`,
    );
  });

  it("also yields and tickles watchdog in the pure-Lua fallback path", () => {
    const res = runLuaProbe({ disableBit: true, mode: "revision", files: { act, map, fn } });
    assert.equal(res.rev, expectedSeedRev);
    assert.ok(res.watchdogTicks >= 20, `fallback must tickle watchdog, got ${res.watchdogTicks}`);
    assert.ok(res.yieldCount >= 20, `fallback must yield cooperatively, got ${res.yieldCount}`);
    assert.ok(
      res.maxBetweenWatchdog <= 120,
      `fallback uninterrupted work between watchdog tickles too high: ${res.maxBetweenWatchdog} x10k`,
    );
  });

  it("commitActivityResources tickles watchdog, yields during save, and rejects stale baseRevision before snapshotting", () => {
    const stale = runLuaProbe({ disableBit: false, mode: "commit", files: { act, map, fn }, staleBase: true });
    assert.equal(stale.commitOk, "false");
    assert.equal(stale.commitConflict, "true");
    assert.equal(stale.rev, expectedSeedRev);
    assert.equal(stale.saveCalls, 0, "stale save must not write resources");
    assert.equal(stale.snapshotCalls, 0, "stale baseRevision should fail before decoding snapshots");
    assert.ok(stale.watchdogTicks >= 15, `stale check must still tickle watchdog, got ${stale.watchdogTicks}`);

    const okSave = runLuaProbe({ disableBit: false, mode: "commit", files: { act, map, fn }, staleBase: false });
    assert.equal(okSave.commitOk, "true");
    assert.equal(okSave.saveCalls, 3);
    // Hash yields + snapshot/validate/save phase yields
    assert.ok(okSave.watchdogTicks >= 20, `commit must tickle watchdog across phases, got ${okSave.watchdogTicks}`);
    assert.ok(okSave.yieldCount >= 20 && okSave.pollRuns >= 20, `commit must yield across phases, got ${okSave.yieldCount}`);
  });
});
