-- LuaJIT tests for the offline guards in payload/scripts/netservicestarter.lua
-- that answer the Harmony Touch's own Sync: the time is answered locally, the
-- hub firmware check is deliberately left to the stock handler (a successful
-- check strands the Touch on a "myharmony.com" screen offline), and a device
-- content file the hub doesn't have is answered with an empty record (a 404
-- aborts every Touch sync).
--
-- Loads the script with stubbed hub modules (mfgData.hasNetwork = false, so
-- it only "loads" its transport tasks), captures what it registers with the
-- engine, and calls the handlers with the cloud blocker on and off and with
-- a sane and an unset clock. No hub is contacted and nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/netservicestarter-guards-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local blocker = "1"
local fakeNow = nil
local handlers, nativeCalls = {}, {}

local function noop() return nil end
local function anything()
  return setmetatable({}, { __index = function() return noop end })
end

-- Small JSON encoder (sorted keys) for the responses under test.
local function encode(v)
  local t = type(v)
  if t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t ~= "table" then return "null" end
  if #v > 0 or next(v) == nil then
    local parts = {}
    for i = 1, #v do parts[i] = encode(v[i]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do parts[#parts + 1] = encode(k) .. ":" .. encode(v[k]) end
  return "{" .. table.concat(parts, ",") .. "}"
end

local fakeIo = {
  open = function(path)
    if path ~= "/data/codex/cloud_blocker.conf" or blocker == nil then return nil end
    return { read = function() return blocker end, close = noop }
  end,
}

local realOs = os
package.loaded["os"] = setmetatable({
  time = function(...) if fakeNow and select("#", ...) == 0 then return fakeNow end return realOs.time(...) end,
}, { __index = realOs })

package.preload["system"] = function()
  local s = anything()
  rawset(s, "io", fakeIo)
  rawset(s, "getFirmwareVersion", function() return "4.15.600" end)
  return s
end
package.preload["json"] = function() return { encode = encode, decode = noop, null = {} } end
package.preload["log"] = function()
  local logger = { notice = noop, error = noop, warning = noop, debug = noop, info = noop }
  return { logger = function() return logger end }
end
package.preload["tasks.hal.core.hbus"] = function() return { instance = function() return anything() end } end
package.preload["socket.http"] = function() return { request = noop } end
package.preload["socket"] = function() return anything() end
package.preload["tasks.connectserver.core.utils"] = function()
  return {
    createResponse = function(cmd, code, msg, data) return { cmd = cmd, code = code, msg = msg, data = data } end,
    fixHbusData = noop,
  }
end
package.preload["tasks.connectserver.core.engine"] = function()
  return { registerMessage = function(mime, _, fn) handlers[mime] = fn end }
end
package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = false } end
-- Resources the stub resource manager has, by name.
local stored = {}
package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
  return {
    getResource = function(name)
      local entry = stored[name]
      if not entry then return nil, "indexInfo not available for the resource " .. name end
      return "200", entry.etag, entry.resource
    end,
    getHubEtag = function(name) return stored[name] and stored[name].hetag end,
  }
end
for _, name in ipairs({
  "tasks.harmonywebservices.apihandler.resource",
  "tasks.setup.apihandler.sync",
  "tasks.harmonywebservices.core.preferencemanager",
  "tasks.harmonywebservices.core.session",
}) do
  package.preload[name] = function() return anything() end
end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return { instance = function() return { tz = "EST5EDT,M3.2.0,M11.1.0" } end }
end
package.preload["tasks.harmonyengine.apihandler.harmonyengine"] = function()
  return { processCmdGetTime = function(cmd) nativeCalls[#nativeCalls + 1] = cmd return { native = cmd } end }
end
package.preload["tasks.setup.apihandler.firmware"] = function()
  return { processCmdDefault = function(cmd) nativeCalls[#nativeCalls + 1] = cmd return { native = cmd } end }
end

local chunk = assert(loadfile(repoRoot .. "/payload/scripts/netservicestarter.lua"))
chunk()

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

local getTime = handlers["harmony.engine?gettime"]
check("registers the time guard under the stock name", type(getTime) == "function")
check("leaves every firmware command to the stock handlers",
  handlers["setup.firmware?check"] == nil and handlers["setup.firmware"] == nil and
  handlers["harmony.firmware"] == nil)
if type(getTime) ~= "function" then
  print(string.format("%d/%d checks passed", count - failures, count))
  os.exit(1)
end

-- Blocker on, clock set: the hub answers the time itself.
blocker, fakeNow, nativeCalls = "1", 1792850000, {}
local r = getTime("harmony.engine?getTime", nil, {})
check("blocker on: the time comes from the hub clock",
  r.code == "200" and type(r.data) == "table" and type(r.data.utcTime) == "table" and
  r.data.utcTime.year == 2026 and r.data.tz == "EST5EDT,M3.2.0,M11.1.0" and #nativeCalls == 0,
  encode(r))

-- Blocker on, clock never set: don't hand the Touch a 1970 date.
blocker, fakeNow, nativeCalls = "1", 3600, {}
r = getTime("harmony.engine?getTime", nil, {})
check("blocker on, clock unset: falls back to the stock answer", r.native ~= nil and #nativeCalls == 1)

-- Blocker off: the stock answer.
blocker, fakeNow, nativeCalls = "0", 1792850000, {}
r = getTime("harmony.engine?getTime", nil, {})
check("blocker off: the time is the stock answer", r.native ~= nil and #nativeCalls == 1)

-- Device content files (CD_<device>), as the Touch asks for them mid-sync.
local getResource = handlers["proxy.resource?get"]
check("registers the resource guard", type(getResource) == "function")
blocker = "1"
local contentUri = "content://1.0/device/90000017-aBc="

r = getResource("proxy.resource?get", nil, { uri = contentUri })
local d = r.data or {}
local res = type(d.resource) == "table" and d.resource or {}
check("missing device content: answered 200, not 404",
  r.code == "200" and d.code == "200" and d.uri == contentUri, encode(r))
check("missing device content: an empty record for that device",
  res.id == "00000000-0000-4000-8000-000090000017" and
  res.device_profile_uri == "svcs.myharmony.com/res/device/90000017-melodious" and
  type(res.services) == "table" and next(res.services) == nil, encode(res))
local again = getResource("proxy.resource?get", nil, { uri = contentUri })
check("missing device content: the same etag and id every sync",
  type(d.etag) == "string" and d.etag ~= "" and again.data.etag == d.etag and
  again.data.resource.id == res.id, encode(again))

r = getResource("proxy.resource?get", nil, { uri = contentUri, encode = true })
check("missing device content: encoded when the Touch asks for text",
  type(r.data.resource) == "string" and r.data.resource:find('"services":[]', 1, true) ~= nil,
  encode(r))

stored.CD_80000002 = {
  etag = '"etag-2"', hetag = "42",
  resource = { id = "stored-2", device_profile_uri = "svcs.myharmony.com/res/device/80000002-x", services = {} },
}
r = getResource("proxy.resource?get", nil, { uri = "content://1.0/device/80000002-x" })
check("stored device content: the hub's own file, untouched",
  r.data.code == "200" and r.data.etag == '"etag-2"' and r.data.hetag == "42" and
  r.data.resource.id == "stored-2", encode(r))

r = getResource("proxy.resource?get", nil, { uri = "harmony://Account/1/InstallerInfo" })
check("other missing resources: still 404", r.data.code == "404", encode(r))

-- Melodious turned off (/etc/melodious-off, and legacy /data/codex/melodious-off):
-- even with cloud_blocker.conf = "1" and restrictions/timezone files present,
-- zero engine.registerMessage overrides, unpatched http.request, zero
-- background tasks, and cloudapi/pubnub/packagemgr all start on newaddr.
local function runOffCase(markerPath)
  local offFiles = {
    [markerPath] = "off 20261111-120000",
    ["/data/codex/cloud_blocker.conf"] = "1",
    ["/data/codex/timezone.conf"] = "America/New_York\nEST5EDT,M3.2.0,M11.1.0",
    ["/data/codex/activity-restrictions.json"] = '{"activities":{"100":[{"days":["mon"],"start":"00:00","end":"24:00"}]}}',
  }
  local offHandlers, offTasks, cloudStarted, loadedTasks = {}, {}, {}, {}
  local origRequest = function() return "unpatched" end
  local offHttp = { request = origRequest }
  local origStartActivity = function() return "stock-start" end
  local heactivity = { startActivity = origStartActivity }

  for _, mod in ipairs({
    "system", "socket.http", "tasks.connectserver.core.engine", "tasks.mfg.core.mfgdata",
    "tasks.connectserver.transport.cloudapi", "tasks.connectserver.transport.pubnubwrapper",
    "tasks.connectserver.transport.packagemgr", "tasks.harmonyengine.apihandler.activity",
    "tasks.crashlog.apihandler.usagelog",
  }) do
    package.loaded[mod] = nil
  end

  local sentAddr = false
  package.preload["system"] = function()
    local s = anything()
    rawset(s, "io", {
      open = function(path)
        local body = offFiles[path]
        if not body then return nil end
        return { read = function() return body end, close = noop }
      end,
    })
    rawset(s, "addTask", function(name, fn)
      offTasks[#offTasks + 1] = name
      return name
    end)
    rawset(s, "loadTask", function(path)
      loadedTasks[#loadedTasks + 1] = path
      return path
    end)
    rawset(s, "isMessageRegistered", function() return true end)
    rawset(s, "uniqueId", function() return "uuid-1" end)
    rawset(s, "netlinkOpen", function()
      return {
        receive = function()
          if not sentAddr then
            sentAddr = true
            return { { family = "inet", label = "ath0", msgtype = "newaddr", address = "192.0.2.10" } }
          end
          error("STOP_NETLINK_LOOP")
        end,
        close = noop,
      }
    end)
    return s
  end
  package.preload["socket.http"] = function() return offHttp end
  package.preload["tasks.connectserver.core.engine"] = function()
    return {
      registerMessage = function(mime, _, fn)
        offHandlers[#offHandlers + 1] = mime
      end,
    }
  end
  package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = true } end
  package.preload["tasks.crashlog.apihandler.usagelog"] = function() return anything() end
  for _, spec in ipairs({
    { key = "cloudapi", mod = "tasks.connectserver.transport.cloudapi" },
    { key = "pubnub", mod = "tasks.connectserver.transport.pubnubwrapper" },
    { key = "packagemgr", mod = "tasks.connectserver.transport.packagemgr" },
  }) do
    package.preload[spec.mod] = function()
      return {
        start = function()
          cloudStarted[spec.key] = (cloudStarted[spec.key] or 0) + 1
          return "task-" .. spec.key
        end,
      }
    end
  end
  package.loaded["tasks.harmonyengine.apihandler.activity"] = heactivity

  local ok, err = pcall(assert(loadfile(repoRoot .. "/payload/scripts/netservicestarter.lua")))
  assert(not ok and tostring(err):find("STOP_NETLINK_LOOP", 1, true), "unexpected exit: " .. tostring(err))
  return {
    handlers = offHandlers,
    http = offHttp,
    origRequest = origRequest,
    tasks = offTasks,
    cloudStarted = cloudStarted,
    loadedTasks = loadedTasks,
    heactivity = heactivity,
    origStartActivity = origStartActivity,
  }
end

local off = runOffCase("/etc/melodious-off")
check("melodious-off: 0 engine.registerMessage overrides",
  #off.handlers == 0, table.concat(off.handlers, ","))
check("melodious-off: socket.http.request stays unpatched",
  off.http.request == off.origRequest and off.http.__codexCloudGuard == nil)
check("melodious-off: 0 background tasks and startActivity unwrapped",
  #off.tasks == 0 and off.heactivity.startActivity == off.origStartActivity and
  off.heactivity.__codexTimeRestrictions == nil, table.concat(off.tasks, ","))
check("melodious-off: cloudapi, pubnub, and packagemgr all start despite cloud_blocker.conf=1",
  off.cloudStarted.cloudapi == 1 and off.cloudStarted.pubnub == 1 and
  off.cloudStarted.packagemgr == 1 and #off.loadedTasks == 5,
  encode(off.cloudStarted))

local legacyOff = runOffCase("/data/codex/melodious-off")
check("legacy /data/codex/melodious-off fallback: also skips guards/tasks and starts cloud",
  #legacyOff.handlers == 0 and legacyOff.http.request == legacyOff.origRequest and
  #legacyOff.tasks == 0 and legacyOff.cloudStarted.cloudapi == 1 and
  legacyOff.cloudStarted.pubnub == 1 and legacyOff.cloudStarted.packagemgr == 1)

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
