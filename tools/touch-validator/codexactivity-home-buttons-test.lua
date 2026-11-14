-- LuaJIT tests for the Harmony Companion's home-control keys in
-- payload/activity/codexactivity.lua: the hook that keeps the MapList's
-- Ha1-Ha4 in the 16422Root map after the engine's AutomationConfig pass,
-- and the processButtonCommand wrapper (rocker aliases, "nothing" in an
-- activity, one fire per home-key press).
--
-- Same loading pattern as codexactivity-device-screens-test.lua: stub the
-- hub modules, here also the engine modules the hooks wrap, and reach the
-- local functions through the plugin's upvalues. No hub is contacted; the
-- only files written are temporary stand-ins for the reload flag and MapList.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-home-buttons-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local NULL = setmetatable({}, { __tostring = function() return "null" end })
local function noop() return nil end

package.preload["system"] = function()
  return {
    uuid = noop,
    sleep = noop,
    blockingSleep = noop,
    jiffies = function() return { tomillis = function() return 1000 end } end,
    -- start() must not run the worker loop here.
    addTask = function() return {} end,
    taskStatus = function() return "dead" end,
    isMessageRegistered = function() return true end,
    sendMessage = function() return true end,
  }
end
package.preload["json"] = function()
  return { null = NULL, encode = function() return "{}" end, decode = noop }
end
package.preload["log"] = function()
  local logger = { notice = noop, error = noop, warning = noop, debug = noop, info = noop }
  return { logger = function() return logger end }
end
package.preload["tasks.harmonywebservices.core.resourcemanager"] = function() return {} end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return { configVersion = 0, stateVersion = 0 } end }
end
package.preload["tasks.connectserver.core.utils"] = function()
  return {
    broadcastEvent = noop,
    createResponse = function(cmd, code, message) return { cmd = cmd, code = code, message = message } end,
  }
end

-- The engine's parsed buttons: actions by name, as userconfigreader builds them.
local function button(actions, longActions)
  local parsed = { actions = {}, longActions = {} }
  for i, name in ipairs(actions) do parsed.actions[i] = { name = name, parameters = {} } end
  for i, name in ipairs(longActions or {}) do parsed.longActions[i] = { name = name, parameters = {} } end
  return parsed
end
local SEND = { "SendCommand" }
local NOTHING = { "SendDelay" }

-- Stand-in for userconfigreader: like the engine, the AutomationConfig pass
-- removes Ha1-Ha4 from the root map, rebuilds the keys AutomationConfig
-- binds and always adds the rocker buttons.
local reader = {}
function reader.getAutomationConfiguration(jsonData, account)
  local map = account.buttonMaps["16422Root"]
  if not map then return true end
  local root = map.buttons
  for _, key in ipairs({ "Ha1", "Ha2", "Ha3", "Ha4" }) do root[key] = nil end
  for key, bound in pairs(jsonData.bound or {}) do root[key] = bound end
  root.RockerUp = button({ "RockerUp" })
  root.RockerDown = button({ "RockerDown" })
  return true
end
package.preload["tasks.harmonyengine.loader.userconfigreader"] = function() return reader end

-- Stand-in for the activity API handler: records what reaches the engine.
local engineCalls = {}
local handler = {}
function handler.processButtonCommand(cmd, verb, params)
  engineCalls[#engineCalls + 1] = { verb = verb, key = params.buttonKey }
  return { cmd = cmd, code = "200", message = "engine" }
end
package.preload["tasks.harmonyengine.apihandler.activity"] = function() return handler end

local account

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

local function upvalueIndex(fn, name)
  local i = 1
  while true do
    local upName = debug.getupvalue(fn, i)
    if upName == nil then return nil end
    if upName == name then return i end
    i = i + 1
  end
end

local requestReload = findUpvalue(plugin.pair, "requestResourceReload")
local homeControlMaps = findUpvalue(plugin.pair, "homeControlMaps")
local hasRootHomeKeys = findUpvalue(plugin.pair, "hasRootHomeKeys")
local validateGraph = findUpvalue(plugin.discover, "validateGraph")
if type(requestReload) ~= "function" or type(homeControlMaps) ~= "function" or
    type(hasRootHomeKeys) ~= "function" or type(validateGraph) ~= "function" then
  io.stderr:write("could not reach the home-control hooks in codexactivity.lua\n")
  os.exit(2)
end

-- The reload flag goes to a temporary file instead of /data/codex.
local flagPath = os.tmpname()
debug.setupvalue(requestReload, upvalueIndex(requestReload, "RESOURCE_RELOAD_FLAG"), flagPath)
local function readFlag()
  local f = io.open(flagPath, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end
local function writeFlag(text)
  local f = assert(io.open(flagPath, "wb"))
  f:write(text)
  f:close()
end

-- The hub's MapList goes to a temporary file too.
local mapListPath = os.tmpname()
os.remove(mapListPath)
debug.setupvalue(hasRootHomeKeys, upvalueIndex(hasRootHomeKeys, "MAP_LIST_FILE"), mapListPath)
local function writeMapList(text)
  local f = assert(io.open(mapListPath, "wb"))
  f:write(text)
  f:close()
end
local COMPANION_MAP_LIST = '{"ButtonMaps":[{"ButtonMapIdentifier":"16422Root","Buttons":[{"ButtonKey":"Ha1"}]}]}'

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

local function press(verb, key, equadId)
  engineCalls = {}
  local answer = handler.processButtonCommand("cmd", verb, { buttonKey = key, equadId = equadId or "16422" })
  return answer, engineCalls[1]
end

-- Each key goes press, hold, release; returns what the engine got.
local function pressAndHold(key, equadId)
  local seen = {}
  for _, verb in ipairs({ "press", "hold", "hold", "release" }) do
    local answer, call = press(verb, key, equadId)
    seen[#seen + 1] = call and (call.verb .. ":" .. call.key) or ("answered:" .. tostring(answer and answer.code))
  end
  return table.concat(seen, " ")
end

-- == Installing the hooks ==================================================

check("no MapList file: no reload is needed", hasRootHomeKeys() == false)
writeMapList('{"ButtonMaps":[{"ButtonMapIdentifier":"16417Root","Buttons":[{"ButtonKey":"Menu"}]}]}')
check("a hub without a Companion needs no reload", hasRootHomeKeys() == false)
writeMapList('{"ButtonMaps":[{"ButtonMapIdentifier":"16422Root","Buttons":[{"ButtonKey":"Menu"}]}]}')
check("a Companion root map without home keys needs no reload", hasRootHomeKeys() == false)
writeMapList(COMPANION_MAP_LIST)
check("a Companion root map with home keys needs the reload", hasRootHomeKeys() == true)

local stockReader = reader.getAutomationConfiguration
local stockCommand = handler.processButtonCommand
-- A pending request without a trailing newline must not run into ours.
writeFlag("DeviceList")
plugin:pair("gateway", {})
local hookedReader = reader.getAutomationConfiguration
local hookedCommand = handler.processButtonCommand
check("start() wraps the AutomationConfig pass and processButtonCommand",
  hookedReader ~= stockReader and hookedCommand ~= stockCommand and
    reader.codexHomeKeysHook == true and handler.codexHomeControlHook == true)
check("installing asks for one MapList reload and keeps the reloads already asked for",
  readFlag() == "DeviceList\nMapList\n", readFlag())
local pendingNames = {}
for name in string.gmatch(readFlag() or "", "[%w]+") do pendingNames[#pendingNames + 1] = name end
check("the reload reader sees both names, not one run-together name",
  table.concat(pendingNames, " ") == "DeviceList MapList", table.concat(pendingNames, " "))

plugin:discover()
plugin:pair("gateway", {})
check("starting again wraps nothing twice and asks for no second reload",
  reader.getAutomationConfiguration == hookedReader and handler.processButtonCommand == hookedCommand and
    readFlag() == "DeviceList\nMapList\n", readFlag())

check("before the engine's first config load, the keys are the engine's",
  pressAndHold("Ha1") == "press:Ha1 hold:Ha1 hold:Ha1 release:Ha1", pressAndHold("Ha1"))

-- == Keeping the root home keys =============================================

local light1 = button(SEND, { "SendCommand" })
local plug1 = button(SEND)
local logitechPlug = { actions = { { name = "SetValue", parameters = { haDeviceId = "plug-1" } } }, longActions = {} }
account = { buttonMaps = { ["16422Root"] = { buttons = { Ha1 = light1, Ha3 = plug1, Menu = button(SEND) } } } }
local result = reader.getAutomationConfiguration({ bound = { Ha3 = logitechPlug } }, account)
local root = account.buttonMaps["16422Root"].buttons
check("the MapList's own home keys come back after the AutomationConfig pass",
  result == true and root.Ha1 == light1 and root.Ha2 == nil and root.Ha4 == nil and root.Menu ~= nil)
check("a key AutomationConfig binds keeps that binding", root.Ha3 == logitechPlug)
check("the engine's rocker buttons stay", root.RockerUp ~= nil and root.RockerDown ~= nil)

reader.getAutomationConfiguration({}, account)
check("a binding AutomationConfig no longer has doesn't come back",
  root.Ha3 == nil and root.Ha1 == light1, tostring(root.Ha3))

account = { buttonMaps = {} }
local ranOk = pcall(reader.getAutomationConfiguration, {}, account)
check("an account without a Companion root map is left alone",
  ranOk and next(account.buttonMaps) == nil)

-- == Key presses ===========================================================

-- The engine hands the hook its account on a config load; the key hook
-- reads the maps from it.
local function hub(activityId, activityButtons, rootButtons)
  local maps = { ["16422Root"] = { buttons = rootButtons } }
  if activityButtons then maps["16422Activity" .. activityId] = { buttons = activityButtons } end
  account = { currentActivityId = activityId, buttonMaps = maps }
  reader.getAutomationConfiguration({}, account)
end

local rootMap = {
  Ha1 = button(SEND),
  Ha1Up = button(SEND),
  Ha1Down = button(SEND),
  Ha2 = button(SEND, { "SendCommand" }),
  Ha3 = button(SEND),
  HcUp = button(SEND),
  HcDown = button(SEND),
}
local activityMap = {
  Ha3 = button(NOTHING),
  Ha4Up = button(SEND),
  Ha2 = button(SEND),
}
hub("100", activityMap, rootMap)

check("a home key without a long press fires once: its holds stop here",
  pressAndHold("Ha1") == "press:Ha1 answered:200 answered:200 release:Ha1", pressAndHold("Ha1"))
hub("-1", nil, rootMap)
check("a home key with a long press keeps its holds, so the long press can fire",
  pressAndHold("Ha2") == "press:Ha2 hold:Ha2 hold:Ha2 release:Ha2", pressAndHold("Ha2"))
hub("100", activityMap, rootMap)
check("the running activity's map wins over the root map (its Ha2 has no long press)",
  pressAndHold("Ha2") == "press:Ha2 answered:200 answered:200 release:Ha2", pressAndHold("Ha2"))
check("\"nothing\" in the running activity swallows press, hold and release",
  pressAndHold("Ha3") == "answered:200 answered:200 answered:200 answered:200", pressAndHold("Ha3"))
hub("200", {}, rootMap)
check("in another activity the same key falls back to the root map",
  pressAndHold("Ha3") == "press:Ha3 answered:200 answered:200 release:Ha3", pressAndHold("Ha3"))
check("a home key with no action anywhere is left to the engine",
  pressAndHold("Ha4") == "press:Ha4 hold:Ha4 hold:Ha4 release:Ha4", pressAndHold("Ha4"))
local logitechLight = { actions = { { name = "SetValue", parameters = { haDeviceId = "hue-1" } } }, longActions = {} }
hub("-1", nil, { Ha4 = logitechLight })
check("a key Logitech's home control binds keeps the engine's own holds",
  pressAndHold("Ha4") == "press:Ha4 hold:Ha4 hold:Ha4 release:Ha4", pressAndHold("Ha4"))
hub("200", {}, rootMap)
check("another remote's keys are never touched",
  pressAndHold("Ha1", "16414") == "press:Ha1 hold:Ha1 hold:Ha1 release:Ha1", pressAndHold("Ha1", "16414"))
local _, numeric = press("hold", "Ha1", 16422)
check("a numeric equadId is the Companion too", numeric == nil)

-- == The rocker ============================================================

hub("100", activityMap, rootMap)
press("press", "Ha1")
check("+ after Light 1 adjusts Light 1, holds included (they repeat for dimming)",
  pressAndHold("RockerUp") == "press:Ha1Up hold:Ha1Up hold:Ha1Up release:Ha1Up", pressAndHold("RockerUp"))
check("- after Light 1 too", pressAndHold("RockerDown") == "press:Ha1Down hold:Ha1Down hold:Ha1Down release:Ha1Down")
press("press", "Ha2")
check("after a home key without +/- actions, + sends the fixed +",
  pressAndHold("RockerUp") == "press:HcUp hold:HcUp hold:HcUp release:HcUp", pressAndHold("RockerUp"))
press("press", "Ha4")
check("a +/- action only the running activity has is found there",
  pressAndHold("RockerUp") == "press:Ha4Up hold:Ha4Up hold:Ha4Up release:Ha4Up", pressAndHold("RockerUp"))
hub("-1", nil, rootMap)
check("with no activity running the same rocker falls back to the fixed +",
  pressAndHold("RockerUp") == "press:HcUp hold:HcUp hold:HcUp release:HcUp", pressAndHold("RockerUp"))
hub("-1", nil, { Ha1 = button(SEND) })
check("with no +/- actions anywhere the rocker stays the engine's own",
  pressAndHold("RockerUp") == "press:RockerUp hold:RockerUp hold:RockerUp release:RockerUp", pressAndHold("RockerUp"))

hub("-1", nil, rootMap)
press("press", "Ha1")
local _, first = press("press", "RockerUp")
press("press", "Ha2")
local _, held = press("hold", "RockerUp")
local _, released = press("release", "RockerUp")
local _, again = press("press", "RockerUp")
check("a held rocker stays on the key it pressed, even when another home key is pressed meanwhile",
  first.key == "Ha1Up" and held.key == "Ha1Up" and released.key == "Ha1Up" and again.key == "HcUp",
  table.concat({ first.key, held.key, released.key, again.key }, " "))

-- == A remote with a screen that has home keys (Elite, 950) ===================

local SCREEN = "16417"
local function screenHub(activityId, activityButtons, rootButtons)
  local maps = { ["16417Root"] = { buttons = rootButtons }, ["16422Root"] = { buttons = rootMap } }
  if activityButtons then maps["16417Activity" .. activityId] = { buttons = activityButtons } end
  account = { currentActivityId = activityId, buttonMaps = maps }
  reader.getAutomationConfiguration({}, account)
end
local screenRoot = {
  HomeControl1 = button(SEND),
  HomeControl1Up = button(SEND),
  HomeControl2 = button(SEND, { "SendCommand" }),
  HomeControl3 = button(SEND),
  HomeControlPlus = button(NOTHING),
  HomeControlMinus = button(NOTHING),
  HcDown = button(SEND),
}
screenHub("-1", nil, screenRoot)
check("a screen remote's home key fires once too",
  pressAndHold("HomeControl1", SCREEN) == "press:HomeControl1 answered:200 answered:200 release:HomeControl1",
  pressAndHold("HomeControl1", SCREEN))
check("its long press keeps the holds",
  pressAndHold("HomeControl2", SCREEN) == "press:HomeControl2 hold:HomeControl2 hold:HomeControl2 release:HomeControl2",
  pressAndHold("HomeControl2", SCREEN))
check("its other keys are never touched",
  pressAndHold("Menu", SCREEN) == "press:Menu hold:Menu hold:Menu release:Menu", pressAndHold("Menu", SCREEN))
check("the Companion's key names mean nothing on a screen remote",
  pressAndHold("Ha1", SCREEN) == "press:Ha1 hold:Ha1 hold:Ha1 release:Ha1", pressAndHold("Ha1", SCREEN))
press("press", "HomeControl1", SCREEN)
check("+ after its Light 1 adjusts Light 1",
  pressAndHold("HomeControlPlus", SCREEN) ==
    "press:HomeControl1Up hold:HomeControl1Up hold:HomeControl1Up release:HomeControl1Up",
  pressAndHold("HomeControlPlus", SCREEN))
check("- falls back to the fixed -",
  pressAndHold("HomeControlMinus", SCREEN) == "press:HcDown hold:HcDown hold:HcDown release:HcDown",
  pressAndHold("HomeControlMinus", SCREEN))
press("press", "HomeControl3", SCREEN)
check("a + with no action is answered here, so the engine's home-automation path never sees it",
  pressAndHold("HomeControlPlus", SCREEN) == "answered:200 answered:200 answered:200 answered:200",
  pressAndHold("HomeControlPlus", SCREEN))
press("press", "Ha1")
press("press", "HomeControl3", SCREEN)
check("each remote has its own last home key",
  pressAndHold("RockerUp") == "press:Ha1Up hold:Ha1Up hold:Ha1Up release:Ha1Up", pressAndHold("RockerUp"))
screenHub("100", { HomeControl3 = button(NOTHING) }, screenRoot)
check("\"nothing\" on a screen remote is run by the engine (the remote waits for it); only holds stop here",
  pressAndHold("HomeControl3", SCREEN) == "press:HomeControl3 answered:200 answered:200 release:HomeControl3",
  pressAndHold("HomeControl3", SCREEN))
screenHub("-1", nil, { HomeControlPlus = logitechLight })
check("a + Logitech's home control binds stays the engine's",
  pressAndHold("HomeControlPlus", SCREEN) ==
    "press:HomeControlPlus hold:HomeControlPlus hold:HomeControlPlus release:HomeControlPlus",
  pressAndHold("HomeControlPlus", SCREEN))

-- == Failure ===============================================================

hub("-1", nil, rootMap)

local accountIndex = upvalueIndex(homeControlMaps, "engineAccount")
debug.setupvalue(homeControlMaps, accountIndex,
  { buttonMaps = setmetatable({}, { __index = function() error("broken account") end }) })
check("when the hook itself fails, the engine still gets the key",
  pressAndHold("Ha1") == "press:Ha1 hold:Ha1 hold:Ha1 release:Ha1", pressAndHold("Ha1"))

-- == validateGraph and the "Nothing" sequence ================================

local nothingMap = {
  __type = "ActivityButtonMap", ButtonMapIdentifier = "16422Activity100", ["ActivityId-"] = 100,
  Sequences = { { SequenceId = 1878029800, Name = "Nothing",
    Actions = { { __type = "ButtonDelayAction", Duration = 0, Order = 1 } } } },
  Buttons = { { __type = "HardRemoteButton", ButtonKey = "Ha3",
    ButtonAction = { __type = "ButtonSequenceAction", SequenceId = 1878029800, EventType = 1 } } },
}
local ok, err = validateGraph(
  { Activities = { { ["Id-"] = 100, Roles = {} } } },
  { ButtonMaps = { nothingMap } },
  { FunctionMaps = { { __type = "ActivityFunctionMap", ["ActivityId-"] = 100, FunctionGroups = {} } } },
  { DevicesWithFeatures = {} })
check("validateGraph accepts the \"Nothing\" sequence as it is", ok == true, err)

os.remove(flagPath)
os.remove(mapListPath)
os.remove(flagPath .. ".new")
print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
