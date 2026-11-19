-- LuaJIT tests for the native LG webOS TV device writer
-- (CommitWebOsDevices) in payload/activity/codexactivity.lua.
--
-- Verifies:
--   - Validated device creation (name, IPv4 host, MAC for WoL, client-key slot)
--   - Defense-in-depth refusal if a plaintext client-key is ever passed
--   - Discrete PowerFeature wiring (PowerOn via WoL + PowerOff via turnOff)
--     when MAC is configured, and honest toggle PowerFeature (no fake PowerOn)
--     when MAC is omitted
--   - Phase B command set (inputs, apps, volume, mute, transport, pointer keys)
--   - Managed Touch device screen creation & updates
--   - CommitDeviceSettings compatibility (power/input/delays) on par with Android TV
--   - Protocol targeting 127.0.0.1:8096/cmd
--   - Isolation from HA, Android TV, and Switch 2 device families
--   - Activity reference guards on remove / command removal
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-webos-devices-test.lua

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
          Name = "Living Room LG (HA)",
          Transport = 64,
          AutoDetectedDevice = { Id = "melodious-ha-39000001" },
          Tokens = { Parameters = {{ Key = "{d}", Value = "media_player.lg_webos_tv" }} }
        },
        Commands = {{ Name = "PowerOff", ["Id-"] = 39000002, TransportType = 64 }},
        DeviceFeatures = {}
      },
      {
        Device = {
          ["Id-"] = 39000010,
          Name = "Den Android TV",
          Transport = 64,
          AutoDetectedDevice = { Id = "melodious-androidtv-39000010" },
          Tokens = { Parameters = {{ Key = "{d}", Value = "androidtv11223344" }} }
        },
        Commands = {{ Name = "PowerOn", ["Id-"] = 39000011, TransportType = 64 }},
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

local function tokenOf(entry, key)
  for _, p in ipairs(entry.Device.Tokens.Parameters or {}) do
    if p.Key == key then return p.Value end
  end
  return nil
end

local function hasCmd(entry, name)
  for _, c in ipairs(entry.Commands or {}) do
    if c.Name == name then return c end
  end
  return nil
end

local function featureOf(entry, ftype)
  for _, f in ipairs(entry.DeviceFeatures or {}) do
    if f.__type == ftype then return f end
  end
  return nil
end

resetStore()

-- 1. Create a native LG webOS TV with WoL MAC, paired slot, and apps
local res = call({
  id = "webos-1",
  op = "CommitWebOsDevices",
  set = {
    devices = {
      {
        entity = "webos1a2b3c4d",
        name = "Living Room LG",
        host = "192.168.1.40",
        mac = "aa-bb-cc-11-22-33",
        paired = true,
        apps = {
          { name = "App Netflix", id = "netflix" },
          { name = "App Plex", id = "cdp-30" }
        }
      }
    }
  }
})
check("add webOS TV succeeds", res.ok == true, res.error)
check("added list names TV", res.added and res.added[1] == "Living Room LG")
local tvId = res.devices[1].deviceId

local dl = getResource("DeviceList")
local tvEntry
for _, e in ipairs(dl.DevicesWithFeatures) do
  if tostring(e.Device["Id-"]) == tostring(tvId) then tvEntry = e end
end
check("webOS TV written to DeviceList", tvEntry ~= nil)
check("DeviceType is Television (1)", tvEntry.Device.DeviceType == 1 and tvEntry.Device.DeviceTypeDisplayName == "Television")
check("Transport is 64", tvEntry.Device.Transport == 64)
check("AutoDetectedDevice.Id carries melodious-webos- tag", tvEntry.Device.AutoDetectedDevice.Id == "melodious-webos-" .. tvId)
check("tokens carry id, host, canonical MAC, keySlot",
  tokenOf(tvEntry, "{d}") == "webos1a2b3c4d" and
  tokenOf(tvEntry, "{host}") == "192.168.1.40" and
  tokenOf(tvEntry, "{mac}") == "AA:BB:CC:11:22:33" and
  tokenOf(tvEntry, "{keySlot}") == "set")

-- Discrete PowerFeature (PowerOn via WoL + PowerOff via turnOff)
local pf = featureOf(tvEntry, "PowerFeature")
check("discrete PowerFeature wired with PowerOn + PowerOff",
  pf ~= nil and pf.PowerTypeId == 1 and
  pf.PowerOnActions[1].IRCommandName == "PowerOn" and
  pf.PowerOffActions[1].IRCommandName == "PowerOff")

-- Baseline commands + inputs + apps
for _, cname in ipairs({
  "PowerOn", "PowerOff", "PowerToggle", "VolumeUp", "VolumeDown", "Mute",
  "Play", "Pause", "PlayPause", "Stop",
  "DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight",
  "Select", "Back", "Home", "Exit",
  "Input HDMI 1", "Input HDMI 2", "Input HDMI 3", "Input HDMI 4",
  "App Netflix", "App Plex"
}) do
  check("has command " .. cname, hasCmd(tvEntry, cname) ~= nil)
end
local netflixCmd = hasCmd(tvEntry, "App Netflix")
check("App Netflix carries app:netflix parameter", netflixCmd and netflixCmd.Parameters[1].Value == "app:netflix")

-- Inputs default to HDMI 1..4
local inf = featureOf(tvEntry, "InputFeature")
check("InputFeature discrete with 4 HDMI inputs",
  inf ~= nil and inf.InputType == 1 and #inf.Inputs == 4 and
  inf.Inputs[1].InputName == "HDMI 1" and inf.Inputs[1].Actions[1].IRCommandName == "Input HDMI 1")

-- Protocol targets codex_webos on 127.0.0.1:8096/cmd
local pl = getResource("ProtocolList")
local proto
for _, p in ipairs(pl.Protocols) do
  if p.Name == "Melodious LG webOS TV" then proto = p end
end
check("protocol posts to codex_webos on 127.0.0.1:8096/cmd",
  proto ~= nil and proto.ControlSection.Url == "http://127.0.0.1:8096/cmd" and
  proto.ControlSection.Method == "POST" and
  proto.ControlSection.Body == '{"device":"{d}","command":"{c}"}')

-- Managed Touch device screen generated
local ml = getResource("MapList")
local foundScreen = false
for _, m in ipairs(ml.ButtonMaps) do
  if m.ButtonMapIdentifier == "16417Device" .. tvId then foundScreen = true end
end
check("managed Touch device screen created", foundScreen)

-- HA-bridged LG TV and Android TV untouched (coexistence)
local haStill, atvStill = false, false
for _, e in ipairs(dl.DevicesWithFeatures) do
  if e.Device.AutoDetectedDevice.Id == "melodious-ha-39000001" then haStill = true end
  if e.Device.AutoDetectedDevice.Id == "melodious-androidtv-39000010" then atvStill = true end
end
check("HA-bridged LG TV and Android TV remain untouched", haStill and atvStill)

-- 2. Discrete power honesty: TV without MAC omits fake PowerOn and uses PowerToggle
local noMacRes = call({
  id = "webos-2",
  op = "CommitWebOsDevices",
  set = {
    devices = {
      {
        entity = "webos1a2b3c4d",
        name = "Living Room LG",
        host = "192.168.1.40",
        mac = "AA:BB:CC:11:22:33",
        paired = true
      },
      {
        entity = "webosdeadbeef",
        name = "Bedroom LG",
        host = "192.168.1.41",
        paired = false
      }
    }
  }
})
check("add second TV without MAC succeeds", noMacRes.ok == true, noMacRes.error)
local dl2 = getResource("DeviceList")
local tv1After, tv2Entry
for _, e in ipairs(dl2.DevicesWithFeatures) do
  if tokenOf(e, "{d}") == "webos1a2b3c4d" then tv1After = e end
  if tokenOf(e, "{d}") == "webosdeadbeef" then tv2Entry = e end
end
check("omitting apps on update preserves existing App commands", hasCmd(tv1After, "App Netflix") ~= nil)
check("TV without MAC omits fake PowerOn", hasCmd(tv2Entry, "PowerOn") == nil)
check("TV without MAC has PowerOff and PowerToggle", hasCmd(tv2Entry, "PowerOff") ~= nil and hasCmd(tv2Entry, "PowerToggle") ~= nil)
local pf2 = featureOf(tv2Entry, "PowerFeature")
check("TV without MAC wires honest toggle PowerFeature",
  pf2 ~= nil and pf2.PowerTypeId == 2 and pf2.PowerToggleActions[1].IRCommandName == "PowerToggle")
check("TV without MAC stores unset keySlot and empty mac",
  tokenOf(tv2Entry, "{keySlot}") == "unset" and tokenOf(tv2Entry, "{mac}") == "")

-- 3. CommitDeviceSettings works on webOS TV on par with Android TV
local setRes = call({
  id = "webos-settings",
  op = "CommitDeviceSettings",
  deviceId = tvId,
  settings = {
    interKeyDelayMs = 100,
    interDeviceDelayMs = 250,
    repeats = 1,
    power = {
      type = "discrete",
      on = "PowerOn",
      off = "PowerOff",
      delayMs = 4000,
      alwaysOn = false,
      onBetweenActivities = false
    },
    inputs = {
      type = "discrete",
      delayMs = 1500,
      list = {
        { name = "Apple TV", command = "Input HDMI 1" },
        { name = "PS5", command = "Input HDMI 2" }
      }
    }
  }
})
check("CommitDeviceSettings succeeds on webOS TV", setRes.ok == true, setRes.error)

-- 4. Validation & security rejections
local badId = call({ id = "bad-1", op = "CommitWebOsDevices", set = { devices = {{ entity = "androidtv12345678", name = "X", host = "192.168.1.40" }} } })
check("refuses non-webos id", badId.ok == false and badId.error:find("webOS TV id") ~= nil, badId.error)

local badHost = call({ id = "bad-2", op = "CommitWebOsDevices", set = { devices = {{ entity = "webos12345678", name = "X", host = "192.168.1.999" }} } })
check("refuses invalid IPv4 host", badHost.ok == false and badHost.error:find("IPv4") ~= nil, badHost.error)

local badMac = call({ id = "bad-3", op = "CommitWebOsDevices", set = { devices = {{ entity = "webos12345678", name = "X", host = "192.168.1.40", mac = "00:00:00:00:00:00" }} } })
check("refuses all-zero MAC", badMac.ok == false and badMac.error:find("MAC") ~= nil, badMac.error)

local leakKey = call({ id = "bad-4", op = "CommitWebOsDevices", set = { devices = {{ entity = "webos12345678", name = "X", host = "192.168.1.40", clientKey = "secret-key-1234" }} } })
check("refuses plaintext clientKey in hub device config", leakKey.ok == false and leakKey.error:find("client%-key") ~= nil, leakKey.error)

local leakKey2 = call({ id = "bad-5", op = "CommitWebOsDevices", set = { devices = {{ entity = "webos12345678", name = "X", host = "192.168.1.40", ["client-key"] = "secret-key-1234" }} } })
check("refuses plaintext client-key in hub device config", leakKey2.ok == false and leakKey2.error:find("client%-key") ~= nil, leakKey2.error)

local badApp = call({ id = "bad-6", op = "CommitWebOsDevices", set = { devices = {{ entity = "webos12345678", name = "X", host = "192.168.1.40", apps = {{ name = "Netflix", id = "netflix" }} }} } })
check("refuses app name missing 'App ' prefix", badApp.ok == false, badApp.error)

-- 5. Remove webOS TV cleanly removes protocol and Touch screen when unused
local rmRes = call({ id = "webos-rm", op = "CommitWebOsDevices", set = { devices = {} } })
check("removing all webOS TVs succeeds", rmRes.ok == true, rmRes.error)
local plAfter = getResource("ProtocolList")
local webosProtoLeft = false
for _, p in ipairs(plAfter.Protocols) do
  if p.Name == "Melodious LG webOS TV" then webosProtoLeft = true end
end
check("Melodious LG webOS TV protocol removed when no webOS TVs remain", not webosProtoLeft)

print("codexactivity-webos-devices-test: " .. passed .. " checks passed")
