-- LuaJIT tests for remote images in payload/activity/codexactivity.lua:
-- RemoteImages lists the activity icons (ImageKey and its _small) and
-- favorite channel logos (CD_<deviceId> dialPositions) the hub's data asks
-- for and whether the store holds them; CommitRemoteImages stores only
-- images from that list and publishes one revision; CommitActivityIcon
-- stores a new 70x70 icon and 38x38 thumbnail under a fresh name.
--
-- Same loading pattern as codexactivity-remote-background-test.lua: stub the
-- hub modules, reach processRequest through discover()'s upvalues, and keep
-- the resources in an in-memory fake. No hub is contacted, nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-remote-images-test.lua

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
  return processRequest(encodeJson(raw))
end
local function byName(images)
  local out = {}
  for _, p in ipairs(images or {}) do out[p.name] = p end
  return out
end

-- A hub with two activities (one with a Logitech icon, one without) and a
-- cable box with two favorites (made-up names and ids).
local BASE = "https://images.example.invalid/"
local function seed()
  resetHub({
    ActivityList = { Activities = {
      { ["Id-"] = 100, Name = "Watch TV", ImageKey = "Activity/1_aaaa-01.png", BaseImageUri = BASE },
      { ["Id-"] = 200, Name = "Music", ImageKey = NULL, BaseImageUri = NULL },
      { ["Id-"] = 300, Name = "Copy", ImageKey = "Activity/1_aaaa-01.png", BaseImageUri = BASE },
    } },
    CD_555 = { id = "x", services = { ["{svc}"] = { dialPositions = {
      { number = "2", image = "cccc-02.png", name = "Kids", station = "s1", added = true },
      { number = "3", image = "dddd-03.png", name = "News", station = "s2", added = true },
      { number = "4", image = "dddd-03.png", name = "News HD", station = "s3", added = true },
    } } } },
    Settings = { Settings = {} },
  })
end

-- RemoteImages: the list comes from the hub's own data.
seed()
local r = call("RemoteImages")
local list = byName(r.images)
check("list: ok, icon + thumbnail per activity icon, one per distinct logo, no duplicates",
  r.ok == true and #r.images == 4 and r.missing == 4, encodeJson(r))
check("list: the activity icon and its _small, with the address the remote asks for",
  list["1_aaaa-01"] and list["1_aaaa-01"].kind == "activity" and
  list["1_aaaa-01"].uri == BASE .. "Activity/1_aaaa-01.png" and list["1_aaaa-01"].activityId == "100" and
  list["1_aaaa-01"].activityName == "Watch TV" and
  list["1_aaaa-01_small"] and list["1_aaaa-01_small"].uri == BASE .. "Activity/1_aaaa-01_small.png",
  encodeJson(r.images))
check("list: favorite logos as ci_<uuid> with their content-image address",
  list["ci_cccc-02"] and list["ci_cccc-02"].kind == "logo" and list["ci_cccc-02"].deviceId == "555" and
  list["ci_cccc-02"].channel == "Kids" and list["ci_cccc-02"].number == "2" and
  list["ci_cccc-02"].uri == "content-image://1.0/image/cccc-02.png" and list["ci_dddd-03"] ~= nil,
  encodeJson(r.images))
check("list: nothing stored yet", not list["1_aaaa-01"].stored and not list["ci_cccc-02"].stored)
check("list: read-only, nothing published", hub.published == 0)
check("list: total and not truncated", r.total == 4 and r.truncated == false, encodeJson(r))

-- A hub with very many favorites: the list stops at 100 entries, counts stay whole.
local many = {}
for i = 1, 150 do many[i] = { number = tostring(i), image = string.format("eeee-%04d.png", i), name = "C" .. i } end
resetHub({ ActivityList = { Activities = {} }, CD_777 = { services = { ["{s}"] = { dialPositions = many } } } })
r = call("RemoteImages")
check("list over 100 entries: truncated to 100, total and missing still count all",
  #r.images == 100 and r.total == 150 and r.missing == 150 and r.truncated == true and
  #encodeJson(r) < 32 * 1024, string.format("%d %s %s %d", #r.images, tostring(r.total), tostring(r.missing), #encodeJson(r)))
seed()

-- CommitRemoteImages: stores what the list asks for, then one revision.
hub.staged[imageFile(1)] = png(70, 70, "icon")
hub.staged[imageFile(2)] = png(54, 50, "logo")
local before = digest.configVersion
r = call("CommitRemoteImages", { images = {
  { name = "1_aaaa-01", file = imageFile(1) },
  { name = "ci_cccc-02", file = imageFile(2) },
} })
check("sync: both saved, nothing failed", r.ok == true and #r.saved == 2 and #r.failed == 0, encodeJson(r))
check("sync: the bytes are in the store under those names",
  hub.files["1_aaaa-01"].image and hub.files["1_aaaa-01"].bytes == png(70, 70, "icon") and
  hub.files["ci_cccc-02"].bytes == png(54, 50, "logo"))
check("sync: one revision published", hub.published == 1 and digest.configVersion == before + 1 and
  r.configVersion == digest.configVersion)
r = call("RemoteImages")
list = byName(r.images)
check("list after sync: stored flags and the missing count follow",
  list["1_aaaa-01"].stored == true and list["ci_cccc-02"].stored == true and
  not list["1_aaaa-01_small"].stored and r.missing == 2, encodeJson(r))
check("list after sync: missing images come first, stored ones after",
  r.images[1].stored == false and r.images[2].stored == false and
  r.images[3].stored == true and r.images[4].stored == true, encodeJson(r.images))
check("list without discovery data: no logo host", r.contentImageHost == nil, encodeJson(r))
hub.discovery = encodeJson({ discoveryUrls = {
  { Identifier = "ContentService/config", Address = "https://other.example.invalid/1.0/config" },
  { Identifier = "ContentImageService/Image", Address = "https://logos.example.invalid/1.0/station/{stationId}/image;maxX=40" },
} })
r = call("RemoteImages")
check("list: the logo host from the hub's discovery data", r.contentImageHost == "https://logos.example.invalid",
  tostring(r.contentImageHost))
hub.discovery = "not json"
r = call("RemoteImages")
check("list with broken discovery data: still answers, no logo host", r.ok == true and r.contentImageHost == nil)

-- Only images from the list; bad files are reported per image.
seed()
hub.staged[imageFile(1)] = png(70, 70)
hub.staged[imageFile(2)] = "GIF89a" .. string.rep("x", 40)
hub.staged[imageFile(3)] = png(600, 70)
hub.staged["/var/volatile/other.png"] = png(70, 70)
r = call("CommitRemoteImages", { images = {
  { name = "1_aaaa-01", file = imageFile(1) },
  { name = "Settings", file = imageFile(1) },
  { name = "someone_else", file = imageFile(1) },
  { name = "ci_cccc-02", file = imageFile(2) },
  { name = "ci_dddd-03", file = imageFile(3) },
  { name = "1_aaaa-01_small", file = "/var/volatile/other.png" },
} })
local failedNames = {}
for _, f in ipairs(r.failed or {}) do failedNames[f.name] = f.error end
check("sync mix: only the good, listed image is saved", r.ok == true and #r.saved == 1 and
  r.saved[1] == "1_aaaa-01" and #r.failed == 5, encodeJson(r))
check("sync mix: a resource name that isn't a needed image is refused (Settings untouched)",
  failedNames.Settings and failedNames.Settings:find("not an image", 1, true) and
  not hub.files.Settings.image and failedNames.someone_else ~= nil and hub.files.someone_else == nil)
check("sync mix: not a PNG, too large and a foreign staging path are refused",
  failedNames["ci_cccc-02"]:find("isn't a PNG", 1, true) and failedNames["ci_dddd-03"]:find("at most", 1, true) and
  failedNames["1_aaaa-01_small"]:find("wasn't received", 1, true), encodeJson(failedNames))

seed()
hub.staged[imageFile(1)] = "nope"
r = call("CommitRemoteImages", { images = { { name = "1_aaaa-01", file = imageFile(1) } } })
check("sync with nothing saved: not ok, says why, nothing published",
  r.ok == false and type(r.error) == "string" and hub.published == 0, encodeJson(r))
r = call("CommitRemoteImages", { images = {} })
check("sync with an empty list: refused", r.ok == false and hub.published == 0, encodeJson(r))

seed()
hub.blocker = "0\n"
hub.staged[imageFile(1)] = png(70, 70)
r = call("CommitRemoteImages", { images = { { name = "1_aaaa-01", file = imageFile(1) } } })
check("sync with the cloud blocker off: refused", r.ok == false and r.error:find("cloud blocker", 1, true) and
  not hub.files["1_aaaa-01"], encodeJson(r))

-- CommitActivityIcon: a new 70x70 icon and 38x38 thumbnail under a fresh name.
seed()
hub.staged[ICON] = png(70, 70, "new")
hub.staged[ICON_SMALL] = png(38, 38, "new-small")
r = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL })
check("new icon: ok, named <account>_<uuid>, with its ImageKey",
  r.ok == true and r.name and r.name:match("^12345678_%x+%-%x+%-%x+%-%x+%-%x+$") and
  r.imageKey == "Activity/" .. r.name .. ".png", encodeJson(r))
check("new icon: both sizes in the store", r.name and hub.files[r.name].bytes == png(70, 70, "new") and
  hub.files[r.name .. "_small"].bytes == png(38, 38, "new-small"))
check("new icon: no revision yet (the activity save publishes it)", hub.published == 0)

local function iconRefused(label, image, small, pattern)
  seed()
  hub.staged[ICON] = image
  hub.staged[ICON_SMALL] = small
  local reply = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL })
  local images = 0
  for _, file in pairs(hub.files) do if file.image then images = images + 1 end end
  check(label, reply.ok == false and reply.error:find(pattern, 1, true) ~= nil and images == 0, encodeJson(reply))
end
iconRefused("new icon of the wrong size: refused", png(64, 64), png(38, 38), "must be 70x70")
iconRefused("new icon thumbnail of the wrong size: refused", png(70, 70), png(32, 32), "must be 38x38")
iconRefused("new icon that isn't a PNG: refused", "GIF89a" .. string.rep("x", 40), png(38, 38), "isn't a PNG")
iconRefused("new icon without its thumbnail: refused", png(70, 70), nil, "wasn't received")

seed()
hub.staged["/var/volatile/other.png"] = png(70, 70)
hub.staged[ICON_SMALL] = png(38, 38)
r = call("CommitActivityIcon", { imageFile = "/var/volatile/other.png", thumbnailFile = ICON_SMALL })
check("new icon from a foreign staging path: refused", r.ok == false, encodeJson(r))

seed()
hub.staged[ICON] = png(70, 70)
hub.staged[ICON_SMALL] = png(38, 38)
hub.blocker = "0\n"
r = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL })
check("new icon with the cloud blocker off: refused", r.ok == false and r.error:find("cloud blocker", 1, true),
  encodeJson(r))

-- CommitActivityIcon with activityId: the icon goes on the activity at once,
-- by saving ActivityList alone (a full activity save doesn't fit in a hub
-- with large lists).
local function activityById(id)
  for _, a in ipairs(decodeJson(hub.files.ActivityList.text).Activities) do
    if tostring(a["Id-"]) == id then return a end
  end
end
seed()
hub.files["1_aaaa-01"] = { bytes = "x", etag = '"o"', hetag = "1", image = true }
hub.files["1_aaaa-01_small"] = { bytes = "x", etag = '"o"', hetag = "1", image = true }
hub.files.MapList = { text = '{"ButtonMaps":[]}', etag = '"map"', hetag = "1" }
hub.staged[ICON] = png(70, 70, "direct")
hub.staged[ICON_SMALL] = png(38, 38, "direct-small")
local beforeVersion, mapEtag = digest.configVersion, hub.files.MapList.etag
r = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "200",
  baseImageUri = "https://icons.example.invalid/" })
check("direct icon: ok, with the new key and one revision",
  r.ok == true and r.activityId == "200" and r.imageKey == "Activity/" .. tostring(r.name) .. ".png" and
  hub.published == 1 and digest.configVersion == beforeVersion + 1 and r.configVersion == digest.configVersion,
  encodeJson(r))
check("direct icon: the activity has it, and the address it lacked",
  activityById("200").ImageKey == r.imageKey and
  activityById("200").BaseImageUri == "https://icons.example.invalid/", hub.files.ActivityList.text)
check("direct icon: other activities and other resources untouched",
  activityById("100").ImageKey == "Activity/1_aaaa-01.png" and activityById("100").BaseImageUri == BASE and
  hub.files.MapList.etag == mapEtag and #hub.deleted == 0, encodeJson(hub.deleted))

-- Replacing an icon another activity still uses keeps the old files; once
-- the last user is gone they are deleted.
hub.staged[ICON] = png(70, 70, "second")
r = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "100" })
check("direct icon on an activity with an address: keeps that address, old icon kept while activity 300 uses it",
  r.ok == true and activityById("100").BaseImageUri == BASE and activityById("100").ImageKey == r.imageKey and
  #hub.deleted == 0, encodeJson(r))
r = call("CommitActivityIcon", { activityId = "300", clear = true })
table.sort(hub.deleted)
check("remove icon: cleared on the activity, and the now unused icon files are deleted",
  r.ok == true and r.cleared == true and activityById("300").ImageKey == NULL and
  encodeJson(hub.deleted) == '["1_aaaa-01","1_aaaa-01_small"]', encodeJson(r) .. encodeJson(hub.deleted))

-- Refusals leave everything as it was.
local function directRefused(label, fields, pattern)
  seed()
  hub.staged[ICON] = png(70, 70)
  hub.staged[ICON_SMALL] = png(38, 38)
  local listBefore = hub.files.ActivityList.text
  local reply = call("CommitActivityIcon", fields)
  local images = 0
  for _, file in pairs(hub.files) do if file.image and not file.gone then images = images + 1 end end
  check(label, reply.ok == false and reply.error:find(pattern, 1, true) ~= nil and images == 0 and
    hub.files.ActivityList.text == listBefore and hub.published == 0, encodeJson(reply))
end
directRefused("direct icon for an activity the hub doesn't have: refused, icon files removed",
  { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "999" }, "save the activity first")
directRefused("direct icon with a bad activity id: refused",
  { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "1; rm" }, "must be a number")
directRefused("direct icon on an activity without an address and none sent: refused",
  { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "200" }, "send baseImageUri")
directRefused("direct icon with an address that isn't a plain https host: refused",
  { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "200", baseImageUri = "https://x.invalid/a/b" },
  "send baseImageUri")
directRefused("remove icon without an activity: refused", { clear = true }, "give the activity")

-- ActivityList can't be written: the old list is put back, the new files go.
seed()
hub.staged[ICON] = png(70, 70)
hub.staged[ICON_SMALL] = png(38, 38)
local listEtag = hub.files.ActivityList.etag
hub.failSave = "ActivityList"
r = call("CommitActivityIcon", { imageFile = ICON, thumbnailFile = ICON_SMALL, activityId = "100" })
check("direct icon when ActivityList can't be saved: rolled back, nothing published",
  r.ok == false and r.rolledBack == true and hub.files.ActivityList.etag == listEtag and
  activityById("100").ImageKey == "Activity/1_aaaa-01.png" and hub.published == 0, encodeJson(r))

-- Long names: the list stays under codex_webui's 32 KB answer limit.
local long = {}
for i = 1, 100 do
  long[i] = { number = tostring(i), image = string.format("ffff-%04d.png", i), name = string.rep("n", 300) }
end
resetHub({ ActivityList = { Activities = {} }, CD_888 = { services = { ["{s}"] = { dialPositions = long } } } })
r = call("RemoteImages")
check("list with long names: cut by size, well under 32 KB, counts whole",
  #r.images < 100 and #r.images > 10 and r.truncated == true and r.total == 100 and r.missing == 100 and
  #encodeJson(r) < 28 * 1024, string.format("%d entries, %d bytes", #r.images, #encodeJson(r)))

-- offset skips that many missing images, so a caller gets past failures.
seed()
r = call("RemoteImages")
local first, third = r.images[1].name, r.images[3].name
r = call("RemoteImages", { offset = 2 })
check("list with offset 2: starts at the third missing image, counts unchanged",
  r.images[1].name == third and r.images[1].name ~= first and #r.images == 2 and
  r.missing == 4 and r.total == 4 and r.offset == 2, encodeJson(r))
r = call("RemoteImages", { offset = 99 })
check("list with an offset past the end: no missing entries listed", #r.images == 0 and r.missing == 4, encodeJson(r))
r = call("RemoteImages", { offset = "junk" })
check("list with a bad offset: treated as 0", #r.images == 4 and r.offset == 0, encodeJson(r))

-- After an activity save, icons only the old list used are deleted.
local images = findUpvalue(plugin.discover, "remoteImages")
check("the image section is reachable", type(images) == "table" and type(images.pruneActivityIcons) == "function")
seed()
for _, name in ipairs({ "old-1", "old-1_small", "keep-2", "keep-2_small", "bg_9" }) do
  hub.files[name] = { bytes = "x", etag = '"e"', hetag = "1", image = true }
end
images.pruneActivityIcons(
  { Activities = {
    { ["Id-"] = 1, ImageKey = "Activity/old-1.png" },
    { ["Id-"] = 2, ImageKey = "Activity/keep-2.png" },
    { ["Id-"] = 3, ImageKey = "Activity/keep-2.png" },
    { ["Id-"] = 4, ImageKey = NULL },
  } },
  { Activities = {
    { ["Id-"] = 1, ImageKey = "Activity/new-5.png" },
    { ["Id-"] = 3, ImageKey = "Activity/keep-2.png" },
  } })
table.sort(hub.deleted)
check("prune: the replaced icon and its thumbnail go, a still used one and other images stay",
  encodeJson(hub.deleted) == '["old-1","old-1_small"]', encodeJson(hub.deleted))
hub.deleted = {}
images.pruneActivityIcons({ Activities = { { ImageKey = "Activity/keep-2.png" } } }, { Activities = {} })
table.sort(hub.deleted)
check("prune: a removed activity's icon goes", encodeJson(hub.deleted) == '["keep-2","keep-2_small"]', encodeJson(hub.deleted))
hub.deleted = {}
images.pruneActivityIcons(nil, { Activities = {} })
images.pruneActivityIcons({ Activities = { { ImageKey = "Activity/../x.png" }, "junk" } }, nil)
check("prune: odd input deletes nothing", #hub.deleted == 0, encodeJson(hub.deleted))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
