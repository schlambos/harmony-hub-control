-- LuaJIT tests for the activity time restrictions in
-- payload/scripts/netservicestarter.lua: the wrapper it installs around the
-- engine's startActivity refuses a start inside a restricted window and lets
-- everything else through (the running activity, the help press, PowerOff,
-- the boot relaunch, an unknown clock or zone, an unreadable rules file).
--
-- Loads the script with stubbed hub modules (mfgData.hasNetwork = false),
-- runs its install task at once, then calls the wrapped startActivity of a
-- stub engine module with a fake clock and fake files. No hub is contacted
-- and nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/netservicestarter-restrictions-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local AMSTERDAM = "CET-1CEST,M3.5.0,M10.5.0/3"

-- Minimal JSON decoder (test code only); bad input raises an error.
local NULL = {}
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
        out[#out + 1] = text:sub(pos + 1, pos + 1)
        pos = pos + 2
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    error("unterminated string")
  end
  local function parseNumber()
    local s = assert(text:match("^%-?%d+%.?%d*[eE]?[%-+]?%d*", pos), "bad json")
    pos = pos + #s
    return tonumber(s)
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
    return parseNumber()
  end
  return parseValue()
end

-- UTC seconds for a civil date and time.
local function utc(y, m, d, hh, mm)
  if m <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  local days = era * 146097 + yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy - 719468
  return days * 86400 + hh * 3600 + mm * 60
end

local files = {}
local fakeNow
local account
local dummySet = false
local digestTz = AMSTERDAM
local accountError

local function noop() return nil end
local function anything()
  return setmetatable({}, { __index = function() return noop end })
end

local fakeIo = {
  open = function(path)
    local body = files[path]
    if not body then return nil end
    local lines, i = {}, 0
    for line in (body .. "\n"):gmatch("([^\n]*)\n") do lines[#lines + 1] = line end
    return {
      read = function(_, fmt)
        if fmt == "*a" then return body end
        i = i + 1
        return lines[i]
      end,
      close = noop,
    }
  end,
}

local realOs = os
package.loaded["os"] = setmetatable({
  time = function(...) if fakeNow and select("#", ...) == 0 then return fakeNow end return realOs.time(...) end,
}, { __index = realOs })

package.preload["system"] = function()
  local s = anything()
  rawset(s, "io", fakeIo)
  -- One-off tasks run inline; the background "codex lan advertise" loop doesn't.
  rawset(s, "addTask", function(name, fn) if name ~= "codex lan advertise" then fn() end return "task" end)
  rawset(s, "isMessageRegistered", function() return true end)
  return s
end
package.preload["json"] = function() return { encode = noop, decode = decodeJson, null = NULL } end
local notices = {}
package.preload["log"] = function()
  local logger = {
    notice = function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
      notices[#notices + 1] = table.concat(parts, " ")
    end,
    error = noop, warning = noop, debug = noop, info = noop,
  }
  return { logger = function() return logger end }
end
package.preload["tasks.hal.core.hbus"] = function() return { instance = function() return anything() end } end
package.preload["socket.http"] = function() return { request = noop } end
package.preload["socket"] = function() return anything() end
package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = false } end
package.preload["tasks.harmonywebservices.core.session"] = function()
  return {
    getAccount = function()
      if accountError then error(accountError) end
      return account
    end,
  }
end
package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return {
    instance = function()
      return { tz = digestTz, isDummyActivitySet = function() return dummySet end }
    end,
  }
end
-- hbus handlers the script registers, and what the stock startactivity got.
local handlers, nativeStarts = {}, {}
package.preload["tasks.connectserver.core.engine"] = function()
  return { registerMessage = function(mime, _, fn) handlers[mime] = fn end }
end
package.preload["tasks.connectserver.core.utils"] = function()
  return {
    createResponse = function(cmd, code, msg, data) return { cmd = cmd, code = code, msg = msg, data = data } end,
    fixHbusData = noop,
  }
end
package.preload["tasks.harmonyengine.apihandler.harmonyengine"] = function()
  return {
    processStartActivity = function(cmd, verb, params)
      nativeStarts[#nativeStarts + 1] = params
      return { cmd = cmd, code = "200", msg = "OK" }
    end,
  }
end
for _, name in ipairs({
  "tasks.harmonywebservices.apihandler.resource",
  "tasks.setup.apihandler.sync",
  "tasks.harmonywebservices.core.preferencemanager",
  "tasks.harmonywebservices.core.resourcemanager",
}) do
  package.preload[name] = function() return anything() end
end

-- The engine's activity module; its startActivity records what reached it.
local started = {}
local function originalStart(params, clientId, callback)
  started[#started + 1] = { params = params, clientId = clientId, callback = callback }
  return "started"
end
local heactivity = { startActivity = originalStart }
package.loaded["tasks.harmonyengine.apihandler.activity"] = heactivity

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

check("wraps the engine's startActivity",
  heactivity.startActivity ~= originalStart and heactivity.__codexTimeRestrictions == true)
if heactivity.startActivity == originalStart then
  print(string.format("%d/%d checks passed", count - failures, count))
  os.exit(1)
end

local RULES = "/data/codex/activity-restrictions.json"
local TZ = "/data/codex/timezone.conf"

local function reset()
  files = {
    [TZ] = "Europe/Amsterdam\n" .. AMSTERDAM,
    [RULES] = [[{"activities": {
      "100": [{"days": ["sat", "sun"], "start": "06:00", "end": "09:00"},
              {"days": ["fri"], "start": "22:00", "end": "02:00"},
              {"days": ["mon"], "start": "20:00", "end": "24:00"}],
      "-1": [{"days": ["sat"], "start": "00:00", "end": "24:00"}]
    }}]],
  }
  account = {
    currentActivityId = "-1",
    activities = { ["100"] = { label = "Play a game" }, ["200"] = { label = "Watch TV" } },
  }
  dummySet, digestTz, accountError = false, AMSTERDAM, nil
  started, notices = {}, {}
end

-- Starts activityId the way hbus startactivity does (with a callback) and
-- reports whether the engine got it and what the callback was given.
local function start(activityId, extra, withoutCallback)
  local params = { cmd = "harmony.engine?startActivity", verb = "startactivity",
    activityId = activityId, id = "req-1", headers = { h = 1 }, callbackUrl = "http://cb" }
  for k, v in pairs(extra or {}) do params[k] = v end
  local reply
  local callback = function(...) reply = { ... } end
  local before = #started
  local result = heactivity.startActivity(params, "client-7", not withoutCallback and callback or nil)
  return #started > before, reply, result
end

-- Saturday 2026-11-14, CET (UTC+1).
local SAT_WINTER = { 2026, 11, 14 }
local function at(date, hh, mm) return utc(date[1], date[2], date[3], hh, mm) end

reset()
files[RULES] = nil
fakeNow = at(SAT_WINTER, 6, 0)
local ran, _, result = start("100")
check("no rules file: the start runs", ran and result == "started")

reset()
fakeNow = at(SAT_WINTER, 6, 0) -- 07:00 local
local reply
ran, reply = start("100")
check("restricted window: the engine never sees the start", not ran)
check("restricted window: answered like the engine's own refusal",
  reply and reply[1] == "client-7" and reply[2] == "harmony.engine?startActivity" and
  reply[3] == "568" and reply[4] == "Activity is restricted at this time: Play a game" and
  reply[5] == "activityId=-1" and reply[6] == "req-1" and type(reply[7]) == "table" and
  reply[7].noHttpResponse == true and reply[7].headers.h == 1 and reply[8] == "http://cb",
  reply and table.concat({ tostring(reply[3]), tostring(reply[4]), tostring(reply[5]) }, " | "))
local logged = false
for _, line in ipairs(notices) do
  if line:find("refused start of Play a game 100 sat,sun 06:00-09:00", 1, true) then logged = true end
end
check("restricted window: the refusal is logged with the window", logged, table.concat(notices, " / "))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
check("numeric activity id: matched as text", not (start(100)))

reset()
fakeNow = at(SAT_WINTER, 8, 0) -- 09:00 local
check("window end is exclusive", (start("100")))
fakeNow = at(SAT_WINTER, 4, 59) -- 05:59 local
check("before the window: runs", (start("100")))
fakeNow = at(SAT_WINTER, 5, 0) -- 06:00 local
check("window start is inclusive", not (start("100")))
fakeNow = at({ 2026, 11, 13 }, 6, 0) -- Friday 07:00 local
check("another weekday: runs", (start("100")))

reset()
fakeNow = at({ 2026, 7, 11 }, 5, 30) -- Saturday 07:30 CEST, 05:30 UTC
check("summer time: the hub-local clock, not UTC", not (start("100")))
fakeNow = at({ 2026, 7, 11 }, 7, 0) -- 09:00 CEST
check("summer time: window end follows the zone", (start("100")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
check("unrestricted activity: runs", (start("200")))
account.currentActivityId = "100"
check("the running activity: pressed again, still runs", (start("100")))
account.currentActivityId = "200"
check("switching from another activity: refused", not (start("100")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
check("help press: runs", (start(nil, { verb = "helpdiscretes", cmd = "harmony.engine?helpdiscretes" })))
check("PowerOff: never refused", (start("-1")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
dummySet = true
check("boot relaunch (dummy start with callback): runs", (start("100")))
check("dummy flag without a callback: still refused", not (start("100", nil, true)))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
ran, reply = start("100", { noResponse = true })
check("noResponse: refused without an answer", not ran and reply == nil)
local ok = pcall(start, "100", nil, true)
check("no callback: refused quietly", ok and #started == 0)

reset()
fakeNow = at({ 2026, 11, 13 }, 22, 0) -- Friday 23:00 local
check("past midnight window: refused on its start day", not (start("100")))
fakeNow = at(SAT_WINTER, 0, 0) -- Saturday 01:00 local
check("past midnight window: refused after midnight", not (start("100")))
fakeNow = at(SAT_WINTER, 1, 0) -- Saturday 02:00 local
check("past midnight window: runs from its end", (start("100")))
fakeNow = at({ 2026, 11, 12 }, 23, 30) -- Friday 00:30 local
check("past midnight window: the night before its start day runs", (start("100")))

reset()
fakeNow = at({ 2026, 11, 16 }, 22, 59) -- Monday 23:59 local
check("end 24:00: covers the last minute", not (start("100")))
fakeNow = at({ 2026, 11, 16 }, 23, 0) -- Tuesday 00:00 local
check("end 24:00: the next day runs", (start("100")))

reset()
fakeNow = 3600
check("clock not set: fails open", (start("100")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
files[RULES] = "not json"
check("unreadable rules: fail open", (start("100")))
files[RULES] = '{"activities": {"100": [{"days": ["sat"], "start": "25:00", "end": "09:00"},' ..
  '{"days": [], "start": "06:00", "end": "09:00"},' ..
  '{"days": ["sat"], "start": "07:00", "end": "07:00"},' ..
  '{"days": ["sat"], "start": "06:30", "end": "07:30"}]}}'
check("bad windows: ignored, good ones still apply", not (start("100")))
fakeNow = at(SAT_WINTER, 5, 0) -- 06:00 local, only the bad windows cover it
check("bad windows: never restrict", (start("100")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
files[TZ] = nil
check("no time zone file: the digest zone is used", not (start("100")))
digestTz = nil
check("no time zone at all: fails open", (start("100")))

reset()
fakeNow = at(SAT_WINTER, 6, 0)
accountError = "boom"
check("an error in the check: the start runs", (start("100")))

-- hbus harmony.engine?startactivity: refused as the answer itself, since the
-- stock handler answers 200 before the startActivity wrapper runs.
local hbusStart = handlers["harmony.engine?startactivity"]
check("registers a guard for hbus startactivity", type(hbusStart) == "function")
if type(hbusStart) == "function" then
  reset()
  nativeStarts = {}
  fakeNow = at(SAT_WINTER, 6, 0) -- 07:00 local, restricted
  local r = hbusStart("harmony.engine?startactivity", nil, { activityId = "100", timestamp = 1 })
  check("hbus start in a restricted window: answered 568, stock handler not called",
    r.code == "568" and r.msg == "Activity is restricted at this time: Play a game" and
    type(r.data) == "table" and r.data.activityId == "-1" and #nativeStarts == 0,
    tostring(r.code) .. " " .. tostring(r.msg))
  r = hbusStart("harmony.engine?startactivity", nil, { activityId = "200" })
  check("hbus start of an unrestricted activity: the stock handler answers",
    r.code == "200" and #nativeStarts == 1 and nativeStarts[1].activityId == "200")
  account.currentActivityId = "100"
  r = hbusStart("harmony.engine?startactivity", nil, { activityId = "100" })
  check("hbus start of the running activity: passes", r.code == "200" and #nativeStarts == 2)
  r = hbusStart("harmony.engine?startactivity", nil, { activityId = "-1" })
  check("hbus PowerOff: passes", r.code == "200" and #nativeStarts == 3)
  accountError = "boom"
  account.currentActivityId = "-1"
  r = hbusStart("harmony.engine?startactivity", nil, { activityId = "100" })
  check("hbus start, error in the check: the stock handler answers", r.code == "200" and #nativeStarts == 4)
end

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
