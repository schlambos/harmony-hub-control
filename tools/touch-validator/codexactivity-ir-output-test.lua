-- LuaJIT tests for the per-device IR output (Device.ControlPort) handled by
-- CommitDeviceSettings in payload/activity/codexactivity.lua.
--
-- Harness copied from codexactivity-switch2-devices-test.lua.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-ir-output-test.lua

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
        Device = { ["Id-"] = 39000010, Name = "TV", Transport = 1, ControlPort = 1 },
        Commands = {
          { Name = "PowerOn", ["Id-"] = 39000011, TransportType = 1 },
          { Name = "PowerOff", ["Id-"] = 39000012, TransportType = 1 }
        },
        DeviceFeatures = {}
      },
      {
        Device = { ["Id-"] = 39000020, Name = "Light", Transport = 64, ControlPort = 7 },
        Commands = {{ Name = "PowerOn", ["Id-"] = 39000021, TransportType = 64 }},
        DeviceFeatures = {}
      },
      {
        Device = { ["Id-"] = 39000030, Name = "Old Amp", ControlPort = 1 },
        Commands = {{ Name = "PowerOn", ["Id-"] = 39000031, TransportType = 1 }},
        DeviceFeatures = {}
      }
    }
  })
  setResource("ProtocolList", { Protocols = {} })
  setResource("ActivityList", { Activities = {} })
  setResource("FunctionList", { FunctionMaps = {} })
  setResource("MapList", { ButtonMaps = {} })
end

local passed = 0
local function check(name, cond, detail)
  if not cond then
    io.stderr:write("FAIL: " .. name .. (detail and (" - " .. tostring(detail)) or "") .. "\n")
    os.exit(1)
  end
  passed = passed + 1
end

local n = 0
local function commit(deviceId, irOutput, on)
  n = n + 1
  return processRequest(encodeJson({
    id = "ir-" .. n,
    op = "CommitDeviceSettings",
    deviceId = deviceId,
    settings = {
      interKeyDelayMs = 100,
      interDeviceDelayMs = 500,
      repeats = 0,
      irOutput = irOutput,
      power = {
        type = on and "discrete" or "none",
        on = on or NULL, off = on and "PowerOff" or NULL, toggle = NULL,
        delayMs = 1000, alwaysOn = false, onBetweenActivities = false
      }
    }
  }))
end

local function controlPort(index)
  return getResource("DeviceList").DevicesWithFeatures[index].Device.ControlPort
end

resetStore()

for _, port in ipairs({7, 0, 2, 4, 1}) do
  local res = commit(39000010, port, "PowerOn")
  check("accepts irOutput " .. port, res.ok == true, res.error)
  check("writes ControlPort " .. port, controlPort(1) == port, controlPort(1))
end

local keep = commit(39000010, nil, "PowerOn")
check("absent irOutput succeeds", keep.ok == true, keep.error)
check("absent irOutput keeps ControlPort", controlPort(1) == 1, controlPort(1))

for _, bad in ipairs({3, 5, 8, -1, 1.5}) do
  local res = commit(39000010, bad, "PowerOn")
  check("rejects irOutput " .. bad, res.ok == false)
end
check("rejections leave ControlPort", controlPort(1) == 1, controlPort(1))

local bt = commit(39000020, 2, nil)
check("rejects irOutput on a non-IR device", bt.ok == false)
check("non-IR ControlPort untouched", controlPort(2) == 7, controlPort(2))

local noTransport = commit(39000030, 4, nil)
check("missing Transport counts as IR", noTransport.ok == true, noTransport.error)
check("missing Transport writes ControlPort", controlPort(3) == 4, controlPort(3))

print(string.format("PASS codexactivity-ir-output-test (%d checks)", passed))
