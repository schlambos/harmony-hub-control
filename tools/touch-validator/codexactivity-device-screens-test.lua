-- LuaJIT tests for Touch device screens in payload/activity/codexactivity.lua:
-- CommitDeviceScreen (one device's screen, made, rebuilt or removed) and the
-- screens CommitHaDevices keeps for the Home Assistant devices it owns.
--
-- Same loading pattern as codexactivity-ha-devices-test.lua: stub the hub
-- modules, reach processRequest through discover()'s upvalues, and keep the
-- resources in an in-memory fake with etags. No hub is contacted and nothing
-- is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-device-screens-test.lua

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

local requestCounter = 0
local function request(op, fields)
  requestCounter = requestCounter + 1
  local raw = { id = "r" .. requestCounter, op = op }
  for key, value in pairs(fields) do raw[key] = value end
  return processRequest(encodeJson(raw))
end
local function screen(fields) return request("CommitDeviceScreen", fields) end
local function stored(name) return decodeJson(hub.files[name].text) end
local function screenOf(deviceId)
  for i, map in ipairs(stored("MapList").ButtonMaps) do
    if map.ButtonMapIdentifier == "16417Device" .. deviceId then return map, i end
  end
end

-- A hub with a Touch: one Logitech device screen, one activity screen.
local function touchMaps()
  return { ButtonMaps = {
    { __type = "RootButtonMap", ButtonMapIdentifier = "16414Root", ["ButtonMapId-"] = 40550459,
      ["SurfaceId-"] = 13151460, ["ButtonMapSurfaceId-"] = 13151460, ["RemoteId-"] = 12345678, Buttons = {} },
    { __type = "DeviceButtonMap", ButtonMapIdentifier = "16417Device200", ["ButtonMapId-"] = 46597140,
      ["DeviceId-"] = 200, ["SurfaceId-"] = 14551427, ["ButtonMapSurfaceId-"] = 14551427,
      ["RemoteId-"] = 12345678, Sequences = NULL, Buttons = {
        { __type = "SoftRemoteButton", ButtonId = 1604611466, FunctionGroupType = 0,
          MenuItem = { IndexInMenu = 0, MenuName = "Device.200" }, TextOnRemote = "Home",
          ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 200, CommandName = "Home" } },
      } },
    { __type = "ActivityButtonMap", ButtonMapIdentifier = "16417Activity1", ["ButtonMapId-"] = 52944093,
      ["ActivityId-"] = 1, ["SurfaceId-"] = 14551427, ["ButtonMapSurfaceId-"] = 14551427,
      ["RemoteId-"] = 12345678, Buttons = {
        { __type = "HardRemoteButton", ButtonId = 1878029700, ButtonKey = "VolumeUp",
          ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 100, CommandName = "VolumeUp" } },
      } },
  } }
end

local function ampCommands()
  local names = { "1", "PowerToggle", "VolumeUp", "VolumeDown", "Mute", "Return", "Display", "DmRewind", "InputTv" }
  local commands = {}
  for i, name in ipairs(names) do
    commands[i] = { ["Id-"] = 39000100 + i, Name = name, TransportType = 1, ProtocolId = 2,
      FunctionId = name == "PowerToggle" and 116 or NULL }
  end
  return commands
end

local function seedState(maps)
  return {
    DeviceList = { DevicesWithFeatures = {
      { Device = { ["Id-"] = 100, Name = "Amp", Transport = 1, Manufacturer = "Sony" },
        Commands = ampCommands(), DeviceFeatures = {} },
      { Device = { ["Id-"] = 200, Name = "TV", Transport = 1, Manufacturer = "LG" },
        Commands = { { ["Id-"] = 39000005, Name = "Home", TransportType = 1, ProtocolId = 2 } },
        DeviceFeatures = {} },
    } },
    ProtocolList = { Protocols = { { ["Id-"] = 2, Name = "Sony 12 Bit", __type = "IrProtocol" } } },
    ActivityList = { Activities = { { ["Id-"] = 1, Name = "Listen", Roles = {
      { ["DeviceId-"] = 100, __type = "VolumeActivityRole" } } } } },
    MapList = maps or touchMaps(),
    FunctionList = { FunctionMaps = { { __type = "ActivityFunctionMap", ["ActivityId-"] = 1, FunctionGroups = {} } } },
  }
end

-- Refusals --------------------------------------------------------------------
resetHub(seedState())
local refusals = {
  { "a deviceId that is not a number", { deviceId = "amp" } },
  { "a device the hub doesn't have", { deviceId = "300" } },
  { "rebuilding a screen Logitech made", { deviceId = "200" } },
  { "removing a screen Logitech made", { deviceId = "200", remove = true } },
}
for _, case in ipairs(refusals) do
  local response = screen(case[2])
  check("refuses " .. case[1], response.ok == false and #hub.saves == 0 and #hub.messages == 0,
    response.error)
end
hub.blocker = "0\n"
local blocked = screen({ deviceId = "100" })
check("refuses while the cloud blocker is off", blocked.ok == false and #hub.saves == 0, blocked.error)
hub.blocker = "1\n"

resetHub(seedState({ ButtonMaps = { touchMaps().ButtonMaps[1] } }))
local noTouch = screen({ deviceId = "100" })
check("refuses on a hub with no Touch screens",
  noTouch.ok == false and noTouch.error:find("no Harmony Touch", 1, true) and #hub.saves == 0, noTouch.error)

-- A dry run plans without writing ---------------------------------------------
resetHub(seedState())
local plan = screen({ deviceId = "100", dryRun = true })
check("a dry run reports the keys and buttons it would make",
  plan.ok and plan.dryRun and plan.changed and plan.onScreen == 5 and
    table.concat(plan.hardKeys, ",") == "VolumeUp,VolumeDown,VolumeMute,PrevChannel" and
    #hub.saves == 0 and hub.published == 0,
  encodeJson(plan))

-- Making a screen ---------------------------------------------------------------
local before = { maps = hub.files.MapList.etag, devices = hub.files.DeviceList.etag,
  activities = hub.files.ActivityList.etag }
local made = screen({ deviceId = "100" })
check("makes the screen", made.ok and made.changed and made.reloaded, encodeJson(made))
check("saves only MapList, with a new etag",
  table.concat(hub.saves, ",") == "MapList" and hub.files.MapList.etag ~= before.maps and
    hub.files.DeviceList.etag == before.devices and hub.files.ActivityList.etag == before.activities,
  table.concat(hub.saves, ","))
check("reloads MapList and publishes a new revision",
  hub.messages[1] == "MapList" and hub.published == 1 and made.configVersion == digest.configVersion,
  hub.messages[1])

local map, at = screenOf(100)
check("the screen sits after the other device screens", at == 3, at)
check("the screen is a device map for the device",
  map and map.__type == "DeviceButtonMap" and map["DeviceId-"] == 100 and map.Sequences == NULL)
check("the screen copies the Touch's surface and remote",
  map["SurfaceId-"] == 14551427 and map["ButtonMapSurfaceId-"] == 14551427 and map["RemoteId-"] == 12345678)
check("the screen has a new map ID above Logitech's", map["ButtonMapId-"] == 52944094, map["ButtonMapId-"])

local soft, hard, ids, idsOk = {}, {}, {}, true
for _, button in ipairs(map.Buttons) do
  idsOk = idsOk and type(button.ButtonId) == "number" and button.ButtonId > 1878029713 and not ids[button.ButtonId]
  ids[button.ButtonId] = true
  if button.__type == "SoftRemoteButton" then soft[#soft + 1] = button else hard[#hard + 1] = button end
end
check("every button has its own new ID above Logitech's", idsOk)
local slotsOk = #soft == 5
for i, button in ipairs(soft) do
  slotsOk = slotsOk and button.MenuItem.IndexInMenu == i - 1 and button.MenuItem.MenuName == "Device.100" and
    button.FunctionGroupType == 0 and button.TextOnRemote == button.ButtonAction.CommandName and
    button.ButtonAction.EventType == 0 and button.ButtonAction["DeviceId-"] == 100
end
check("on-screen buttons take one slot each, in the device's order, labelled by command", slotsOk)
local softNames = {}
for _, button in ipairs(soft) do softNames[#softNames + 1] = button.TextOnRemote end
check("commands on hard keys stay off the screen, digits stay on it",
  table.concat(softNames, ",") == "1,PowerToggle,Display,DmRewind,InputTv",
  table.concat(softNames, ","))
check("the power command keeps its function ID", soft[2].ButtonAction["FunctionId-"] == 116 and
  soft[1].ButtonAction["FunctionId-"] == 0)
local keys = {}
for _, button in ipairs(hard) do keys[button.ButtonKey] = button.ButtonAction end
check("hard keys take commands named exactly as one of the wizard's aliases",
  keys.VolumeUp.CommandName == "VolumeUp" and keys.VolumeMute.CommandName == "Mute" and
    keys.PrevChannel.CommandName == "Return" and keys.Rewind == nil and
    keys.VolumeUp.EventType == 1)
check("other maps are left alone", stored("MapList").ButtonMaps[2].Buttons[1].TextOnRemote == "Home" and
  #stored("MapList").ButtonMaps == 4)

-- The same screen again changes nothing ----------------------------------------
local savesBefore = #hub.saves
local again = screen({ deviceId = "100" })
check("rebuilding an unchanged device saves nothing",
  again.ok and again.changed == false and #hub.saves == savesBefore and hub.published == 1, encodeJson(again))

-- A rebuild keeps IDs ---------------------------------------------------------
local devices = stored("DeviceList")
table.insert(devices.DevicesWithFeatures[1].Commands, 3,
  { ["Id-"] = 39000200, Name = "Sleep", TransportType = 1, ProtocolId = 2 })
hub.files.DeviceList.text = encodeJson(devices)
local oldIds = {}
for _, button in ipairs(map.Buttons) do oldIds[button.ButtonKey or button.TextOnRemote] = button.ButtonId end
local rebuilt = screen({ deviceId = "100" })
local newMap = screenOf(100)
local kept, sleepSlot = newMap["ButtonMapId-"] == map["ButtonMapId-"], nil
for _, button in ipairs(newMap.Buttons) do
  local name = button.ButtonKey or button.TextOnRemote
  if oldIds[name] then kept = kept and button.ButtonId == oldIds[name] end
  if name == "Sleep" then sleepSlot = button.MenuItem.IndexInMenu end
end
check("a rebuild keeps the map and button IDs and adds the new command",
  rebuilt.ok and rebuilt.changed and kept and sleepSlot == 2 and rebuilt.onScreen == 6, encodeJson(rebuilt))

-- Removing a screen -------------------------------------------------------------
local removed = screen({ deviceId = "100", remove = true })
check("removes the screen", removed.ok and removed.removed and screenOf(100) == nil and
  #stored("MapList").ButtonMaps == 3 and hub.messages[#hub.messages] == "MapList", encodeJson(removed))
savesBefore = #hub.saves
local removedAgain = screen({ deviceId = "100", remove = true })
check("removing a missing screen saves nothing",
  removedAgain.ok and removedAgain.changed == false and #hub.saves == savesBefore, encodeJson(removedAgain))

-- Failures roll back -------------------------------------------------------------
local mapsBefore = { etag = hub.files.MapList.etag, text = hub.files.MapList.text }
hub.failSave = "MapList"
local failed = screen({ deviceId = "100" })
check("a failed save restores MapList",
  failed.ok == false and failed.rolledBack == true and hub.files.MapList.etag == mapsBefore.etag and
    hub.files.MapList.text == mapsBefore.text, encodeJson(failed))
hub.configNewResult = false
local rejected = screen({ deviceId = "100" })
hub.configNewResult = true
check("a reload the engine rejects restores MapList",
  rejected.ok == false and rejected.rolledBack == true and hub.files.MapList.etag == mapsBefore.etag and
    screenOf(100) == nil, encodeJson(rejected))

-- Home Assistant devices get screens with the device set ------------------------
local WEBHOOK = "http://ha.example:8123/api/webhook/melodious-test"
local function lamp(commands)
  local list = {}
  for i, name in ipairs(commands or { "PowerOn", "PowerOff", "BrightnessUp", "BrightnessDown" }) do
    list[i] = { name = name, value = string.lower(name) }
  end
  return { entity = "light.kitchen", name = "Kitchen", commands = list, power = { on = "PowerOn", off = "PowerOff" } }
end
local function ha(devices, dryRun)
  return request("CommitHaDevices", { set = { webhook = WEBHOOK, devices = devices }, dryRun = dryRun })
end

resetHub(seedState())
local added = ha({ lamp() })
local lampId = added.devices and added.devices[1].deviceId
local lampMap = lampId and screenOf(lampId)
check("a new Home Assistant device gets a screen",
  added.ok and added.screensChanged and lampMap ~= nil, encodeJson(added))
check("the screen is saved after the device and reloaded with it",
  table.concat(hub.saves, ",") == "ProtocolList,DeviceList,MapList" and
    hub.messages[1] == "DeviceList,ProtocolList,MapList", table.concat(hub.saves, ","))
local lampKeys, lampSoft = {}, {}
for _, button in ipairs(lampMap and lampMap.Buttons or {}) do
  if button.ButtonKey then lampKeys[button.ButtonKey] = button.ButtonAction.CommandName
  else lampSoft[#lampSoft + 1] = button.TextOnRemote end
end
check("a lamp's brightness is on the volume keys and power is on screen",
  lampKeys.VolumeUp == "BrightnessUp" and lampKeys.VolumeDown == "BrightnessDown" and
    lampKeys.DirectionRight == nil and table.concat(lampSoft, ",") == "PowerOn,PowerOff",
  encodeJson(lampKeys))

savesBefore = #hub.saves
local same = ha({ lamp() })
check("the same set again saves nothing", same.ok and same.changed == false and #hub.saves == savesBefore,
  encodeJson(same))

local fewer = ha({ lamp({ "PowerOn", "PowerOff", "BrightnessUp" }) })
local fewerMap = screenOf(lampId)
check("dropping a command only its own screen uses is allowed, and the screen follows",
  fewer.ok and fewer.screensChanged and #fewerMap.Buttons == 3 and
    fewerMap["ButtonMapId-"] == lampMap["ButtonMapId-"], fewer.error or encodeJson(fewerMap))

local maps = stored("MapList")
maps.ButtonMaps[4].Buttons[2] = { __type = "HardRemoteButton", ButtonId = 1878029701, ButtonKey = "VolumeMute",
  ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = tonumber(lampId), CommandName = "PowerOn" } }
hub.files.MapList.text = encodeJson(maps)
savesBefore = #hub.saves
local inUse = ha({})
check("a device an activity button uses is retained with its screen intact",
  inUse.ok == true and inUse.changed == false and #inUse.retained == 1 and
    inUse.retained[1].name == "Kitchen" and
    table.concat(inUse.retained[1].usedBy, ",") == "MapList" and
    screenOf(lampId) ~= nil and #hub.saves == savesBefore,
  encodeJson(inUse))
local withNew = ha({ {
  entity = "script.movie",
  name = "Movie",
  commands = { { name = "Run", value = "turn_on" } },
} })
local movieId = withNew.devices and withNew.devices[1] and withNew.devices[1].deviceId
check("adding another device while Kitchen is retained builds the new screen and keeps Kitchen's",
  withNew.ok == true and withNew.changed == true and withNew.added[1] == "Movie" and
    #withNew.retained == 1 and withNew.retained[1].name == "Kitchen" and
    screenOf(lampId) ~= nil and movieId ~= nil and screenOf(movieId) ~= nil,
  encodeJson(withNew))
maps = stored("MapList")
for _, m in ipairs(maps.ButtonMaps) do
  if m.__type == "ActivityButtonMap" then m.Buttons[2] = nil end
end
hub.files.MapList.text = encodeJson(maps)

local cleared = ha({})
check("removing devices removes their screens",
  cleared.ok and #cleared.removed == 2 and screenOf(lampId) == nil and screenOf(movieId) == nil and
    #stored("MapList").ButtonMaps == 3 and hub.messages[#hub.messages] == "DeviceList,ProtocolList,MapList",
  cleared.error or encodeJson(cleared))

resetHub(seedState({ ButtonMaps = { touchMaps().ButtonMaps[1] } }))
local noTouchHa = ha({ lamp() })
check("a hub without a Touch gets the device and no screen",
  noTouchHa.ok and noTouchHa.screensChanged == false and table.concat(hub.saves, ",") == "ProtocolList,DeviceList" and
    hub.messages[1] == "DeviceList,ProtocolList", encodeJson(noTouchHa))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
