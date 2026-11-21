-- Lua 5.1 / LuaJIT tests for the hub's clock sync ("codex time sync") in
-- payload/scripts/netservicestarter.lua: the custom NTP servers set in System
-- (/data/codex/ntp_servers.conf) replace the public ones, a server on a route
-- the hub already has is asked without a temporary host route, and a changed
-- setting is picked up within one wait step.
--
-- Runs the real script in a coroutine with stubbed hub modules. A netlink
-- address event starts the sync task, which is then stepped one sleep at a
-- time. DNS, the UDP socket, /proc/net/route, the saved gateway and
-- os.execute are fakes. No hub is contacted and nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/netservicestarter-ntp-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local function noop() return nil end
local function anything()
  return setmetatable({}, { __index = function() return noop end })
end

local NTP_EPOCH_OFFSET = 2208988800
local SERVER_TIME = 1790000000            -- 2026-09-21, what every server answers
local HUB_TIME = 0                        -- the hub's clock: unset (1970)

-- The fake hub.
local ntpConf = nil                       -- contents of /data/codex/ntp_servers.conf
-- /proc/net/route as the hub prints it (big-endian MIPS): the Wi-Fi subnet
-- and the private ranges the egress guard keeps; no default route.
local routeLines = {
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "ath0\tC0A80100\t00000000\t0001\t0\t0\t0\tFFFFFF00\t0\t0\t0",
  "ath0\tC0A80000\tC0A80101\t0003\t0\t0\t0\tFFFF0000\t0\t0\t0",
  "ath0\tAC100000\tC0A80101\t0003\t0\t0\t0\tFFF00000\t0\t0\t0",
  "ath0\t0A000000\tC0A80101\t0003\t0\t0\t0\tFF000000\t0\t0\t0",
  "ath0\tE0000000\t00000000\t0001\t0\t0\t0\tF0000000\t0\t0\t0",
}
local dns = {
  ["ntp.example.com"] = "192.168.1.5",
  ["pool.ntp.org"] = "85.209.96.20",
  ["time.google.com"] = "216.239.35.8",
  ["time.cloudflare.com"] = "162.159.200.1",
  ["clock.example"] = "203.0.113.7",
  ["ntp2.example.com"] = "192.168.1.6",
}
local answering = {}                      -- ip -> true when its NTP server answers
local lookups, queries, executes = {}, {}, {}
local tasks = {}

local function lineReader(lines)
  local i = 0
  return function() i = i + 1 return lines[i] end
end

local realOpen = io.open
local fakeIo = {
  open = function(path)
    if path == "/data/codex/ntp_servers.conf" then
      if not ntpConf then return nil end
      local body = ntpConf
      return { read = function() return body end, close = noop }
    end
    if path == "/proc/net/route" then
      return { lines = function() return lineReader(routeLines) end, read = function() return routeLines[1] end, close = noop }
    end
    if path == "/var/volatile/codex-default-gateway" then
      return { read = function() return "192.168.1.1" end, close = noop }
    end
    if path == "/data/codex/cloud_blocker.conf" then
      return { read = function() return "1" end, close = noop }
    end
    return nil
  end,
}
io.open = fakeIo.open
io.popen = function() return { read = function() return "" end, close = noop } end
fakeIo.popen = io.popen  -- the script reaches io as system.io

local realOs = os
package.loaded["os"] = setmetatable({
  time = function(...) if select("#", ...) == 0 then return HUB_TIME end return realOs.time(...) end,
  execute = function(cmd) executes[#executes + 1] = cmd return 0 end,
}, { __index = realOs })

local netlink = {
  receive = function() return coroutine.yield("need-events") end,
  close = noop,
}
package.preload["system"] = function()
  local s = anything()
  rawset(s, "io", fakeIo)
  rawset(s, "getFirmwareVersion", function() return "4.15.600" end)
  rawset(s, "isMessageRegistered", function() return true end)
  rawset(s, "netlinkOpen", function() return netlink end)
  rawset(s, "addTask", function(name, fn) tasks[name] = fn return name end)
  rawset(s, "taskStatus", function() return "running" end)
  rawset(s, "sleep", function(ms) coroutine.yield(ms) end)
  rawset(s, "uniqueId", function() return "uuid" end)
  return s
end
package.preload["json"] = function() return { encode = function() return "{}" end, decode = noop, null = {} } end
package.preload["log"] = function()
  local logger = { notice = noop, error = function(...) print("script error:", ...) end, warning = noop, debug = noop, info = noop }
  return { logger = function() return logger end }
end
package.preload["tasks.hal.core.hbus"] = function() return { instance = function() return anything() end } end
package.preload["socket.http"] = function() return { request = noop } end
package.preload["socket"] = function()
  local s = anything()
  rawset(s, "dns", {
    toip = function(name)
      lookups[#lookups + 1] = name
      return dns[name]
    end,
  })
  rawset(s, "udp", function()
    local u = { peer = nil }
    function u:settimeout() end
    function u:setpeername(ip) self.peer = ip return 1 end
    function u:send() queries[#queries + 1] = self.peer return 48 end
    function u:receive()
      if not answering[self.peer] then return nil, "timeout" end
      local t = SERVER_TIME + NTP_EPOCH_OFFSET
      local b = {}
      for i = 4, 1, -1 do b[i] = t % 256 t = math.floor(t / 256) end
      -- LI 0, version 3, mode 4 (server); stratum 2; transmit time at byte 41.
      return string.char(0x1C, 2) .. string.rep("\0", 38) .. string.char(b[1], b[2], b[3], b[4]) .. string.rep("\0", 4)
    end
    function u:close() end
    return u
  end)
  return s
end
package.preload["tasks.connectserver.core.utils"] = function() return anything() end
package.preload["tasks.connectserver.core.engine"] = function() return { registerMessage = noop } end
package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = true } end
package.preload["tasks.harmonywebservices.core.session"] = function()
  return { setIp = noop, getIp = noop, getAccount = noop }
end
for _, name in ipairs({
  "tasks.harmonywebservices.apihandler.resource",
  "tasks.setup.apihandler.sync",
  "tasks.harmonywebservices.core.preferencemanager",
  "tasks.harmonywebservices.core.resourcemanager",
  "tasks.crashlog.apihandler.usagelog",
}) do
  package.preload[name] = function() return anything() end
end
local stockAttr = function(attribute)
  if attribute == "ipaddr" then return "192.168.1.65" end
end
package.preload["common.config"] = function() return { getNetworkAttribute = stockAttr } end
package.preload["works.system"] = function() return { getNetworkAttribute = stockAttr } end

local chunk = assert(loadfile(repoRoot .. "/payload/scripts/netservicestarter.lua"))
local main = coroutine.create(chunk)
local ok, why = coroutine.resume(main)
assert(ok and why == "need-events", "the script didn't reach its netlink loop: " .. tostring(why))

local failures, count = 0, 0
local function check(name, cond, detail)
  count = count + 1
  if cond then
    print("PASS " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. (detail ~= nil and (" (" .. tostring(detail) .. ")") or ""))
  end
end

local function reset()
  lookups, queries, executes = {}, {}, {}
end
local function routeAdds()
  local n = 0
  for _, cmd in ipairs(executes) do
    if cmd:match("^route add ") then n = n + 1 end
  end
  return n
end
local function clockSet()
  for _, cmd in ipairs(executes) do
    if cmd:match("^date %-u %-s ") then return true end
  end
  return false
end

-- Boot: Wi-Fi gets its address, which starts the sync task. Nothing set in
-- System: the public servers, each through a temporary host route.
local okE, whyE = coroutine.resume(main, { { family = "inet", msgtype = "newaddr", label = "ath0", address = "192.168.1.65" } })
assert(okE, whyE)
local syncTask = tasks["codex time sync"]
assert(type(syncTask) == "function", "no codex time sync task")
local syncCo = coroutine.create(syncTask)
local function step()
  local ok2, slept = coroutine.resume(syncCo)
  assert(ok2, slept)
  return slept
end

local slept = step()
check("no setting: the public servers are asked, in order",
  table.concat(lookups, ",") == "pool.ntp.org,time.google.com,time.cloudflare.com", table.concat(lookups, ","))
check("no setting: each public server gets a temporary host route", routeAdds() == 3, routeAdds())
check("no setting: no answer leaves the clock alone", not clockSet())
check("a failed sync waits in 30 s steps", slept == 30000, slept)

-- Saved in System while the task waits: the next step notices and asks it.
reset()
ntpConf = "ntp.example.com\n"
answering["192.168.1.5"] = true
step()
check("a changed setting is picked up after one step", lookups[1] == "ntp.example.com", lookups[1])
check("set: only the configured server is asked", #lookups == 1 and #queries == 1, #lookups .. "/" .. #queries)
check("set: a LAN server is asked directly, with no route add", routeAdds() == 0, routeAdds())
check("set: its answer sets the clock", clockSet())

-- A sync that worked waits for the 6-hour resync, still in steps, and stops
-- early when the setting changes.
reset()
local steps = 0
for _ = 1, 5 do step() steps = steps + 1 end
check("after a good sync no server is asked while waiting", #lookups == 0 and #queries == 0, #lookups)
ntpConf = "clock.example\n"
answering["203.0.113.7"] = true
step()
check("a change during the 6-hour wait is picked up within a step", lookups[1] == "clock.example", lookups[1])
check("a server off the hub's routes gets a temporary host route", routeAdds() == 1, routeAdds())

-- Comments, blank lines, bad entries and the cap of 3.
reset()
answering = {}
ntpConf = "# local first\n\nntp.example.com, ntp2.example.com\nbad;host\n-bad\n192.168.1.9 clock.example extra.example\n"
step()
check("parsing: comments, blanks and bad entries are skipped; at most 3 servers",
  table.concat(lookups, ",") == "ntp.example.com,ntp2.example.com", table.concat(lookups, ","))
check("parsing: an IPv4 address is asked without a DNS lookup",
  table.concat(queries, ",") == "192.168.1.5,192.168.1.6,192.168.1.9", table.concat(queries, ","))
check("set: the public servers are never asked when servers are set", #queries == 3, #queries)

-- A file with nothing usable in it falls back to the public servers.
reset()
ntpConf = "# nothing here\nbad;host\n"
step()
check("a file with no valid server falls back to the public servers",
  table.concat(lookups, ",") == "pool.ntp.org,time.google.com,time.cloudflare.com", table.concat(lookups, ","))

print(string.format("%d/%d checks passed", count - failures, count))
io.open = realOpen
os.exit(failures == 0 and 0 or 1)
