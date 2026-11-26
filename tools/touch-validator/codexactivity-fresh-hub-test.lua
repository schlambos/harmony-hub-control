-- LuaJIT tests for a hub that was never set up, in
-- payload/activity/codexactivity.lua.
--
-- A fresh hub has none of the base resources (ProtocolList, DeviceList,
-- ActivityList, FunctionList, MapList), and codex_webui answers
-- /api/activity-config with 503 until ActivityList, MapList, FunctionList and
-- DeviceList can all be read (render_activity_config_json). The plugin's
-- worker creates the five as empty lists on such a hub, and only on such a
-- hub. These tests run the worker against a fake disk and resource index and
-- check that, then save the first activity hardware ran through the writer.
--
-- Same loading pattern as codexactivity-device-screens-test.lua: stub the hub
-- modules and keep the hub's files in memory. The worker is started the way
-- the hub starts it, through discover(). No hub is contacted and nothing is
-- written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-fresh-hub-test.lua

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

local RESOURCES = "/data/resources/"
local BLOCKER = "/data/codex/cloud_blocker.conf"
local RELOAD_FLAG = "/data/codex/reload_resources"
local CONFIG_READY = "/var/volatile/codex-config-ready.json"
local REQUEST = "/var/volatile/codex-activity-request.json"
local RESPONSE = "/var/volatile/codex-activity-response.json"

-- The five base resources as they must be written: the stock reader's own
-- keys (userconfigreader.lua), each with nothing in it.
local EMPTY = {
  { "ProtocolList", '{"Protocols":[]}' },
  { "DeviceList", '{"DevicesWithFeatures":[]}' },
  { "ActivityList", '{"Activities":[]}' },
  { "FunctionList", '{"FunctionMaps":[]}' },
  { "MapList", '{"ButtonMaps":[]}' },
}

-- The fake hub: its disk, the resource manager's index, and a record of
-- every save, reload and publish.
local hub
local plugin
local worker
local uuidCounter = 0
local function resetHub()
  hub = {
    fs = { [BLOCKER] = "1\n" },
    index = {},
    saves = {},
    messages = {},
    published = 0,
    sync = false,
    engineListening = true,
    fullLoadFailures = 0,
    account = nil,
    failSave = nil,
    pending = nil, -- a request codex_webui leaves for the worker's next pass
    passes = 0,
    limit = 1,
    readyLog = {}, -- the readiness file at the end of each pass
    readyWrites = 0, -- renames onto the readiness file
    readyRemoves = 0,
    onPass = nil, -- called with the pass number at the end of each pass
  }
end

-- A resource the hub already has: its file and its index entry.
local function put(name, text)
  uuidCounter = uuidCounter + 1
  hub.fs[RESOURCES .. name .. ".json"] = text
  hub.index[name] = { etag = '"seed-' .. uuidCounter .. '"', hetag = tostring(uuidCounter) }
end

local function noop() return nil end
package.preload["system"] = function()
  return {
    uuid = function()
      uuidCounter = uuidCounter + 1
      return string.format("00000000-0000-4000-8000-%012d", uuidCounter)
    end,
    -- The worker sleeps once a pass; the test ends it after `limit` passes.
    sleep = function()
      hub.passes = hub.passes + 1
      hub.readyLog[hub.passes] = hub.fs[CONFIG_READY] or false
      if hub.onPass then hub.onPass(hub.passes) end
      if hub.pending then
        hub.fs[REQUEST] = hub.pending
        hub.pending = nil
      end
      if hub.passes >= hub.limit then plugin.exit(plugin) end
    end,
    blockingSleep = noop,
    jiffies = function() return { tomillis = function() return 1000 end } end,
    -- The worker is kept for the test to run; the engine barrier answers at once.
    addTask = function(name, fn)
      if name == "codexactivity" then worker = fn else fn() end
      return {}
    end,
    taskStatus = function() return "dead" end,
    isMessageRegistered = function() return hub.engineListening end,
    sendMessage = function(name, args)
      if name == "config_new" then
        hub.messages[#hub.messages + 1] = type(args) == "table" and table.concat(args, ",") or tostring(args)
        -- harmonyengine's named-resource loadResource() returns true without
        -- loading anything while account is nil. Only "all" reaches loadAll().
        if args == "all" then
          if hub.fullLoadFailures > 0 then
            hub.fullLoadFailures = hub.fullLoadFailures - 1
            return nil, "simulated loadAll failure"
          end
          hub.account = { DevicesWithFeatures = {} }
        end
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
-- The stock resource manager's rules (resourcemanager.lua): a resource
-- without an index entry can't be read, and a save writes the file, when it
-- is given one, and the index entry.
package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
  return {
    isAnySyncInProgress = function() return hub.sync end,
    getResource = function(name)
      local entry = hub.index[name]
      if not entry then return nil, "indexInfo not available for the resource " .. name end
      local text = hub.fs[RESOURCES .. name .. ".json"]
      if not text then return nil, "file not found" end
      local ok, value = pcall(decodeJson, text)
      if not ok then return nil, value end
      return "200", entry.etag, value
    end,
    getHubEtag = function(name) return hub.index[name] and hub.index[name].hetag end,
    saveResource = function(_, etag, value, name, _, hetag)
      if hub.failSave == name then
        hub.failSave = nil
        return nil, "disk full"
      end
      hub.saves[#hub.saves + 1] = name
      if value ~= nil then
        hub.fs[RESOURCES .. name .. ".json"] = type(value) == "string" and value or encodeJson(value)
      end
      hub.index[name] = { etag = etag, hetag = hetag }
      return true
    end,
  }
end
-- saveStateDigest sits behind the metatable: the plugin encodes the digest.
local digest = setmetatable({ configVersion = 0, stateVersion = 0 }, { __index = {
  saveStateDigest = function() hub.published = hub.published + 1 end,
} })
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return digest end }
end
package.preload["tasks.connectserver.core.utils"] = function()
  return { broadcastEvent = noop }
end

-- The hub's disk: everything under /data and /var/volatile is the fake one.
local function onHub(path)
  return path:sub(1, 6) == "/data/" or path:sub(1, 14) == "/var/volatile/"
end
local realOpen, realRemove, realRename = io.open, os.remove, os.rename
io.open = function(path, mode)
  if not onHub(path) then return realOpen(path, mode) end
  if mode and mode:find("w") then
    local parts = {}
    return {
      write = function(self, ...)
        for _, part in ipairs({ ... }) do parts[#parts + 1] = part end
        return self
      end,
      close = function() hub.fs[path] = table.concat(parts) end,
    }
  end
  local text = hub.fs[path]
  if not text then return nil end
  return { read = function() return text end, close = noop }
end
os.remove = function(path)
  if not onHub(path) then return realRemove(path) end
  if path == CONFIG_READY then hub.readyRemoves = hub.readyRemoves + 1 end
  hub.fs[path] = nil
  return true
end
os.rename = function(from, to)
  if not onHub(from) then return realRename(from, to) end
  if to == CONFIG_READY then hub.readyWrites = hub.readyWrites + 1 end
  hub.fs[to], hub.fs[from] = hub.fs[from], nil
  return true
end

package.path = repoRoot .. "/payload/activity/?.lua;" .. package.path

-- A boot: the plugin loaded anew.
local function boot()
  package.loaded["codexactivity"] = nil
  plugin = require("codexactivity")
  worker = nil
end

-- The hub's discover call, then `passes` passes of the worker.
local function run(passes)
  hub.passes, hub.limit = 0, passes or 2
  plugin.discover(plugin)
  if type(worker) ~= "function" then
    io.stderr:write("discover() did not start the codexactivity worker\n")
    os.exit(2)
  end
  worker()
end

-- codex_webui's answer to GET /api/activity-config (render_activity_config_json):
-- 503 unless these four files can be read.
local function activityConfigStatus()
  for _, name in ipairs({ "ActivityList", "MapList", "FunctionList", "DeviceList" }) do
    if hub.fs[RESOURCES .. name .. ".json"] == nil then return 503 end
  end
  return 200
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

local function fileOf(name) return hub.fs[RESOURCES .. name .. ".json"] end
local function allEmpty()
  for _, entry in ipairs(EMPTY) do
    if fileOf(entry[1]) ~= entry[2] then return false, entry[1] .. " = " .. tostring(fileOf(entry[1])) end
    if not hub.index[entry[1]] then return false, entry[1] .. " has no index entry" end
  end
  return true
end
local function snapshot()
  local copy = {}
  for path, text in pairs(hub.fs) do copy[path] = text end
  for name, entry in pairs(hub.index) do copy["index:" .. name] = entry.etag .. "|" .. tostring(entry.hetag) end
  return copy
end
local function unchanged(before)
  local now = snapshot()
  for key, value in pairs(before) do
    if now[key] ~= value then return false, key .. " changed" end
  end
  for key in pairs(now) do
    if before[key] == nil then return false, key .. " appeared" end
  end
  return true
end

local fixtureFile = assert(realOpen(repoRoot .. "/tools/webui-sim/fixtures/fresh-hub.json", "rb"))
local FRESH = decodeJson(fixtureFile:read("*a"))
fixtureFile:close()

local function queueFirstActivity(id)
  hub.fs[RESOURCES .. "DeviceList.json"] = encodeJson(FRESH.blank.deviceList)
  hub.fs[RESOURCES .. "ProtocolList.json"] = '{"Protocols":[{"Id-":2,"Name":"Toshiba 32 Bit","__type":"IrProtocol"}]}'
  hub.pending = encodeJson({
    id = id, op = "CommitActivityResources",
    activityList = FRESH.proven.activityList,
    mapList = FRESH.proven.mapList,
    functionList = FRESH.proven.functionList,
    activityChanged = true, mapChanged = true, functionChanged = true,
  })
end

-- A fresh hub ------------------------------------------------------------------
-- Its index holds only the AutomationConfig the activation chain seeds.
resetHub()
put("AutomationConfig", '{"devices":{}}')
local automation = snapshot()
boot()
check("a fresh hub answers /api/activity-config with 503", activityConfigStatus() == 503)
run(2)
check("the five base resources exist, empty, each with an index entry", allEmpty())
check("/api/activity-config answers 200 afterwards", activityConfigStatus() == 200)
check("they were saved once each, through the resource manager",
  table.concat(hub.saves, ",") == "ProtocolList,DeviceList,ActivityList,FunctionList,MapList",
  table.concat(hub.saves, ","))
check("the engine was told to load the whole account",
  hub.messages[1] == "all" and #hub.messages == 1,
  table.concat(hub.messages, " | "))
check("config_new all initialized harmonyengine's account", hub.account ~= nil)
check("and the reload request was used up", hub.fs[RELOAD_FLAG] == nil)
check("every other resource is left alone",
  fileOf("AutomationConfig") == automation[RESOURCES .. "AutomationConfig.json"] and
  hub.index.AutomationConfig.etag .. "|" .. hub.index.AutomationConfig.hetag == automation["index:AutomationConfig"])
do
  local etags, distinct = {}, true
  for _, entry in ipairs(EMPTY) do
    local etag = hub.index[entry[1]] and hub.index[entry[1]].etag
    if type(etag) ~= "string" or etags[etag] then
      distinct = false
    else
      etags[etag] = true
    end
  end
  check("each has its own etag", distinct)
end

-- Later passes and later boots find them and write nothing.
local seeded = snapshot()
hub.saves, hub.messages = {}, {}
run(3)
boot()
run(3)
check("the empty resources are not written again, in that boot or the next",
  #hub.saves == 0 and #hub.messages == 0 and unchanged(seeded), table.concat(hub.saves, ","))

-- The first activity, as the web app saves it once a device was added
-- (codex_webui writes DeviceList and ProtocolList straight to disk).
queueFirstActivity("first")
run(3)
do
  local response = hub.fs[RESPONSE] and decodeJson(hub.fs[RESPONSE]) or {}
  check("the writer saves the first activity onto the empty resources",
    response.ok == true and response.id == "first", tostring(response.error))
  local maps = fileOf("MapList") and decodeJson(fileOf("MapList")).ButtonMaps or {}
  local root
  for _, map in ipairs(maps) do
    if map.ButtonMapIdentifier == "16414Root" then root = map end
  end
  check("with the Smart Control's root map beside its activity map",
    #maps == 2 and root ~= nil and root.Buttons[1].ButtonKey == "WatchTVActivity" and
    root.Buttons[1].ButtonAction["ActivityId-"] == FRESH.proven.activityList.Activities[1]["Id-"])
end

-- Hubs that are left alone -------------------------------------------------------
local function configured()
  resetHub()
  put("ProtocolList", '{"Protocols":[{"Id-":2,"Name":"Sony 12 Bit","__type":"IrProtocol"}]}')
  put("DeviceList", '{"DevicesWithFeatures":[{"Device":{"Id-":100,"Name":"Amp"},"Commands":[],"DeviceFeatures":[]}]}')
  put("ActivityList", '{"Activities":[{"Id-":1,"Name":"Listen","Roles":[]}]}')
  put("FunctionList", '{"FunctionMaps":[{"__type":"ActivityFunctionMap","ActivityId-":1,"FunctionGroups":[]}]}')
  put("MapList", '{"ButtonMaps":[{"__type":"RootButtonMap","ButtonMapIdentifier":"16414Root","Buttons":[]}]}')
end
local function leftAlone(name)
  local before = snapshot()
  boot()
  run(3)
  local same, detail = unchanged(before)
  check(name, #hub.saves == 0 and #hub.messages == 0 and same,
    #hub.saves > 0 and ("saved " .. table.concat(hub.saves, ",")) or detail)
end

configured()
leftAlone("a hub that is set up is not touched")

configured()
hub.fs[RESOURCES .. "ActivityList.json"], hub.index.ActivityList = nil, nil
hub.fs[RESOURCES .. "MapList.json"], hub.index.MapList = nil, nil
leftAlone("a hub with devices and missing lists is not touched")

resetHub()
put("DeviceList", '{"DevicesWithFeatures":[{"Device":{"Id-":100,"Name":"Amp"},"Commands":[],"DeviceFeatures":[]}]}')
leftAlone("a hub with only a device is not touched")

resetHub()
hub.fs[RESOURCES .. "MapList.json"] = '{"ButtonMaps":[{"__type":"RootButtonMap","ButtonMapIdentifier":"16414Root","Buttons":[]}]}'
leftAlone("a file the index doesn't list is not overwritten, nor are its neighbours made")

resetHub()
hub.index.ActivityList = { etag = '"lost"', hetag = "9" }
leftAlone("an index entry without its file is not overwritten, nor are its neighbours made")

resetHub()
put("ActivityList", "not json")
leftAlone("a resource that can't be read is not overwritten, nor are its neighbours made")

configured()
boot()
run(2)
queueFirstActivity("configured")
run(3)
do
  local response = hub.fs[RESPONSE] and decodeJson(hub.fs[RESPONSE]) or {}
  check("a normal hub still reloads only the activity resources after a commit",
    response.ok == true and table.concat(hub.messages, " | ") == "ActivityList,FunctionList,MapList",
    table.concat(hub.messages, " | "))
  check("the simulated named-resource rule leaves account nil", hub.account == nil)
end

-- When it runs ---------------------------------------------------------------------
resetHub()
hub.fs[BLOCKER] = "0\n"
boot()
run(3)
check("nothing is written while the cloud blocker is off", #hub.saves == 0 and activityConfigStatus() == 503)
hub.fs[BLOCKER] = "1\n"
run(2)
check("and it is done once the blocker is on", allEmpty())

resetHub()
hub.sync = true
boot()
run(3)
check("nothing is written during a stock sync", #hub.saves == 0 and next(hub.index) == nil)
hub.sync = false
run(2)
check("and it is done when the sync ends", allEmpty())

resetHub()
hub.engineListening = false
boot()
run(3)
check("with the engine not listening yet the resources are made and the full reload waits",
  allEmpty() and #hub.messages == 0 and hub.fs[RELOAD_FLAG] == "all\n",
  tostring(hub.fs[RELOAD_FLAG]))
hub.engineListening = true
run(2)
check("and the engine loads the account once it listens",
  hub.messages[1] == "all" and hub.account ~= nil and hub.fs[RELOAD_FLAG] == nil,
  table.concat(hub.messages, " | "))

-- A failed full load must not allow a same-boot activity commit to downgrade
-- to the named-resource rule, which would return true with account still nil.
resetHub()
hub.fullLoadFailures = 2
boot()
run(1)
check("a failed full load leaves account unavailable and the full load pending",
  table.concat(hub.messages, " | ") == "all" and hub.account == nil and hub.fs[RELOAD_FLAG] == nil,
  table.concat(hub.messages, " | "))
queueFirstActivity("full-load-retry")
run(3)
do
  local response = hub.fs[RESPONSE] and decodeJson(hub.fs[RESPONSE]) or {}
  check("the activity commit falls back to all until the full load succeeds",
    response.ok == true and hub.account ~= nil and table.concat(hub.messages, " | ") == "all | all | all",
    table.concat(hub.messages, " | ") .. "; " .. tostring(response.error))
end

-- A save that fails part-way leaves what it wrote; the next boot finishes.
resetHub()
hub.failSave = "FunctionList"
boot()
run(3)
check("a failed save stops there and isn't retried in that boot",
  table.concat(hub.saves, ",") == "ProtocolList,DeviceList,ActivityList" and activityConfigStatus() == 503,
  table.concat(hub.saves, ","))
hub.saves = {}
boot()
run(2)
check("the next boot makes only what is still missing",
  table.concat(hub.saves, ",") == "FunctionList,MapList" and allEmpty() and activityConfigStatus() == 200,
  table.concat(hub.saves, ","))

-- Import readiness (/var/volatile/codex-config-ready.json): codex_webui's
-- /import writes resource files directly, and a file written before the
-- blank-hub check has no index entry, so the engine boots without an account.
-- The worker reports when such writes are safe.
local function readyAt(pass)
  local text = hub.readyLog[pass]
  if not text then return nil end
  return decodeJson(text)
end
local function lastReady() return readyAt(#hub.readyLog) end

resetHub()
hub.engineListening = false
boot()
run(2)
do
  local r = lastReady() or {}
  check("imports wait while the engine is not listening",
    r.ready == false and r.reason == "engine-starting" and type(r.uptime) == "number", encodeJson(r))
end

resetHub()
hub.sync = true
boot()
run(2)
check("imports wait during a stock sync", (lastReady() or {}).reason == "resource-sync", encodeJson(lastReady() or {}))

resetHub()
boot()
run(1)
check("on a blank hub imports wait for the full reload the seeding asked for",
  (readyAt(1) or {}).reason == "reload-pending", encodeJson(readyAt(1) or {}))
run(2)
check("and are allowed once the base resources are indexed and loaded",
  (lastReady() or {}).ready == true and hub.index.DeviceList ~= nil and hub.account ~= nil,
  encodeJson(lastReady() or {}))

resetHub()
for _, name in ipairs({ "ProtocolList", "DeviceList", "ActivityList", "FunctionList", "MapList" }) do
  put(name, '{"x":[1]}')
end
boot()
run(1)
check("a hub that was set up is ready after the worker's first pass",
  (readyAt(1) or {}).ready == true, encodeJson(readyAt(1) or {}))

resetHub()
hub.fs[BLOCKER] = "0\n"
boot()
run(1)
check("with the blocker off (no blank-hub check) the engine alone decides",
  (readyAt(1) or {}).ready == true, encodeJson(readyAt(1) or {}))

resetHub()
for _, name in ipairs({ "ProtocolList", "DeviceList", "ActivityList", "FunctionList", "MapList" }) do
  put(name, '{"x":[1]}')
end
hub.engineListening = false
hub.fs[RELOAD_FLAG] = "DeviceList\n"
boot()
run(1)
check("a reload codex_webui asked for keeps imports waiting until it ran",
  (readyAt(1) or {}).ready == false, encodeJson(readyAt(1) or {}))
hub.engineListening = true
run(2)
check("and releases them after", (lastReady() or {}).ready == true and hub.fs[RELOAD_FLAG] == nil,
  encodeJson(lastReady() or {}))
check("a stopped worker removes the readiness file", hub.fs[CONFIG_READY] == nil)

-- localMode tells codex_webui whether the blank-hub check applies: a bundle
-- that turns cloud blocking on waits for a report that says local.
local function setUp()
  for _, name in ipairs({ "ProtocolList", "DeviceList", "ActivityList", "FunctionList", "MapList" }) do
    put(name, '{"x":[1]}')
  end
end
resetHub()
setUp()
boot()
run(1)
check("the report says local mode while the blocker is on", (readyAt(1) or {}).localMode == true,
  encodeJson(readyAt(1) or {}))

resetHub()
setUp()
hub.fs[BLOCKER] = "0\n"
hub.onPass = function(pass) if pass == 1 then hub.fs[BLOCKER] = "1\n" end end
boot()
run(3)
check("and cloud mode while it is off, rewritten on the next pass after it changes",
  (readyAt(1) or {}).localMode == false and (readyAt(2) or {}).localMode == true and
    (readyAt(2) or {}).ready == true,
  encodeJson(readyAt(1) or {}) .. " -> " .. encodeJson(readyAt(2) or {}))

-- A cloud-mode blank hub turned local: the check runs on the next pass and
-- the report stays not ready until the full reload it asked for.
resetHub()
hub.fs[BLOCKER] = "0\n"
hub.onPass = function(pass) if pass == 1 then hub.fs[BLOCKER] = "1\n" end end
boot()
run(4)
check("a blank hub switched to local mode is seeded before it reports local and ready",
  (readyAt(1) or {}).ready == true and (readyAt(1) or {}).localMode == false and
    (readyAt(2) or {}).ready == false and (readyAt(2) or {}).localMode == true and
    (lastReady() or {}).ready == true and allEmpty(),
  encodeJson(readyAt(1) or {}) .. " -> " .. encodeJson(readyAt(2) or {}) .. " -> " .. encodeJson(lastReady() or {}))

-- A blank-hub check that could not finish runs no more that boot: imports
-- stay refused rather than landing on a half-made store.
resetHub()
hub.failSave = "FunctionList"
boot()
run(3)
check("a failed blank-hub check keeps imports refused for that boot",
  (lastReady() or {}).ready == false and (lastReady() or {}).reason == "store-setup-failed",
  encodeJson(lastReady() or {}))
boot()
run(3)
check("and the next boot that finishes it reports ready", (lastReady() or {}).ready == true,
  encodeJson(lastReady() or {}))

-- The report is replaced by a rename alone: a missing file reads as a stopped
-- plugin, so it is only removed when the worker stops.
resetHub()
setUp()
boot()
run(45)
check("the readiness file is refreshed without being removed until the worker stops",
  hub.readyWrites >= 3 and hub.readyRemoves == 1,
  string.format("writes %d, removes %d", hub.readyWrites, hub.readyRemoves))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
