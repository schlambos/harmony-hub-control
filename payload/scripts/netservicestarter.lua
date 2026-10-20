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
local CLOUD_HOST_PATTERNS = {
  "myharmony%.com$",
  "logitech%.com$",
  "logitechharmony%.com$",
  "pubnub%.com$",
  "pubnub%.net$"
}

local function cloudBlockerEnabled()
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

local function installCloudHttpGuard()
  if http.__codexCloudGuard then
    return
  end
  local request = http.request
  http.request = function(req, body)
    local url = type(req) == "table" and req.url or req
    if isCloudHost(url) and cloudBlockerEnabled() then
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
  local route = "-host " .. ip .. " gw " .. gateway .. " dev ath0"
  os.execute("route add " .. route .. " >/dev/null 2>&1")
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
  log.notice(
    "codex offline guard acknowledged resource put without cloud or mutation",
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
  log.notice("codex offline HBus guards registered")
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
      session.setIp(event.address)
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
      startTimeSync()
      maybeStartCloudTasks()
      system.broadcastMessageExceptMeNoWarning(MSG_NETSERVICE_NEW_ADDRESS, {
        label = event.label,
        ipaddr = event.address
      })
    end
  elseif event.msgtype == "deladdr" then
    log.notice(event.label .. ":deladdr", event.address)
    if event.label ~= "lo" then
      session.setIp(nil)
      local usageLog = require("tasks.crashlog.apihandler.usagelog")
      logWifiEvent("disconnect wifi", usageLog.getUniqueId("wifi"))
    end
  end
end

installCloudHttpGuard()
installOfflineApiGuards()

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
