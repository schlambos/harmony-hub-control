-- LuaJIT tests for the network TV device writer (CommitAndroidTvDevices) in
-- payload/activity/codexactivity.lua: Android/Google TVs that codex_androidtv
-- drives. The writer shares CommitHaDevices' code; these checks cover what
-- differs (fixed command set, fixed local URL, its own tag and protocol) and
-- that the two families never touch each other's devices.
--
-- Same loading pattern as codexactivity-validate-test.lua: stub the hub
-- modules, reach processRequest through discover()'s upvalues. The resource
-- manager is an in-memory fake that keeps etags like the hub's index, so the
-- tests can tell what the Touch would pull. No hub is contacted and nothing
-- is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-androidtv-devices-test.lua

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


local HA_WEBHOOK = "http://ha.example:8123/api/webhook/melodious-test"

local function seedState()
  return {
    DeviceList = { DevicesWithFeatures = {
      { Device = { ["Id-"] = 100, Name = "Receiver", Transport = 1, Manufacturer = "Denon" },
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

local requestCounter = 0
local function commit(op, set, dryRun)
  requestCounter = requestCounter + 1
  return processRequest(encodeJson({ id = "r" .. requestCounter, op = op, set = set, dryRun = dryRun }))
end
local function androidtv(set, dryRun) return commit("CommitAndroidTvDevices", set, dryRun) end

local function stored(name) return decodeJson(hub.files[name].text) end

local function entryTagged(prefix)
  local out = {}
  for _, entry in ipairs(stored("DeviceList").DevicesWithFeatures) do
    local id = entry.Device.AutoDetectedDevice and entry.Device.AutoDetectedDevice.Id
    if type(id) == "string" and string.sub(id, 1, #prefix) == prefix then out[#out + 1] = entry end
  end
  return out
end

local function protocolNamed(name)
  for _, protocol in ipairs(stored("ProtocolList").Protocols) do
    if protocol.Name == name then return protocol end
  end
end

local function featureOf(entry, kind)
  for _, feature in ipairs(entry.DeviceFeatures) do
    if feature.__type == kind then return feature end
  end
end

local TV = { entity = "androidtv1a2b3c4d", name = "Game Room TV", manufacturer = "Hisense", model = "75U8H" }

-- Rejected sets ------------------------------------------------------------
resetHub(seedState())
local bad = androidtv({ devices = { { entity = "light.kitchen", name = "Lamp" } } })
check("refuses an id that isn't a codex_androidtv TV id", bad.ok == false and bad.error:find("paired TV id") ~= nil, bad.error)
local quote = androidtv({ devices = { { entity = "androidtv1a2b3c4d", name = 'Joe"s TV' } } })
check("refuses a name with quotes", quote.ok == false, quote.error)
local twice = androidtv({ devices = { TV, TV } })
check("refuses the same TV twice", twice.ok == false, twice.error)
check("nothing was saved by a refused set", #hub.saves == 0)

-- Adding a TV ----------------------------------------------------------------
local added = androidtv({ devices = { TV } })
check("adds the TV", added.ok and added.changed and added.added[1] == "Game Room TV", encodeJson(added))
local tvs = entryTagged("melodious-androidtv-")
check("one device carries the network TV tag", #tvs == 1, #tvs)
local entry = tvs[1]
local device = entry.Device
check("it is an IP-only Television", device.Transport == 64 and device.DeviceTypeDisplayName == "Television" and
  device.DeviceType == 1, encodeJson({ device.Transport, device.DeviceTypeDisplayName, device.DeviceType }))
check("it keeps the manufacturer and model it was given", device.Manufacturer == "Hisense" and device.Model == "75U8H")
check("its {d} token is the codex_androidtv id",
  device.Tokens.Parameters[1].Key == "{d}" and device.Tokens.Parameters[1].Value == "androidtv1a2b3c4d")
check("its uid is the tag plus its device id", device.AutoDetectedDevice.Id == "melodious-androidtv-" .. tostring(device["Id-"]))

local names, valuesOk, rawOk = {}, true, true
for _, command in ipairs(entry.Commands) do
  names[command.Name] = true
  valuesOk = valuesOk and command.TransportType == 64 and command.Parameters[1].Key == "{c}" and
    command.Parameters[1].Value == command.Name
end
check("it has the fixed command set (51 commands)", #entry.Commands == 51, #entry.Commands)
check("the command set covers power, navigation, volume and HDMI inputs",
  names.PowerOn and names.PowerOff and names.DirectionUp and names.Select and names.VolumeUp and
    names.Mute and names.InputHdmi1 and names.InputHdmi4 and names.Number9 and names.Home and names.Back)
check("each command sends its own name in {c}", valuesOk)
check("Raw is written as null on every command",
  not hub.files.DeviceList.text:find('"Name":"PowerOn"[^}]*"Raw"') or hub.files.DeviceList.text:find('"Raw":null') ~= nil)

local protocol = protocolNamed("Melodious Android TV")
check("one protocol posts to codex_androidtv on the hub itself",
  protocol and protocol.ControlSection.Url == "http://127.0.0.1:8095/cmd" and protocol.ControlSection.Method == "POST" and
    protocol.ControlSection.Body == '{"device":"{d}","command":"{c}"}', encodeJson(protocol and protocol.ControlSection))
check("the protocol loads as an IR protocol",
  protocol.__type == "IrProtocol" and protocol.CarrierFrequency == 38000 and type(protocol.IRSegments) == "table")
local power = featureOf(entry, "PowerFeature")
check("power is discrete PowerOn / PowerOff", power and power.PowerTypeId == 1 and
  power.PowerOnActions[1].IRCommandName == "PowerOn" and power.PowerOffActions[1].IRCommandName == "PowerOff",
  encodeJson(power))
local input = featureOf(entry, "InputFeature")
local inputNames = {}
for _, i in ipairs(input and input.Inputs or {}) do inputNames[#inputNames + 1] = i.InputName end
check("inputs are HDMI 1-4", table.concat(inputNames, ",") == "HDMI 1,HDMI 2,HDMI 3,HDMI 4", table.concat(inputNames, ","))
check("other devices are left alone", stored("DeviceList").DevicesWithFeatures[1].Device.Name == "Receiver")

-- The same set again changes nothing; a rename keeps every ID ------------------
local again = androidtv({ devices = { TV } })
check("the same set again saves nothing", again.ok and again.changed == false, encodeJson(again))
local ids = {}
for _, c in ipairs(entry.Commands) do ids[c.Name] = c["Id-"] end
local renamed = androidtv({ devices = { { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H" } } })
local after = entryTagged("melodious-androidtv-")[1]
local sameIds = after.Device["Id-"] == device["Id-"]
for _, c in ipairs(after.Commands) do sameIds = sameIds and ids[c.Name] == c["Id-"] end
check("a rename keeps device and command IDs", renamed.ok and after.Device.Name == "Den TV" and sameIds, encodeJson(renamed))

-- The two families keep to their own devices ---------------------------------
local ha = commit("CommitHaDevices", { webhook = HA_WEBHOOK, devices = { {
  entity = "light.kitchen", name = "Kitchen", commands = { { name = "PowerOn", value = "turn_on" },
    { name = "PowerOff", value = "turn_off" } }, power = { on = "PowerOn", off = "PowerOff" } } } })
check("a Home Assistant device can be added next to it", ha.ok and ha.added[1] == "Kitchen", encodeJson(ha))
check("the Home Assistant commit kept the network TV", #entryTagged("melodious-androidtv-") == 1 and
  protocolNamed("Melodious Android TV") ~= nil)
local onlyTvs = androidtv({ devices = {} })
check("removing the network TVs keeps the Home Assistant device and protocol",
  onlyTvs.ok and onlyTvs.removed[1] == "Den TV" and #entryTagged("melodious-androidtv-") == 0 and
    #entryTagged("melodious-ha-") == 1 and protocolNamed("Melodious Home Assistant") ~= nil and
    protocolNamed("Melodious Android TV") == nil, encodeJson(onlyTvs))
local haStill = commit("CommitHaDevices", { webhook = HA_WEBHOOK, devices = { {
  entity = "light.kitchen", name = "Kitchen", commands = { { name = "PowerOn", value = "turn_on" },
    { name = "PowerOff", value = "turn_off" } }, power = { on = "PowerOn", off = "PowerOff" } } } })
check("the Home Assistant set is unchanged by it", haStill.ok and haStill.changed == false, encodeJson(haStill))

-- A TV in an activity can't be removed -----------------------------------------
local back = androidtv({ devices = { TV } })
local tvId = tonumber(back.devices[1].deviceId)
local activities = stored("ActivityList")
activities.Activities[1].Roles[#activities.Activities[1].Roles + 1] = { ["DeviceId-"] = tvId, __type = "DisplayActivityRole" }
hub.files.ActivityList.text = encodeJson(activities)
local inUse = androidtv({ devices = {} })
check("refuses to remove a TV an activity uses", inUse.ok == false and inUse.error:find("still used") ~= nil, inUse.error)
check("the name clash with another device is refused",
  androidtv({ devices = { TV, { entity = "androidtv99887766", name = "Receiver" } } }).ok == false)

-- Inputs: the Settings page sends a TV's inputs, each a slot command -------------
resetHub(seedState())
androidtv({ devices = { TV } })
local function tvEntry() return entryTagged("melodious-androidtv-")[1] end
local function inputsOf(e)
  local feature = featureOf(e, "InputFeature")
  if not feature then return "none" end
  local out = {}
  for _, input in ipairs(feature.Inputs) do
    out[#out + 1] = input.InputOrder .. ":" .. input.InputName .. "=" .. input.Actions[1].IRCommandName
  end
  return table.concat(out, ",")
end
local function hasCommand(e, name)
  for _, c in ipairs(e.Commands) do if c.Name == name then return c end end
end
local withInputs = { entity = TV.entity, name = TV.name, manufacturer = TV.manufacturer, model = TV.model,
  inputDelay = 500, inputs = {
    { name = "Shield", command = "InputHdmi2" }, { name = "Xbox", command = "inputhdmi3" },
    { name = "Live TV", command = "Input6" } } }
local saved = androidtv({ devices = { withInputs } })
local e = tvEntry()
check("a TV's inputs are saved with their names, order and slot commands", saved.ok and
  inputsOf(e) == "1:Shield=InputHdmi2,2:Xbox=InputHdmi3,3:Live TV=Input6", inputsOf(e))
check("the input delay is saved", featureOf(e, "InputFeature").InputDelay == 500)
check("an input's slot command beyond HDMI 4 joins the commands (Input6)",
  hasCommand(e, "Input6") ~= nil and #e.Commands == 52 and hasCommand(e, "Input6").Parameters[1].Value == "Input6", #e.Commands)
local input6Id = hasCommand(e, "Input6")["Id-"]
local renamedAgain = androidtv({ devices = { { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H" } } })
e = tvEntry()
check("a commit without inputs (a rename) keeps them, their delay and Input6", renamedAgain.ok and
  inputsOf(e) == "1:Shield=InputHdmi2,2:Xbox=InputHdmi3,3:Live TV=Input6" and
  featureOf(e, "InputFeature").InputDelay == 500 and hasCommand(e, "Input6")["Id-"] == input6Id, inputsOf(e))
local reordered = androidtv({ devices = { { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H",
  inputs = { { name = "Live TV", command = "Input6" }, { name = "Shield", command = "InputHdmi2" } } } } })
e = tvEntry()
check("reordering keeps each input's slot and Input6's command ID", reordered.ok and
  inputsOf(e) == "1:Live TV=Input6,2:Shield=InputHdmi2" and hasCommand(e, "Input6")["Id-"] == input6Id, inputsOf(e))
local dropped = androidtv({ devices = { { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H",
  inputs = { { name = "Shield", command = "InputHdmi2" } } } } })
e = tvEntry()
check("removing the input that used Input6 removes the command", dropped.ok and hasCommand(e, "Input6") == nil and
  #e.Commands == 51 and hasCommand(e, "InputHdmi4") ~= nil, #e.Commands)
local function refused(inputs, extra)
  local d = { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H", inputs = inputs }
  for k, v in pairs(extra or {}) do d[k] = v end
  return androidtv({ devices = { d } })
end
local r1 = refused({ { name = "Menu", command = "InputNext" } })
check("an input must use a slot command, not another command", r1.ok == false and r1.error:find("slot command") ~= nil, r1.error)
local r2 = refused({ { name = "A", command = "Input5" }, { name = "B", command = "input5" } })
check("two inputs can't share a slot", r2.ok == false and r2.error:find("two inputs") ~= nil, r2.error)
local r3 = refused({ { name = "A", command = "Input33" } })
check("Input33 is past the last slot", r3.ok == false, r3.error)
local r4 = refused({ { name = "A", command = "InputHdmi1" }, { name = "a", command = "InputHdmi2" } })
check("input names are unique, ignoring case", r4.ok == false and r4.error:find("twice") ~= nil, r4.error)
local r5 = refused({ { name = "A", command = "InputHdmi1" } }, { inputDelay = 70000 })
check("the input delay is 0-60000 ms", r5.ok == false and r5.error:find("inputDelay") ~= nil, r5.error)
check("refused input lists change nothing", inputsOf(tvEntry()) == "1:Shield=InputHdmi2")
local none = androidtv({ devices = { { entity = TV.entity, name = "Den TV", manufacturer = "Hisense", model = "75U8H", inputs = {} } } })
check("an empty input list is \"don't switch inputs\" (no input feature)", none.ok and inputsOf(tvEntry()) == "none")
androidtv({ devices = { { entity = TV.entity, name = "Den", manufacturer = "Hisense", model = "75U8H" } } })
check("and a later commit without inputs keeps it that way", inputsOf(tvEntry()) == "none")
androidtv({ devices = { withInputs } })
local tvDeviceId = tonumber(tvEntry().Device["Id-"])
local acts = stored("ActivityList")
acts.Activities[1].Roles[#acts.Activities[1].Roles + 1] = { ["DeviceId-"] = tvDeviceId, __type = "DisplayActivityRole",
  SelectedInput = { Name = "Xbox" } }
hub.files.ActivityList.text = encodeJson(acts)
local usedInput = refused({ { name = "Shield", command = "InputHdmi2" } })
check("an input an activity switches to can't be removed", usedInput.ok == false and usedInput.error:find("Xbox") ~= nil,
  usedInput.error)
local renamedInput = refused({ { name = "Shield", command = "InputHdmi2" }, { name = "Xbox", command = "Input7" } })
check("but it may move to another slot", renamedInput.ok and hasCommand(tvEntry(), "Input7") ~= nil and
  hasCommand(tvEntry(), "Input6") == nil, renamedInput.error)

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
