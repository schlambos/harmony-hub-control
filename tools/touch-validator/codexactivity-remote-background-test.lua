-- LuaJIT tests for remote backgrounds in payload/activity/codexactivity.lua:
-- CommitRemoteBackground saves an uploaded picture and its thumbnail as images
-- in the resource store, makes it the paired screen remote's background in the
-- Settings resource, keeps its list of pictures to MaxCount (deleting the files
-- of one that drops off), switches to a listed picture or back to Logitech's
-- default, and refuses anything else without writing.
--
-- Same loading pattern as codexactivity-device-screens-test.lua: stub the hub
-- modules, reach processRequest through discover()'s upvalues, and keep the
-- resources in an in-memory fake with etags. No hub is contacted and nothing
-- is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-remote-background-test.lua

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

-- codex_webui stages an upload under its own process id.
local STAGED = "/var/volatile/codex-remote-background-4242.png"
local STAGED_SMALL = "/var/volatile/codex-remote-background-4242-small.png"
local realOpen = io.open
io.open = function(path, mode)
  local text
  if path == "/data/codex/cloud_blocker.conf" then
    text = hub.blocker
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
local function background(fields)
  requestCounter = requestCounter + 1
  local raw = { id = "r" .. requestCounter, op = "CommitRemoteBackground" }
  if fields.action == "upload" then
    raw.imageFile, raw.thumbnailFile = STAGED, STAGED_SMALL
  end
  for key, value in pairs(fields) do raw[key] = value end
  return processRequest(encodeJson(raw))
end
local function stored(name) return decodeJson(hub.files[name].text) end
local function setting(name)
  for _, entry in ipairs(stored("Settings").Settings) do
    if entry.Name == name then return entry.Values end
  end
end
local function stage(image, small)
  hub.staged[STAGED] = image
  hub.staged[STAGED_SMALL] = small
end

-- A paired Elite's settings, as Logitech left them (made-up picture names).
local DEFAULT = "8d8f352a-0000-4000-8000-000000000001.png"
local function eliteSettings(userImages, current)
  return {
    RemoteName = "Harmony Elite",
    UserImageBucketUri = "https://images.example.invalid/UserImages/111/",
    DefaultImageBucketUri = "https://images.example.invalid/DefaultImages/111/",
    Settings = {
      { SettingId = 1, Name = "UserImages", MaxCount = 5, MinCount = 0, DefaultValue = NULL, Values = userImages or {} },
      { SettingId = 2, Name = "BackgroundImage", MaxCount = 1, MinCount = 0, DefaultValue = DEFAULT,
        Values = current or { DEFAULT } },
      { SettingId = 4, Name = "ScreenBrightness", MaxCount = 1, MinCount = 0, DefaultValue = NULL, Values = { "85" } },
    },
  }
end

-- Upload: both images saved, the picture first in the list and the background.
resetHub({ Settings = eliteSettings() })
stage(png(240, 320, "full"), png(60, 80, "small"))
local before = digest.configVersion
local r = background({ action = "upload" })
local name = r.saved and r.saved:match("^(.+)%.png$")
check("upload: ok, with the saved picture's name",
  r.ok == true and r.changed == true and type(r.saved) == "string", encodeJson(r))
check("upload: named <account>_<uuid>.png like Logitech's own pictures",
  name and name:match("^12345678_%x+%-%x+%-%x+%-%x+%-%x+$") ~= nil, tostring(r.saved))
check("upload: the picture and its thumbnail are images in the store",
  name and hub.files[name] and hub.files[name].image and hub.files[name].bytes == png(240, 320, "full") and
  hub.files[name .. "_small"] and hub.files[name .. "_small"].bytes == png(60, 80, "small"))
check("upload: it's the background and first in the list",
  setting("BackgroundImage")[1] == r.saved and setting("UserImages")[1] == r.saved and
  #setting("UserImages") == 1, encodeJson(stored("Settings")))
check("upload: other settings untouched",
  setting("ScreenBrightness")[1] == "85" and stored("Settings").RemoteName == "Harmony Elite")
check("upload: one revision published", hub.published == 1 and digest.configVersion == before + 1 and
  r.configVersion == digest.configVersion)

-- A full list: the oldest picture drops off and loses its files.
local five = {}
for i = 1, 5 do five[i] = "old_" .. i .. ".png" end
resetHub({ Settings = eliteSettings(five, { "old_2.png" }) })
for i = 1, 5 do
  hub.files["old_" .. i] = { bytes = "x", etag = '"o' .. i .. '"', hetag = "1", image = true }
  hub.files["old_" .. i .. "_small"] = { bytes = "x", etag = '"s' .. i .. '"', hetag = "1", image = true }
end
stage(png(240, 320), png(60, 80))
r = background({ action = "upload" })
local list = setting("UserImages")
check("full list: kept to MaxCount, newest first, oldest gone",
  #list == 5 and list[1] == r.saved and list[2] == "old_1.png" and list[5] == "old_4.png", encodeJson(list))
check("full list: the dropped picture's files are deleted, nothing else",
  #hub.deleted == 2 and hub.deleted[1] == "old_5" and hub.deleted[2] == "old_5_small", encodeJson(hub.deleted))

-- Select a listed picture; selecting it again changes nothing.
resetHub({ Settings = eliteSettings({ "a.png", "b.png" }, { "a.png" }) })
r = background({ action = "select", image = "b.png" })
check("select: switches the background", r.ok and r.changed and setting("BackgroundImage")[1] == "b.png" and
  hub.published == 1, encodeJson(r))
check("select: the list is unchanged", encodeJson(setting("UserImages")) == '["a.png","b.png"]')
r = background({ action = "select", image = "b.png" })
check("select again: unchanged, nothing saved or published", r.ok and r.changed == false and hub.published == 1,
  encodeJson(r))

r = background({ action = "select", image = "c.png" })
check("select a picture that isn't listed: refused", r.ok == false and setting("BackgroundImage")[1] == "b.png",
  encodeJson(r))

-- Back to Logitech's default background.
r = background({ action = "default" })
check("default: the remote's own default picture", r.ok and setting("BackgroundImage")[1] == DEFAULT and
  encodeJson(setting("UserImages")) == '["a.png","b.png"]', encodeJson(r))

-- Bad uploads: nothing saved, nothing published.
local function refused(label, image, small, pattern)
  resetHub({ Settings = eliteSettings() })
  stage(image, small)
  local reply = background({ action = "upload" })
  local images = 0
  for _, file in pairs(hub.files) do if file.image then images = images + 1 end end
  check(label, reply.ok == false and reply.error:find(pattern, 1, true) ~= nil and images == 0 and
    hub.published == 0 and setting("BackgroundImage")[1] == DEFAULT, encodeJson(reply))
end
refused("upload of the wrong size: refused", png(320, 240), png(60, 80), "must be 240x320")
refused("thumbnail of the wrong size: refused", png(240, 320), png(80, 60), "must be 60x80")
refused("upload that isn't a PNG: refused", "GIF89a" .. string.rep("x", 40), png(60, 80), "isn't a PNG")
refused("upload without its thumbnail: refused", png(240, 320), nil, "thumbnail wasn't received")
refused("upload over 512 KB: refused", png(240, 320, string.rep("x", 512 * 1024)), png(60, 80), "larger than 512 KB")

resetHub({ Settings = eliteSettings() })
r = background({ action = "rotate" })
check("unknown action: refused", r.ok == false and hub.published == 0, encodeJson(r))

-- Only codex_webui's own staging files are read.
resetHub({ Settings = eliteSettings() })
hub.staged["/var/volatile/other.png"] = png(240, 320)
stage(png(240, 320), png(60, 80))
r = background({ action = "upload", imageFile = "/var/volatile/other.png" })
check("upload from a path outside codex_webui's staging names: refused",
  r.ok == false and r.error:find("wasn't received", 1, true) ~= nil and hub.published == 0, encodeJson(r))
r = background({ action = "upload", imageFile = "/data/resources/Settings.json" })
check("upload from a resource file: refused", r.ok == false and hub.published == 0, encodeJson(r))

-- No remote with a screen has synced with this hub yet.
resetHub({})
stage(png(240, 320), png(60, 80))
r = background({ action = "upload" })
check("no remote settings: refused, says why", r.ok == false and r.error:find("pair one", 1, true) ~= nil and
  next(hub.files) == nil, encodeJson(r))

-- Cloud blocker off: refused.
resetHub({ Settings = eliteSettings() })
hub.blocker = "0\n"
stage(png(240, 320), png(60, 80))
r = background({ action = "upload" })
check("cloud blocker off: refused", r.ok == false and r.error:find("cloud blocker", 1, true) ~= nil and
  hub.published == 0, encodeJson(r))

-- Settings can't be written: restored, and the new picture's files removed.
resetHub({ Settings = eliteSettings({ "a.png" }, { "a.png" }) })
local seedEtag = hub.files.Settings.etag
stage(png(240, 320), png(60, 80))
hub.failSave = "Settings"
r = background({ action = "upload" })
check("Settings save fails: rolled back with its old etag",
  r.ok == false and r.rolledBack == true and hub.files.Settings.etag == seedEtag and
  setting("BackgroundImage")[1] == "a.png" and encodeJson(setting("UserImages")) == '["a.png"]', encodeJson(r))
check("Settings save fails: the new picture's files are deleted, nothing published",
  #hub.deleted == 2 and hub.published == 0, encodeJson(hub.deleted))

-- A hub that doesn't know its account: the uuid alone.
account = nil
resetHub({ Settings = eliteSettings() })
stage(png(240, 320), png(60, 80))
r = background({ action = "upload" })
check("no account id: named <uuid>.png",
  r.ok and r.saved:match("^%x+%-%x+%-%x+%-%x+%-%x+%.png$") ~= nil, tostring(r.saved))

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
