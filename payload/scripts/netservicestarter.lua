local hbus = require("tasks.hal.core.hbus"):instance()
local http = require("socket.http")
local connectUtils = require("tasks.connectserver.core.utils")
local engine = require("tasks.connectserver.core.engine")
local json = require("json")
local log = require("log").logger("cs.netservicestarter")
local mfgData = require("tasks.mfg.core.mfgdata")
local nativeResourceHandler =
  require("tasks.harmonywebservices.apihandler.resource")
local nativeSyncHandler = require("tasks.setup.apihandler.sync")
local prefMgr = require("tasks.harmonywebservices.core.preferencemanager")
local resMgr = require("tasks.harmonywebservices.core.resourcemanager")
local session = require("tasks.harmonywebservices.core.session")
local string = require("string")
local system = require("system")
local table = require("table")
local math = require("math")
local os = require("os")
local socket = require("socket")

-- luaworks tasks run sandboxed without the io global; stock code opens files
-- through system.io (the real io, reached via package.seeall).
local io = system.io

MSG_NETSERVICE_NEW_ADDRESS = "cs.netservicestarter_new_address"

local ipaddr
local discovery
local ssdpDiscovery
local halConnect
local hbusHttpServerConnect
local ltcpServerConnector
local cloudapi
local pubnubServerConnect
local packagemgr
local timeSyncTask

local NTP_SERVERS = {"pool.ntp.org", "time.google.com", "time.cloudflare.com"}
local NTP_EPOCH_OFFSET = 2208988800 -- seconds from 1900 (NTP) to 1970 (Unix)
local NTP_MIN_VALID = 1767225600 -- 2026-01-01; anything older is a bad reply
local NTP_RESYNC_SECONDS = 6 * 60 * 60
local GATEWAY_STATE = "/var/volatile/codex-default-gateway"
-- Written by usb_eth_service.sh while a USB Ethernet adapter carries LAN traffic.
local LAN_DEV_FILE = "/var/run/codex-lan-dev"
local CLOUD_HOST_PATTERNS = {
  "myharmony%.com$",
  "logitech%.com$",
  "logitechharmony%.com$",
  "pubnub%.com$",
  "pubnub%.net$"
}

local MELODIOUS_OFF_FILE = "/etc/melodious-off"
local LEGACY_MELODIOUS_OFF_FILE = "/data/codex/melodious-off"

local function fileExists(path)
  if not io or not io.open then
    return false
  end
  local f = io.open(path, "r")
  if not f then
    return false
  end
  f:close()
  return true
end

local function melodiousOff()
  return fileExists(MELODIOUS_OFF_FILE) or fileExists(LEGACY_MELODIOUS_OFF_FILE)
end

local function cloudBlockerEnabled()
  if melodiousOff() then
    return false
  end
  if not io or not io.open then
    return true
  end
  local f = io.open("/data/codex/cloud_blocker.conf", "r")
  if not f then
    return true
  end
  local value = string.lower(tostring(f:read("*l") or ""))
  f:close()
  return not (value == "0" or value == "off" or value == "false" or value == "disabled" or value == "allow" or value == "allowed")
end

-- Stock tasks (discovery, TimeManager, crashlog) keep calling Logitech over
-- HTTPS. Behind the blocker those calls can die inside the TLS client with
-- "bad argument #1 to '?' (table expected, got number)" and kill the task,
-- while a DNS failure returns cleanly. Answer cloud hosts with that clean
-- failure before any socket is opened. require("socket.http") is the shared
-- works.http table, so patching it covers every stock caller.
local function isCloudHost(url)
  local host = type(url) == "string" and string.match(url, "^%a+://([^/:]+)")
  if not host then
    return false
  end
  host = string.lower(host)
  for _, pattern in ipairs(CLOUD_HOST_PATTERNS) do
    if string.find(host, pattern) then
      return true
    end
  end
  return false
end

-- Offline time zone. The activity engine takes its UTC offset (schedules,
-- sunrise/sunset, the digest tz the remotes display) from Logitech's
-- TimeServer/zone, and only counts the clock as set after TimeServer/current
-- answers. With the blocker on, answer both locally: the zone comes from the
-- web UI (TIMEZONE_CONF: IANA name, then its POSIX TZ rule). The hub's libc
-- stays on UTC, which the stock schedule code assumes.
local TIMEZONE_CONF = "/data/codex/timezone.conf"
local MONTH_DAYS = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

local function parseTzName(s, i)
  if string.sub(s, i, i) == "<" then
    local j = string.find(s, ">", i + 1, true)
    if not j or j == i + 1 then
      return nil
    end
    return string.sub(s, i + 1, j - 1), j + 1
  end
  local name = string.match(s, "^%a%a%a+", i)
  if not name then
    return nil
  end
  return name, i + #name
end

-- [+-]hh[:mm[:ss]] -> seconds
local function parseTzTime(s, i)
  local sign, hours, j = string.match(s, "^([+-]?)(%d+)()", i)
  if not hours then
    return nil
  end
  local seconds = tonumber(hours) * 3600
  local minutes, k = string.match(s, "^:(%d+)()", j)
  if minutes then
    seconds = seconds + tonumber(minutes) * 60
    j = k
    local secs, l = string.match(s, "^:(%d+)()", j)
    if secs then
      seconds = seconds + tonumber(secs)
      j = l
    end
  end
  if sign == "-" then
    seconds = -seconds
  end
  return seconds, j
end

-- Mm.w.d | Jn | n, then an optional /time (default 02:00)
local function parseTzRule(s, i)
  local rule = {time = 7200}
  local m, w, d, j = string.match(s, "^M(%d+)%.(%d)%.(%d)()", i)
  if m then
    rule.kind, rule.m, rule.w, rule.d = "M", tonumber(m), tonumber(w), tonumber(d)
    if rule.m < 1 or rule.m > 12 then
      return nil
    end
  else
    local n
    n, j = string.match(s, "^J(%d+)()", i)
    if n then
      rule.kind, rule.n = "J", tonumber(n)
    else
      n, j = string.match(s, "^(%d+)()", i)
      if not n then
        return nil
      end
      rule.kind, rule.n = "n", tonumber(n)
    end
  end
  if string.sub(s, j, j) == "/" then
    local t
    t, j = parseTzTime(s, j + 1)
    if not t then
      return nil
    end
    rule.time = t
  end
  return rule, j
end

-- Offsets are stored east-positive (POSIX writes them west-positive).
local function parsePosixTz(s)
  if type(s) ~= "string" or #s > 80 then
    return nil
  end
  local tz, i, offset = {}
  tz.std, i = parseTzName(s, 1)
  if not tz.std then
    return nil
  end
  offset, i = parseTzTime(s, i)
  if not offset then
    return nil
  end
  tz.stdOffset = -offset
  if i > #s then
    return tz
  end
  tz.dst, i = parseTzName(s, i)
  if not tz.dst then
    return nil
  end
  tz.dstOffset = tz.stdOffset + 3600
  if string.sub(s, i, i) ~= "," then
    offset, i = parseTzTime(s, i)
    if not offset then
      return nil
    end
    tz.dstOffset = -offset
  end
  -- tzdata always spells the rules out; no implied US defaults
  if string.sub(s, i, i) ~= "," then
    return nil
  end
  tz.start, i = parseTzRule(s, i + 1)
  if not tz.start or string.sub(s, i, i) ~= "," then
    return nil
  end
  tz.finish, i = parseTzRule(s, i + 1)
  if not tz.finish or i <= #s then
    return nil
  end
  return tz
end

local function daysFromCivil(y, m, d)
  if m <= 2 then
    y = y - 1
  end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  return era * 146097 + yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy - 719468
end

local function isLeapYear(y)
  return (y % 4 == 0 and y % 100 ~= 0) or y % 400 == 0
end

-- day number (since 1970-01-01) the rule falls on in year y
local function ruleDay(rule, y)
  if rule.kind == "M" then
    local first = daysFromCivil(y, rule.m, 1)
    local day = 1 + (rule.d - (first + 4) % 7) % 7 + (rule.w - 1) * 7
    local monthDays = MONTH_DAYS[rule.m] + ((rule.m == 2 and isLeapYear(y)) and 1 or 0)
    while day > monthDays do
      day = day - 7
    end
    return first + day - 1
  elseif rule.kind == "J" then
    local n = rule.n
    if isLeapYear(y) and n >= 60 then
      n = n + 1
    end
    return daysFromCivil(y, 1, 1) + n - 1
  end
  return daysFromCivil(y, 1, 1) + rule.n
end

-- abbreviation and offset in force at UTC time t, and the next change
local function tzStateAt(tz, t)
  if not tz.dst then
    return tz.std, tz.stdOffset, nil
  end
  local year = tonumber(os.date("!%Y", t))
  local changes = {}
  for y = year - 1, year + 1 do
    changes[#changes + 1] = {
      at = ruleDay(tz.start, y) * 86400 + tz.start.time - tz.stdOffset,
      name = tz.dst,
      offset = tz.dstOffset
    }
    changes[#changes + 1] = {
      at = ruleDay(tz.finish, y) * 86400 + tz.finish.time - tz.dstOffset,
      name = tz.std,
      offset = tz.stdOffset
    }
  end
  table.sort(changes, function(a, b)
    return a.at < b.at
  end)
  local current, nextChange
  for _, change in ipairs(changes) do
    if change.at <= t then
      current = change
    elseif not nextChange then
      nextChange = change
    end
  end
  return current.name, current.offset, nextChange
end

local function readTimezoneConf()
  local f = io.open(TIMEZONE_CONF, "r")
  if not f then
    return nil
  end
  local zone = f:read("*l")
  local posix = f:read("*l")
  f:close()
  if not zone or zone == "" or not parsePosixTz(posix) then
    return nil
  end
  return {zone = zone, posix = posix}
end

-- TimeServer/zone reply shape, as stored in activityengine context.timezone
local function timezoneReply(conf)
  local name, offset, nextChange = tzStateAt(parsePosixTz(conf.posix), os.time())
  local zone = {
    tz = conf.posix,
    current = {[name] = {offset = offset}}
  }
  if nextChange then
    zone.next = {[nextChange.name] = {nextStart = nextChange.at, offset = nextChange.offset}}
  end
  return {timezone = zone}
end

local function localTimeServerReply(url)
  local path = string.match(url, "^%a+://[^/]+(/[^?#]*)")
  if path == "/time/current" then
    -- only once NTP has set the clock; before that, keep failing
    if os.time() < NTP_MIN_VALID then
      return nil
    end
    return {utc = os.date("!%Y-%m-%d %H:%M:%S")}
  end
  if path and string.find(path, "^/time/zone/") then
    local conf = readTimezoneConf()
    if conf then
      return timezoneReply(conf)
    end
  end
  return nil
end

local function installCloudHttpGuard()
  if http.__codexCloudGuard then
    return
  end
  local request = http.request
  http.request = function(req, body)
    local url = type(req) == "table" and req.url or req
    if isCloudHost(url) and cloudBlockerEnabled() then
      local reply = localTimeServerReply(url)
      if reply then
        local encoded = json.encode(reply)
        if type(req) ~= "table" then
          return encoded, 200, {}
        end
        if req.sink then
          req.sink(encoded)
          req.sink(nil)
        end
        return 1, 200, {}
      end
      log.notice("codex cloud blocker refused", url)
      return nil, "host not found"
    end
    return request(req, body)
  end
  http.__codexCloudGuard = true
  log.notice("codex cloud HTTP guard installed")
end

local function readFirstLine(path)
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local line = f:read("*l")
  f:close()
  return line
end

-- The interface LAN traffic goes through: Wi-Fi, or a USB Ethernet adapter.
-- usb_eth_service.sh names the adapter only while its address is on the saved
-- gateway's network; this also checks that it still has a route (an
-- address), with the same name rule as offline_egress_guard.sh.
local function lanDev()
  local dev = readFirstLine(LAN_DEV_FILE)
  if dev and (string.match(dev, "^eth%d%d?$") or string.match(dev, "^usb%d%d?$")) then
    local f = io.open("/proc/net/route", "r")
    if f then
      for line in f:lines() do
        if string.match(line, "^(%S+)") == dev then
          f:close()
          return dev
        end
      end
      f:close()
    end
  end
  return "ath0"
end

-- The hub's address for discovery and the rest of the engine (session.getIp:
-- the SSDP reply's LOCATION, among others). Stock sets it to the address of
-- the last netlink "newaddr", Wi-Fi's in practice, and clears it on any
-- "deladdr". While a USB Ethernet adapter carries local traffic, that's the
-- cable's address instead, and the cable joins the SSDP group too: the stock
-- responder (transport/ssdpdiscovery.lua) joins 239.255.255.250 once, on the
-- interface its route named at boot (Wi-Fi), so with Wi-Fi off the hub
-- wasn't discoverable, and Home Assistant, which takes a known hub's address
-- from SSDP, moved to the Wi-Fi address and lost the hub when Wi-Fi went off.
-- Joining from our own socket is enough for the responder's socket to get
-- the datagrams from the cable too (IP_MULTICAST_ALL, on by default). The
-- reply's LOCATION (and every other stock "the hub's address": discovery
-- info, Sonos and LIFX callbacks, the state digest) comes from
-- getNetworkAttribute("ipaddr"), which common/config.lua answers with ath0's
-- address, kept even while Wi-Fi is disconnected: while the cable carries
-- local traffic it answers with the cable's.
local SSDP_GROUP = "239.255.255.250"
local addrByLabel = {}
local lanAdvert = { ip = nil, sock = nil }
local advertisedIp

-- Modules are shared by the engine's tasks (see installCloudHttpGuard), so
-- this covers the stock callers. Only "ipaddr", only while the cable carries
-- local traffic; the MAC address and the rest stay Wi-Fi's.
local function installNetworkAttributeOverride()
  for _, name in ipairs({ "common.config", "works.system" }) do
    local ok, mod = pcall(require, name)
    if ok and type(mod) == "table" and type(mod.getNetworkAttribute) == "function" and not mod.__codexLanAddr then
      local stock = mod.getNetworkAttribute
      mod.getNetworkAttribute = function(attribute, ...)
        if attribute == "ipaddr" and advertisedIp then
          return advertisedIp
        end
        return stock(attribute, ...)
      end
      mod.__codexLanAddr = true
    end
  end
end

local function ifaceAddr(dev)
  if addrByLabel[dev] then
    return addrByLabel[dev]
  end
  -- An address the netlink loop didn't see (it takes one event per batch).
  local p = io.popen("ifconfig " .. dev .. " 2>/dev/null")
  if not p then
    return nil
  end
  local out = p:read("*a") or ""
  p:close()
  -- Kept until a netlink event for it says otherwise: no fork every pass.
  addrByLabel[dev] = string.match(out, "inet addr:(%d+%.%d+%.%d+%.%d+)")
  return addrByLabel[dev]
end

local function ssdpJoin(ip)
  if lanAdvert.ip == ip and lanAdvert.sock then
    return
  end
  if lanAdvert.sock then
    pcall(function() lanAdvert.sock:close() end)
    lanAdvert.sock, lanAdvert.ip = nil, nil
  end
  if not ip then
    return
  end
  local udp = socket.udp()
  if not udp then
    return
  end
  local ok = udp:setoption("ip-add-membership", { multiaddr = SSDP_GROUP, interface = ip })
  if ok then
    lanAdvert.sock, lanAdvert.ip = udp, ip
    log.notice("codex lan advertise: SSDP group joined on", ip)
  else
    udp:close()
  end
end

-- Puts the session address and the SSDP membership where local traffic goes.
-- With Wi-Fi carrying it, only a missing address (after a "deladdr") or one
-- on another interface (an adapter that isn't carrying local traffic) is
-- corrected, to Wi-Fi's.
local function lanAdvertSync()
  local dev = lanDev()
  local want
  if dev ~= "ath0" then
    want = ifaceAddr(dev)
    ssdpJoin(want)
  else
    ssdpJoin(nil)
  end
  advertisedIp = want
  if not want then
    want = ifaceAddr("ath0")
  end
  if want and session.getIp() ~= want then
    log.notice("codex lan advertise: hub address", want, "on", want == lanAdvert.ip and dev or "ath0")
    session.setIp(want)
  end
end

local lanAdvertTask
local function startLanAdvertise()
  if lanAdvertTask and system.taskStatus(lanAdvertTask) ~= "dead" then
    return
  end
  lanAdvertTask = system.addTask("codex lan advertise", function()
    while true do
      local ok, err = pcall(lanAdvertSync)
      if not ok then
        log.error("codex lan advertise:", err)
      end
      system.sleep(5000)
    end
  end)
end

local function hasDefaultRoute()
  local f = io.open("/proc/net/route", "r")
  if not f then
    return false
  end
  local found = false
  for line in f:lines() do
    local dest, flags = string.match(line, "^%S+%s+(%x+)%s+%x+%s+(%x+)")
    -- RTF_GATEWAY is bit 1 of the flags column
    if dest == "00000000" and flags and math.floor(tonumber(flags, 16) / 2) % 2 == 1 then
      found = true
      break
    end
  end
  f:close()
  return found
end

local function isIpv4(value)
  return type(value) == "string" and string.match(value, "^%d+%.%d+%.%d+%.%d+$") ~= nil
end

local function ntpQuery(ip)
  local udp = socket.udp()
  if not udp then
    return nil, "no udp socket"
  end
  udp:settimeout(3)
  local ok, err = udp:setpeername(ip, 123)
  if not ok then
    udp:close()
    return nil, err
  end
  -- LI 0, version 3, mode 3 (client); the rest of the 48 bytes are zero.
  udp:send(string.char(27) .. string.rep(string.char(0), 47))
  local reply
  reply, err = udp:receive()
  udp:close()
  if not reply then
    return nil, err or "no reply"
  end
  if #reply < 48 then
    return nil, "short reply"
  end
  local mode = string.byte(reply, 1) % 8
  local stratum = string.byte(reply, 2)
  if mode ~= 4 or stratum < 1 or stratum > 15 then
    return nil, "unsynchronised server"
  end
  local b1, b2, b3, b4 = string.byte(reply, 41, 44)
  local seconds = ((b1 * 256 + b2) * 256 + b3) * 256 + b4 - NTP_EPOCH_OFFSET
  if seconds < NTP_MIN_VALID then
    return nil, "implausible time"
  end
  return seconds
end

-- With the blocker on, the egress guard removes the default route. Open a
-- host route to just this NTP server through the saved gateway for the
-- length of one query.
local function ntpQueryRouted(ip)
  if hasDefaultRoute() then
    return ntpQuery(ip)
  end
  local gateway = readFirstLine(GATEWAY_STATE)
  if not isIpv4(gateway) then
    return nil, "no saved gateway"
  end
  local route = "-host " .. ip .. " gw " .. gateway .. " dev " .. lanDev()
  -- If the adapter can't reach the gateway after all (a stale codex-lan-dev),
  -- Wi-Fi still can.
  local added = os.execute("route add " .. route .. " >/dev/null 2>&1")
  if added ~= 0 and added ~= true and not string.match(route, " dev ath0$") then
    route = "-host " .. ip .. " gw " .. gateway .. " dev ath0"
    os.execute("route add " .. route .. " >/dev/null 2>&1")
  end
  local seconds, err = ntpQuery(ip)
  os.execute("route del " .. route .. " >/dev/null 2>&1")
  return seconds, err
end

local function syncClockOnce()
  for _, server in ipairs(NTP_SERVERS) do
    local ip = socket.dns.toip(server, 10000)
    if isIpv4(ip) then
      local seconds, err = ntpQueryRouted(ip)
      if seconds then
        local drift = seconds - os.time()
        if math.abs(drift) > 2 then
          -- The watchdog reboots the hub when a /var/watchdog file looks
          -- older than 15 s; touch them all in the same shell as the jump.
          os.execute("date -u -s \"" .. os.date("!%Y-%m-%d %H:%M:%S", seconds) ..
            "\" >/dev/null 2>&1; touch /var/watchdog/* 2>/dev/null")
          system.tiggleWatchDog("codex time sync: clock stepped by " ..
            tostring(drift) .. " s from " .. server)
        else
          log.notice("codex time sync: clock within 2 s of", server)
        end
        return true
      end
      log.notice("codex time sync:", server, ip, tostring(err))
    else
      log.notice("codex time sync: cannot resolve", server)
    end
  end
  return false
end

-- Apply a time zone saved from the web UI without waiting for the activity
-- engine's own refresh (it only refetches when the previous zone's next
-- change has passed). All luaworks tasks share one Lua state, so the
-- activity engine's context and timemanager are the same module tables.
local timezoneWatchTask

local function startTimezoneWatch()
  if timezoneWatchTask and system.taskStatus(timezoneWatchTask) ~= "dead" then
    return
  end
  timezoneWatchTask = system.addTask("codex timezone watch", function()
    local applied
    while true do
      system.sleep(30000)
      local conf = readTimezoneConf()
      local key = conf and (conf.zone .. "\n" .. conf.posix)
      if key and key ~= applied and system.isMessageRegistered("process_activity") then
        local context = require("tasks.activityengine.core.contextmanager").getContext()
        if context and context.clockinitialized then
          applied = key
          -- one-off task: an error here must not stop the watcher
          system.addTask("codex timezone apply", function()
            local timeMgr = require("tasks.activityengine.core.timemanager")
            context.timezoneid = context.timezoneid or conf.zone
            timeMgr.updateTimezone(context, true)
            timeMgr.updateSunTimes(context)
            log.notice("codex timezone applied:", conf.zone, conf.posix)
          end)
        end
      end
    end
  end)
end

local function startTimeSync()
  if timeSyncTask and system.taskStatus(timeSyncTask) ~= "dead" then
    return
  end
  timeSyncTask = system.addTask("codex time sync", function()
    local retry = 30
    while true do
      if syncClockOnce() then
        retry = 30
        system.sleep(NTP_RESYNC_SECONDS * 1000)
      else
        system.sleep(retry * 1000)
        retry = math.min(retry * 2, 900)
      end
    end
  end)
end

local function localResourceName(params)
  local uri = tostring(params and params.uri or "")
  local known = {
    "ActivityList",
    "DeviceList",
    "MapList",
    "FunctionList",
    "CapabilityList",
    "ProtocolList",
    "InstallerInfo",
    "Settings",
    "Context"
  }
  for _, name in ipairs(known) do
    if string.find(uri, "/" .. name, 1, true) then
      return name
    end
  end
  if string.find(uri, "HomeAutomationService/Config", 1, true) then
    return "AutomationConfig"
  end
  if string.find(uri, "content://1.0/user", 1, true) then
    return "ContentUser"
  end
  local deviceId = string.match(uri, "/device/(%d+)%-")
  if not deviceId and params and params.deviceId then
    deviceId = tostring(params.deviceId)
  end
  if deviceId and string.find(uri, "content://1.0/device", 1, true) then
    return "CD_" .. deviceId
  end
  return nil
end

-- During every sync the Harmony Touch fetches CD_<device> for some of its
-- devices and aborts the whole sync (553) unless the answer is 200 or 304,
-- so it then retries on every button press and never takes a new setup.
-- Devices made on the hub have no such file, so answer with the record
-- Logitech kept for a device with no content services. The id and etag
-- depend only on the device, so repeated syncs see the same record.
local function emptyDeviceContent(cmd, uri, deviceId, encode)
  local resource = {
    id = string.format("00000000-0000-4000-8000-%012d", tonumber(deviceId)),
    device_profile_uri = "svcs.myharmony.com/res/device/" .. deviceId .. "-melodious",
    services = {}
  }
  if encode then
    resource = json.encode(resource)
  end
  log.notice("codex offline guard served empty device content", deviceId)
  return connectUtils.createResponse(cmd, "200", "OK", {
    code = "200",
    uri = uri,
    etag = "\"melodious-empty-content-" .. deviceId .. "\"",
    hetag = "1",
    resource = resource,
    localOnly = true
  })
end

local function offlineResourceGet(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeResourceHandler.processGetResource(cmd, verb, params)
  end
  params = params or {}
  connectUtils.fixHbusData(cmd, verb, params)
  local uri = tostring(params.uri or "")
  local resourceName = localResourceName(params)
  if not resourceName then
    log.notice("codex offline guard blocked resource get", uri)
    local code = string.find(uri, "sus://", 1, true) and "304" or "404"
    return connectUtils.createResponse(cmd, "200", "OK", {
      code = code,
      uri = uri,
      localOnly = true
    })
  end
  local status, etag, resource = resMgr.getResource(resourceName)
  if tostring(status or "") ~= "200" then
    local deviceId = string.match(resourceName, "^CD_(%d+)$")
    if deviceId then
      return emptyDeviceContent(cmd, uri, deviceId, params.encode)
    end
    log.notice(
      "codex offline guard could not serve local resource",
      resourceName
    )
    return connectUtils.createResponse(cmd, "200", "OK", {
      code = "404",
      uri = uri,
      localOnly = true
    })
  end
  if params.encode then
    resource = json.encode(resource)
  end
  log.notice("codex offline guard served local resource", resourceName)
  return connectUtils.createResponse(cmd, "200", "OK", {
    code = "200",
    uri = uri,
    etag = etag,
    hetag = resMgr.getHubEtag(resourceName),
    resource = resource,
    localOnly = true
  })
end

-- The remote records "Did the activity start correctly? -> Yes" by dropping
-- that activity's Alternatives key and PUTting the whole ActivityList. Keep
-- just that change locally, or the remote asks again on every start; the
-- rest of the PUT is still discarded. Returns the names of changed activities.
local function dropConfirmedAlternatives(putList, localList)
  local confirmed, changed = {}, {}
  if type(putList) ~= "table" or type(putList.Activities) ~= "table" or
      type(localList) ~= "table" or type(localList.Activities) ~= "table" then
    return changed
  end
  for _, activity in ipairs(putList.Activities) do
    if type(activity) == "table" and activity["Id-"] ~= nil and
        (activity.Alternatives == nil or activity.Alternatives == json.null) then
      confirmed[tostring(activity["Id-"])] = true
    end
  end
  for _, activity in ipairs(localList.Activities) do
    if type(activity) == "table" and confirmed[tostring(activity["Id-"])] and
        activity.Alternatives ~= nil then
      activity.Alternatives = nil
      changed[#changed + 1] = tostring(activity.Name or activity["Id-"])
    end
  end
  return changed
end

local function newResourceEtag()
  local ok, uuid = pcall(system.uuid)
  if ok and type(uuid) == "string" and string.match(uuid, "^[%x%-]+$") then
    return '"' .. uuid .. '"'
  end
  return string.format('"%08x-%04x-4%03x-a%03x-%06x%06x"',
    math.random(0, 0x7fffffff), math.random(0, 0xffff), math.random(0, 0xfff),
    math.random(0, 0xfff), math.random(0, 0xffffff), math.random(0, 0xffffff))
end

-- Returns the new etag and hetag when the local ActivityList changed.
local function keepActivityConfirmations(params)
  if resMgr.isAnySyncInProgress() then
    return nil
  end
  local body = params.resource
  if type(body) == "string" then
    local ok, decoded = pcall(json.decode, body)
    body = ok and decoded or nil
  end
  local status, _, current = resMgr.getResource("ActivityList")
  if tostring(status or "") ~= "200" then
    return nil
  end
  local changed = dropConfirmedAlternatives(body, current)
  if #changed == 0 then
    return nil
  end
  local etag = newResourceEtag()
  local hetag = tostring((tonumber(resMgr.getHubEtag("ActivityList")) or 0) + 1)
  local ok, detail = resMgr.saveResource("application/json", etag, current, "ActivityList", nil, hetag)
  if not ok then
    log.notice("codex could not keep activity confirmation:", tostring(detail))
    return nil
  end
  log.notice("codex kept activity confirmation for", table.concat(changed, ", "))
  return etag, hetag
end

local function offlineResourcePut(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeResourceHandler.processPutResource(cmd, verb, params)
  end
  params = params or {}
  connectUtils.fixHbusData(cmd, verb, params)
  local uri = tostring(params.uri or "")
  local resourceName = localResourceName(params)
  local etag
  local hetag
  if resourceName then
    etag = resMgr.getEtag(resourceName)
    hetag = resMgr.getHubEtag(resourceName)
  end
  -- CODEX DIAG (removable, behaviour-neutral): capture the paired remote's put payload
  local diagOk, diagError = pcall(function()
    local body = params.resource
    local encoded
    if type(body) == "string" then
      encoded = body
    elseif body ~= nil then
      local ok, enc = pcall(json.encode, body)
      encoded = ok and enc or nil
    end
    log.notice(
      "codex put payload",
      uri,
      "type", type(body),
      "len", encoded and #encoded or 0
    )
    if encoded and #encoded < 262144 then
      local path = "/var/volatile/codex-put-" .. tostring(resourceName or "unknown") .. ".json"
      local f = io.open(path, "w")
      if f then
        f:write(encoded)
        f:close()
      end
    end
    if type(params) == "table" then
      local names = {}
      for k in pairs(params) do
        names[#names + 1] = tostring(k)
      end
      log.notice("codex put param keys", uri, table.concat(names, ","))
    end
  end)
  if not diagOk then
    log.notice("codex put diagnostics failed:", tostring(diagError))
  end
  if resourceName == "ActivityList" then
    local keptEtag, keptHetag = keepActivityConfirmations(params)
    if keptEtag then
      etag, hetag = keptEtag, keptHetag
    end
  end
  log.notice(
    "codex offline guard acknowledged resource put without cloud",
    uri
  )
  return connectUtils.createResponse(cmd, "200", "OK", {
    code = "204",
    uri = uri,
    etag = etag,
    hetag = hetag,
    localOnly = true
  })
end

local function offlineSyncDefault(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processCmdDefault(cmd, verb, params)
  end
  log.notice("codex offline guard acknowledged local-only sync", cmd)
  return connectUtils.createResponse(cmd, "200", "OK", {
    localOnly = true
  })
end

local function offlineSyncRemoteChanges(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processSyncRemoteChangesCommand(cmd, verb, params)
  end
  log.notice(
    "codex offline guard discarded cloud-bound remote change queue request",
    cmd
  )
  return connectUtils.createResponse(cmd, "200", "OK", {
    localOnly = true
  })
end

local function offlineConfigChanged(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processConfigChangedCommand(cmd, verb, params)
  end
  log.notice("codex offline guard ignored cloud-stale marker", cmd)
  return connectUtils.createResponse(cmd, "200", "OK", {
    localOnly = true
  })
end

local function offlineSyncBegin(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processCmdBegin(cmd, verb, params)
  end
  return offlineSyncDefault(cmd, verb, params)
end

local function offlineSyncEnd(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processCmdEnd(cmd, verb, params)
  end
  return offlineSyncDefault(cmd, verb, params)
end

local function offlineSyncContentChanged(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processCmdContentChanged(cmd, verb, params)
  end
  return offlineSyncDefault(cmd, verb, params)
end

local function offlineDeleteResources(cmd, verb, params)
  if not cloudBlockerEnabled() then
    return nativeSyncHandler.processCmdDeleteResources(cmd, verb, params)
  end
  log.notice("codex offline guard refused resource deletion", cmd)
  return connectUtils.createResponse(cmd, "200", "OK", {
    localOnly = true
  })
end

-- The Harmony Touch's own Sync asks the hub for the time. Stock code answers
-- only with internet, so offline the Touch gets 506 "Wi-Fi is not available"
-- and its clock is never set. The hub keeps NTP time itself.
--
-- The same Sync also asks for a hub firmware check (setup.firmware?check).
-- Leave that to the stock handler, which fails offline: a Touch that gets a
-- successful check goes on to judge its own update status, which the offline
-- sus:// answer leaves empty, and stops on a "myharmony.com" screen that
-- needs a forced restart. Failing the check ends the Sync harmlessly.
local function offlineGetTime(cmd, verb, params)
  if not cloudBlockerEnabled() or os.time() < NTP_MIN_VALID then
    local native = require("tasks.harmonyengine.apihandler.harmonyengine")
    return native.processCmdGetTime(cmd, verb, params)
  end
  local localDigest = require("tasks.harmonywebservices.core.statedigest"):instance()
  log.notice("codex offline guard answered the time from the hub clock", cmd)
  return connectUtils.createResponse(cmd, "200", "OK", {
    utcTime = os.date("!*t"),
    tz = localDigest.tz
  })
end

local function installOfflineApiGuards()
  engine.registerMessage(
    "proxy.resource?get", nil, offlineResourceGet
  )
  engine.registerMessage(
    "proxy.resource?put", nil, offlineResourcePut
  )
  engine.registerMessage(
    "setup.configchanged", nil, offlineConfigChanged
  )
  engine.registerMessage(
    "setup.sync?begin", nil, offlineSyncBegin
  )
  engine.registerMessage(
    "setup.sync?end", nil, offlineSyncEnd
  )
  engine.registerMessage(
    "setup.sync?contentchanged", nil, offlineSyncContentChanged
  )
  engine.registerMessage(
    "setup.sync?deleteresources", nil, offlineDeleteResources
  )
  engine.registerMessage(
    "setup.sync", nil, offlineSyncDefault
  )
  engine.registerMessage(
    "setup.syncremotechanges", nil, offlineSyncRemoteChanges
  )
  engine.registerMessage(
    "harmony.engine?gettime", nil, offlineGetTime
  )
  log.notice("codex offline HBus guards registered")
end

-- Activity time restrictions. Every activity start (Companion and Touch
-- activity buttons through the activity engine, hbus startactivity from the
-- web UI, apps and MQTT, the help press) ends in startActivity(params,
-- clientId, callback) of tasks.harmonyengine.apihandler.activity, and every
-- caller takes it from that module table when it calls or queues it. One
-- wrapper there refuses a restricted start before the engine changes any
-- state. hbus startactivity is also refused at its handler, so its callers
-- get the refusal as the answer (guardedStartActivity). Only starts are
-- refused: the running activity, the help press,
-- PowerOff and the boot relaunch of the activity that ran before a reboot
-- always pass, and so does everything while the clock or zone is unknown.
--
-- RESTRICTIONS_CONF is read on every start, so edits apply without a reboot:
--   {"activities": {"<activityId>": [
--     {"days": ["sat", "sun"], "start": "06:00", "end": "09:00"}]}}
-- Times are hub-local, end is exclusive and may be "24:00". A window whose
-- end is before its start runs past midnight and belongs to its start day.
local RESTRICTIONS_CONF = "/data/codex/activity-restrictions.json"
-- the engine's own refusals stop at 567 (activity not found)
local RESTRICTED_CODE = "568"
local DAY_NAMES = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

local activityRestrictionTask

-- "HH:MM" -> minutes since midnight
local function parseClock(value, isEnd)
  local h, m = string.match(tostring(value), "^(%d%d?):(%d%d)$")
  h, m = tonumber(h), tonumber(m)
  if not h or m > 59 then
    return nil
  end
  local minutes = h * 60 + m
  if minutes < 1440 or (isEnd and minutes == 1440) then
    return minutes
  end
  return nil
end

local function parseWindow(window)
  if type(window) ~= "table" or type(window.days) ~= "table" then
    return nil
  end
  local days, names = {}, {}
  for _, name in ipairs(window.days) do
    for wday, dayName in ipairs(DAY_NAMES) do
      if string.lower(tostring(name)) == dayName and not days[wday] then
        days[wday] = true
        names[#names + 1] = dayName
      end
    end
  end
  local start, finish = parseClock(window.start, false), parseClock(window["end"], true)
  if #names == 0 or not start or not finish or start == finish then
    return nil
  end
  return {
    days = days,
    start = start,
    finish = finish,
    text = table.concat(names, ",") .. " " .. tostring(window.start) .. "-" .. tostring(window["end"])
  }
end

-- activityId -> list of windows; a missing file means no restrictions
local function readActivityRestrictions()
  local f = io.open(RESTRICTIONS_CONF, "r")
  if not f then
    return {}
  end
  local body = f:read("*a")
  f:close()
  local ok, decoded = pcall(json.decode, body)
  if not ok or type(decoded) ~= "table" or type(decoded.activities) ~= "table" then
    return nil, "unreadable " .. RESTRICTIONS_CONF
  end
  local rules = {}
  for activityId, windows in pairs(decoded.activities) do
    if type(windows) == "table" then
      for _, raw in ipairs(windows) do
        local window = parseWindow(raw)
        if window then
          local key = tostring(activityId)
          rules[key] = rules[key] or {}
          table.insert(rules[key], window)
        else
          log.notice("codex activity restrictions: ignored a bad window for", tostring(activityId))
        end
      end
    end
  end
  return rules
end

-- weekday (1 = Sunday) and minutes since midnight in hub-local time
local function localClock(now)
  local conf = readTimezoneConf()
  local tz = conf and parsePosixTz(conf.posix)
  if not tz then
    local ok, digest = pcall(function()
      return require("tasks.harmonywebservices.core.statedigest"):instance()
    end)
    tz = ok and type(digest) == "table" and parsePosixTz(digest.tz)
  end
  if not tz then
    return nil
  end
  local _, offset = tzStateAt(tz, now)
  local t = os.date("!*t", now + offset)
  return t.wday, t.hour * 60 + t.min
end

local function windowCovers(window, wday, minutes)
  if window.start < window.finish then
    return window.days[wday] == true and minutes >= window.start and minutes < window.finish
  end
  local previous = (wday + 5) % 7 + 1
  return (window.days[wday] == true and minutes >= window.start) or
    (window.days[previous] == true and minutes < window.finish)
end

-- The window that refuses this start, and the account, or nil to let it run.
local function restrictedStart(params, callback)
  if type(params) ~= "table" or params.verb == "helpdiscretes" or params.activityId == nil then
    return nil
  end
  local activityId = tostring(params.activityId)
  if activityId == "-1" then
    return nil
  end
  local account = session.getAccount()
  if not account or activityId == tostring(account.currentActivityId) then
    return nil
  end
  -- The rules runner passes a callback only for the boot relaunch, which
  -- restores the activity that was running before the reboot.
  if callback then
    local digest = require("tasks.harmonywebservices.core.statedigest"):instance()
    if digest.isDummyActivitySet() then
      return nil
    end
  end
  local rules, err = readActivityRestrictions()
  if not rules then
    log.notice("codex activity restrictions not applied:", err)
    return nil
  end
  local windows = rules[activityId]
  if not windows then
    return nil
  end
  local now = os.time()
  local wday, minutes
  if now >= NTP_MIN_VALID then
    wday, minutes = localClock(now)
  end
  if not wday then
    log.notice("codex activity restrictions not applied: clock or time zone unknown")
    return nil
  end
  for _, window in ipairs(windows) do
    if windowCovers(window, wday, minutes) then
      return window, account
    end
  end
  return nil
end

-- Answer like the engine's own "activity not found" refusal.
-- Logs the refusal; returns the message to answer with.
local function refusalMessage(params, window, account)
  local activity = type(account.activities) == "table" and account.activities[params.activityId]
  local label = tostring(type(activity) == "table" and activity.label or params.activityId)
  log.notice("codex activity restriction refused start of", label, tostring(params.activityId), window.text)
  return "Activity is restricted at this time: " .. label
end

local function refuseStart(params, clientId, callback, window, account)
  local message = refusalMessage(params, window, account)
  if callback and params.noResponse ~= true then
    return callback(clientId, params.cmd, RESTRICTED_CODE, message,
      "activityId=" .. tostring(account.currentActivityId), params.id,
      {noHttpResponse = true, headers = params.headers}, params.callbackUrl)
  end
end

-- hbus harmony.engine?startactivity (the web UI, MQTT, the apps): the stock
-- handler only broadcasts run_activity and answers 200 at once, so a refusal
-- from the startActivity wrapper comes second, after callers such as
-- codex_hbus have taken the 200 and gone. Refuse here first, as the answer
-- itself; everything else goes to the stock handler.
local function guardedStartActivity(cmd, verb, params)
  local ok, window, account = pcall(restrictedStart, params, nil)
  if not ok then
    log.notice("codex activity restrictions check failed:", tostring(window))
  elseif window then
    return connectUtils.createResponse(cmd, RESTRICTED_CODE, refusalMessage(params, window, account),
      {activityId = tostring(account.currentActivityId)})
  end
  local native = require("tasks.harmonyengine.apihandler.harmonyengine")
  return native.processStartActivity(cmd, verb, params)
end

local function installActivityRestrictions()
  if activityRestrictionTask and system.taskStatus(activityRestrictionTask) ~= "dead" then
    return
  end
  engine.registerMessage("harmony.engine?startactivity", nil, guardedStartActivity)
  activityRestrictionTask = system.addTask("codex activity restrictions", function()
    -- the activity engine loads the module before it registers this
    while not system.isMessageRegistered("process_activity") do
      system.sleep(1000)
    end
    local heactivity = require("tasks.harmonyengine.apihandler.activity")
    if heactivity.__codexTimeRestrictions then
      return
    end
    local startActivity = heactivity.startActivity
    heactivity.startActivity = function(params, clientId, callback)
      local ok, window, account = pcall(restrictedStart, params, callback)
      if not ok then
        log.notice("codex activity restrictions check failed:", tostring(window))
      elseif window then
        return refuseStart(params, clientId, callback, window, account)
      end
      return startActivity(params, clientId, callback)
    end
    heactivity.__codexTimeRestrictions = true
    log.notice("codex activity restrictions installed")
  end)
end

local function startCloudModule(label, moduleName)
  log.notice("starting " .. label .. " task")
  local ok, task = pcall(require, moduleName)
  if not ok then
    log.notice("codex cloud task load failed", label, tostring(task))
    return nil
  end
  if task and task.start then
    local started, err = pcall(function()
      task.start()
    end)
    if not started then
      log.notice("codex cloud task start failed", label, tostring(err))
    end
  end
  return task
end

local function maybeStartCloudTasks()
  if cloudBlockerEnabled() then
    log.notice("codex cloud blocker active: cloudapi, pubnub, and packagemgr background tasks not started")
    return
  end
  if not cloudapi then
    cloudapi = startCloudModule("cloudapi", "tasks.connectserver.transport.cloudapi")
  end
  if not pubnubServerConnect then
    pubnubServerConnect = startCloudModule("PubNub Connection", "tasks.connectserver.transport.pubnubwrapper")
  end
  if not packagemgr or (packagemgr.taskStatus and packagemgr.taskStatus() == "dead") then
    packagemgr = startCloudModule("packagemgr", "tasks.connectserver.transport.packagemgr")
  end
end

local function logWifiEvent(name, id)
  local usageLog = require("tasks.crashlog.apihandler.usagelog")
  local t = {
    category = "hub connectivity",
    name = name
  }
  if id then
    t.id = id
  end
  usageLog.postAnalyticEvent(t)
end

local function handleEvent(event)
  if event.family ~= "inet" or event.label == "br-lan" then
    return
  end

  if event.msgtype == "newaddr" then
    log.notice(event.label .. ":newaddr", event.address)
    if event.label ~= "lo" then
      addrByLabel[event.label] = event.address
      session.setIp(event.address)
      pcall(lanAdvertSync)
    end

    local uuid = system.uniqueId()
    local usageLog = require("tasks.crashlog.apihandler.usagelog")
    usageLog.setUniqueId("wifi", uuid)
    logWifiEvent("connect wifi", uuid)

    if ipaddr ~= event.address and event.label ~= "lo" then
      ipaddr = event.address
    end

    if not discovery then
      log.notice("discovery: starting task")
      discovery = system.loadTask("tasks/connectserver/transport/discovery.lua")
    end
    if not ssdpDiscovery and event.label ~= "lo" then
      log.notice("ssdpDiscovery: starting task")
      ssdpDiscovery = system.loadTask("tasks/connectserver/transport/ssdpdiscovery.lua")
    end
    if not halConnect then
      log.notice("starting HAL task")
      halConnect = system.loadTask("tasks/connectserver/transport/halhttpserverconnector.lua")
    end
    if not hbusHttpServerConnect then
      log.notice("starting HBUS over HTTP server task")
      hbusHttpServerConnect = system.loadTask("tasks/connectserver/transport/hbushttpserverconnector.lua")
    end
    if not ltcpServerConnector then
      log.notice("starting LTCP Server task")
      ltcpServerConnector = system.loadTask("tasks/connectserver/transport/ltcpserverconnector.lua")
    end

    if event.label ~= "lo" then
      if not melodiousOff() then
        startTimeSync()
        startTimezoneWatch()
      end
      maybeStartCloudTasks()
      system.broadcastMessageExceptMeNoWarning(MSG_NETSERVICE_NEW_ADDRESS, {
        label = event.label,
        ipaddr = event.address
      })
    end
  elseif event.msgtype == "deladdr" then
    log.notice(event.label .. ":deladdr", event.address)
    if event.label ~= "lo" then
      if addrByLabel[event.label] == event.address then
        addrByLabel[event.label] = nil
      end
      session.setIp(nil)
      pcall(lanAdvertSync)
      local usageLog = require("tasks.crashlog.apihandler.usagelog")
      logWifiEvent("disconnect wifi", usageLog.getUniqueId("wifi"))
    end
  end
end

if not melodiousOff() then
  installCloudHttpGuard()
  installOfflineApiGuards()
  installActivityRestrictions()
  installNetworkAttributeOverride()
  startLanAdvertise()
else
  log.notice("codex melodious off: skipping offline guards, activity restrictions and LAN advertise")
end

if mfgData.hasNetwork == true then
  while not system.isMessageRegistered("config_unload") or not system.isMessageRegistered("get_setup_account") do
    system.yield()
  end
  local netlink = system.netlinkOpen()
  while true do
    system.yieldSocketRecv(netlink)
    local events = netlink:receive()
    if events then
      local processEvent = false
      local newEvent
      for i, event in ipairs(events) do
        log.notice("netlink event", i, event)
        if event.msgtype == "newaddr" then
          newEvent = event
        end
        if event.family == "inet" and event.label ~= "lo" then
          handleEvent(event)
          processEvent = true
          break
        end
      end
      if newEvent and not processEvent then
        handleEvent(newEvent)
      end
    end
  end
  netlink:close()
else
  log.notice("starting HAL task")
  halConnect = system.loadTask("tasks/connectserver/transport/halhttpserverconnector.lua")
  log.notice("starting HBUS over HTTP server task")
  hbusHttpServerConnect = system.loadTask("tasks/connectserver/transport/hbushttpserverconnector.lua")
  log.notice("starting LTCP Server task")
  ltcpServerConnector = system.loadTask("tasks/connectserver/transport/ltcpserverconnector.lua")
end
