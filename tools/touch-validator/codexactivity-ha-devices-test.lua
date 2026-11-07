-- LuaJIT tests for the Home Assistant device writer (CommitHaDevices) in
-- payload/activity/codexactivity.lua.
--
-- Same loading pattern as codexactivity-validate-test.lua: stub the hub
-- modules, reach processRequest through discover()'s upvalues. The resource
-- manager is an in-memory fake that keeps etags like the hub's index, so the
-- tests can tell what the Touch would pull. No hub is contacted and nothing
-- is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-ha-devices-test.lua

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

local WEBHOOK = "http://ha.example:8123/api/webhook/melodious-test"

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

local function lamp(extra)
  local device = {
    entity = "light.kitchen",
    name = "Kitchen",
    commands = {
      { name = "PowerOn", value = "turn_on" },
      { name = "PowerOff", value = "turn_off" },
      { name = "InputHdmi1", value = "select_source:HDMI 1" },
    },
    power = { on = "PowerOn", off = "PowerOff" },
    inputs = { { name = "HDMI 1", command = "InputHdmi1" } },
  }
  for key, value in pairs(extra or {}) do device[key] = value end
  return device
end

local requestCounter = 0
local function commit(set, dryRun)
  requestCounter = requestCounter + 1
  local raw = encodeJson({ id = "r" .. requestCounter, op = "CommitHaDevices", set = set, dryRun = dryRun })
  local response = processRequest(raw)
  return response
end

local function stored(name) return decodeJson(hub.files[name].text) end

local function haEntry()
  for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
    if entry.Device.Manufacturer == "Home Assistant" then return entry end
  end
end

local function haProtocol()
  for _, protocol in ipairs(stored("ProtocolList").Protocols) do
    if protocol.Name == "Melodious Home Assistant" then return protocol end
  end
end

local function featureOf(entry, kind)
  for _, feature in ipairs(entry.DeviceFeatures) do
    if feature.__type == kind then return feature end
  end
end

-- Rejected sets ------------------------------------------------------------
resetHub(seedState())
local rejects = {
  { "no webhook", { devices = { lamp() } } },
  { "https webhook", { webhook = "https://ha.example/api/webhook/x", devices = { lamp() } } },
  { "webhook with a placeholder", { webhook = "http://ha.example/api/webhook/{d}", devices = { lamp() } } },
  { "bad entity", { webhook = WEBHOOK, devices = { lamp({ entity = "Kitchen Light" }) } } },
  { "quote in a value", { webhook = WEBHOOK, devices = { lamp({ commands = { { name = "A", value = 'a"b' } }, power = NULL, inputs = NULL }) } } },
  { "percent in a value", { webhook = WEBHOOK, devices = { lamp({ commands = { { name = "A", value = "50%" } }, power = NULL, inputs = NULL }) } } },
  { "brace in a value", { webhook = WEBHOOK, devices = { lamp({ commands = { { name = "A", value = "{d}" } }, power = NULL, inputs = NULL }) } } },
  { "command listed twice", { webhook = WEBHOOK, devices = { lamp({ commands = {
    { name = "PowerOn", value = "a" }, { name = "poweron", value = "b" } }, power = NULL, inputs = NULL }) } } },
  { "power names a missing command", { webhook = WEBHOOK, devices = { lamp({ power = { on = "PowerOn", off = "Nope" } }) } } },
  { "input names a missing command", { webhook = WEBHOOK, devices = { lamp({ inputs = { { name = "HDMI 2", command = "Nope" } } }) } } },
  { "entity listed twice", { webhook = WEBHOOK, devices = { lamp(), lamp({ name = "Other" }) } } },
  { "name taken by another device", { webhook = WEBHOOK, devices = { lamp({ name = "tv" }) } } },
}
for _, case in ipairs(rejects) do
  local response = commit(case[2])
  check("rejects " .. case[1], response.ok == false and #hub.saves == 0 and #hub.messages == 0,
    response.error)
end

hub.blocker = "0\n"
local blocked = commit({ webhook = WEBHOOK, devices = { lamp() } })
check("refuses while the cloud blocker is off", blocked.ok == false and #hub.saves == 0, blocked.error)
hub.blocker = "1\n"

-- A dry run plans without writing -------------------------------------------
local plan = commit({ webhook = WEBHOOK, devices = { lamp() } }, true)
check("a dry run reports the device it would add",
  plan.ok and plan.dryRun and plan.changed and plan.added[1] == "Kitchen" and
    #hub.saves == 0 and #hub.messages == 0 and hub.published == 0,
  encodeJson(plan))

-- Adding a device -----------------------------------------------------------
local before = { devices = hub.files.DeviceList.etag, protocols = hub.files.ProtocolList.etag }
local added = commit({ webhook = WEBHOOK, devices = { lamp() } })
check("adds the device", added.ok and added.changed and added.added[1] == "Kitchen", encodeJson(added))
check("saves both lists with new etags",
  hub.files.DeviceList.etag ~= before.devices and hub.files.ProtocolList.etag ~= before.protocols)
check("saves the protocol before the device",
  hub.saves[1] == "ProtocolList" and hub.saves[2] == "DeviceList", table.concat(hub.saves, ","))
check("reloads DeviceList and ProtocolList", hub.messages[1] == "DeviceList,ProtocolList", hub.messages[1])
check("publishes a new revision", hub.published == 1 and digest.configVersion == 8 and
  added.configVersion == 8, digest.configVersion)

local entry = haEntry()
local protocol = haProtocol()
local device = entry and entry.Device or {}
local deviceId = device["Id-"]
check("the device is IP-only", device.Transport == 64)
check("the device has a uid the engine can clear",
  device.AutoDetectedDevice and device.AutoDetectedDevice.Id == "melodious-ha-" .. tostring(deviceId))
check("the device names its entity in {d}",
  device.Tokens and device.Tokens.Parameters[1].Key == "{d}" and
    device.Tokens.Parameters[1].Value == "light.kitchen")
check("the device has a new ID above every other", type(deviceId) == "number" and deviceId > 39000005,
  deviceId)
check("the device ID is its added device ID", added.devices[1].deviceId == tostring(deviceId))

local commandsOk = entry and #entry.Commands == 3
for _, command in ipairs(entry and entry.Commands or {}) do
  commandsOk = commandsOk and command.TransportType == 64 and command.Raw == NULL and
    command.KeyCode == "" and command.ProtocolId == protocol["Id-"] and
    command.Parameters[1].Key == "{c}"
end
check("each command is IP with Raw null and its value in {c}", commandsOk)
check("Raw is written as null, not left out",
  select(2, hub.files.DeviceList.text:gsub('"Raw":null', "")) == 3)
check("the input command carries its value",
  entry.Commands[3].Parameters[1].Value == "select_source:HDMI 1")

check("the protocol loads as an IR protocol",
  protocol and protocol.__type == "IrProtocol" and protocol.CarrierFrequency == 38000 and
    protocol.KeyCode == NULL and type(protocol.IRSegments) == "table" and
    type(protocol.CodeSegments) == "table")
local control = protocol and protocol.ControlSection or {}
check("the protocol posts to the webhook",
  control.Url == WEBHOOK and control.Method == "POST" and
    control.Body == '{"device":"{d}","command":"{c}"}' and
    decodeJson(control.Header)["Content-Type"] == "application/json")

local power = featureOf(entry, "PowerFeature")
check("power uses the on and off commands",
  power and power.PowerTypeId == 1 and power.PowerOnActions[1].IRCommandName == "PowerOn" and
    power.PowerOffActions[1].IRCommandName == "PowerOff")
local input = featureOf(entry, "InputFeature")
check("the input selects its command",
  input and input.Inputs[1].InputName == "HDMI 1" and
    input.Inputs[1].Actions[1].IRCommandName == "InputHdmi1")

local tv = stored("DeviceList").DevicesWithFeatures[1]
check("other devices are left alone", tv.Device.Name == "TV" and tv.Commands[1]["Id-"] == 39000005)
check("DeviceList keeps Device before Commands for codex_webui",
  hub.files.DeviceList.text:find('"Device":', 1, true) < hub.files.DeviceList.text:find('"Commands":', 1, true))

-- The same set again changes nothing ----------------------------------------
local savesBefore, etagBefore = #hub.saves, hub.files.DeviceList.etag
local again = commit({ webhook = WEBHOOK, devices = { lamp() } })
check("the same set again saves nothing",
  again.ok and again.changed == false and again.unchanged[1] == "Kitchen" and
    #hub.saves == savesBefore and hub.files.DeviceList.etag == etagBefore and hub.published == 1,
  encodeJson(again))

-- Only the webhook changes --------------------------------------------------
local moved = commit({ webhook = "http://10.0.0.5:8123/api/webhook/other", devices = { lamp() } })
check("a new webhook saves only ProtocolList",
  moved.ok and moved.changed and hub.saves[#hub.saves] == "ProtocolList" and
    hub.files.DeviceList.etag == etagBefore and haProtocol().ControlSection.Url:find("10.0.0.5", 1, true),
  table.concat(hub.saves, ","))

-- Updating keeps IDs --------------------------------------------------------
local oldIds = {}
for _, command in ipairs(haEntry().Commands) do oldIds[command.Name] = command["Id-"] end
local renamed = lamp({ name = "Kitchen lamp" })
renamed.commands[#renamed.commands + 1] = { name = "Dim", value = "brightness_step:-10" }
local updated = commit({ webhook = WEBHOOK, devices = { renamed } })
entry = haEntry()
local idsKept = entry.Device["Id-"] == deviceId
for _, command in ipairs(entry.Commands) do
  if oldIds[command.Name] then idsKept = idsKept and command["Id-"] == oldIds[command.Name] end
end
check("an update keeps the device and command IDs",
  updated.ok and updated.updated[1] == "Kitchen lamp" and idsKept and #entry.Commands == 4,
  encodeJson(updated))

-- Devices and commands in use are kept --------------------------------------
local activities = stored("ActivityList")
activities.Activities[1].Roles[2] = { ["DeviceId-"] = deviceId, __type = "VolumeActivityRole",
  SelectedInput = { Name = "HDMI 1" } }
hub.files.ActivityList.text = encodeJson(activities)
local maps = { ButtonMaps = { { __type = "ActivityButtonMap", Buttons = { { ButtonAction = {
  __type = "ButtonCommandAction", ["DeviceId-"] = deviceId, CommandName = "Dim" } } } } } }
hub.files.MapList.text = encodeJson(maps)
savesBefore = #hub.saves

local gone = commit({ webhook = WEBHOOK, devices = {} })
check("refuses to remove a device an activity uses",
  gone.ok == false and gone.error:find("still used by ActivityList, MapList", 1, true) and
    #hub.saves == savesBefore, gone.error)
local noDim = lamp({ name = "Kitchen lamp" })
local noDimResponse = commit({ webhook = WEBHOOK, devices = { noDim } })
check("refuses to drop a command a button uses",
  noDimResponse.ok == false and noDimResponse.error:find("dim", 1, true) and #hub.saves == savesBefore,
  noDimResponse.error)
local noInput = lamp({ name = "Kitchen lamp", inputs = NULL })
noInput.commands[#noInput.commands + 1] = { name = "Dim", value = "x" }
local noInputResponse = commit({ webhook = WEBHOOK, devices = { noInput } })
check("refuses to drop an input an activity selects",
  noInputResponse.ok == false and noInputResponse.error:find("HDMI 1", 1, true) and
    #hub.saves == savesBefore, noInputResponse.error)

-- A failed save rolls back --------------------------------------------------
hub.files.ActivityList.text = encodeJson(seedState().ActivityList)
hub.files.MapList.text = encodeJson({ ButtonMaps = {} })
local protocolBefore = { etag = hub.files.ProtocolList.etag, text = hub.files.ProtocolList.text }
local deviceBefore = hub.files.DeviceList.text
hub.failSave = "DeviceList"
local failed = commit({ webhook = WEBHOOK, devices = {} })
check("a failed DeviceList save restores ProtocolList",
  failed.ok == false and failed.rolledBack == true and
    hub.files.ProtocolList.etag == protocolBefore.etag and
    hub.files.ProtocolList.text == protocolBefore.text and hub.files.DeviceList.text == deviceBefore,
  encodeJson(failed))

hub.configNewResult = false
local rejected = commit({ webhook = WEBHOOK, devices = {} })
hub.configNewResult = true
check("a reload the engine rejects restores both lists",
  rejected.ok == false and rejected.rolledBack == true and haEntry() ~= nil and haProtocol() ~= nil,
  encodeJson(rejected))

-- Removing every device removes the protocol too ----------------------------
local cleared = commit({ webhook = WEBHOOK, devices = {} })
check("an empty set removes the devices and the protocol",
  cleared.ok and cleared.removed[1] == "Kitchen lamp" and haEntry() == nil and haProtocol() == nil and
    #stored("DeviceList").DevicesWithFeatures == 1 and #stored("ProtocolList").Protocols == 1,
  encodeJson(cleared))
local clearedAgain = commit({ devices = {} })
check("an empty set needs no webhook and is a no-op the second time",
  clearedAgain.ok and clearedAgain.changed == false, encodeJson(clearedAgain))

-- Unreadable requests still answer with their id ----------------------------
local broken = processRequest('{"id":"x42","op":"CommitHaDevices","set":{')
check("a request that is not JSON is answered with its id",
  broken.ok == false and broken.id == "x42", encodeJson(broken))

-- Spec v2: one Harmony device from N entities ------------------------------
local function merged(extra)
  local device = {
    key = "media_player.living_room_tv",
    name = "Living Room TV",
    model = "Google TV",
    entities = {
      { alias = "media_player.living_room_tv", entity = "media_player.living_room_tv" },
      { alias = "remote.living_room_tv", entity = "remote.living_room_tv" },
    },
    commands = {
      { name = "PowerOn", value = "media_player.living_room_tv:turn_on" },
      { name = "PowerOff", value = "media_player.living_room_tv:turn_off" },
      { name = "DirectionUp", value = "remote.living_room_tv:send_command:DPAD_UP" },
    },
    power = { on = "PowerOn", off = "PowerOff" },
    inputs = {},
  }
  for key, value in pairs(extra or {}) do device[key] = value end
  return device
end

resetHub(seedState())
local v2rejects = {
  { "unknown alias in a v2 value", { webhook = WEBHOOK, devices = { merged({ commands = {
    { name = "PowerOn", value = "media_player.other:turn_on" } }, power = NULL }) } } },
  { "v2 value without an action", { webhook = WEBHOOK, devices = { merged({ commands = {
    { name = "PowerOn", value = "media_player.living_room_tv:" } }, power = NULL }) } } },
  { "v2 entities listed twice", { webhook = WEBHOOK, devices = { merged({ entities = {
    { alias = "media_player.living_room_tv", entity = "media_player.living_room_tv" },
    { alias = "media_player.living_room_tv", entity = "light.other" } } }) } } },
  { "v2 entity in two devices", { webhook = WEBHOOK, devices = {
    merged(), merged({ key = "media_player.other", name = "Other" }) } } },
}
for _, case in ipairs(v2rejects) do
  local response = commit(case[2])
  check("v2 rejects " .. case[1], response.ok == false and #hub.saves == 0, response.error)
end

local v2added = commit({ webhook = WEBHOOK, devices = { merged() } })
check("v2 adds the merged device",
  v2added.ok and v2added.changed and v2added.added[1] == "Living Room TV", encodeJson(v2added))
check("v2 reports the key and entities",
  v2added.devices[1].key == "media_player.living_room_tv" and
    #v2added.devices[1].entities == 2, encodeJson(v2added.devices[1]))
local v2entry
for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
  if entry.Device.Manufacturer == "Home Assistant" then v2entry = entry end
end
check("v2 stores the key in {d}",
  v2entry.Device.Tokens.Parameters[1].Value == "media_player.living_room_tv")
local v2deviceId = v2entry.Device["Id-"]
check("v2 keeps {c} values opaque",
  v2entry.Commands[3].Parameters[1].Value == "remote.living_room_tv:send_command:DPAD_UP")

-- v1 -> v2 migration preserves the device and command IDs -------------------
local oldIds = {}
for _, command in ipairs(v2entry.Commands) do oldIds[command.Name] = command["Id-"] end
resetHub(seedState())
local v1first = commit({ webhook = WEBHOOK, devices = { {
  entity = "media_player.living_room_tv", name = "Living Room TV",
  commands = {
    { name = "PowerOn", value = "turn_on" },
    { name = "DirectionUp", value = "send_command:DPAD_UP" },
  },
  power = { on = "PowerOn", off = "PowerOff" }, inputs = {},
} } })
local v1entry
for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
  if entry.Device.Manufacturer == "Home Assistant" then v1entry = entry end
end
local v1deviceId = v1entry.Device["Id-"]
local migrated = commit({ webhook = WEBHOOK, devices = { merged({
  commands = {
    { name = "PowerOn", value = "media_player.living_room_tv:turn_on" },
    { name = "PowerOff", value = "media_player.living_room_tv:turn_off" },
    { name = "DirectionUp", value = "remote.living_room_tv:send_command:DPAD_UP" },
  }, power = { on = "PowerOn", off = "PowerOff" } }) } })
local migratedEntry
for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
  if entry.Device.Manufacturer == "Home Assistant" then migratedEntry = entry end
end
check("v1->v2 keeps the device ID",
  migrated.ok and migratedEntry.Device["Id-"] == v1deviceId, encodeJson(migrated))
check("v1->v2 reports what it migrated",
  migrated.devices[1].migratedFrom == "media_player.living_room_tv", encodeJson(migrated.devices[1]))
check("v1->v2 re-sends the same {d} after migration",
  migratedEntry.Device.Tokens.Parameters[1].Value == "media_player.living_room_tv")

-- Absorbed referenced devices are retained -----------------------------------
local activities = stored("ActivityList")
local secondId
do
  local second = commit({ webhook = WEBHOOK, devices = { merged(), {
    entity = "remote.living_room_tv", name = "Living Room Remote",
    commands = { { name = "Press", value = "press" } }, power = NULL, inputs = {},
  } } })
  for _, device in ipairs(second.devices) do
    if device.name == "Living Room Remote" then secondId = device.deviceId end
  end
end
activities = stored("ActivityList")
activities.Activities[1].Roles[2] = { ["DeviceId-"] = tonumber(secondId), __type = "VolumeActivityRole" }
hub.files.ActivityList.text = encodeJson(activities)
local absorbed = commit({ webhook = WEBHOOK, devices = { merged({
  commands = {
    { name = "PowerOn", value = "media_player.living_room_tv:turn_on" },
    { name = "DirectionUp", value = "remote.living_room_tv:send_command:DPAD_UP" },
    { name = "Press", value = "remote.living_room_tv:press" },
  }, power = NULL }) } })
check("a referenced absorbed device is retained, not deleted",
  absorbed.ok and #absorbed.retained == 1 and
    absorbed.retained[1].name == "Living Room Remote", encodeJson(absorbed))
local stillThere = false
for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
  if tostring(entry.Device["Id-"]) == tostring(secondId) then stillThere = true end
end
check("the retained device is still in DeviceList", stillThere)
check("an unchanged v2 set saves nothing",
  commit({ webhook = WEBHOOK, devices = { merged({
    commands = {
      { name = "PowerOn", value = "media_player.living_room_tv:turn_on" },
      { name = "DirectionUp", value = "remote.living_room_tv:send_command:DPAD_UP" },
      { name = "Press", value = "remote.living_room_tv:press" },
    }, power = NULL }) } }).changed == false)

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
