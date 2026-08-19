local hbus = require("tasks.hal.core.hbus"):instance()
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
