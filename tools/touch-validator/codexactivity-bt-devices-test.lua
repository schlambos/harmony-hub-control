-- LuaJIT tests for the Bluetooth keyboard device writer (CommitBtDevices) in
-- payload/activity/codexactivity.lua, and for its separation from the Home
-- Assistant devices (CommitHaDevices) that share the same writer.
--
-- Same loading pattern as codexactivity-validate-test.lua: stub the hub
-- modules, reach processRequest through discover()'s upvalues. The resource
-- manager is an in-memory fake that keeps etags like the hub's index, so the
-- tests can tell what the Touch would pull. No hub is contacted and nothing
-- is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-bt-devices-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

-- Minimal JSON (test code only). null decodes to the sentinel the plugin
-- sees as json.null.
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

-- The fake hub: resources with etags, the files the plugin reads directly,
-- and a record of every reload and publish.
local hub
local uuidCounter = 0
local function resetHub(state)
  hub = {
    files = {}, -- name -> { text, etag, hetag }
    blocker = "1\n",
    messages = {},
    published = 0,
    saves = {},
    failSave = nil,
    configNewResult = true,
  }
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
    sleep = noop,
    blockingSleep = noop,
    jiffies = function() return { tomillis = function() return 1000 end } end,
    -- The engine barrier answers at once.
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
package.preload["json"] = function()
  return { null = NULL, encode = encodeJson, decode = decodeJson }
end
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
      if hub.failSave == name then
        hub.failSave = nil -- one failed write; the restore after it succeeds
        return nil, "disk full"
      end
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

-- The plugin reads DeviceList's text and the cloud blocker straight from disk.
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
if type(processRequest) ~= "function" then
  io.stderr:write("could not reach processRequest in codexactivity.lua\n")
  os.exit(2)
end

local failures, count = 0, 0
local function check(name, ok, detail)
  count = count + 1
  if ok then
    print("PASS " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. (detail and (" (" .. tostring(detail) .. ")") or ""))
  end
end

local BT_WEBHOOK = "http://127.0.0.1:8080/api/bt-webhook"
local HA_WEBHOOK = "http://ha.example:8123/api/webhook/melodious-test"

local function seedState()
  return {
    DeviceList = { DevicesWithFeatures = {
      { Device = { ["Id-"] = 100, Name = "TV", Transport = 1, Manufacturer = "LG" },
        Commands = { { ["Id-"] = 39000005, Name = "PowerOn", TransportType = 1, ProtocolId = 2 } },
        DeviceFeatures = {} },
    } },
    ProtocolList = { Protocols = { { ["Id-"] = 2, Name = "Toshiba 32 Bit", __type = "IrProtocol" } } },
    ActivityList = { Activities = { { ["Id-"] = 1, Name = "Watch", Roles = {
      { ["DeviceId-"] = 100, __type = "DisplayActivityRole" } } } } },
    MapList = { ButtonMaps = {} },
    FunctionList = { FunctionMaps = {} },
  }
end

local function box(extra)
  local device = {
    entity = "bt_1730000000_42",
    name = "Homatics Box",
    model = "Android TV keyboard",
    commands = {
      { name = "Home", value = "tvhome" },
      { name = "Back", value = "tvback" },
      { name = "Select", value = "select" },
      { name = "DirectionUp", value = "directionup" },
    },
  }
  for key, value in pairs(extra or {}) do device[key] = value end
  return device
end

local function lamp()
  return {
    entity = "light.kitchen", name = "Kitchen",
    commands = { { name = "PowerOn", value = "turn_on" }, { name = "PowerOff", value = "turn_off" } },
    power = { on = "PowerOn", off = "PowerOff" },
  }
end

local requestCounter = 0
local function request(op, set, dryRun)
  requestCounter = requestCounter + 1
  return processRequest(encodeJson({ id = "r" .. requestCounter, op = op, set = set, dryRun = dryRun }))
end
local function commitBt(set, dryRun) return request("CommitBtDevices", set, dryRun) end
local function commitHa(set, dryRun) return request("CommitHaDevices", set, dryRun) end

local function stored(name) return decodeJson(hub.files[name].text) end

local function entryBy(manufacturer)
  for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
    if entry.Device.Manufacturer == manufacturer then return entry end
  end
end

local function protocolNamed(name)
  for _, protocol in ipairs(stored("ProtocolList").Protocols) do
    if protocol.Name == name then return protocol end
  end
end

-- Rejected sets ------------------------------------------------------------
resetHub(seedState())
local rejects = {
  { "an entity that is not a saved Bluetooth ID", { devices = { box({ entity = "light.kitchen" }) } } },
  { "a Home Assistant style entity", { devices = { box({ entity = "media_player.box" }) } } },
  { "a value with a brace", { devices = { box({ commands = { { name = "Home", value = "{c}" } } }) } } },
  { "no commands", { devices = { box({ commands = {} }) } } },
}
for _, case in ipairs(rejects) do
  local response = commitBt(case[2])
  check("rejects " .. case[1], response.ok == false and #hub.saves == 0 and #hub.messages == 0,
    response.error)
end

-- Adding a Bluetooth device -------------------------------------------------
local added = commitBt({ webhook = "http://evil.example/steal", devices = { box() } })
check("adds the device", added.ok and added.changed and added.added[1] == "Homatics Box", encodeJson(added))
check("reloads DeviceList and ProtocolList", hub.messages[1] == "DeviceList,ProtocolList", hub.messages[1])
local entry = entryBy("Melodious Bluetooth")
local device = entry and entry.Device or {}
check("the device is IP-only", device.Transport == 64)
check("the device is tagged as a Melodious Bluetooth device",
  device.AutoDetectedDevice and device.AutoDetectedDevice.Id == "melodious-bt-" .. tostring(device["Id-"]))
check("the device names its saved Bluetooth target in {d}",
  device.Tokens and device.Tokens.Parameters[1].Key == "{d}" and
    device.Tokens.Parameters[1].Value == "bt_1730000000_42")
check("the model is kept", device.Model == "Android TV keyboard")
local valuesOk = entry ~= nil and #entry.Commands == 4
for i, command in ipairs(entry and entry.Commands or {}) do
  valuesOk = valuesOk and command.TransportType == 64 and command.Parameters[1].Key == "{c}" and
    command.Parameters[1].Value == box().commands[i].value
end
check("each command carries its key name in {c}", valuesOk)
local protocol = protocolNamed("Melodious Bluetooth keyboard")
check("the protocol posts to codex_webui on the hub, not to the requested URL",
  protocol and protocol.ControlSection.Url == BT_WEBHOOK and
    protocol.ControlSection.Body == '{"device":"{d}","command":"{c}"}',
  protocol and protocol.ControlSection.Url)
check("commands use the Bluetooth protocol",
  entry and entry.Commands[1].ProtocolId == protocol["Id-"])
check("no power feature is set",
  (function()
    for _, feature in ipairs(entry and entry.DeviceFeatures or {}) do
      if feature.__type == "PowerFeature" then return feature.PowerTypeId == 0 end
    end
    return true
  end)())

-- The two owners leave each other alone -------------------------------------
local ha = commitHa({ webhook = HA_WEBHOOK, devices = { lamp() } })
check("a Home Assistant commit adds its device", ha.ok and ha.added[1] == "Kitchen", encodeJson(ha))
check("a Home Assistant commit keeps the Bluetooth device and protocol",
  entryBy("Melodious Bluetooth") ~= nil and protocolNamed("Melodious Bluetooth keyboard") ~= nil)
local sameBt = commitBt({ devices = { box() } })
check("the same Bluetooth set again saves nothing", sameBt.ok and sameBt.changed == false,
  encodeJson(sameBt))
local clash = commitBt({ devices = { box({ name = "Kitchen" }) } })
check("a Bluetooth device cannot take a Home Assistant device's name",
  clash.ok == false and string.find(clash.error or "", "Kitchen", 1, true) ~= nil, clash.error)
local haEmpty = commitHa({ devices = {} })
check("an empty Home Assistant set keeps the Bluetooth device",
  haEmpty.ok and haEmpty.removed[1] == "Kitchen" and entryBy("Melodious Bluetooth") ~= nil and
    protocolNamed("Melodious Bluetooth keyboard") ~= nil and protocolNamed("Melodious Home Assistant") == nil,
  encodeJson(haEmpty))

-- Updating and removing -------------------------------------------------------
local idBefore = device["Id-"]
local updated = commitBt({ devices = { box({ commands = {
  { name = "Home", value = "tvhome" }, { name = "Back", value = "tvback" },
  { name = "Select", value = "select" }, { name = "DirectionUp", value = "directionup" },
  { name = "Mute", value = "mute" } } }) } })
local after = entryBy("Melodious Bluetooth")
check("adding a command keeps the device ID",
  updated.ok and updated.updated[1] == "Homatics Box" and after.Device["Id-"] == idBefore and
    #after.Commands == 5, encodeJson(updated))
local cleared = commitBt({ devices = {} })
check("an empty Bluetooth set removes the device and its protocol",
  cleared.ok and cleared.removed[1] == "Homatics Box" and entryBy("Melodious Bluetooth") == nil and
    protocolNamed("Melodious Bluetooth keyboard") == nil and #stored("DeviceList").DevicesWithFeatures == 1,
  encodeJson(cleared))

-- A set file from codex_webui (tools/bt_harmony_webui_smoke.py) ------------
if arg and arg[1] then
  local file = assert(io.open(arg[1], "r"))
  local fromWebui = decodeJson(file:read("*a"))
  file:close()
  resetHub(seedState())
  local committed = commitBt(fromWebui)
  local entry = entryBy("Melodious Bluetooth")
  check("the writer accepts codex_webui's set",
    committed.ok and committed.added[1] == fromWebui.devices[1].name and entry ~= nil and
      #entry.Commands == #fromWebui.devices[1].commands, encodeJson(committed))
end

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
