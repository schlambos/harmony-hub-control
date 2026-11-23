/* Issue #250: automatic hub-side repair for missing paired-remote activity maps.
   On Melodious 2.1.0 and older, creating an activity on a hub that only ever
   had a screen remote (e.g. Harmony Elite, @TOMSTR3's MapList shape) wrote only
   16414Activity<id> and omitted 16417Activity<id>. The engine drops every press
   from the Elite while that activity runs.

   These tests run the real payload/activity/codexactivity.lua under
   `luajit -joff` (interpreter mode, no JIT) and verify:
   1. On an Elite-only hub shaped like the #250 repro + @TOMSTR3's MapList
      (including #178's pre-existing slot-9 clash and ButtonId 0 DeviceButtonMap):
      - Boot repair and installer-flag repair automatically create the missing
        16417Activity<new> map with the exact hard keys and surface IDs that a
        fresh save on `main` (wizard-model.js) and "Add its keys" (remotes-model.js)
        produce, without touching existing maps or creating unrequested 16414 maps
        for old activities.
      - Resources are backed up to /data/codex/resource-backups/ before writing.
      - Engine reloads MapList (config_new) and publishes a new revision
        (configVersion + stateVersion + connect.stateDigest?notify) so the
        screen remote auto-pull-syncs.
      - Second pass is a strict no-op (idempotent).
   2. Scenarios C (only 16417Device maps) and D (no 16417 maps at all; surface
      ids stay null and never borrow 16414 surface ids) match wizard-model.js.
   3. Healthy hubs (hub-emu seed resources, plus ~/Repos/harmony/hub1-backup-pre-2.5-smoke
      when present locally) and no-screen-only hubs stay 100% byte-identical
      with zero writes, zero backups, zero reloads, and zero broadcasts.
   4. Watchdog/yield safety (like issue224-save-watchdog.test.mjs): repairing a
      ~340 KB MapList repeatedly tickles the watchdog and yields cooperatively.
   5. Manual fallback: Remotes page "Add its keys" (remotes-model.js) works for
      screen remotes too and matches the hub-side repair. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildActivityGraph, draftButtonsFromMap } from "../public/js/wizard-model.js";
import {
  buildRemoteActivityMapsMapList,
  missingRemoteActivityMaps,
} from "../public/js/views/remotes-model.js";
import { validateMapList } from "../public/js/views/remote-model.js";

const luaPath = new URL("../../../payload/activity/codexactivity.lua", import.meta.url).pathname;
const seedDir = new URL("../../hub-emu/seed/resources/", import.meta.url).pathname;
const fixtureConfig = JSON.parse(
  readFileSync(new URL("../fixtures/activity-config.json", import.meta.url), "utf8"),
);

const clone = (v) => JSON.parse(JSON.stringify(v));

function hasLuajit() {
  const probe = spawnSync("luajit", ["-v"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

function runLuajit(script) {
  const dir = mkdtempSync(join(tmpdir(), "issue250-"));
  try {
    const scriptPath = join(dir, "probe.lua");
    writeFileSync(scriptPath, script);
    return execFileSync("luajit", ["-joff", scriptPath], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* Build a hub config shaped like @TOMSTR3's Elite-only hub (#178/#250):
   - 16417Root, 16417Device* (ButtonId 0, ButtonState 0, no ButtonMapId-),
     16417Activity* (including pre-existing #178 slot-9 clash on activity 301).
   - No 16414* maps for the existing Logitech activities.
   - One activity (303, "Listen to CD") made on Melodious 2.1.0: has ONLY
     16414Activity303 (with hard keys including Dvr, Number1, hold, plus a
     non-command ButtonSequenceAction) and NO 16417Activity303. */
function makeEliteOnlyBrokenHub() {
  const amp = clone(fixtureConfig.deviceList.DevicesWithFeatures.find((e) => String(e.Device["Id-"]) === "81897247"));
  const cd = clone(amp);
  cd.Device["Id-"] = 90000001;
  cd.Device.Name = "Miio DM15";
  cd.Commands = ["Power", "Play", "Pause", "Stop", "Prev", "Next", "Dvr", "1", "2", "3"].map((Name, i) => ({
    Raw: null, "FunctionId-": 0, KeyCode: `F:NEC:(00)(${(i + 16).toString(16)})():1`,
    DateTaught: null, Parameters: null, TransportType: 1, Name, FunctionGroupId: 0,
    ProtocolId: 1, CommandTypeId: Name, IsLearned: true, "Id-": 3000000 + i,
  }));

  const cmdAction = (deviceId, commandName, eventType = 1) => ({
    __type: "ButtonCommandAction",
    "DeviceId-": Number(deviceId),
    CommandName: commandName,
    "FunctionId-": 0,
    Order: 0,
    EventType: eventType,
    Id: 0,
  });
  const hard = (buttonId, key, deviceId, commandName, { hold = null, fg = 0 } = {}) => ({
    __type: "HardRemoteButton",
    FunctionGroupType: fg,
    ButtonId: buttonId,
    ButtonState: 1,
    ButtonKey: key,
    ButtonAction: cmdAction(deviceId, commandName, 1),
    ButtonLongPressAction: hold ? cmdAction(hold.deviceId, hold.commandName, 2) : null,
    ButtonDoublePressAction: null,
  });
  const soft = (buttonId, fgt, slot, label, commandName, actId = 301) => ({
    __type: "SoftRemoteButton",
    FunctionGroupType: fgt,
    ButtonId: buttonId,
    ButtonState: 1,
    TextOnRemote: label,
    ButtonImageKey: null,
    ButtonImagePath: null,
    "ImageId-": 0,
    MenuItem: { IndexInMenu: slot, MenuName: `Activity.${actId}` },
    ButtonAction: cmdAction(81897247, commandName, 0),
    ButtonLongPressAction: null,
    ButtonDoublePressAction: null,
  });

  const activityList = {
    Activities: [
      {
        "Id-": 301, Name: "Watch TV", ActivityDisplayName: "Watch TV",
        ActivityOrder: 0, ActivityGroup: 1, Type: 1,
        Roles: [{ "DeviceId-": 81897247, __type: "VolumeActivityRole" }],
      },
      {
        "Id-": 302, Name: "Watch Movie", ActivityDisplayName: "Watch Movie",
        ActivityOrder: 1, ActivityGroup: 1, Type: 2,
        Roles: [{ "DeviceId-": 81897247, __type: "VolumeActivityRole" }],
      },
      {
        "Id-": 303, Name: "Listen to CD", ActivityDisplayName: "Listen to CD",
        ActivityOrder: 2, ActivityGroup: 1, Type: 4,
        Roles: [
          { "DeviceId-": 90000001, __type: "PlayMediaActivityRole" },
          { "DeviceId-": 81897247, __type: "VolumeActivityRole" },
        ],
      },
    ],
  };

  const mapList = {
    ButtonMaps: [
      {
        __type: "RootButtonMap",
        "ButtonMapId-": 5300,
        "RemoteId-": 15390924,
        "SurfaceId-": 14551427,
        "ButtonMapSurfaceId-": 14551427,
        ButtonMapIdentifier: "16417Root",
        Sequences: null,
        Buttons: [],
      },
      {
        __type: "DeviceButtonMap",
        "DeviceId-": 81897247,
        ButtonMapIdentifier: "16417Device81897247",
        "RemoteId-": 15390924,
        "SurfaceId-": 14551427,
        "ButtonMapSurfaceId-": 14551427,
        Buttons: [
          {
            __type: "HardRemoteButton",
            FunctionGroupType: 0,
            ButtonId: 0,
            ButtonState: 0,
            ButtonKey: "VolumeUp",
            ButtonAction: cmdAction(81897247, "VolumeUp", 1),
            ButtonLongPressAction: null,
            ButtonDoublePressAction: null,
          },
        ],
      },
      {
        "ButtonMapId-": 5301,
        "ActivityId-": 301,
        "RemoteId-": 15390924,
        "SurfaceId-": 14551427,
        "ButtonMapSurfaceId-": 14551427,
        __type: "ActivityButtonMap",
        ButtonMapIdentifier: "16417Activity301",
        DateModified: null,
        Sequences: [],
        Buttons: [
          hard(2001, "VolumeUp", 81897247, "VolumeUp"),
          // Pre-existing #178 Logitech slot-9 clash (must not block repair!).
          soft(2009, 0, 9, "NumberPlus", "VolumeDown", 301),
          soft(2021, 0, 9, "Audio", "VolumeUp", 301),
        ],
      },
      {
        "ButtonMapId-": 5302,
        "ActivityId-": 302,
        "RemoteId-": 15390924,
        "SurfaceId-": 14551427,
        "ButtonMapSurfaceId-": 14551427,
        __type: "ActivityButtonMap",
        ButtonMapIdentifier: "16417Activity302",
        DateModified: null,
        Sequences: [],
        Buttons: [hard(2101, "VolumeUp", 81897247, "VolumeUp")],
      },
      // Activity 303 as left by Melodious 2.1.0: ONLY 16414Activity303, missing 16417Activity303!
      {
        "ButtonMapId-": 52944090,
        "ActivityId-": 303,
        "RemoteId-": 15390924,
        "SurfaceId-": 14551427,
        "ButtonMapSurfaceId-": 14551427,
        __type: "ActivityButtonMap",
        ButtonMapIdentifier: "16414Activity303",
        DateModified: "/Date(1700000000000+0000)/",
        Sequences: [{ SequenceId: 77, Name: "TestSeq", Actions: [cmdAction(90000001, "Play", 1)] }],
        Buttons: [
          hard(1878029714, "Play", 90000001, "Play"),
          hard(1878029715, "Pause", 90000001, "Pause"),
          hard(1878029716, "Stop", 90000001, "Stop"),
          hard(1878029717, "Rewind", 90000001, "Prev"),
          hard(1878029718, "FastForward", 90000001, "Next"),
          hard(1878029719, "VolumeUp", 81897247, "VolumeUp", { hold: { deviceId: 81897247, commandName: "VolumeDown" } }),
          hard(1878029720, "VolumeDown", 81897247, "VolumeDown"),
          hard(1878029721, "Dvr", 90000001, "Dvr"),
          hard(1878029722, "Number1", 90000001, "1", { fg: 2 }),
          hard(1878029723, "Number2", 90000001, "2", { fg: 2 }),
          {
            __type: "HardRemoteButton",
            FunctionGroupType: 0,
            ButtonId: 1878029724,
            ButtonState: 1,
            ButtonKey: "Red",
            ButtonAction: { __type: "ButtonSequenceAction", SequenceId: 77, Order: 0, EventType: 1, Id: 0 },
            ButtonLongPressAction: null,
            ButtonDoublePressAction: null,
          },
        ],
      },
    ],
  };

  const functionList = {
    FunctionMaps: [
      { __type: "ActivityFunctionMap", "ActivityId-": 301, FunctionGroups: [] },
      { __type: "ActivityFunctionMap", "ActivityId-": 302, FunctionGroups: [] },
      { __type: "ActivityFunctionMap", "ActivityId-": 303, FunctionGroups: [] },
    ],
  };

  const deviceList = { DevicesWithFeatures: [amp, cd] };
  return { revision: "rev-250", activityList, mapList, functionList, deviceList };
}

/* Run codexactivity.lua inside LuaJIT (-joff) against an in-memory hub and
   return the resulting resources, backups, reloads, broadcasts, and watchdog metrics. */
function runHubRepairProbe({
  pluginPath = luaPath,
  resources,
  rfDevices = [{ EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "111" }],
  mode = "boot", // "boot" | "flag" | "op"
  passes = 2,
  secondFlagAtPass = null,
}) {
  const script = `
    local NULL = setmetatable({}, { __tostring = function() return "null" end })

    local function encodeJson(value)
      if value == NULL or value == nil then return "null" end
      local kind = type(value)
      if kind == "boolean" then return tostring(value) end
      if kind == "number" then
        if value == math.floor(value) then return string.format("%.0f", value) end
        return tostring(value)
      end
      if kind == "string" then
        return '"' .. value:gsub('[%c"\\\\]', function(c)
          local map = { ['"'] = '\\\\"', ["\\\\"] = "\\\\\\\\", ["\\n"] = "\\\\n", ["\\r"] = "\\\\r", ["\\t"] = "\\\\t" }
          return map[c] or string.format("\\\\u%04x", c:byte())
        end) .. '"'
      end
      local count = 0
      for _ in pairs(value) do count = count + 1 end
      if count == 0 then return "[]" end
      if count == #value then
        local parts = {}
        for i, item in ipairs(value) do parts[i] = encodeJson(item) end
        return "[" .. table.concat(parts, ",") .. "]"
      end
      local keys = {}
      for key in pairs(value) do keys[#keys + 1] = tostring(key) end
      table.sort(keys)
      local parts = {}
      for i, key in ipairs(keys) do parts[i] = encodeJson(key) .. ":" .. encodeJson(value[key]) end
      return "{" .. table.concat(parts, ",") .. "}"
    end

    local function decodeJson(text)
      local pos = 1
      local parseValue
      local function skipWs()
        while pos <= #text and text:sub(pos, pos):match("%s") do pos = pos + 1 end
      end
      local function parseString()
        pos = pos + 1
        local out = {}
        while pos <= #text do
          local c = text:sub(pos, pos)
          if c == '"' then
            pos = pos + 1
            return table.concat(out)
          elseif c == "\\\\" then
            local esc = text:sub(pos + 1, pos + 1)
            if esc == "u" then
              local code = tonumber(text:sub(pos + 2, pos + 5), 16) or 0
              out[#out + 1] = code < 128 and string.char(code) or "?"
              pos = pos + 6
            else
              local map = { n = "\\n", t = "\\t", r = "\\r", b = "\\b", f = "\\f" }
              out[#out + 1] = map[esc] or esc
              pos = pos + 2
            end
          else
            out[#out + 1] = c
            pos = pos + 1
          end
        end
        error("unterminated string")
      end
      function parseValue()
        skipWs()
        local c = text:sub(pos, pos)
        if c == "{" then
          pos = pos + 1
          local obj = {}
          skipWs()
          if text:sub(pos, pos) == "}" then pos = pos + 1 return obj end
          while true do
            skipWs()
            local key = parseString()
            skipWs()
            pos = pos + 1
            obj[key] = parseValue()
            skipWs()
            if text:sub(pos, pos) == "}" then pos = pos + 1 return obj end
            pos = pos + 1
          end
        elseif c == "[" then
          pos = pos + 1
          local arr = {}
          skipWs()
          if text:sub(pos, pos) == "]" then pos = pos + 1 return arr end
          while true do
            arr[#arr + 1] = parseValue()
            skipWs()
            if text:sub(pos, pos) == "]" then pos = pos + 1 return arr end
            pos = pos + 1
          end
        elseif c == '"' then
          return parseString()
        elseif text:sub(pos, pos + 3) == "true" then
          pos = pos + 4 return true
        elseif text:sub(pos, pos + 4) == "false" then
          pos = pos + 5 return false
        elseif text:sub(pos, pos + 3) == "null" then
          pos = pos + 4 return NULL
        else
          local num = text:match("^%-?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
          assert(num and #num > 0, "bad json at " .. pos)
          pos = pos + #num
          return tonumber(num)
        end
      end
      return parseValue()
    end

    local fs = {
      ["/data/codex/cloud_blocker.conf"] = "1\\n",
      ["/data/resources/ActivityList.json"] = ${JSON.stringify(resources.ActivityList)},
      ["/data/resources/MapList.json"] = ${JSON.stringify(resources.MapList)},
      ["/data/resources/FunctionList.json"] = ${JSON.stringify(resources.FunctionList)},
      ["/data/resources/DeviceList.json"] = ${JSON.stringify(resources.DeviceList)},
      ["/data/resources/ProtocolList.json"] = ${JSON.stringify(resources.ProtocolList ?? '{"Protocols":[]}')},
    }
    if ${JSON.stringify(mode)} == "flag" then
      fs["/data/codex/repair_remote_maps"] = ""
    end

    local dirs = { ["/data"] = true, ["/data/codex"] = true, ["/data/codex/resource-backups"] = true }
    local index = {
      ActivityList = { etag = '"e-act"', hetag = "1" },
      MapList = { etag = '"e-map"', hetag = "2" },
      FunctionList = { etag = '"e-fn"', hetag = "3" },
      DeviceList = { etag = '"e-dev"', hetag = "4" },
      ProtocolList = { etag = '"e-proto"', hetag = "5" },
    }
    local events = {}
    local notices = {}
    local warnings = {}
    local saveCalls = 0
    local reloadCalls = {}
    local broadcasts = {}
    local watchdogTicks = 0
    local yieldCount = 0
    local pollRuns = 0
    local hookTicks = 0
    local sinceWatchdog = 0
    local maxBetweenWatchdog = 0
    local sinceYield = 0
    local maxBetweenYield = 0
    local uuidN = 0

    local function noteWatchdog()
      watchdogTicks = watchdogTicks + 1
      if sinceWatchdog > maxBetweenWatchdog then maxBetweenWatchdog = sinceWatchdog end
      sinceWatchdog = 0
    end
    local function noteYield()
      yieldCount = yieldCount + 1
      if sinceYield > maxBetweenYield then maxBetweenYield = sinceYield end
      sinceYield = 0
      if coroutine.running() ~= nil then
        coroutine.yield("worker-yield")
      end
    end

    local realIoOpen = io.open
    local realOsRemove = os.remove
    local realOsRename = os.rename
    io.open = function(p, m)
      m = m or "r"
      if p:sub(1, 5) == "/data" or p:sub(1, 4) == "/var" or p:sub(1, 6) == "/cache" or p:sub(1, 4) == "/etc" then
        if m:sub(1, 1) == "r" then
          if fs[p] == nil then return nil, "no such file" end
          local body = fs[p]
          return { read = function() return body end, close = function() end }
        elseif m:sub(1, 1) == "w" then
          local buf = {}
          return {
            write = function(_, ...) for i = 1, select("#", ...) do buf[#buf + 1] = tostring(select(i, ...)) end return true end,
            close = function()
              fs[p] = table.concat(buf)
              if p:find("^/data/codex/resource%-backups/") then
                events[#events + 1] = "backup:" .. p
              end
            end
          }
        elseif m:sub(1, 1) == "a" then
          local buf = {}
          return {
            write = function(_, ...) for i = 1, select("#", ...) do buf[#buf + 1] = tostring(select(i, ...)) end return true end,
            close = function() fs[p] = (fs[p] or "") .. table.concat(buf) end
          }
        end
      end
      return realIoOpen(p, m)
    end
    os.remove = function(p)
      if p:sub(1, 5) == "/data" or p:sub(1, 4) == "/var" or p:sub(1, 6) == "/cache" then
        fs[p] = nil
        return true
      end
      return realOsRemove(p)
    end
    os.rename = function(a, b)
      if a:sub(1, 4) == "/var" or b:sub(1, 4) == "/var" then
        fs[b] = fs[a]
        fs[a] = nil
        return true
      end
      return realOsRename(a, b)
    end

    package.preload["lfs"] = function()
      return {
        mkdir = function(d) dirs[d] = true return true end,
        rmdir = function(d) dirs[d] = nil return true end,
        dir = function(d)
          local items = {}
          local seen = {}
          local prefix = d .. "/"
          for k in pairs(dirs) do
            if k:sub(1, #prefix) == prefix then
              local rest = k:sub(#prefix + 1):match("^([^/]+)")
              if rest and not seen[rest] then seen[rest] = true items[#items + 1] = rest end
            end
          end
          for k in pairs(fs) do
            if k:sub(1, #prefix) == prefix then
              local rest = k:sub(#prefix + 1):match("^([^/]+)")
              if rest and not seen[rest] then seen[rest] = true items[#items + 1] = rest end
            end
          end
          local i = 0
          return function() i = i + 1 return items[i] end
        end,
      }
    end

    local inNativeJson = false
    local function nativeDecode(raw)
      inNativeJson = true
      local v = decodeJson(raw)
      inNativeJson = false
      return v
    end
    local function nativeEncode(v)
      inNativeJson = true
      local s = encodeJson(v)
      inNativeJson = false
      return s
    end

    local workerFn
    local pluginObj
    local passesDone = 0
    local maxPasses = ${passes}
    local secondFlagPass = ${secondFlagAtPass === null ? "nil" : secondFlagAtPass}

    package.preload["system"] = function()
      return {
        uuid = function()
          uuidN = uuidN + 1
          return string.format("00000000-0000-4000-8000-%012d", uuidN)
        end,
        jiffies = function() return { tomillis = function() return 1000 end } end,
        tiggleWatchDog = noteWatchdog,
        yield = noteYield,
        blockingSleep = function() noteYield() end,
        sleep = function()
          passesDone = passesDone + 1
          if secondFlagPass and passesDone == secondFlagPass then
            fs["/data/codex/repair_remote_maps"] = ""
          end
          if passesDone >= maxPasses and pluginObj then
            pluginObj:exit()
          end
        end,
        addTask = function(name, fn)
          if name == "codexactivity" then
            workerFn = fn
          else
            fn()
          end
          return { status = "dead" }
        end,
        taskStatus = function() return "dead" end,
        isMessageRegistered = function(name)
          return name == "config_new" or name == "process_activity" or name == "hal_transaction"
        end,
        sendMessage = function(name, args)
          if name == "config_new" then
            local label = type(args) == "table" and table.concat(args, ",") or tostring(args)
            reloadCalls[#reloadCalls + 1] = label
            events[#events + 1] = "reload:" .. label
          elseif name == "process_activity" then
            events[#events + 1] = "barrier"
          end
          return true
        end,
      }
    end

    package.preload["json"] = function()
      return { null = NULL, decode = nativeDecode, encode = nativeEncode }
    end

    package.preload["log"] = function()
      return {
        logger = function()
          return {
            notice = function(...)
              local t = {}
              for i = 1, select("#", ...) do t[i] = tostring(select(i, ...)) end
              notices[#notices + 1] = table.concat(t, " ")
            end,
            warning = function(...)
              local t = {}
              for i = 1, select("#", ...) do t[i] = tostring(select(i, ...)) end
              warnings[#warnings + 1] = table.concat(t, " ")
            end,
            error = function(...)
              local t = {}
              for i = 1, select("#", ...) do t[i] = tostring(select(i, ...)) end
              notices[#notices + 1] = "ERR:" .. table.concat(t, " ")
            end,
            debug = function() end,
          }
        end
      }
    end

    package.preload["tasks.hal.core.hbus"] = function()
      return {
        instance = function()
          return {
            command = function(_, cmd)
              if cmd == "rf.info" then
                return {
                  code = 200,
                  data = { Devices = decodeJson(${JSON.stringify(JSON.stringify(rfDevices))}) }
                }
              end
              return nil
            end
          }
        end
      }
    end

    package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
      return {
        isAnySyncInProgress = function() return false end,
        getResource = function(name)
          local entry = index[name]
          if not entry then return nil, "missing" end
          local raw = fs["/data/resources/" .. name .. ".json"]
          if not raw then return nil, "missing file" end
          return "200", entry.etag, nativeDecode(raw)
        end,
        getHubEtag = function(name) return index[name] and index[name].hetag end,
        saveResource = function(_, etag, value, name, _, hetag)
          saveCalls = saveCalls + 1
          events[#events + 1] = "save:" .. name
          fs["/data/resources/" .. name .. ".json"] = type(value) == "string" and value or nativeEncode(value)
          index[name] = { etag = etag, hetag = hetag }
          return true
        end,
      }
    end

    local digest = setmetatable({ configVersion = 10, stateVersion = 20 }, {
      __index = {
        saveStateDigest = function()
          events[#events + 1] = "saveStateDigest"
        end
      }
    })
    package.preload["tasks.harmonywebservices.core.statedigest"] = function()
      return { instance = function() return digest end }
    end
    package.preload["tasks.connectserver.core.utils"] = function()
      return {
        broadcastEvent = function(cmd, payload)
          broadcasts[#broadcasts + 1] = { cmd = cmd, payload = payload }
          events[#events + 1] = "broadcast:" .. cmd
        end,
        createResponse = function() return {} end,
      }
    end

    local src = assert(realIoOpen(${JSON.stringify(pluginPath)}, "r")):read("*a")
    assert(loadstring(src))("codexactivity")
    pluginObj = _G.codexactivity:instance()
    pluginObj:discover()

    if ${JSON.stringify(mode)} == "op" then
      fs["/var/volatile/codex-activity-request.json"] = encodeJson({
        id = "req-1",
        op = "RepairRemoteActivityMaps",
      })
    end

    local worker = coroutine.create(function()
      workerFn()
    end)

    debug.sethook(worker, function()
      if inNativeJson then return end
      hookTicks = hookTicks + 1
      sinceWatchdog = sinceWatchdog + 1
      sinceYield = sinceYield + 1
    end, "", 10000)

    while coroutine.status(worker) ~= "dead" do
      local ok, why = coroutine.resume(worker)
      assert(ok, tostring(why))
      if why == "worker-yield" then
        pollRuns = pollRuns + 1
      end
    end
    if sinceWatchdog > maxBetweenWatchdog then maxBetweenWatchdog = sinceWatchdog end
    if sinceYield > maxBetweenYield then maxBetweenYield = sinceYield end

    local backupFiles = {}
    for k in pairs(fs) do
      if k:find("^/data/codex/resource%-backups/") then
        backupFiles[#backupFiles + 1] = k
      end
    end
    table.sort(backupFiles)

    io.write(encodeJson({
      mapListRaw = fs["/data/resources/MapList.json"],
      activityListRaw = fs["/data/resources/ActivityList.json"],
      functionListRaw = fs["/data/resources/FunctionList.json"],
      deviceListRaw = fs["/data/resources/DeviceList.json"],
      flagExists = fs["/data/codex/repair_remote_maps"] ~= nil,
      initLog = fs["/cache/codex-init.log"] or "",
      responseRaw = fs["/var/volatile/codex-activity-response.json"] or "",
      saveCalls = saveCalls,
      reloadCalls = reloadCalls,
      broadcasts = broadcasts,
      events = events,
      notices = notices,
      warnings = warnings,
      backupFiles = backupFiles,
      configVersion = digest.configVersion,
      stateVersion = digest.stateVersion,
      watchdogTicks = watchdogTicks,
      yieldCount = yieldCount,
      pollRuns = pollRuns,
      hookTicks = hookTicks,
      maxBetweenWatchdog = maxBetweenWatchdog,
      maxBetweenYield = maxBetweenYield,
    }))
  `;
  return JSON.parse(runLuajit(script));
}

const keyShape = (map) => Object.fromEntries(
  (map?.Buttons ?? [])
    .filter((b) => b.__type === "HardRemoteButton")
    .map((b) => [
      b.ButtonKey,
      {
        fg: b.FunctionGroupType,
        state: b.ButtonState,
        press: b.ButtonAction ? [b.ButtonAction.__type, b.ButtonAction["DeviceId-"], b.ButtonAction.CommandName, b.ButtonAction.EventType] : null,
        hold: b.ButtonLongPressAction ? [b.ButtonLongPressAction.__type, b.ButtonLongPressAction["DeviceId-"], b.ButtonLongPressAction.CommandName, b.ButtonLongPressAction.EventType] : null,
        dbl: b.ButtonDoublePressAction ? [b.ButtonDoublePressAction.__type, b.ButtonDoublePressAction["DeviceId-"], b.ButtonDoublePressAction.CommandName, b.ButtonDoublePressAction.EventType] : null,
      },
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);

describe("issue #250: automatic hub-side repair for screen-remote activity maps", () => {
  it("repairs a missing 16417Activity map on an Elite-only hub (matching fresh save on main + Add its keys)", (t) => {
    if (!hasLuajit()) return t.skip("luajit is not available");
    const broken = makeEliteOnlyBrokenHub();
    const resources = {
      ActivityList: JSON.stringify(broken.activityList),
      MapList: JSON.stringify(broken.mapList),
      FunctionList: JSON.stringify(broken.functionList),
      DeviceList: JSON.stringify(broken.deviceList),
    };

    const res = runHubRepairProbe({
      resources,
      rfDevices: [{ EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "111" }],
      mode: "boot",
      passes: 2,
    });

    assert.equal(res.saveCalls, 1, "must save MapList once");
    assert.deepEqual(res.reloadCalls, ["MapList"], "must reload MapList in harmonyengine");
    assert.equal(res.configVersion, 11, "must increment configVersion for screen remote auto-sync");
    assert.equal(res.stateVersion, 21, "must increment stateVersion so statedigest?get does not 304");
    assert.equal(res.broadcasts.length, 1);
    assert.equal(res.broadcasts[0].cmd, "connect.stateDigest?notify");
    assert.ok(res.backupFiles.some((p) => p.endsWith("/MapList.json")), "must back up MapList before writing");
    assert.ok(res.backupFiles.some((p) => p.endsWith("/ActivityList.json")), "must back up ActivityList before writing");

    // Verify backup happened strictly BEFORE saveResource, and reload/barrier/broadcast happened AFTER.
    const firstBackup = res.events.findIndex((e) => e.startsWith("backup:"));
    const firstSave = res.events.indexOf("save:MapList");
    const firstReload = res.events.indexOf("reload:MapList");
    const firstBarrier = res.events.indexOf("barrier");
    const firstBroadcast = res.events.indexOf("broadcast:connect.stateDigest?notify");
    assert.ok(firstBackup >= 0 && firstBackup < firstSave, `backup before save: ${JSON.stringify(res.events)}`);
    assert.ok(firstSave < firstReload && firstReload < firstBarrier && firstBarrier < firstBroadcast);

    // Logged what it created.
    assert.ok(res.notices.some((n) => n.includes("16417Activity303")), `expected notice: ${JSON.stringify(res.notices)}`);
    assert.ok(res.initLog.includes("16417Activity303"), `expected init log: ${res.initLog}`);

    const repairedMapList = JSON.parse(res.mapListRaw);
    const ids = repairedMapList.ButtonMaps.map((m) => m.ButtonMapIdentifier);
    assert.ok(ids.includes("16417Activity303"), "created missing 16417Activity303");
    // Must NOT invent 16414 maps for the existing Logitech activities (only 16417 is paired).
    assert.ok(!ids.includes("16414Activity301"));
    assert.ok(!ids.includes("16414Activity302"));
    // Existing maps stayed untouched.
    for (const oldMap of broken.mapList.ButtonMaps) {
      const now = repairedMapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === oldMap.ButtonMapIdentifier);
      assert.deepEqual(now, oldMap, `existing map ${oldMap.ButtonMapIdentifier} must not change`);
    }
    // Passes web map validator against the pre-repair baseline (preserving #178 slot-9 clash tolerance).
    assert.deepEqual(validateMapList(repairedMapList, broken), []);

    // Must match what a fresh save on `main` produces (hard keys + surface + identity contract).
    const own16414 = broken.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16414Activity303");
    const draft = {
      name: "Listen to CD",
      type: 4,
      roles: [
        { deviceId: "90000001", roleType: "PlayMediaActivityRole", input: "", powerDelay: "" },
        { deviceId: "81897247", roleType: "VolumeActivityRole", input: "", powerDelay: "" },
      ],
      buttons: draftButtonsFromMap(own16414),
    };
    const untouchedEliteHub = clone(broken);
    untouchedEliteHub.activityList.Activities = untouchedEliteHub.activityList.Activities.filter((a) => a["Id-"] !== 303);
    untouchedEliteHub.mapList.ButtonMaps = untouchedEliteHub.mapList.ButtonMaps.filter((m) => m["ActivityId-"] !== 303);
    untouchedEliteHub.functionList.FunctionMaps = untouchedEliteHub.functionList.FunctionMaps.filter((m) => m["ActivityId-"] !== 303);
    const freshMain = buildActivityGraph({ config: untouchedEliteHub, draft, editId: null, remotes: ["16417"] });
    const freshEliteMap = freshMain.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === `16417Activity${freshMain.activityId}`);
    const repairedEliteMap = repairedMapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16417Activity303");

    assert.deepEqual(keyShape(repairedEliteMap), keyShape(freshEliteMap), "repaired hard keys must match fresh save on main");
    assert.equal(repairedEliteMap["RemoteId-"], freshEliteMap["RemoteId-"]);
    assert.equal(repairedEliteMap["SurfaceId-"], freshEliteMap["SurfaceId-"]);
    assert.equal(repairedEliteMap["ButtonMapSurfaceId-"], freshEliteMap["ButtonMapSurfaceId-"]);
    assert.equal(repairedEliteMap.__type, "ActivityButtonMap");
    assert.equal(repairedEliteMap["ActivityId-"], 303);
    assert.ok(repairedEliteMap["ButtonMapId-"] > 52944089);
    assert.deepEqual(repairedEliteMap.Sequences, []);
    // Dvr -> DVR, Number1/Number2 dropped, sequence button (Red) not copied.
    assert.ok(repairedEliteMap.Buttons.some((b) => b.ButtonKey === "DVR"));
    assert.ok(!repairedEliteMap.Buttons.some((b) => b.ButtonKey === "Dvr" || b.ButtonKey === "Number1" || b.ButtonKey === "Red"));

    // Also matches Remotes page "Add its keys" (remotes-model.js).
    const jsAddKeys = buildRemoteActivityMapsMapList(broken, ["16417"]);
    assert.deepEqual(jsAddKeys.created, ["16417Activity303"]);
    const jsEliteMap = jsAddKeys.mapList.ButtonMaps.find((m) => m.ButtonMapIdentifier === "16417Activity303");
    assert.deepEqual(keyShape(repairedEliteMap), keyShape(jsEliteMap));
    assert.equal(repairedEliteMap["RemoteId-"], jsEliteMap["RemoteId-"]);
    assert.equal(repairedEliteMap["SurfaceId-"], jsEliteMap["SurfaceId-"]);
    assert.equal(repairedEliteMap["ButtonMapSurfaceId-"], jsEliteMap["ButtonMapSurfaceId-"]);

    // Second run (idempotency): byte-identical, zero saves/backups/reloads/broadcasts.
    const second = runHubRepairProbe({
      resources: { ...resources, MapList: res.mapListRaw },
      rfDevices: [{ EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "111" }],
      mode: "flag",
      passes: 2,
    });
    assert.equal(second.saveCalls, 0);
    assert.equal(second.backupFiles.length, 0);
    assert.equal(second.reloadCalls.length, 0);
    assert.equal(second.broadcasts.length, 0);
    assert.equal(second.flagExists, false, "installer flag is consumed even on no-op");
    assert.equal(second.mapListRaw, res.mapListRaw);
  });

  it("handles installer post-install flag repair mid-boot and Scenarios C/D surface rules", (t) => {
    if (!hasLuajit()) return t.skip("luajit is not available");
    // Scenario C: only 16417Device map + 16414Activity303 -> copies surface from 16417Device.
    const scenC = makeEliteOnlyBrokenHub();
    scenC.activityList.Activities = [scenC.activityList.Activities[2]];
    scenC.mapList.ButtonMaps = scenC.mapList.ButtonMaps.filter((m) =>
      m.ButtonMapIdentifier === "16417Device81897247" || m.ButtonMapIdentifier === "16414Activity303"
    );
    scenC.functionList.FunctionMaps = [scenC.functionList.FunctionMaps[2]];
    const resC = runHubRepairProbe({
      resources: {
        ActivityList: JSON.stringify(scenC.activityList),
        MapList: JSON.stringify(scenC.mapList),
        FunctionList: JSON.stringify(scenC.functionList),
        DeviceList: JSON.stringify(scenC.deviceList),
      },
      mode: "flag",
      passes: 2,
    });
    const mapC = JSON.parse(resC.mapListRaw).ButtonMaps.find((m) => m.ButtonMapIdentifier === "16417Activity303");
    assert.equal(resC.flagExists, false);
    assert.equal(mapC["RemoteId-"], 15390924);
    assert.equal(mapC["SurfaceId-"], 14551427);

    // Scenario D: no 16417 maps at all -> surface ids stay null (never borrow 16414 surface).
    const scenD = clone(scenC);
    scenD.mapList.ButtonMaps = scenD.mapList.ButtonMaps.filter((m) => m.ButtonMapIdentifier === "16414Activity303");
    scenD.mapList.ButtonMaps[0]["SurfaceId-"] = 13151460;
    scenD.mapList.ButtonMaps[0]["ButtonMapSurfaceId-"] = 13151460;
    const resD = runHubRepairProbe({
      resources: {
        ActivityList: JSON.stringify(scenD.activityList),
        MapList: JSON.stringify(scenD.mapList),
        FunctionList: JSON.stringify(scenD.functionList),
        DeviceList: JSON.stringify(scenD.deviceList),
      },
      mode: "boot",
      passes: 2,
    });
    const mapD = JSON.parse(resD.mapListRaw).ButtonMaps.find((m) => m.ButtonMapIdentifier === "16417Activity303");
    assert.equal(mapD["RemoteId-"], null);
    assert.equal(mapD["SurfaceId-"], null);
    assert.equal(mapD["ButtonMapSurfaceId-"], null);
    assert.ok(mapD.Buttons.some((b) => b.ButtonKey === "Play"));
  });

function cleanHealthySeedResources() {
  // hub-emu's anonymized seed has one activity id (1594209107) whose maps still
  // carry the pre-anonymized id (41467671). Align them so this is a genuinely
  // healthy ~340 KB multi-remote hub with 0 orphans and 0 missing maps.
  const ActivityList = readFileSync(`${seedDir}ActivityList.json`, "utf8");
  const MapList = readFileSync(`${seedDir}MapList.json`, "utf8").replaceAll("41467671", "1594209107");
  const FunctionList = readFileSync(`${seedDir}FunctionList.json`, "utf8").replaceAll("41467671", "1594209107");
  const DeviceList = readFileSync(`${seedDir}DeviceList.json`, "utf8");
  const ProtocolList = readFileSync(`${seedDir}ProtocolList.json`, "utf8");
  return { ActivityList, MapList, FunctionList, DeviceList, ProtocolList };
}

  it("no-op on healthy hub (seed + real Hub 1 backup when present) and no-screen-only hub stays byte-identical", (t) => {
    if (!hasLuajit()) return t.skip("luajit is not available");
    const seedResources = cleanHealthySeedResources();
    const healthySeed = runHubRepairProbe({
      resources: seedResources,
      rfDevices: [
        { EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "99" },
        { EquadID: "16414", DeviceIndex: "2", RFID: "22222222", SkinId: "" },
      ],
      mode: "flag",
      passes: 2,
    });
    assert.deepEqual(healthySeed.warnings, []);
    assert.equal(healthySeed.saveCalls, 0);
    assert.equal(healthySeed.backupFiles.length, 0);
    assert.equal(healthySeed.reloadCalls.length, 0);
    assert.equal(healthySeed.broadcasts.length, 0);
    assert.equal(healthySeed.mapListRaw, seedResources.MapList);
    assert.equal(healthySeed.activityListRaw, seedResources.ActivityList);
    assert.equal(healthySeed.functionListRaw, seedResources.FunctionList);
    assert.equal(healthySeed.deviceListRaw, seedResources.DeviceList);

    // No-screen-only hub (only 16414 paired, only 16414 maps).
    const noScreenMapList = JSON.stringify({
      ButtonMaps: JSON.parse(seedResources.MapList).ButtonMaps.filter(
        (m) => String(m.ButtonMapIdentifier ?? "").startsWith("16414"),
      ),
    });
    const noScreen = runHubRepairProbe({
      resources: { ...seedResources, MapList: noScreenMapList },
      rfDevices: [{ EquadID: "16414", DeviceIndex: "1", RFID: "22222222", SkinId: "" }],
      mode: "flag",
      passes: 2,
    });
    assert.deepEqual(noScreen.warnings, []);
    assert.equal(noScreen.saveCalls, 0);
    assert.equal(noScreen.backupFiles.length, 0);
    assert.equal(noScreen.reloadCalls.length, 0);
    assert.equal(noScreen.broadcasts.length, 0);
    assert.equal(noScreen.mapListRaw, noScreenMapList);

    // Real Hub 1 backup when available locally (off-hub owner fixture).
    const hub1Dir = join(homedir(), "Repos/harmony/hub1-backup-pre-2.5-smoke/resources");
    if (existsSync(join(hub1Dir, "MapList.json"))) {
      const hub1Resources = {
        ActivityList: readFileSync(join(hub1Dir, "ActivityList.json"), "utf8"),
        MapList: readFileSync(join(hub1Dir, "MapList.json"), "utf8"),
        FunctionList: readFileSync(join(hub1Dir, "FunctionList.json"), "utf8"),
        DeviceList: readFileSync(join(hub1Dir, "DeviceList.json"), "utf8"),
        ProtocolList: readFileSync(join(hub1Dir, "ProtocolList.json"), "utf8"),
      };
      const hub1Res = runHubRepairProbe({
        resources: hub1Resources,
        rfDevices: [
          { EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "99" },
          { EquadID: "16414", DeviceIndex: "2", RFID: "22222222", SkinId: "" },
        ],
        mode: "flag",
        passes: 2,
      });
      assert.deepEqual(hub1Res.warnings, []);
      assert.equal(hub1Res.saveCalls, 0, "Hub 1 backup must be a strict no-op");
      assert.equal(hub1Res.backupFiles.length, 0);
      assert.equal(hub1Res.reloadCalls.length, 0);
      assert.equal(hub1Res.broadcasts.length, 0);
      assert.equal(hub1Res.mapListRaw, hub1Resources.MapList);
      assert.equal(hub1Res.activityListRaw, hub1Resources.ActivityList);
      assert.equal(hub1Res.functionListRaw, hub1Resources.FunctionList);
      assert.equal(hub1Res.deviceListRaw, hub1Resources.DeviceList);
    }
  });

  it("tickles the watchdog and yields cooperatively while repairing a realistic ~340 KB config", (t) => {
    if (!hasLuajit()) return t.skip("luajit is not available");
    const clean = cleanHealthySeedResources();
    const seedMapObj = JSON.parse(clean.MapList);
    const targetAct = String(JSON.parse(clean.ActivityList).Activities[0]["Id-"]);
    const brokenMapObj = {
      ...seedMapObj,
      ButtonMaps: seedMapObj.ButtonMaps.filter((m) => m.ButtonMapIdentifier !== `16417Activity${targetAct}`),
    };
    const res = runHubRepairProbe({
      resources: {
        ...clean,
        MapList: JSON.stringify(brokenMapObj),
      },
      rfDevices: [{ EquadID: "16417", DeviceIndex: "1", RFID: "11111111", SkinId: "111" }],
      mode: "boot",
      passes: 2,
    });
    assert.deepEqual(res.warnings, []);
    assert.equal(res.saveCalls, 1);
    assert.ok(res.watchdogTicks >= 10, `expected watchdog tickles during repair, got ${res.watchdogTicks}`);
    assert.ok(res.yieldCount >= 10 && res.pollRuns >= 10, `expected cooperative yields, got yields=${res.yieldCount} polls=${res.pollRuns}`);
    assert.ok(
      res.maxBetweenWatchdog <= 80,
      `uninterrupted VM work between watchdog tickles too high: ${res.maxBetweenWatchdog} x10k`,
    );
    assert.ok(
      res.maxBetweenYield <= 80,
      `uninterrupted VM work between cooperative yields too high: ${res.maxBetweenYield} x10k`,
    );
  });

  it("Remotes page 'Add its keys' detects and repairs missing screen-remote maps cleanly", () => {
    const broken = makeEliteOnlyBrokenHub();
    const missing = missingRemoteActivityMaps(broken, ["16417"]);
    assert.deepEqual(missing.map((m) => `${m.remote}:${m.activityId}`), ["16417:303"]);
    const { mapList, created } = buildRemoteActivityMapsMapList(broken, ["16417"]);
    assert.deepEqual(created, ["16417Activity303"]);
    assert.deepEqual(validateMapList(mapList, broken), []);
    assert.deepEqual(missingRemoteActivityMaps({ ...broken, mapList }, ["16417"]), []);
  });
});
