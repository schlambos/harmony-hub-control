-- Lua 5.1 / LuaJIT tests for the "codex lan advertise" part of
-- payload/scripts/netservicestarter.lua: while a USB Ethernet adapter carries
-- the hub's local traffic (usb_eth_service.sh's /var/run/codex-lan-dev), the
-- hub's session address (the SSDP reply's LOCATION, among others) is the
-- cable's and the cable joins the SSDP group; otherwise the stock behaviour
-- stays, except that a missing address or one on an adapter not carrying local
-- traffic goes back to Wi-Fi's.
--
-- Runs the real script in a coroutine with stubbed hub modules: the netlink
-- loop gets scripted events, and the advertise task is stepped one pass at a
-- time. ifconfig, the lan-dev file, /proc/net/route, the session and the UDP
-- socket are fakes. No hub is contacted and nothing is written.
--
-- Run from the repo root:
--   luajit tools/touch-validator/netservicestarter-lan-advertise-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local function noop() return nil end
local function anything()
  return setmetatable({}, { __index = function() return noop end })
end

-- The fake hub.
local lanDevFile = nil                    -- contents of /var/run/codex-lan-dev
local routes = { "ath0" }                 -- interfaces with a route in /proc/net/route
local ifconfigAddr = {}                   -- what `ifconfig <dev>` shows
local sessionIp, setIpCalls = nil, 0
local joins, closes, joinFails = {}, 0, false
local tasks = {}

local realOpen = io.open
local fakeIo = {
  open = function(path, mode)
    if path == "/var/run/codex-lan-dev" then
      if not lanDevFile then return nil end
      return { read = function() return lanDevFile end, close = noop }
    end
    if path == "/proc/net/route" then
      local lines = { "Iface\tDestination\tGateway" }
      for _, dev in ipairs(routes) do lines[#lines + 1] = dev .. "\t0058A8C0\t00000000\t0001" end
      local i = 0
      return {
        lines = function() return function() i = i + 1 return lines[i] end end,
        read = function() return lines[1] end,
        close = noop,
      }
    end
    if path == "/data/codex/cloud_blocker.conf" then
      return { read = function() return "1" end, close = noop }
    end
    return nil
  end,
}
io.open = fakeIo.open
local popens = 0
io.popen = function(cmd)
  local dev = cmd:match("^ifconfig (%S+)")
  popens = popens + 1
  local out = dev and ifconfigAddr[dev] and
    (dev .. "      Link encap:Ethernet\n          inet addr:" .. ifconfigAddr[dev] .. "  Bcast:x  Mask:255.255.255.0\n") or ""
  return { read = function() return out end, close = noop }
end
fakeIo.popen = io.popen  -- the script reaches io as system.io

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
  rawset(s, "sleep", function() coroutine.yield("slept") end)
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
  rawset(s, "udp", function()
    local u = {}
    function u:setoption(name, opt)
      if name ~= "ip-add-membership" or joinFails then return nil, "fail" end
      joins[#joins + 1] = opt.multiaddr .. "@" .. opt.interface
      return 1
    end
    function u:close() closes = closes + 1 end
    return u
  end)
  return s
end
package.preload["tasks.connectserver.core.utils"] = function() return anything() end
package.preload["tasks.connectserver.core.engine"] = function() return { registerMessage = noop } end
package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = true } end
package.preload["tasks.harmonywebservices.core.session"] = function()
  return {
    setIp = function(ip) sessionIp = ip setIpCalls = setIpCalls + 1 end,
    getIp = function() return sessionIp end,
    getAccount = noop,
  }
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

-- common/config.lua's getNetworkAttribute: always ath0's (stock), and
-- works.system's copy of it.
local stockAttr = function(attribute)
  if attribute == "ipaddr" then return ifconfigAddr.ath0 end
  if attribute == "macaddr" then return "00:04:20:00:00:01" end
end
local config = { getNetworkAttribute = stockAttr }
local workssystem = { getNetworkAttribute = stockAttr }
package.preload["common.config"] = function() return config end
package.preload["works.system"] = function() return workssystem end

local chunk = assert(loadfile(repoRoot .. "/payload/scripts/netservicestarter.lua"))
local main = coroutine.create(chunk)
local ok, why = coroutine.resume(main)
assert(ok and why == "need-events", "the script didn't reach its netlink loop: " .. tostring(why))

local function event(msgtype, label, address)
  local ok2, why2 = coroutine.resume(main, { { family = "inet", msgtype = msgtype, label = label, address = address } })
  assert(ok2, why2)
end
local advertise = tasks["codex lan advertise"]
assert(type(advertise) == "function", "no codex lan advertise task")
local advertiseCo = coroutine.create(advertise)
local function pass()
  local ok2, why2 = coroutine.resume(advertiseCo)
  assert(ok2 and why2 == "slept", tostring(why2))
end

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

local WIFI, CABLE = "192.168.1.65", "192.168.1.50"

-- Boot: Wi-Fi first, as stock.
ifconfigAddr.ath0 = WIFI
event("newaddr", "ath0", WIFI)
pass()
check("Wi-Fi only: the hub's address is Wi-Fi's, as stock", sessionIp == WIFI, sessionIp)
check("Wi-Fi only: no SSDP membership of its own", #joins == 0, #joins)
check("Wi-Fi only: getNetworkAttribute(ipaddr) is stock (Wi-Fi's)",
  config.getNetworkAttribute("ipaddr") == WIFI and workssystem.getNetworkAttribute("ipaddr") == WIFI)
local before = setIpCalls
pass(); pass()
check("Wi-Fi only: nothing changes pass after pass", setIpCalls == before, setIpCalls - before)

-- The adapter gets an address but doesn't carry local traffic yet (gateway
-- check pending, or another network): stock would advertise it.
ifconfigAddr.eth2 = CABLE
routes = { "ath0", "eth2" }
event("newaddr", "eth2", CABLE)
check("an adapter not carrying local traffic isn't advertised", sessionIp == WIFI, sessionIp)

-- The worker hands it the LAN.
lanDevFile = "eth2"
pass()
check("cable carrying local traffic: the hub's address is the cable's", sessionIp == CABLE, sessionIp)
check("cable carrying local traffic: getNetworkAttribute(ipaddr) is the cable's, in both modules",
  config.getNetworkAttribute("ipaddr") == CABLE and workssystem.getNetworkAttribute("ipaddr") == CABLE,
  config.getNetworkAttribute("ipaddr"))
check("cable carrying local traffic: the MAC address stays Wi-Fi's",
  config.getNetworkAttribute("macaddr") == "00:04:20:00:00:01")
check("cable carrying local traffic: SSDP group joined on the cable's address",
  joins[#joins] == "239.255.255.250@" .. CABLE, joins[#joins])
local joined = #joins
pass(); pass()
check("the membership is kept, not joined again each pass", #joins == joined and closes == 0, #joins .. "/" .. closes)

-- Wi-Fi reconnects (the stock handler sets its address): the cable's stays.
event("newaddr", "ath0", WIFI)
check("a Wi-Fi reconnect doesn't take the address back", sessionIp == CABLE, sessionIp)

-- Wi-Fi drops its address: stock clears the session address.
event("deladdr", "ath0", WIFI)
check("a Wi-Fi deladdr doesn't clear the cable's address", sessionIp == CABLE, sessionIp)
ifconfigAddr.ath0 = nil

-- Local traffic back on Wi-Fi.
ifconfigAddr.ath0 = WIFI
event("newaddr", "ath0", WIFI)
lanDevFile = nil
pass()
check("hand-back: the hub's address is Wi-Fi's again", sessionIp == WIFI, sessionIp)
check("hand-back: the cable's SSDP membership is dropped", closes == 1, closes)
check("hand-back: getNetworkAttribute(ipaddr) is Wi-Fi's again", config.getNetworkAttribute("ipaddr") == WIFI)

-- The adapter loses its address: stock clears the session address.
ifconfigAddr.eth2 = nil
routes = { "ath0" }
event("deladdr", "eth2", CABLE)
check("an adapter's deladdr doesn't leave the hub without an address", sessionIp == WIFI, sessionIp)

-- An address the netlink loop never reported (it takes one event per batch):
-- found with ifconfig, once.
ifconfigAddr.eth2 = CABLE
routes = { "ath0", "eth2" }
lanDevFile = "eth2"
popens = 0
pass()
check("a missed newaddr: the cable's address comes from ifconfig", sessionIp == CABLE, sessionIp)
pass(); pass()
check("ifconfig is read once, not every pass", popens == 1, popens)

-- A refused join is tried again on the next pass.
lanDevFile = nil
pass()
joinFails = true
lanDevFile = "eth2"
local n = #joins
pass()
check("a refused join keeps nothing", #joins == n, #joins)
joinFails = false
pass()
check("a refused join is tried again", #joins == n + 1, #joins)

-- A bogus lan-dev name is ignored (same rule as the egress guard).
lanDevFile = "br0; reboot"
pass()
check("a bogus lan-dev name falls back to Wi-Fi", sessionIp == WIFI, sessionIp)

print(string.format("%d/%d checks passed", count - failures, count))
io.open = realOpen
os.exit(failures == 0 and 0 or 1)
