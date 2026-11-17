-- LuaJIT tests for the hub MapList validator in payload/activity/codexactivity.lua.
--
-- The plugin's validateGraph is a local function. The harness loads the
-- plugin with stubbed hub modules, then walks the upvalues of its public
-- discover() entry point (discover -> start -> workerLoop -> processRequest
-- -> commitActivityResources -> validateGraph) to reach it. No hub is
-- contacted and nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-validate-test.lua \
--     tools/webui-sim/fixtures/touch-maplist.json
-- Exit code 0 means every fixture case validated as expected.

local fixturePath = arg and arg[1]
if not fixturePath then
  io.stderr:write("usage: luajit codexactivity-validate-test.lua <fixtures.json>\n")
  os.exit(2)
end

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

-- Minimal JSON decoder (test code only). null decodes to the same sentinel
-- the json stub below hands to the plugin, so its json.null checks work.
local NULL = {}
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
      elseif c == "\\" then
        local esc = text:sub(pos + 1, pos + 1)
        if esc == "u" then
          local code = tonumber(text:sub(pos + 2, pos + 5), 16) or 0
          out[#out + 1] = code < 128 and string.char(code) or "?"
          pos = pos + 6
        else
          local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
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
  local function parseNumber()
    local s = text:match("^%-?%d+%.?%d*[eE]?[%-+]?%d*", pos)
    pos = pos + #s
    return tonumber(s)
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
      pos = pos + 4
      return true
    elseif text:sub(pos, pos + 4) == "false" then
      pos = pos + 5
      return false
    elseif text:sub(pos, pos + 3) == "null" then
      pos = pos + 4
      return NULL
    end
    return parseNumber()
  end
  return parseValue()
end

-- Stub the hub modules the plugin requires at load time.
local function noop() return nil end
package.preload["system"] = function()
  return { uuid = noop, sleep = noop, addTask = noop, isMessageRegistered = noop }
end
package.preload["json"] = function()
  return { null = NULL, encode = function() return "{}" end, decode = decodeJson }
end
package.preload["log"] = function()
  local logger = { notice = noop, error = noop, warning = noop, debug = noop, info = noop }
  return { logger = function() return logger end }
end
local resourceStubs = {}
package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
  return resourceStubs
end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return { configVersion = 0, stateVersion = 0 } end }
end
package.preload["tasks.connectserver.core.utils"] = function() return {} end

package.path = repoRoot .. "/payload/activity/?.lua;" .. package.path
local plugin = require("codexactivity")

local function findUpvalue(fn, name, seen)
  seen = seen or {}
  if type(fn) ~= "function" or seen[fn] then return nil end
  seen[fn] = true
  local i = 1
  while true do
    local upName, value = debug.getupvalue(fn, i)
    if upName == nil then return nil end
    if upName == name then return value end
    if type(value) == "function" then
      local found = findUpvalue(value, name, seen)
      if found ~= nil then return found end
    end
    i = i + 1
  end
end

local validateGraph = findUpvalue(plugin.discover, "validateGraph")
local commitActivityResources = findUpvalue(plugin.discover, "commitActivityResources")
if type(validateGraph) ~= "function" or type(commitActivityResources) ~= "function" then
  io.stderr:write("could not reach validateGraph/commitActivityResources in codexactivity.lua\n")
  os.exit(2)
end

local f = io.open(fixturePath, "rb")
if not f then
  io.stderr:write("cannot read fixtures: " .. fixturePath .. "\n")
  os.exit(2)
end
local fixtures = decodeJson(f:read("*a"))
f:close()

local failures = 0
for _, case in ipairs(fixtures.cases) do
  local graph = case.graph
  local oldMapList = case.oldMapList ~= nil and case.oldMapList ~= NULL and case.oldMapList or nil
  local ok, err = validateGraph(
    graph.activityList, graph.mapList, graph.functionList, graph.deviceList, oldMapList
  )
  local passed
  if case.expect == "valid" then
    passed = ok == true
  else
    passed = ok == nil and type(err) == "string" and
      string.find(err, case.errorIncludes, 1, true) ~= nil
  end
  if passed then
    print("PASS " .. case.name)
  else
    failures = failures + 1
    print("FAIL " .. case.name .. " (ok=" .. tostring(ok) ..
      ", err=" .. tostring(err) .. ", expect=" .. case.expect .. ")")
  end
end
print(string.format("%d/%d cases passed", #fixtures.cases - failures, #fixtures.cases))

-- Issue #178 regression checks: pre-existing Logitech IndexInMenu slot 9 clashes
-- (Audio + NumberPlus both tagged FunctionGroupType 0) and 16417Device ButtonId 0 maps.
local function softButton(buttonId, fgt, slot, label, commandName)
  return {
    __type = "SoftRemoteButton",
    FunctionGroupType = fgt,
    ButtonId = buttonId,
    ButtonState = 1,
    TextOnRemote = label,
    ButtonImageKey = NULL,
    ButtonImagePath = NULL,
    ["ImageId-"] = 0,
    MenuItem = { IndexInMenu = slot, MenuName = "Activity.301" },
    ButtonAction = {
      __type = "ButtonCommandAction",
      ["DeviceId-"] = 10,
      CommandName = commandName,
      ["FunctionId-"] = 0,
      Order = 0,
      EventType = 0,
      Id = 0,
    },
    ButtonLongPressAction = NULL,
    ButtonDoublePressAction = NULL,
  }
end

local function hardButton(buttonId, key, commandName)
  return {
    __type = "HardRemoteButton",
    FunctionGroupType = 0,
    ButtonId = buttonId,
    ButtonState = 1,
    ButtonKey = key,
    ButtonAction = {
      __type = "ButtonCommandAction",
      ["DeviceId-"] = 10,
      CommandName = commandName,
      ["FunctionId-"] = 0,
      Order = 0,
      EventType = 1,
      Id = 0,
    },
    ButtonLongPressAction = NULL,
    ButtonDoublePressAction = NULL,
  }
end

local function logitechClashGraph()
  return {
    activityList = {
      Activities = {
        { ["Id-"] = 301, Name = "Activity 301", Roles = {} },
        { ["Id-"] = 302, Name = "Activity 302", Roles = {} },
      },
    },
    deviceList = {
      DevicesWithFeatures = {
        { Device = { ["Id-"] = 10, Name = "Receiver" }, Commands = {} },
      },
    },
    functionList = {
      FunctionMaps = {
        { __type = "ActivityFunctionMap", ["ActivityId-"] = 301, FunctionGroups = {} },
        { __type = "ActivityFunctionMap", ["ActivityId-"] = 302, FunctionGroups = {} },
      },
    },
    mapList = {
      ButtonMaps = {
        {
          __type = "DeviceButtonMap",
          ["DeviceId-"] = 10,
          ButtonMapIdentifier = "16417Device10",
          ["RemoteId-"] = 8001,
          ["SurfaceId-"] = 7001,
          ["ButtonMapSurfaceId-"] = 7001,
          Buttons = {
            {
              __type = "HardRemoteButton",
              FunctionGroupType = 0,
              ButtonId = 0,
              ButtonState = 0,
              ButtonKey = "VolumeUp",
              ButtonAction = {
                __type = "ButtonCommandAction",
                ["DeviceId-"] = 10,
                CommandName = "VolumeUp",
                ["FunctionId-"] = 0,
                Order = 0,
                EventType = 1,
                Id = 0,
              },
              ButtonLongPressAction = NULL,
              ButtonDoublePressAction = NULL,
            },
          },
        },
        {
          ["ButtonMapId-"] = 5301,
          ["ActivityId-"] = 301,
          ["RemoteId-"] = 8001,
          ["SurfaceId-"] = 7001,
          ["ButtonMapSurfaceId-"] = 7001,
          __type = "ActivityButtonMap",
          ButtonMapIdentifier = "16417Activity301",
          Sequences = {},
          Buttons = {
            hardButton(2001, "VolumeUp", "VolumeUp"),
            softButton(2008, 2, 8, "9", "9"),
            softButton(2009, 0, 9, "NumberPlus", "Clear"),
            softButton(2010, 2, 10, "0", "0"),
            softButton(2020, 0, 4, "Guide", "Guide"),
            softButton(2021, 0, 9, "Audio", "Audio"),
          },
        },
        {
          ["ButtonMapId-"] = 5302,
          ["ActivityId-"] = 302,
          ["RemoteId-"] = 8001,
          ["SurfaceId-"] = 7001,
          ["ButtonMapSurfaceId-"] = 7001,
          __type = "ActivityButtonMap",
          ButtonMapIdentifier = "16417Activity302",
          Sequences = {},
          Buttons = {
            hardButton(2101, "VolumeUp", "VolumeUp"),
            softButton(2110, 0, 0, "Aspect", "Aspect"),
          },
        },
      },
    },
  }
end

local issue178Checks = 0
local function check178(name, cond, detail)
  issue178Checks = issue178Checks + 1
  if cond then
    print("PASS issue178: " .. name)
  else
    failures = failures + 1
    print("FAIL issue178: " .. name .. (detail and (" (" .. tostring(detail) .. ")") or ""))
  end
end

do
  local baseline = logitechClashGraph()
  local strictOk, strictErr = validateGraph(
    baseline.activityList, baseline.mapList, baseline.functionList, baseline.deviceList
  )
  check178(
    "4-arg validateGraph stays strict when no baseline oldMapList is supplied",
    strictOk == nil and type(strictErr) == "string" and
      string.find(strictErr, "duplicate IndexInMenu 9", 1, true) ~= nil,
    strictErr
  )

  local edited = logitechClashGraph()
  table.insert(edited.mapList.ButtonMaps[3].Buttons, hardButton(2102, "Mute", "Mute"))
  local hardEditOk, hardEditErr = validateGraph(
    edited.activityList, edited.mapList, edited.functionList, edited.deviceList, baseline.mapList
  )
  check178(
    "5-arg validateGraph accepts hard-key edit alongside pre-existing slot 9 Logitech duplicate and 16417Device ButtonId 0 map",
    hardEditOk == true,
    hardEditErr
  )

  local newSlotDup = logitechClashGraph()
  table.insert(newSlotDup.mapList.ButtonMaps[2].Buttons, softButton(2099, 0, 4, "Extra", "Extra"))
  local newSlotOk, newSlotErr = validateGraph(
    newSlotDup.activityList, newSlotDup.mapList, newSlotDup.functionList, newSlotDup.deviceList, baseline.mapList
  )
  check178(
    "5-arg validateGraph rejects newly added duplicate IndexInMenu on another slot",
    newSlotOk == nil and type(newSlotErr) == "string" and
      string.find(newSlotErr, "duplicate IndexInMenu 4", 1, true) ~= nil,
    newSlotErr
  )

  local thirdOnNine = logitechClashGraph()
  table.insert(thirdOnNine.mapList.ButtonMaps[2].Buttons, softButton(2098, 0, 9, "Third", "Third"))
  local thirdOk, thirdErr = validateGraph(
    thirdOnNine.activityList, thirdOnNine.mapList, thirdOnNine.functionList, thirdOnNine.deviceList, baseline.mapList
  )
  check178(
    "5-arg validateGraph rejects exceeding baseline duplicate count on slot 9",
    thirdOk == nil and type(thirdErr) == "string" and
      string.find(thirdErr, "duplicate IndexInMenu 9", 1, true) ~= nil,
    thirdErr
  )

  local otherMapDup = logitechClashGraph()
  table.insert(otherMapDup.mapList.ButtonMaps[3].Buttons, softButton(2198, 0, 9, "A", "A"))
  table.insert(otherMapDup.mapList.ButtonMaps[3].Buttons, softButton(2199, 0, 9, "B", "B"))
  local otherOk, otherErr = validateGraph(
    otherMapDup.activityList, otherMapDup.mapList, otherMapDup.functionList, otherMapDup.deviceList, baseline.mapList
  )
  check178(
    "5-arg validateGraph rejects new slot 9 duplicate on an activity map without baseline clash",
    otherOk == nil and type(otherErr) == "string" and
      string.find(otherErr, "16417Activity302 has duplicate IndexInMenu 9", 1, true) ~= nil,
    otherErr
  )

  -- Verify commitActivityResources passes oldMaps.resource into validateGraph.
  local blockerUpIndex
  do
    local idx = 1
    while true do
      local uname = debug.getupvalue(commitActivityResources, idx)
      if not uname then break end
      if uname == "blockerActive" then blockerUpIndex = idx break end
      idx = idx + 1
    end
  end
  if blockerUpIndex then
    local _, origBlocker = debug.getupvalue(commitActivityResources, blockerUpIndex)
    debug.setupvalue(commitActivityResources, blockerUpIndex, function() return true end)
    local byName = {
      ActivityList = baseline.activityList,
      MapList = baseline.mapList,
      FunctionList = baseline.functionList,
      DeviceList = baseline.deviceList,
    }
    resourceStubs.getResource = function(name)
      return 200, "e1", byName[name]
    end
    resourceStubs.getHubEtag = function()
      return "h1"
    end
    resourceStubs.isAnySyncInProgress = function() return true end
    local commitAllowed = commitActivityResources({
      activityList = edited.activityList,
      mapList = edited.mapList,
      functionList = edited.functionList,
    })
    check178(
      "commitActivityResources passes oldMaps.resource and reaches sync guard on hard-key edit",
      commitAllowed and commitAllowed.error == "a Harmony sync is in progress; try again when it finishes",
      commitAllowed and commitAllowed.error
    )
    local commitRejected = commitActivityResources({
      activityList = newSlotDup.activityList,
      mapList = newSlotDup.mapList,
      functionList = newSlotDup.functionList,
    })
    check178(
      "commitActivityResources still rejects newly introduced duplicate IndexInMenu",
      commitRejected and type(commitRejected.error) == "string" and
        string.find(commitRejected.error, "duplicate IndexInMenu 4", 1, true) ~= nil,
      commitRejected and commitRejected.error
    )
    debug.setupvalue(commitActivityResources, blockerUpIndex, origBlocker)
  end
end
print(string.format("%d/%d issue178 checks passed", issue178Checks - math.min(failures, issue178Checks), issue178Checks))
os.exit(failures == 0 and 0 or 1)
