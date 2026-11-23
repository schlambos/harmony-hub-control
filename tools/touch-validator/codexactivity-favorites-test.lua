-- LuaJIT tests for favorite channels in payload/activity/codexactivity.lua:
-- Favorites lists a device's favorites (the dialPositions of its
-- CD_<deviceId> resource); CommitFavorites replaces the list, stores uploaded
-- logos under fresh names, repeats the station ids in ContentUser, removes
-- logos nothing uses any more and publishes one revision.
--
-- Same harness as codexactivity-remote-images-test.lua: stubbed hub modules,
-- processRequest reached through discover()'s upvalues, resources in an
-- in-memory fake. No hub is contacted, nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-favorites-test.lua

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

-- A PNG header good enough for the plugin's checks: signature, IHDR, size.
local function be32(n)
  return string.char(math.floor(n / 16777216) % 256, math.floor(n / 65536) % 256,
    math.floor(n / 256) % 256, n % 256)
end
local function png(width, height, tag)
  return "\137PNG\r\n\26\n" .. "\0\0\0\13IHDR" .. be32(width) .. be32(height) ..
    "\8\2\0\0\0" .. (tag or "pixels")
end

-- The fake hub: JSON resources and images with etags, the staged upload, and
-- a record of every publish and image deletion.
local hub
local uuidCounter = 0
local account = "12345678"
local function resetHub(state)
  hub = {
    files = {}, -- name -> { text | bytes, etag, hetag, image }
    staged = {}, -- path -> bytes
    blocker = "1\n",
    published = 0,
    deleted = {},
    failSave = nil,
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
    addTask = function(_, fn) fn() return {} end,
    taskStatus = function() return "dead" end,
    isMessageRegistered = function() return true end,
    sendMessage = function() return true end,
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
    -- As the stock store answers: JSON as a table, an image as its file path,
    -- and a deleted image's index entry as "file not found".
    getResource = function(name)
      local file = hub.files[name]
      if not file then return nil, "indexInfo not available for the resource " .. name end
      if file.image then
        if file.gone then return nil, "file [" .. name .. ".png] not found" end
        return 200, file.etag, "resources/" .. name .. ".png"
      end
      return "200", file.etag, decodeJson(file.text)
    end,
    getHubEtag = function(name) return hub.files[name] and hub.files[name].hetag end,
    saveResource = function(contentType, etag, value, name, _, hetag)
      if hub.failSave == name then
        hub.failSave = nil -- one failed write; the restore after it succeeds
        return nil, "disk full"
      end
      if contentType == "image/png" then
        hub.files[name] = { bytes = value, etag = etag, hetag = hetag, image = true }
      else
        hub.files[name] = {
          text = type(value) == "string" and value or encodeJson(value),
          etag = etag,
          hetag = hetag,
        }
      end
      return true
    end,
    deleteResource = function(contentType, name)
      hub.deleted[#hub.deleted + 1] = name
      if hub.files[name] then hub.files[name].gone = true end
    end,
  }
end
package.preload["tasks.harmonywebservices.core.preferencemanager"] = function()
  return setmetatable({}, { __index = function(_, key) if key == "accountId" then return account end end })
end
local digest = { configVersion = 7, stateVersion = 3 }
function digest.saveStateDigest() hub.published = hub.published + 1 end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return digest end }
end
package.preload["tasks.connectserver.core.utils"] = function()
  return { broadcastEvent = noop }
end


-- codex_webui stages uploads under its own process id; the store's index
-- lists every resource by name.
local function imageFile(i) return "/var/volatile/codex-remote-image-4242-" .. i .. ".png" end
local ICON = "/var/volatile/codex-activity-icon-4242.png"
local ICON_SMALL = "/var/volatile/codex-activity-icon-4242-small.png"
local realOpen = io.open
io.open = function(path, mode)
  local text
  if path == "/data/codex/cloud_blocker.conf" then
    text = hub.blocker
  elseif path == "/data/discovery/RuntimeConfig.json" then
    text = hub.discovery
  elseif path == "/data/resources/index.json" then
    local index = {}
    for name in pairs(hub.files) do index[name] = '{"type":"application/json"}' end
    text = encodeJson(index)
  elseif hub.staged[path] ~= nil or path:find("^/var/volatile/") then
    text = hub.staged[path]
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
local function call(op, fields)
  requestCounter = requestCounter + 1
  local raw = { id = "r" .. requestCounter, op = op }
  for key, value in pairs(fields or {}) do raw[key] = value end
  if type(raw.positions) == "table" and raw.logoFiles == nil then
    local files = {}
    for _, position in ipairs(raw.positions) do
      if type(position) == "table" and type(position.logo) == "table" then
        files[#files + 1] = "/var/volatile/codex-favorite-logo-4242-" .. position.logo.staged .. ".png"
        position.logo = #files - 1
      end
    end
    raw.logoFiles = files
  end
  return processRequest(encodeJson(raw))
end
local function byName(images)
  local out = {}
  for _, p in ipairs(images or {}) do out[p.name] = p end
  return out
end

-- codex_webui stages uploaded logos and names them in logoFiles; a favorite
-- points at one by its place (from 0). useLogo(i) stands for "the staged file
-- i": call() below turns it into that pair.
local function useLogo(i) return { staged = i } end
local function logoFile(i) return "/var/volatile/codex-favorite-logo-4242-" .. i .. ".png" end
local function fileJson(name) return hub.files[name] and decodeJson(hub.files[name].text) end
local function stored(name) return hub.files[name] ~= nil and hub.files[name].image == true and not hub.files[name].gone end
local function wasDeleted(name)
  for _, deleted in ipairs(hub.deleted) do
    if deleted == name then return true end
  end
  return false
end

-- A cable box (555) with three favorites, two of them sharing a logo; a
-- second box (666) that uses one of the same logos; a TV (777) with no
-- favorites yet; a device made on the hub (888) and one whose favorites
-- belong to another device (999). Made-up names and ids.
local function seed(extra)
  local state = {
    DeviceList = { DevicesWithFeatures = {
      { Device = { ["Id-"] = 555, Name = "Cable", ContentProfileKey = 555, DeviceProfileUri = "profiles.example.invalid/555-a" } },
      { Device = { ["Id-"] = 666, Name = "Box 2", ContentProfileKey = 666, DeviceProfileUri = "profiles.example.invalid/666-b" } },
      { Device = { ["Id-"] = 777, Name = "TV", ContentProfileKey = 777, DeviceProfileUri = "profiles.example.invalid/777-c" } },
      { Device = { ["Id-"] = 888, Name = "Made here" } },
      { Device = { ["Id-"] = 999, Name = "Twin", ContentProfileKey = 555, DeviceProfileUri = "profiles.example.invalid/999-d" } },
    } },
    CD_555 = { id = "rec-555", device_profile_uri = "profiles.example.invalid/555-a", services = { ["{svc}"] = { dialPositions = {
      { number = "2", image = "cccc-02.png", name = "Kids", station = "s1", added = true, extra = "kept" },
      { number = "3", image = "dddd-03.png", name = "News", station = "s2", added = true },
      { number = "4", image = "dddd-03.png", name = "News HD", station = "s3", added = true },
    } } } },
    CD_666 = { id = "rec-666", services = { ["{svc}"] = { dialPositions = {
      { number = "9", image = "cccc-02.png", name = "Kids", station = "t1", added = true },
    } } } },
    ContentUser = { id = "user", location = { country = "XX" }, preferences = {
      ["555"] = { ["{svc}"] = { stations = { { id = "s1" }, { id = "s2" }, { id = "s3" } } } },
      ["444"] = { ["{svc}"] = { stations = { { id = "gone" } } } },
    } },
    Settings = { Settings = {} },
  }
  for name, value in pairs(extra or {}) do
    state[name] = value ~= false and value or nil
  end
  resetHub(state)
  hub.files["ci_cccc-02"] = { bytes = png(54, 50), etag = '"i1"', hetag = "1", image = true }
  hub.files["ci_dddd-03"] = { bytes = png(54, 50), etag = '"i2"', hetag = "2", image = true }
end

-- Favorites: the list.
seed()
local r = call("Favorites", { deviceId = "555" })
check("list: the device's favorites in order, with their logo names",
  r.ok == true and r.exists == true and r.canCreate == true and r.serviceId == "{svc}" and r.count == 3 and
  #r.positions == 3 and r.positions[1].number == "2" and r.positions[1].name == "Kids" and
  r.positions[1].station == "s1" and r.positions[1].image == "cccc-02.png" and
  r.positions[1].logo == "ci_cccc-02" and r.positions[1].stored == true and r.positions[3].name == "News HD" and
  r.max == 64 and type(r.etag) == "string", encodeJson(r))
hub.files["ci_dddd-03"].gone = true
r = call("Favorites", { deviceId = 555 })
check("list: a logo the hub doesn't hold is marked, a number id is accepted",
  r.ok == true and r.positions[2].stored == false and r.positions[1].stored == true, encodeJson(r))
r = call("Favorites", { deviceId = "777" })
check("list: a device with no favorites yet can get some",
  r.ok == true and r.exists == false and r.canCreate == true and r.count == 0 and r.positions == nil, encodeJson(r))
r = call("Favorites", { deviceId = "888" })
check("list: a device made on the hub can't", r.ok == true and r.exists == false and r.canCreate == false and
  type(r.reason) == "string" and r.reason:find("made on the hub", 1, true), encodeJson(r))
r = call("Favorites", { deviceId = "999" })
check("list: nor one that keeps favorites under another device", r.canCreate == false, encodeJson(r))
r = call("Favorites", { deviceId = "1" })
check("list: nor a device the hub doesn't have", r.ok == true and r.canCreate == false, encodeJson(r))
for _, bad in ipairs({ "", "12a", "../x", "1234567890123" }) do
  r = call("Favorites", { deviceId = bad })
  check("list: refuses device id '" .. bad .. "'", r.ok == false, encodeJson(r))
end
check("list: nothing is published or written", hub.published == 0)

-- CommitFavorites: rename, renumber, reorder, delete, add, new logo.
seed()
local before = call("Favorites", { deviceId = "555" })
hub.staged[logoFile(1)] = png(108, 108, "new logo")
hub.staged[logoFile(4)] = png(100, 60, "added logo")
r = call("CommitFavorites", { deviceId = "555", etag = before.etag, positions = {
  { number = "30", name = "  News One ", station = "s2", logo = useLogo(1) },
  { number = "2", name = "Kids", station = "s1", image = "cccc-02.png" },
  { number = "12-1", name = "Sport" },
  { number = "7.2", name = "Film", logo = useLogo(4) },
} })
local cd = fileJson("CD_555")
local saved = cd and cd.services["{svc}"].dialPositions or {}
check("commit: ok and the answer is the new list", r.ok == true and r.count == 4 and #r.positions == 4 and
  r.positions[1].name == "News One" and r.positions[1].stored == true and r.etag ~= before.etag and
  r.configVersion == digest.configVersion, encodeJson(r))
check("commit: order, numbers and trimmed names are saved", #saved == 4 and saved[1].number == "30" and
  saved[1].name == "News One" and saved[2].name == "Kids" and saved[3].number == "12-1" and
  saved[4].number == "7.2", hub.files.CD_555.text)
check("commit: a kept favorite keeps its station and other fields", saved[1].station == "s2" and
  saved[2].station == "s1" and saved[2].extra == "kept" and saved[2].image == "cccc-02.png" and
  saved[2].added == true, hub.files.CD_555.text)
local newImage = saved[1].image or ""
local newUuid = newImage:match("^([%w%-]+)%.png$")
check("commit: an uploaded logo gets a fresh name and is stored", newUuid ~= nil and newImage ~= "dddd-03.png" and
  stored("ci_" .. tostring(newUuid)) and hub.files["ci_" .. tostring(newUuid)].bytes == png(108, 108, "new logo"),
  hub.files.CD_555.text)
check("commit: a new favorite gets a station of its own, and no logo unless one was sent",
  type(saved[3].station) == "string" and saved[3].station ~= "" and saved[3].station ~= saved[4].station and
  saved[3].added == true and saved[3].image == nil and saved[4].image ~= nil and saved[4].image ~= newImage and
  stored("ci_" .. saved[4].image:gsub("%.png$", "")), hub.files.CD_555.text)
check("commit: the record's other fields are untouched", cd.id == "rec-555" and
  cd.device_profile_uri == "profiles.example.invalid/555-a")
local user = fileJson("ContentUser")
local stations = user.preferences["555"]["{svc}"].stations
check("commit: the user record repeats the stations in order", #stations == 4 and stations[1].id == "s2" and
  stations[2].id == "s1" and stations[3].id == saved[3].station and stations[4].id == saved[4].station,
  hub.files.ContentUser.text)
check("commit: other devices' preferences and fields are untouched", user.preferences["444"]["{svc}"].stations[1].id == "gone" and
  user.id == "user" and user.location.country == "XX", hub.files.ContentUser.text)
check("commit: a logo no favorite uses any more is deleted", wasDeleted("ci_dddd-03"), encodeJson(hub.deleted))
check("commit: a logo another device still uses is kept", not wasDeleted("ci_cccc-02") and stored("ci_cccc-02"))
check("commit: one revision, with the content version, so remotes fetch images on wake",
  hub.published == 1 and digest.contentVersion ~= nil, tostring(hub.published))

-- Removing a logo, and every favorite.
seed()
r = call("CommitFavorites", { deviceId = "555", positions = { { number = "2", name = "Kids", station = "s1" } } })
saved = fileJson("CD_555").services["{svc}"].dialPositions
check("commit: leaving the logo out removes it; without an etag the list is replaced as it is",
  r.ok == true and #saved == 1 and saved[1].image == nil and r.positions[1].logo == nil, hub.files.CD_555.text)
check("commit: its logo stays while the other device uses it, the unused one goes",
  stored("ci_cccc-02") and wasDeleted("ci_dddd-03"))
seed()
r = call("CommitFavorites", { deviceId = "555", positions = {} })
check("commit: no favorites left is saved as an empty list, not an object",
  r.ok == true and r.count == 0 and r.positions == nil and
  hub.files.CD_555.text:find('"dialPositions":[]', 1, true) ~= nil and
  hub.files.ContentUser.text:find('"555":{"{svc}":{"stations":[]}}', 1, true) ~= nil, hub.files.CD_555.text)
seed()
r = call("CommitFavorites", { deviceId = "555" })
check("commit: so is a request with no positions at all", r.ok == true and
  hub.files.CD_555.text:find('"dialPositions":[]', 1, true) ~= nil, encodeJson(r))

-- The first favorites of a device.
seed()
hub.staged[logoFile(1)] = png(54, 54)
r = call("CommitFavorites", { deviceId = "777", positions = { { number = "1", name = "One", logo = useLogo(1) } } })
cd = fileJson("CD_777")
check("create: a new record under the household's lineup, with the device's profile",
  r.ok == true and r.exists == true and r.serviceId == "{svc}" and cd ~= nil and
  cd.device_profile_uri == "profiles.example.invalid/777-c" and type(cd.id) == "string" and cd.id ~= "" and
  #cd.services["{svc}"].dialPositions == 1, hub.files.CD_777 and hub.files.CD_777.text)
user = fileJson("ContentUser")
check("create: the user record gets the device's stations", user.preferences["777"] ~= nil and
  user.preferences["777"]["{svc}"].stations[1].id == cd.services["{svc}"].dialPositions[1].station,
  hub.files.ContentUser.text)
seed({ ContentUser = false, CD_555 = false, CD_666 = false })
r = call("CommitFavorites", { deviceId = "777", positions = { { number = "1", name = "One" } } })
cd = fileJson("CD_777")
local lineup = cd and next(cd.services)
check("create: with no lineup anywhere a new one is made, and no user record",
  r.ok == true and type(lineup) == "string" and lineup:match("^{[%x%-]+}$") ~= nil and
  hub.files.ContentUser == nil, hub.files.CD_777 and hub.files.CD_777.text)
seed()
r = call("CommitFavorites", { deviceId = "888", positions = { { number = "1", name = "One" } } })
check("create: refused for a device made on the hub", r.ok == false and hub.files.CD_888 == nil and
  hub.published == 0, encodeJson(r))
seed({ CD_555 = { id = "rec-555", services = {} } })
r = call("CommitFavorites", { deviceId = "555", positions = { { number = "1", name = "One" } } })
cd = fileJson("CD_555")
check("create: a record with no services gets the device's own lineup",
  r.ok == true and cd.services["{svc}"] ~= nil and #cd.services["{svc}"].dialPositions == 1, hub.files.CD_555.text)

-- Refusals: nothing is written.
local function refused(name, fields, setup)
  seed()
  if setup then setup() end
  local text, userText = hub.files.CD_555.text, hub.files.ContentUser.text
  local reply = call("CommitFavorites", fields)
  local images = 0
  for _, file in pairs(hub.files) do
    if file.image and not file.gone then images = images + 1 end
  end
  check("refuse: " .. name, reply.ok == false and type(reply.error) == "string" and hub.files.CD_555.text == text and
    hub.files.ContentUser.text == userText and hub.published == 0 and images == 2, encodeJson(reply))
  return reply
end
refused("a stale etag", { deviceId = "555", etag = '"old"', positions = {} })
refused("a number with letters", { deviceId = "555", positions = { { number = "12a", name = "X" } } })
refused("an empty number", { deviceId = "555", positions = { { number = "", name = "X" } } })
refused("a number that is too long", { deviceId = "555", positions = { { number = "123456789", name = "X" } } })
refused("an empty name", { deviceId = "555", positions = { { number = "1", name = "   " } } })
refused("a name that is too long", { deviceId = "555", positions = { { number = "1", name = string.rep("n", 65) } } })
refused("a name with control characters", { deviceId = "555", positions = { { number = "1", name = "a\nb" } } })
refused("a station from elsewhere", { deviceId = "555", positions = { { number = "1", name = "X", station = "t1" } } })
refused("the same station twice", { deviceId = "555", positions = {
  { number = "1", name = "X", station = "s1" }, { number = "2", name = "Y", station = "s1" } } })
refused("a logo this device doesn't use", { deviceId = "555", positions = { { number = "1", name = "X", image = "eeee-09.png" } } })
refused("a logo path outside the staging area", { deviceId = "555", logoFiles = { "/etc/passwd" },
  positions = { { number = "1", name = "X", logo = 0 } } })
refused("a logo that wasn't sent", { deviceId = "555", logoFiles = {},
  positions = { { number = "1", name = "X", logo = 3 } } })
refused("a logo that isn't a place in the list", { deviceId = "555", logoFiles = { logoFile(1) },
  positions = { { number = "1", name = "X", logo = "0" } } }, function() hub.staged[logoFile(1)] = png(54, 54) end)
refused("a staged file that isn't a PNG", { deviceId = "555", positions = { { number = "1", name = "X", logo = useLogo(1) } } },
  function() hub.staged[logoFile(1)] = "GIF89a" .. string.rep("x", 40) end)
refused("a logo larger than 512x512", { deviceId = "555", positions = { { number = "1", name = "X", logo = useLogo(1) } } },
  function() hub.staged[logoFile(1)] = png(600, 54) end)
refused("a second bad logo after a good one", { deviceId = "555", positions = {
  { number = "1", name = "X", logo = useLogo(1) }, { number = "2", name = "Y", logo = useLogo(2) } } },
  function() hub.staged[logoFile(1)] = png(54, 54) end)
local many = {}
for i = 1, 65 do many[i] = { number = tostring(i), name = "C" .. i } end
refused("more than 64 favorites", { deviceId = "555", positions = many })
refused("positions that aren't a list", { deviceId = "555", positions = "all" })
refused("a bad device id", { deviceId = "5x5", positions = {} })
refused("the cloud blocker off", { deviceId = "555", positions = {} }, function() hub.blocker = "0\n" end)

-- A failed write is undone.
seed()
hub.staged[logoFile(1)] = png(54, 54, "lost")
local original = fileJson("CD_555")
hub.failSave = "CD_555"
r = call("CommitFavorites", { deviceId = "555", positions = { { number = "1", name = "X", logo = useLogo(1) } } })
local images = 0
for _, file in pairs(hub.files) do
  if file.image and not file.gone then images = images + 1 end
end
check("undo: a failed save restores the list and drops the new logo", r.ok == false and r.rolledBack == true and
  #fileJson("CD_555").services["{svc}"].dialPositions == #original.services["{svc}"].dialPositions and
  images == 2 and hub.published == 0, encodeJson(r))
seed()
hub.failSave = "ContentUser"
r = call("CommitFavorites", { deviceId = "555", positions = { { number = "1", name = "X" } } })
check("undo: a failed user record save restores both", r.ok == false and r.rolledBack == true and
  #fileJson("CD_555").services["{svc}"].dialPositions == 3 and
  #fileJson("ContentUser").preferences["555"]["{svc}"].stations == 3 and hub.published == 0 and
  not wasDeleted("ci_dddd-03"), encodeJson(r))

-- The image list (RemoteImages) follows the favorites.
seed()
hub.staged[logoFile(1)] = png(54, 54)
call("CommitFavorites", { deviceId = "555", positions = { { number = "1", name = "X", logo = useLogo(1) } } })
r = call("RemoteImages")
local names = byName(r.images)
local only = fileJson("CD_555").services["{svc}"].dialPositions[1].image:gsub("%.png$", "")
check("images: the list names the uploaded logo as stored", names["ci_" .. only] ~= nil and
  names["ci_" .. only].stored == true and r.missing == 0, encodeJson(r))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
