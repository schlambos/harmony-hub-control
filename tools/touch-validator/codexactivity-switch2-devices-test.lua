-- LuaJIT tests for the Nintendo Switch 2 wake device writer
-- (CommitSwitch2Devices) in payload/activity/codexactivity.lua.
--
-- Mirrors codexactivity-androidtv-devices-test.lua: stubs hub modules,
-- reaches processRequest through discover()'s upvalues, verifies device/protocol
-- structure, strict MAC/PID validation, Touch screen generation, in-place edit,
-- wake-only CommitDeviceSettings, and isolation from HA/Android TV families.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-switch2-devices-test.lua

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
      if c == '"' then pos = pos + 1 return table.concat(out)
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
    elseif c == '"' then return parseString()
    elseif text:sub(pos, pos + 3) == "true" then pos = pos + 4 return true
    elseif text:sub(pos, pos + 4) == "false" then pos = pos + 5 return false
    elseif text:sub(pos, pos + 3) == "null" then pos = pos + 4 return NULL
    else
      local num = text:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  return parseValue()
end

local hub = {
  blocker = "1\n",
  files = {},
  messages = {},
  saves = {},
  published = 0,
  configNewResult = true,
}

local noop = function() end
local uuidCounter = 0

package.preload["system"] = function()
  return {
    uuid = function()
      uuidCounter = uuidCounter + 1
      return string.format("00000000-0000-4000-8000-%012d", uuidCounter)
    end,
    sleep = noop,
    blockingSleep = noop,
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
      hub.files[name] = {
        text = type(value) == "string" and value or encodeJson(value),
        etag = etag,
        hetag = hetag,
      }
      return true
    end,
  }
end
local digest = { configVersion = 7, stateVersion = 3 }
function digest.saveStateDigest() hub.published = hub.published + 1 end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return digest end }
end
package.preload["tasks.connectserver.core.utils"] = function()
  return { broadcastEvent = noop }
end

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

local processRequest = assert(findUpvalue(plugin.discover, "processRequest"), "could not reach processRequest")

local function setResource(name, value, etag)
  hub.files[name] = { text = encodeJson(value), etag = etag or "et-0", hetag = "h-0" }
end

local function getResource(name)
  return decodeJson(hub.files[name].text)
end

local function resetStore()
  hub.messages = {}
  hub.saves = {}
  hub.published = 0
  setResource("DeviceList", {
    DevicesWithFeatures = {
      {
        Device = {
          ["Id-"] = 39000001,
          Name = "Living Room Light",
          Transport = 64,
          AutoDetectedDevice = { Id = "melodious-ha-39000001" },
          Tokens = { Parameters = {{ Key = "{d}", Value = "light.living_room" }} }
        },
        Commands = {{ Name = "PowerOn", ["Id-"] = 39000002, TransportType = 64 }},
        DeviceFeatures = {}
      }
    }
  })
  setResource("ProtocolList", { Protocols = {} })
  setResource("ActivityList", { Activities = {{ ["Id-"] = 100, Name = "Watch TV", Roles = {} }} })
  setResource("FunctionList", { FunctionMaps = {{ ["ActivityId-"] = 100, __type = "ActivityFunctionMap", FunctionGroups = {} }} })
  setResource("MapList", {
    ButtonMaps = {
      {
        __type = "ActivityButtonMap",
        ["ButtonMapId-"] = 40560730,
        ["ActivityId-"] = 100,
        ["SurfaceId-"] = 1,
        ["RemoteId-"] = 2,
        ButtonMapIdentifier = "16417Activity100",
        Buttons = {}
      }
    }
  })
end

local passed = 0
local function check(name, cond, detail)
  if not cond then
    io.stderr:write("FAIL: " .. name .. (detail and (" — " .. tostring(detail)) or "") .. "\n")
    os.exit(1)
  end
  passed = passed + 1
end

local function call(req)
  return processRequest(encodeJson(req))
end

resetStore()

-- 1. Add a Switch 2 wake device
local res = call({
  id = "s2-1",
  op = "CommitSwitch2Devices",
  set = {
    devices = {
      {
        entity = "switch2a1b2c3d4",
        name = "Nintendo Switch 2",
        switch2Mac = "d8:6b:83:f0:42:fd",
        controllerMac = "bc-89-a6-1f-ca-5b",
        pid = "66 20"
      }
    }
  }
})
check("add succeeds", res.ok == true, res.error)
check("added list names Switch 2", res.added and res.added[1] == "Nintendo Switch 2")
local s2Id = res.devices[1].deviceId
check("assigned deviceId", tonumber(s2Id) ~= nil)

-- Verify DeviceList entry
local dl = getResource("DeviceList").DevicesWithFeatures
check("HA device untouched alongside Switch 2", #dl == 2)
local s2Entry = dl[2]
check("Transport = 64", s2Entry.Device.Transport == 64)
check("DeviceType = 23 GameConsole", s2Entry.Device.DeviceType == 23 and s2Entry.Device.DeviceTypeDisplayName == "GameConsole")
check("AutoDetectedDevice tag", s2Entry.Device.AutoDetectedDevice.Id == "melodious-switch2-" .. s2Id)
local tok = {}
for _, p in ipairs(s2Entry.Device.Tokens.Parameters) do tok[p.Key] = p.Value end
check("tokens normalized",
  tok["{d}"] == "switch2a1b2c3d4" and
  tok["{s2mac}"] == "D8:6B:83:F0:42:FD" and
  tok["{cmac}"] == "BC:89:A6:1F:CA:5B" and
  tok["{pid}"] == "6620")
check("single Wake command", #s2Entry.Commands == 1 and s2Entry.Commands[1].Name == "Wake")
local pf = s2Entry.DeviceFeatures[1]
check("PowerFeature discrete Wake on, empty off",
  pf.__type == "PowerFeature" and pf.PowerTypeId == 1 and
  pf.PowerOnActions[1].IRCommandName == "Wake" and #pf.PowerOffActions == 0)

-- Verify ProtocolList entry
local proto = getResource("ProtocolList").Protocols[1]
check("protocol name and local URL",
  proto.Name == "Melodious Switch 2 Wake" and
  proto.ControlSection.Url == "http://127.0.0.1:8080/api/switch2/cmd" and
  proto.ControlSection.Timeout == "6")
check("protocol body substitutes all 4 tokens",
  proto.ControlSection.Body == '{"device":"{d}","command":"{c}","switch2Mac":"{s2mac}","controllerMac":"{cmac}","pid":"{pid}"}')

-- Verify Touch device screen built with one-shot Wake button
local screen
for _, m in ipairs(getResource("MapList").ButtonMaps) do
  if m.ButtonMapIdentifier == "16417Device" .. s2Id then screen = m end
end
check("Touch device screen created", screen ~= nil and #screen.Buttons == 1)
check("Touch Wake button has one-shot self-long",
  screen.Buttons[1].TextOnRemote == "Wake" and
  screen.Buttons[1].ButtonLongPressAction ~= NULL and
  screen.Buttons[1].ButtonLongPressAction.CommandName == "Wake")

-- 2. In-place edit keeps DeviceId and updates PID/MAC
local editRes = call({
  id = "s2-2",
  op = "CommitSwitch2Devices",
  set = {
    devices = {
      {
        entity = "switch2a1b2c3d4",
        name = "Switch 2 Pro Wake",
        switch2Mac = "D86B83F042FD",
        controllerMac = "BC:89:A6:1F:CA:5B",
        pid = "6920"
      }
    }
  }
})
check("edit succeeds", editRes.ok == true, editRes.error)
check("edit preserves DeviceId", editRes.devices[1].deviceId == s2Id)
check("edit recorded in updated", editRes.updated[1] == "Switch 2 Pro Wake")

-- 3. Wake-only CommitDeviceSettings succeeds with empty off
local setRes = call({
  id = "s2-3",
  op = "CommitDeviceSettings",
  deviceId = s2Id,
  settings = {
    interKeyDelayMs = 100,
    interDeviceDelayMs = 500,
    repeats = 0,
    power = {
      type = "discrete",
      on = "Wake",
      off = NULL,
      toggle = NULL,
      delayMs = 1000,
      alwaysOn = false,
      onBetweenActivities = false
    }
  }
})
check("CommitDeviceSettings allows wake-only empty off", setRes.ok == true, setRes.error)

-- 4. Validation rejections
local badMac = call({
  id = "s2-4",
  op = "CommitSwitch2Devices",
  set = {
    devices = {{
      entity = "switch2a1b2c3d4", name = "Bad",
      switch2Mac = "00:00:00:00:00:00", controllerMac = "BC:89:A6:1F:CA:5B", pid = "6620"
    }}
  }
})
check("rejects all-zero switch2Mac", badMac.ok == false)

local sameMac = call({
  id = "s2-5",
  op = "CommitSwitch2Devices",
  set = {
    devices = {{
      entity = "switch2a1b2c3d4", name = "Same",
      switch2Mac = "D8:6B:83:F0:42:FD", controllerMac = "D8:6B:83:F0:42:FD", pid = "6620"
    }}
  }
})
check("rejects identical switch2Mac and controllerMac", sameMac.ok == false)

local badPid = call({
  id = "s2-6",
  op = "CommitSwitch2Devices",
  set = {
    devices = {{
      entity = "switch2a1b2c3d4", name = "BadPid",
      switch2Mac = "D8:6B:83:F0:42:FD", controllerMac = "BC:89:A6:1F:CA:5B", pid = "66;id"
    }}
  }
})
check("rejects shell injection in PID", badPid.ok == false)

-- 5. Remove cleanly (and leaves HA device intact)
local remRes = call({
  id = "s2-7",
  op = "CommitSwitch2Devices",
  set = { devices = {} }
})
check("remove succeeds", remRes.ok == true, remRes.error)
check("HA device still present", #getResource("DeviceList").DevicesWithFeatures == 1)
check("Switch 2 protocol removed", #getResource("ProtocolList").Protocols == 0)

print(string.format("PASS codexactivity-switch2-devices-test (%d checks)", passed))
