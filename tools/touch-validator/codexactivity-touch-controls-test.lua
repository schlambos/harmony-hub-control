-- LuaJIT tests for Touch & HA control studio (P11 one-shot + P18 gestures):
-- device screens get self-long for one-shot commands, and the gesture
-- lookup simulator matches soft/hard/hard-gate/missing cases.
-- Same harness as codexactivity-device-screens-test.lua: stub hub modules,
-- reach processRequest through discover()'s upvalues, in-memory fake.
-- Run from repo root:
--   luajit tools/touch-validator/codexactivity-touch-controls-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local NULL = setmetatable({}, { __tostring = function() return "null" end })

local function encodeJson(value)
  if value == NULL or value == nil then return "null" end
  local kind = type(value)
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then
    if value == math.floor(value) then return string.format("%d", value) end
    return tostring(value)
  end
  if kind == "string" then
    return '"' .. value:gsub('[%c"\\]', function(c)
      local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return map[c] or string.format("\\u%04x", c:byte())
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
    local s = text:match("^%-?%d+%.?%d*[eE]?[%-+]?%d*", pos)
    if not s or s == "" then error("bad JSON at " .. pos) end
    pos = pos + #s
    return tonumber(s)
  end
  return parseValue()
end

local hub
local uuidCounter = 0
local function resetHub(state)
  hub = { files = {}, blocker = "1\n", messages = {}, published = 0, saves = {}, failSave = nil, configNewResult = true }
  for name, value in pairs(state) do
    uuidCounter = uuidCounter + 1
    hub.files[name] = { text = encodeJson(value), etag = '"seed-' .. uuidCounter .. '"', hetag = tostring(uuidCounter) }
  end
end

local function noop() return nil end
package.preload["system"] = function()
  return {
    uuid = function()
      uuidCounter = uuidCounter + 1
      return string.format("00000000-0000-4000-8000-%012d", uuidCounter)
    end,
    sleep = noop, blockingSleep = noop,
    jiffies = function() return { tomillis = function() return 1000 end } end,
    addTask = function(_, fn) fn() return {} end,
    taskStatus = function() return "dead" end,
    isMessageRegistered = function() return true end,
    sendMessage = function(name, args)
      if name == "config_new" then
        hub.messages[#hub.messages + 1] = table.concat(args, ",")
        return hub.configNewResult
      end
      return true
    end,
  }
end
package.preload["json"] = function() return { null = NULL, encode = encodeJson, decode = decodeJson } end
package.preload["log"] = function()
  local logger = { notice = noop, error = noop, warning = noop, debug = noop, info = noop }
  return { logger = function() return logger end }
end
package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
  return {
    isAnySyncInProgress = function() return false end,
    getResource = function(name)
      local file = hub.files[name]
      if not file then return "404" end
      return "200", file.etag, decodeJson(file.text)
    end,
    getHubEtag = function(name) return hub.files[name] and hub.files[name].hetag end,
    saveResource = function(_, etag, value, name, _, hetag)
      hub.saves[#hub.saves + 1] = name
      hub.files[name] = { text = type(value) == "string" and value or encodeJson(value), etag = etag, hetag = hetag }
      return true
    end,
  }
end
local digest = { configVersion = 7, stateVersion = 3 }
function digest.saveStateDigest() hub.published = hub.published + 1 end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return digest end }
end
package.preload["tasks.connectserver.core.utils"] = function() return { broadcastEvent = noop } end

local realOpen = io.open
io.open = function(path, mode)
  local text
  if path == "/data/resources/DeviceList.json" then
    text = hub.files.DeviceList and hub.files.DeviceList.text
  elseif path == "/data/codex/cloud_blocker.conf" then
    text = hub.blocker
  else
    return realOpen(path, mode)
  end
  if not text then return nil end
  return { read = function() return text end, close = noop }
end

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

local processRequest = findUpvalue(plugin.discover, "processRequest")
local validateGraph = findUpvalue(plugin.discover, "validateGraph")
if type(processRequest) ~= "function" or type(validateGraph) ~= "function" then
  io.stderr:write("could not reach plugin functions\n")
  os.exit(2)
end
-- P18 helpers are reached via read-only ops (SimulateGesture/GestureWarnings).
local function simulateViaHub(mapList, activityId, gestureKey)
  local raw = encodeJson({ id = "sim", op = "SimulateGesture", mapList = mapList, activityId = activityId, gestureKey = gestureKey })
  local res = processRequest(raw)
  return res.simulation
end

local failures, count = 0, 0
local function check(name, ok, detail)
  count = count + 1
  if ok then print("PASS " .. name)
  else failures = failures + 1 print("FAIL " .. name .. (detail and (" (" .. tostring(detail) .. ")") or "")) end
end

local function touchMaps()
  return { ButtonMaps = {
    { __type = "RootButtonMap", ButtonMapIdentifier = "16414Root", ["ButtonMapId-"] = 40550459,
      ["SurfaceId-"] = 13151460, ["ButtonMapSurfaceId-"] = 13151460, ["RemoteId-"] = 12345678, Buttons = {} },
    { __type = "DeviceButtonMap", ButtonMapIdentifier = "16417Device200", ["ButtonMapId-"] = 52944090,
      ["DeviceId-"] = 200, ["SurfaceId-"] = 14551427, ["ButtonMapSurfaceId-"] = 14551427,
      ["RemoteId-"] = 12345678, Sequences = NULL, Buttons = {} },
    { __type = "ActivityButtonMap", ButtonMapIdentifier = "16417Activity1", ["ButtonMapId-"] = 52944093,
      ["ActivityId-"] = 1, ["SurfaceId-"] = 14551427, ["ButtonMapSurfaceId-"] = 14551427,
      ["RemoteId-"] = 12345678, Buttons = {}, Sequences = {} },
  } }
end

-- One-shot device screens ----------------------------------------------------
resetHub({
  DeviceList = { DevicesWithFeatures = {
    { Device = { ["Id-"] = 100, Name = "Lamp", Transport = 1, Manufacturer = "Test" },
      Commands = {
        { ["Id-"] = 39000101, Name = "PowerToggle", TransportType = 1, ProtocolId = 2 },
        { ["Id-"] = 39000102, Name = "BrightnessUp", TransportType = 1, ProtocolId = 2 },
        { ["Id-"] = 39000103, Name = "Mute", TransportType = 1, ProtocolId = 2 },
        { ["Id-"] = 39000104, Name = "PowerOn", TransportType = 1, ProtocolId = 2 },
      }, DeviceFeatures = {} },
    { Device = { ["Id-"] = 200, Name = "TV", Transport = 1, Manufacturer = "LG" },
      Commands = { { ["Id-"] = 39000201, Name = "Home", TransportType = 1, ProtocolId = 2 } },
      DeviceFeatures = {} },
  } },
  ProtocolList = { Protocols = { { ["Id-"] = 2, Name = "Test", __type = "IrProtocol" } } },
  ActivityList = { Activities = { { ["Id-"] = 1, Name = "Test", Roles = {} } } },
  MapList = touchMaps(),
  FunctionList = { FunctionMaps = { { __type = "ActivityFunctionMap", ["ActivityId-"] = 1, FunctionGroups = {} } } },
})

local reqId = 0
local function screen(fields)
  reqId = reqId + 1
  local raw = { id = "r" .. reqId, op = "CommitDeviceScreen" }
  for k, v in pairs(fields) do raw[k] = v end
  return processRequest(encodeJson(raw))
end

local made = screen({ deviceId = "100" })
check("one-shot device screen builds", made.ok and made.changed, encodeJson(made))
local stored = decodeJson(hub.files.MapList.text)
local lampMap
for _, m in ipairs(stored.ButtonMaps) do
  if m.ButtonMapIdentifier == "16417Device100" then lampMap = m break end
end
check("screen exists", lampMap ~= nil)
local longs = {}
for _, b in ipairs(lampMap and lampMap.Buttons or {}) do
  local cmd = b.ButtonAction and b.ButtonAction.CommandName
  local long = b.ButtonLongPressAction and b.ButtonLongPressAction ~= NULL and b.ButtonLongPressAction.CommandName or nil
  longs[cmd] = long
  if cmd == "PowerToggle" or cmd == "Mute" then
    check(cmd .. " has self-long EventType 2", b.ButtonLongPressAction ~= NULL
      and b.ButtonLongPressAction.CommandName == cmd
      and b.ButtonLongPressAction.EventType == 2, encodeJson(b.ButtonLongPressAction))
  end
  if cmd == "BrightnessUp" or cmd == "PowerOn" then
    check(cmd .. " stays standard (no long)", b.ButtonLongPressAction == NULL, encodeJson(b.ButtonLongPressAction))
  end
end

-- A Home-named command gets the Touch's real Home hard key, not Menu -------
local homeMade = screen({ deviceId = "200" })
check("home device screen builds", homeMade.ok and homeMade.changed, encodeJson(homeMade))
local homeMap
for _, m in ipairs(decodeJson(hub.files.MapList.text).ButtonMaps) do
  if m.ButtonMapIdentifier == "16417Device200" then homeMap = m break end
end
local homeHard, menuHard
for _, b in ipairs(homeMap and homeMap.Buttons or {}) do
  if b.ButtonKey == "Home" then homeHard = b end
  if b.ButtonKey == "Menu" then menuHard = b end
end
check("Home command lands on the Home hard key",
  homeHard ~= nil and homeHard.ButtonAction.CommandName == "Home",
  encodeJson(homeHard))
check("Menu stays unmapped when the device has no Menu command", menuHard == nil, encodeJson(menuHard))

-- validateGraph accepts long on hard and soft (activity + device) -----------
local function graphWithLong(buttonType, mapId, mapType)
  return {
    activityList = { Activities = { { ["Id-"] = 1, Name = "A", Roles = {} } } },
    mapList = { ButtonMaps = { {
      ["ButtonMapId-"] = 6000, ["ActivityId-"] = 1, ["DeviceId-"] = 100,
      __type = mapType, ButtonMapIdentifier = mapId,
      ["SurfaceId-"] = 1, ["ButtonMapSurfaceId-"] = 1, ["RemoteId-"] = 1,
      Sequences = {}, Buttons = { {
        __type = buttonType, ButtonId = 7000, ButtonState = 1,
        ButtonKey = buttonType == "GestureRemoteButton" and "Tap" or "VolumeMute",
        MenuItem = buttonType == "SoftRemoteButton" and { IndexInMenu = 0, MenuName = "Activity.1" } or NULL,
        FunctionGroupType = 0, TextOnRemote = "X",
        ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 100, CommandName = "Mute", ["FunctionId-"] = 0, Order = 0, EventType = buttonType == "SoftRemoteButton" and 0 or 1, Id = 0 },
        ButtonLongPressAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 100, CommandName = "Mute", ["FunctionId-"] = 0, Order = 0, EventType = 2, Id = 0 },
        ButtonDoublePressAction = NULL,
      } },
    } } },
    functionList = { FunctionMaps = { { __type = "ActivityFunctionMap", ["ActivityId-"] = 1, FunctionGroups = {} } } },
    deviceList = { DevicesWithFeatures = { { Device = { ["Id-"] = 100, Name = "D" }, Commands = {}, DeviceFeatures = {} } } },
  }
end
for _, case in ipairs({
  { "hard long on activity", "HardRemoteButton", "16417Activity1", "ActivityButtonMap" },
  { "soft self-long on activity", "SoftRemoteButton", "16417Activity1", "ActivityButtonMap" },
  { "hard long on device", "HardRemoteButton", "16417Device100", "DeviceButtonMap" },
  { "soft self-long on device", "SoftRemoteButton", "16417Device100", "DeviceButtonMap" },
}) do
  local g = graphWithLong(case[2], case[3], case[4])
  local ok, err = validateGraph(g.activityList, g.mapList, g.functionList, g.deviceList)
  check("validateGraph accepts " .. case[1], ok == true, err)
end

-- Gesture simulator vectors (P18) --------------------------------------------
local gestureMaps = { ButtonMaps = {
  { ButtonMapIdentifier = "16417Activity100", Buttons = {
    { __type = "GestureRemoteButton", ButtonKey = "SwipeUp",
      ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "BrightnessUp", ["FunctionId-"] = 0 } },
    { __type = "GestureRemoteButton", ButtonKey = "Tap",
      ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "PowerToggle", ["FunctionId-"] = 0 } },
    { __type = "HardRemoteButton", ButtonKey = "VolumeUp",
      ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "VolumeUp" } },
  } },
  { ButtonMapIdentifier = "16417Device10", Buttons = {
    { __type = "HardRemoteButton", ButtonKey = "VolumeUp",
      ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "BrightnessUp", ["FunctionId-"] = 0 } },
    { __type = "SoftRemoteButton", FunctionGroupType = 0, TextOnRemote = "Toggle", MenuItem = { IndexInMenu = 0 },
      ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "PowerToggle", ["FunctionId-"] = 0 } },
  } },
} }
local swipe = simulateViaHub(gestureMaps, "100", "SwipeUp")
check("swipe resolves to hard with gate pass", swipe.ok and swipe.resolved == "hard" and swipe.hardGateOk, encodeJson(swipe))
local tap = simulateViaHub(gestureMaps, "100", "Tap")
check("tap toggle warns (no hub protection)", tap.ok and tap.resolved == "soft" and #(tap.warnings or {}) > 0, encodeJson(tap))
-- Remove hard key from activity: gate blocks.
gestureMaps.ButtonMaps[1].Buttons = {
  gestureMaps.ButtonMaps[1].Buttons[1], gestureMaps.ButtonMaps[1].Buttons[2],
}
local blocked = simulateViaHub(gestureMaps, "100", "SwipeUp")
check("hard-gate blocked without activity key", not blocked.ok and blocked.reason == "hard-gate-blocked", encodeJson(blocked))
-- FunctionId>0 match.
gestureMaps.ButtonMaps[1].Buttons[1].ButtonAction["FunctionId-"] = 77
gestureMaps.ButtonMaps[2].Buttons[1].ButtonAction["FunctionId-"] = 77
gestureMaps.ButtonMaps[1].Buttons[#gestureMaps.ButtonMaps[1].Buttons + 1] = {
  __type = "HardRemoteButton", ButtonKey = "VolumeUp",
  ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "Other", ["FunctionId-"] = 0 },
}
local byFunc = simulateViaHub(gestureMaps, "100", "SwipeUp")
check("FunctionId>0 matches first", byFunc.ok and byFunc.resolved == "hard", encodeJson(byFunc))
-- Missing map.
local missing = simulateViaHub(gestureMaps, "100", "SwipeDown")
check("missing gesture reports no-gesture", not missing.ok and missing.reason == "no-gesture", encodeJson(missing))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
