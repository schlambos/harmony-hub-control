module(..., package.seeall)

local system = require("system")
local json = require("json")
local hbus = require("tasks.hal.core.hbus"):instance()
local log = require("log").logger("auto.p.codexactivity")
local resources = require("tasks.harmonywebservices.core.resourcemanager")
local digest = require("tasks.harmonywebservices.core.statedigest"):instance()
local connect = require("tasks.connectserver.core.utils")

local REQUEST_FILE = "/var/volatile/codex-activity-request.json"
local RESPONSE_FILE = "/var/volatile/codex-activity-response.json"
local CLOUD_BLOCKER_FILE = "/data/codex/cloud_blocker.conf"
-- The activityengine task is the only listener for process_activity, so a
-- synchronous send is a FIFO barrier behind the init_activity_engine that
-- harmonyengine broadcasts while handling config_new.
local ACTIVITY_ENGINE_BARRIER_MESSAGE = "process_activity"
-- A long activity start can hold the engine; bound the wait (100 ms steps).
local ACTIVITY_ENGINE_BARRIER_STEPS = 600
-- codex_webui leaves this flag (resource names, one per line) after it edits
-- IR devices or commands. codexmqtt used to be its only reader and never looks
-- while its broker is unreachable, so the reload lives here, with the other
-- local config writes.
local RESOURCE_RELOAD_FLAG = "/data/codex/reload_resources"
local RELOADABLE_RESOURCES = {
  ActivityList = true,
  AutomationConfig = true,
  DeviceList = true,
  FunctionList = true,
  MapList = true,
  ProtocolList = true
}

local moduleObj
local workerTask
local barrierTask
local stopRequested = false
local tokenCounter = 0

local function new(self)
  local obj = {}
  setmetatable(obj, self)
  self.__index = self
  return obj
end

function instance(self)
  if not moduleObj then
    moduleObj = new(self)
  end
  return moduleObj
end

local function readFile(path)
  local f = io.open(path, "rb")
  if not f then
    return nil
  end
  local data = f:read("*a")
  f:close()
  return data
end

local function writeFileAtomic(path, data)
  local temporary = path .. ".new"
  local f = io.open(temporary, "wb")
  if not f then
    return nil, "could not open local response file"
  end
  local ok, err = f:write(data, "\n")
  f:close()
  if not ok then
    os.remove(temporary)
    return nil, tostring(err or "could not write local response file")
  end
  os.remove(path)
  local renamed, renameErr = os.rename(temporary, path)
  if not renamed then
    os.remove(temporary)
    return nil, tostring(renameErr or "could not publish local response file")
  end
  return true
end

local function blockerActive()
  local value = readFile(CLOUD_BLOCKER_FILE)
  return value ~= nil and string.match(value, "^%s*1[%s]*$") ~= nil
end

local function nextToken()
  tokenCounter = tokenCounter + 1
  local ok, value = pcall(system.uuid)
  if ok and value then
    return tostring(value) .. "-" .. tostring(tokenCounter)
  end
  local millis = 0
  pcall(function()
    millis = system.jiffies():tomillis()
  end)
  return tostring(os.time() or 0) .. "-" .. tostring(millis) .. "-" .. tostring(tokenCounter)
end

local function localEtag()
  local token = nextToken()
  local uuid = string.match(
    token,
    "^([%da-fA-F]+%-%x+%-%x+%-%x+%-%x+)"
  )
  if uuid then
    return '"' .. uuid .. '"'
  end
  return '"00000000-0000-4000-8000-' ..
    string.format("%012d", tokenCounter % 1000000000000) .. '"'
end

local function localHetag()
  local millis = 0
  pcall(function()
    millis = system.jiffies():tomillis()
  end)
  local value = (
    ((tonumber(os.time()) or 0) % 1000000) * 1000 +
    (tonumber(millis) or 0) % 1000 +
    tokenCounter
  ) % 2147483646 + 1
  return tostring(math.floor(value))
end

local function sameValue(left, right, seen)
  if left == right then
    return true
  end
  if type(left) ~= type(right) then
    return false
  end
  if type(left) ~= "table" then
    return false
  end
  seen = seen or {}
  if seen[left] == right then
    return true
  end
  seen[left] = right
  for key, value in pairs(left) do
    if not sameValue(value, right[key], seen) then
      return false
    end
  end
  for key in pairs(right) do
    if left[key] == nil then
      return false
    end
  end
  return true
end

local function resourceSnapshot(name)
  local status, etag, resource = resources.getResource(name)
  if tostring(status or "") ~= "200" or type(resource) ~= "table" then
    return nil, "could not read local " .. tostring(name)
  end
  return {
    etag = etag,
    hetag = resources.getHubEtag(name),
    resource = resource
  }
end

local function saveResource(name, value, etag, hetag)
  local ok, detail = resources.saveResource(
    "application/json", etag, value, name, nil, hetag
  )
  if not ok then
    return nil, tostring(detail or ("could not save local " .. tostring(name)))
  end
  local status, actualEtag, actual = resources.getResource(name)
  if tostring(status or "") ~= "200" or actualEtag ~= etag or
      type(actual) ~= "table" or not sameValue(value, actual) then
    return nil, "local " .. tostring(name) .. " verification failed"
  end
  return true
end

local function reloadActivityEngine()
  if not system.isMessageRegistered("config_new") then
    return nil, "Harmony activity engine reload handler is unavailable"
  end
  local ok, result = pcall(
    system.sendMessage,
    "config_new",
    {"ActivityList", "FunctionList", "MapList"}
  )
  if not ok or result ~= true then
    return nil, "Harmony activity engine rejected the local resource reload"
  end
  return true
end

-- system.sendMessage has no timeout, so send the barrier from a helper task
-- and poll it. A timed-out helper stays parked until the engine replies; only
-- one may be outstanding.
local function waitForActivityEngine()
  if not system.isMessageRegistered(ACTIVITY_ENGINE_BARRIER_MESSAGE) then
    return nil, "activity engine barrier is unavailable"
  end
  if barrierTask and system.taskStatus(barrierTask) ~= "dead" then
    return nil, "previous activity engine barrier is still pending"
  end
  local state = {done = false}
  barrierTask = system.addTask("codexactivity-barrier", function()
    local ok, result = pcall(
      system.sendMessage,
      ACTIVITY_ENGINE_BARRIER_MESSAGE,
      {}
    )
    state.ok, state.result, state.done = ok, result, true
  end)
  local steps = 0
  while not state.done do
    if steps >= ACTIVITY_ENGINE_BARRIER_STEPS then
      return nil, "activity engine did not finish rebuilding in time"
    end
    steps = steps + 1
    system.blockingSleep(100)
  end
  barrierTask = nil
  if not state.ok then
    return nil, "activity engine barrier failed: " .. tostring(state.result)
  end
  return true
end

local function notifyLocalClients()
  local encoded = json.encode(digest)
  connect.broadcastEvent("connect.stateDigest?notify", encoded, nil, {
    noHttpResponse = true
  })
end

local function restoreSnapshots(
  activitySnapshot,
  mapSnapshot,
  functionSnapshot,
  configVersion
)
  local activityOk = saveResource(
    "ActivityList",
    activitySnapshot.resource,
    activitySnapshot.etag,
    activitySnapshot.hetag
  )
  local mapOk = saveResource(
    "MapList",
    mapSnapshot.resource,
    mapSnapshot.etag,
    mapSnapshot.hetag
  )
  local functionOk = saveResource(
    "FunctionList",
    functionSnapshot.resource,
    functionSnapshot.etag,
    functionSnapshot.hetag
  )
  local reloadOk = reloadActivityEngine()
  digest.configVersion = configVersion
  pcall(function()
    digest:saveStateDigest()
    notifyLocalClients()
  end)
  return activityOk and mapOk and functionOk and reloadOk
end

local function normalizedId(value)
  if type(value) == "number" then
    if value ~= math.floor(value) then
      return nil
    end
    return tostring(value)
  end
  if type(value) == "string" and string.match(value, "^%-?%d+$") then
    return value
  end
  return nil
end

local function deviceIdsFrom(deviceList)
  local ids = {}
  if type(deviceList) ~= "table" then
    return nil
  end
  local entries = deviceList.DevicesWithFeatures or deviceList.Devices
  if type(entries) ~= "table" then
    return nil
  end
  for _, entry in ipairs(entries) do
    local device = type(entry) == "table" and (entry.Device or entry) or nil
    local id = device and normalizedId(device["Id-"] or device.Id)
    if id then
      ids[id] = true
    end
  end
  return ids
end

local function validateDeviceReference(deviceIds, rawId, context)
  if rawId == nil or rawId == json.null then
    return true
  end
  local id = normalizedId(rawId)
  if not id or not deviceIds[id] then
    return nil, context .. " references missing device " .. tostring(id or rawId)
  end
  return true
end

local function validateActivityReference(activityIds, rawId, context)
  if rawId == nil or rawId == json.null then
    return true
  end
  local id = normalizedId(rawId)
  if not id then
    return nil, context .. " contains an invalid activity reference"
  end
  if id ~= "-1" and not activityIds[id] then
    return nil, context .. " references missing activity " .. id
  end
  return true
end

local function validateGraph(activityList, mapList, functionList, deviceList)
  if type(activityList) ~= "table" or type(activityList.Activities) ~= "table" then
    return nil, "ActivityList.Activities must be an array"
  end
  if type(mapList) ~= "table" or type(mapList.ButtonMaps) ~= "table" then
    return nil, "MapList.ButtonMaps must be an array"
  end
  if type(functionList) ~= "table" or type(functionList.FunctionMaps) ~= "table" then
    return nil, "FunctionList.FunctionMaps must be an array"
  end
  local deviceIds = deviceIdsFrom(deviceList)
  if not deviceIds then
    return nil, "DeviceList.DevicesWithFeatures must be an array"
  end
  local activityIds = {}
  for _, activity in ipairs(activityList.Activities) do
    if type(activity) ~= "table" then
      return nil, "ActivityList contains a non-object activity"
    end
    local id = normalizedId(activity["Id-"])
    if not id or id == "-1" then
      return nil, "ActivityList contains an invalid activity ID"
    end
    if activityIds[id] then
      return nil, "ActivityList contains duplicate activity ID " .. id
    end
    activityIds[id] = true
    if type(activity.Roles) ~= "table" then
      return nil, "Activity " .. id .. " has an invalid Roles value"
    end
    for _, role in ipairs(activity.Roles) do
      local roleOk, roleError = validateDeviceReference(
        deviceIds,
        type(role) == "table" and role["DeviceId-"] or nil,
        "Activity " .. id .. " role"
      )
      if not roleOk then
        return nil, roleError
      end
    end
  end
  for _, buttonMap in ipairs(mapList.ButtonMaps) do
    if type(buttonMap) ~= "table" then
      return nil, "MapList contains a non-object button map"
    end
    local mapOk, mapError = validateActivityReference(
      activityIds,
      buttonMap["ActivityId-"],
      "MapList"
    )
    if not mapOk then
      return nil, mapError
    end
    local mapDeviceOk, mapDeviceError = validateDeviceReference(
      deviceIds,
      buttonMap["DeviceId-"],
      "MapList device map"
    )
    if not mapDeviceOk then
      return nil, mapDeviceError
    end
    if type(buttonMap.Buttons) == "table" then
      for _, button in ipairs(buttonMap.Buttons) do
        if type(button) == "table" then
          for _, field in ipairs({
            "ButtonAction",
            "ButtonLongPressAction",
            "ButtonDoublePressAction"
          }) do
            local action = button[field]
            if type(action) == "table" then
              local actionDeviceOk, actionDeviceError = validateDeviceReference(
                deviceIds,
                action["DeviceId-"],
                "MapList " .. field
              )
              if not actionDeviceOk then
                return nil, actionDeviceError
              end
              local actionActivityOk, actionActivityError =
                validateActivityReference(
                  activityIds,
                  action["ActivityId-"],
                  "MapList " .. field
                )
              if not actionActivityOk then
                return nil, actionActivityError
              end
            end
          end
        end
      end
    end
  end
  local activityFunctionMaps = {}
  for _, functionMap in ipairs(functionList.FunctionMaps) do
    if type(functionMap) ~= "table" then
      return nil, "FunctionList contains a non-object function map"
    end
    local mapType = tostring(functionMap.__type or "")
    if string.find(mapType, "ActivityFunctionMap", 1, true) then
      local id = normalizedId(functionMap["ActivityId-"])
      if not id or not activityIds[id] then
        return nil, "FunctionList references missing activity " .. tostring(id or "")
      end
      if activityFunctionMaps[id] then
        return nil, "FunctionList contains duplicate activity map " .. id
      end
      activityFunctionMaps[id] = true
    elseif string.find(mapType, "DeviceFunctionMap", 1, true) then
      local functionDeviceOk, functionDeviceError = validateDeviceReference(
        deviceIds,
        functionMap["DeviceId-"],
        "FunctionList device map"
      )
      if not functionDeviceOk then
        return nil, functionDeviceError
      end
    else
      return nil, "FunctionList contains unknown function map type " .. mapType
    end
    if type(functionMap.FunctionGroups) ~= "table" then
      return nil, "FunctionList contains a map without FunctionGroups"
    end
    for _, group in ipairs(functionMap.FunctionGroups) do
      if type(group) ~= "table" or type(group.Functions) ~= "table" then
        return nil, "FunctionList contains an invalid function group"
      end
      for _, action in ipairs(group.Functions) do
        local functionOk, functionError = validateDeviceReference(
          deviceIds,
          type(action) == "table" and action["DeviceId-"] or nil,
          "FunctionList action"
        )
        if not functionOk then
          return nil, functionError
        end
      end
    end
  end
  for id in pairs(activityIds) do
    if not activityFunctionMaps[id] then
      return nil, "FunctionList is missing activity map " .. id
    end
  end
  return true
end

local function commitActivityResources(request)
  if not blockerActive() then
    return {
      ok = false,
      localOnly = true,
      error = "offline activity writer refused to run because the cloud blocker is not active"
    }
  end
  local oldActivities, activityReadError = resourceSnapshot("ActivityList")
  if not oldActivities then
    return {ok = false, localOnly = true, error = activityReadError}
  end
  local oldMaps, mapReadError = resourceSnapshot("MapList")
  if not oldMaps then
    return {ok = false, localOnly = true, error = mapReadError}
  end
  local oldFunctions, functionReadError = resourceSnapshot("FunctionList")
  if not oldFunctions then
    return {ok = false, localOnly = true, error = functionReadError}
  end
  local devices, deviceReadError = resourceSnapshot("DeviceList")
  if not devices then
    return {ok = false, localOnly = true, error = deviceReadError}
  end
  local valid, validationError = validateGraph(
    request.activityList,
    request.mapList,
    request.functionList,
    devices.resource
  )
  if not valid then
    return {ok = false, localOnly = true, error = validationError}
  end

  if resources.isAnySyncInProgress() then
    return {
      ok = false,
      localOnly = true,
      error = "a Harmony sync is in progress; try again when it finishes"
    }
  end

  local previousConfigVersion = tonumber(digest.configVersion) or 0
  local activityEtag = localEtag()
  local mapEtag = localEtag()
  local functionEtag = localEtag()
  local activityHetag = localHetag()
  tokenCounter = tokenCounter + 1
  local mapHetag = localHetag()
  tokenCounter = tokenCounter + 1
  local functionHetag = localHetag()

  local ok, err = saveResource(
    "ActivityList", request.activityList, activityEtag, activityHetag
  )
  if not ok then
    local restored = restoreSnapshots(
      oldActivities, oldMaps, oldFunctions, previousConfigVersion
    )
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = err
    }
  end
  ok, err = saveResource("MapList", request.mapList, mapEtag, mapHetag)
  if not ok then
    local restored = restoreSnapshots(
      oldActivities, oldMaps, oldFunctions, previousConfigVersion
    )
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = err
    }
  end
  ok, err = saveResource(
    "FunctionList",
    request.functionList,
    functionEtag,
    functionHetag
  )
  if not ok then
    local restored = restoreSnapshots(
      oldActivities, oldMaps, oldFunctions, previousConfigVersion
    )
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = err
    }
  end
  ok, err = reloadActivityEngine()
  if not ok then
    local restored = restoreSnapshots(
      oldActivities, oldMaps, oldFunctions, previousConfigVersion
    )
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = err
    }
  end
  -- harmonyengine is already live with the new config, so a slow activity
  -- engine is not a reason to roll back: its queued init runs next. Wait so
  -- remotes don't see the new revision early, and report a timeout.
  local engineReady, engineError = waitForActivityEngine()
  if not engineReady then
    log.warning("activity engine barrier:", engineError)
  end

  digest.configVersion = previousConfigVersion + 1
  -- connect.statedigest?get answers 304 unless stateVersion changes.
  digest.stateVersion = (tonumber(digest.stateVersion) or 0) + 1
  local digestOk, digestError = pcall(function()
    digest:saveStateDigest()
    notifyLocalClients()
  end)
  if not digestOk then
    local restored = restoreSnapshots(
      oldActivities, oldMaps, oldFunctions, previousConfigVersion
    )
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = "could not publish the local configuration revision: " ..
        tostring(digestError)
    }
  end

  return {
    ok = true,
    localOnly = true,
    reloaded = true,
    activityEngineReady = engineReady and true or false,
    activityEngineDetail = engineError,
    configVersion = digest.configVersion,
    activityEtag = activityEtag,
    mapEtag = mapEtag,
    functionEtag = functionEtag,
    activityChanged = request.activityChanged and true or false,
    mapChanged = request.mapChanged and true or false,
    functionChanged = request.functionChanged and true or false
  }
end

local function statusResponse()
  local activities = resourceSnapshot("ActivityList")
  local maps = resourceSnapshot("MapList")
  local functions = resourceSnapshot("FunctionList")
  return {
    ok = activities ~= nil and maps ~= nil and functions ~= nil and blockerActive(),
    localOnly = true,
    blockerActive = blockerActive(),
    state = workerTask and "running" or "stopped",
    configVersion = digest.configVersion,
    activityEtag = activities and activities.etag or nil,
    mapEtag = maps and maps.etag or nil,
    functionEtag = functions and functions.etag or nil
  }
end

-- After a reload: wait for the activity engine, then publish a new revision
-- so the remote and /api/state see the change.
local function publishLocalRevision()
  local engineReady, engineError = waitForActivityEngine()
  if not engineReady then
    log.warning("activity engine barrier:", engineError)
  end
  digest.configVersion = (tonumber(digest.configVersion) or 0) + 1
  -- connect.statedigest?get answers 304 unless stateVersion changes.
  digest.stateVersion = (tonumber(digest.stateVersion) or 0) + 1
  local digestOk, digestError = pcall(function()
    digest:saveStateDigest()
    notifyLocalClients()
  end)
  if not digestOk then
    log.warning("codexactivity: could not publish the revision:", tostring(digestError))
  end
  return engineReady and true or false
end

local POWER_TYPE_IDS = {none = 0, discrete = 1, toggle = 2}
local DEVICE_LIST_FILE = "/data/resources/DeviceList.json"
local DEVICE_ENTRY_KEYS = {"Device", "Commands", "DeviceFeatures"}

-- codex_webui edits DeviceList as text: it finds a device by its
-- "Device":{...} object and that device's commands at the next "Commands":[.
-- json.encode writes keys in hash order, so write each entry's keys in the
-- order those scanners expect.
local function encodeDeviceList(deviceList)
  local entries = {}
  for i, entry in ipairs(deviceList.DevicesWithFeatures) do
    local parts = {}
    for _, key in ipairs(DEVICE_ENTRY_KEYS) do
      if entry[key] ~= nil then
        parts[#parts + 1] = '"' .. key .. '":' .. json.encode(entry[key])
      end
    end
    for key, value in pairs(entry) do
      if key ~= "Device" and key ~= "Commands" and key ~= "DeviceFeatures" then
        parts[#parts + 1] = json.encode(tostring(key)) .. ":" .. json.encode(value)
      end
    end
    entries[i] = "{" .. table.concat(parts, ",") .. "}"
  end
  local tail = {}
  for key, value in pairs(deviceList) do
    if key ~= "DevicesWithFeatures" then
      tail[#tail + 1] = "," .. json.encode(tostring(key)) .. ":" .. json.encode(value)
    end
  end
  return '{"DevicesWithFeatures":[' .. table.concat(entries, ",") .. "]" ..
    table.concat(tail) .. "}"
end

local function saveDeviceListText(text, expected, etag, hetag)
  local ok, detail = resources.saveResource(
    "application/json", etag, text, "DeviceList", nil, hetag
  )
  if not ok then
    return nil, tostring(detail or "could not save local DeviceList")
  end
  local status, actualEtag, actual = resources.getResource("DeviceList")
  if tostring(status or "") ~= "200" or actualEtag ~= etag or
      type(actual) ~= "table" or not sameValue(expected, actual) then
    return nil, "local DeviceList verification failed"
  end
  return true
end

local function wholeNumber(value, low, high)
  if type(value) ~= "number" or value ~= math.floor(value) or
      value < low or value > high then
    return nil
  end
  return value
end

local function deviceEntry(deviceList, deviceId)
  if type(deviceList) ~= "table" or
      type(deviceList.DevicesWithFeatures) ~= "table" then
    return nil
  end
  for _, entry in ipairs(deviceList.DevicesWithFeatures) do
    local device = type(entry) == "table" and entry.Device or nil
    if type(device) == "table" and normalizedId(device["Id-"]) == deviceId then
      return entry
    end
  end
  return nil
end

-- The engine keys commands by lower-cased name; return the stored spelling.
local function storedCommandName(entry, name)
  if type(name) ~= "string" or name == "" or type(entry.Commands) ~= "table" then
    return nil
  end
  local wanted = string.lower(name)
  for _, command in ipairs(entry.Commands) do
    if type(command) == "table" and type(command.Name) == "string" and
        string.lower(command.Name) == wanted then
      return command.Name
    end
  end
  return nil
end

local function pressActions(commandName)
  if not commandName then
    return {}
  end
  return {{
    __type = "IRPressAction",
    IRCommandName = commandName,
    Order = 0,
    Duration = json.null,
    ActionId = 0
  }}
end

local function powerFeatureOf(entry)
  if type(entry.DeviceFeatures) ~= "table" then
    entry.DeviceFeatures = {}
  end
  for _, feature in ipairs(entry.DeviceFeatures) do
    if type(feature) == "table" and
        string.find(tostring(feature.__type or ""), "PowerFeature", 1, true) then
      return feature
    end
  end
  local feature = {
    __type = "PowerFeature",
    ["DeviceId-"] = tonumber(entry.Device["Id-"]) or entry.Device["Id-"],
    Id = 0,
    State = 1,
    PowerOnActionId = 0,
    PowerOffActionId = 0,
    PowerToggleActionId = 0,
    PowerOnSetType = 0,
    PowerOffSetType = 0,
    PowerOnResetActions = {},
    PowerOnResetInputName = json.null,
    ConnectedAppPowerOnDelay = 0,
    HasAdditionalActions = false
  }
  table.insert(entry.DeviceFeatures, feature)
  return feature
end

-- Check one device's power and timing settings against its own commands.
local function deviceSettingsFrom(entry, settings)
  if type(settings) ~= "table" or type(settings.power) ~= "table" then
    return nil, "settings.power is required"
  end
  local power = settings.power
  local out = {
    typeId = POWER_TYPE_IDS[power.type],
    interKeyDelay = wholeNumber(settings.interKeyDelayMs, 0, 5000),
    interDeviceDelay = wholeNumber(settings.interDeviceDelayMs, 0, 10000),
    repeats = wholeNumber(settings.repeats, 0, 10),
    powerOnDelay = wholeNumber(power.delayMs, 0, 60000)
  }
  if not out.typeId then
    return nil, "power.type must be discrete, toggle or none"
  end
  if not out.interKeyDelay then
    return nil, "interKeyDelayMs must be a whole number from 0 to 5000"
  end
  if not out.interDeviceDelay then
    return nil, "interDeviceDelayMs must be a whole number from 0 to 10000"
  end
  if not out.repeats then
    return nil, "repeats must be a whole number from 0 to 10"
  end
  if not out.powerOnDelay then
    return nil, "power.delayMs must be a whole number from 0 to 60000"
  end
  if type(power.alwaysOn) ~= "boolean" or
      type(power.onBetweenActivities) ~= "boolean" then
    return nil, "power.alwaysOn and power.onBetweenActivities must be true or false"
  end
  out.alwaysOn = power.alwaysOn
  out.onBetweenActivities = power.onBetweenActivities
  if out.typeId == 1 then
    out.on = storedCommandName(entry, power.on)
    out.off = storedCommandName(entry, power.off)
    if not out.on or not out.off then
      return nil, "separate power needs an On and an Off command that the device has"
    end
    if out.on == out.off then
      return nil, "On and Off are the same command; choose one power button instead"
    end
  elseif out.typeId == 2 then
    out.toggle = storedCommandName(entry, power.toggle)
    if not out.toggle then
      return nil, "one power button needs a command that the device has"
    end
  end
  return out
end

-- InputFeature.InputType: 1 discrete; 2 toggle, which the engine cycles as a
-- relative state.
local INPUT_TYPE_IDS = {discrete = 1, cycle = 2}
local MAX_INPUTS = 32

local function present(value)
  return value ~= nil and value ~= json.null and value ~= ""
end

-- Check the input settings; nil inputs means "leave the inputs alone".
local function inputSettingsFrom(entry, inputs)
  if inputs == nil or inputs == json.null then
    return nil
  end
  if type(inputs) ~= "table" then
    return nil, "settings.inputs must be an object"
  end
  local out = {type = inputs.type, delay = wholeNumber(inputs.delayMs, 0, 60000), list = {}}
  if out.type ~= "none" and not INPUT_TYPE_IDS[out.type] then
    return nil, "inputs.type must be discrete, cycle or none"
  end
  if not out.delay then
    return nil, "inputs.delayMs must be a whole number from 0 to 60000"
  end
  if out.type == "none" then
    return out
  end
  if type(inputs.list) ~= "table" or #inputs.list == 0 or #inputs.list > MAX_INPUTS then
    return nil, "inputs.list must have 1 to " .. MAX_INPUTS .. " inputs"
  end
  local seen = {}
  for i, input in ipairs(inputs.list) do
    local name = type(input) == "table" and type(input.name) == "string" and
      string.match(input.name, "^%s*(.-)%s*$") or ""
    if name == "" or #name > 64 or string.find(name, '[%c"\\]') then
      return nil, "input names must be 1-64 characters without quotes or backslashes"
    end
    if seen[string.lower(name)] then
      return nil, "input " .. name .. " is listed twice"
    end
    seen[string.lower(name)] = name
    local command
    -- A discrete input may have no command (it is selected by doing nothing).
    if out.type == "discrete" and present(input.command) then
      command = storedCommandName(entry, input.command)
      if not command then
        return nil, "input " .. name .. " needs a command that the device has"
      end
    end
    out.list[i] = {name = name, command = command}
  end
  if out.type == "cycle" then
    if #out.list < 2 then
      return nil, "cycling needs at least two inputs"
    end
    out.next = storedCommandName(entry, inputs.next)
    if not out.next then
      return nil, "cycling needs the device's next-input command"
    end
    if present(inputs.previous) then
      out.previous = storedCommandName(entry, inputs.previous)
      if not out.previous then
        return nil, "the previous-input command is not on the device"
      end
    end
    if present(inputs.afterPowerOn) then
      out.afterPowerOn = seen[string.lower(tostring(inputs.afterPowerOn))]
      if not out.afterPowerOn then
        return nil, "the input after power-on must be one of the inputs"
      end
    end
  end
  return out
end

-- Activities name an input by its exact InputName; refuse to drop one that a
-- role still selects, since the engine would silently skip the switch.
local function inputsInUse(deviceId, inputs)
  local activities = resourceSnapshot("ActivityList")
  if not activities or type(activities.resource.Activities) ~= "table" then
    return {"ActivityList could not be read"}
  end
  local names = {}
  for _, input in ipairs(inputs.list) do
    names[input.name] = true
  end
  local problems = {}
  for _, activity in ipairs(activities.resource.Activities) do
    for _, role in ipairs(type(activity.Roles) == "table" and activity.Roles or {}) do
      local selected = type(role) == "table" and role.SelectedInput
      if normalizedId(role["DeviceId-"]) == deviceId and type(selected) == "table" and
          type(selected.Name) == "string" and not names[selected.Name] then
        problems[#problems + 1] = '"' .. tostring(activity.Name or activity["Id-"]) ..
          '" switches it to ' .. selected.Name
      end
    end
  end
  return problems
end

local function featureOf(entry, typeName)
  for i, feature in ipairs(entry.DeviceFeatures) do
    if type(feature) == "table" and
        string.find(tostring(feature.__type or ""), typeName, 1, true) then
      return feature, i
    end
  end
  return nil
end

local function applyInputs(entry, power, inputs)
  local feature, index = featureOf(entry, "InputFeature")
  if inputs.type == "none" then
    if index then
      table.remove(entry.DeviceFeatures, index)
    end
  else
    if not feature then
      feature = {
        __type = "InputFeature",
        ["DeviceId-"] = tonumber(entry.Device["Id-"]) or entry.Device["Id-"],
        Id = 0,
        State = 1,
        CanSkipInputs = 0,
        StartActions = {},
        FinishActions = {},
        HasAdditionalActions = false
      }
      table.insert(entry.DeviceFeatures, 1, feature)
    end
    -- Keep each input's other fields (PortTypes, Id, IsOnline, ...) by name.
    local byName = {}
    for _, old in ipairs(type(feature.Inputs) == "table" and feature.Inputs or {}) do
      if type(old) == "table" and type(old.InputName) == "string" then
        byName[old.InputName] = old
      end
    end
    feature.InputType = INPUT_TYPE_IDS[inputs.type]
    feature.InputDelay = inputs.delay
    if type(feature.DefaultInputDelay) ~= "number" then
      feature.DefaultInputDelay = inputs.delay
    end
    feature.Inputs = {}
    for i, input in ipairs(inputs.list) do
      local item = byName[input.name] or {
        Id = 0,
        ActionId = 0,
        ActionName = json.null,
        StateName = json.null,
        StateValue = json.null,
        Attributes = json.null,
        IsOnline = false,
        IsAutoSwitch = json.null,
        PressDuration = 0,
        PortTypes = json.null,
        DevActionType = 0,
        HasAdditionalActions = false
      }
      item.InputName = input.name
      item.InputOrder = i
      item.IsActiveInput = true
      item.ActionSetTypeId = 1
      item.Actions = pressActions(input.command)
      feature.Inputs[i] = item
    end
    feature.NextActions = pressActions(inputs.next)
    feature.PreviousActions = pressActions(inputs.previous)
  end
  -- A cycled input has to be known after power-on: a ForceValue power-on
  -- reset tells the engine without sending anything.
  local resets = {}
  for _, action in ipairs(type(power.PowerOnResetActions) == "table" and power.PowerOnResetActions or {}) do
    if not (type(action) == "table" and action.StateName == "Input" and action.DevActionType == 1) then
      resets[#resets + 1] = action
    end
  end
  if inputs.afterPowerOn then
    resets[#resets + 1] = {
      __type = "IRDevAction",
      DevActionType = 1,
      StateName = "Input",
      StateValue = inputs.afterPowerOn,
      IRCommandName = json.null,
      Order = #resets,
      ActionId = 0
    }
  end
  power.PowerOnResetActions = resets
end

local function commitDeviceSettings(request)
  if not blockerActive() then
    return {
      ok = false,
      localOnly = true,
      error = "offline device writer refused to run because the cloud blocker is not active"
    }
  end
  if resources.isAnySyncInProgress() then
    return {
      ok = false,
      localOnly = true,
      error = "a Harmony sync is in progress; try again when it finishes"
    }
  end
  local deviceId = normalizedId(request.deviceId)
  if not deviceId then
    return {ok = false, localOnly = true, error = "deviceId must be a device ID"}
  end
  local old, readError = resourceSnapshot("DeviceList")
  local oldText = readFile(DEVICE_LIST_FILE)
  if not old or not oldText then
    return {
      ok = false,
      localOnly = true,
      error = readError or "could not read the local DeviceList"
    }
  end
  -- Edit a copy; a failed reload restores the file's exact old text.
  local copied, deviceList = pcall(json.decode, oldText)
  if not copied or type(deviceList) ~= "table" then
    return {ok = false, localOnly = true, error = "could not copy the local DeviceList"}
  end
  local entry = deviceEntry(deviceList, deviceId)
  if not entry then
    return {ok = false, localOnly = true, error = "DeviceList has no device " .. deviceId}
  end
  local settings, settingsError = deviceSettingsFrom(entry, request.settings)
  if not settings then
    return {ok = false, localOnly = true, error = settingsError}
  end
  local inputs, inputsError = inputSettingsFrom(entry, request.settings.inputs)
  if inputsError then
    return {ok = false, localOnly = true, error = inputsError}
  end
  if inputs then
    local problems = inputsInUse(deviceId, inputs)
    if #problems > 0 then
      return {
        ok = false,
        localOnly = true,
        error = "activities still use inputs this change removes: " ..
          table.concat(problems, "; ")
      }
    end
  end

  local device = entry.Device
  device.InterKeyDelay = settings.interKeyDelay
  device.InterDeviceDelay = settings.interDeviceDelay
  device.PressMinRepeats = settings.repeats
  local feature = powerFeatureOf(entry)
  feature.PowerTypeId = settings.typeId
  feature.PowerOnActions = pressActions(settings.on)
  feature.PowerOffActions = pressActions(settings.off)
  feature.PowerToggleActions = pressActions(settings.toggle)
  feature.PowerOnDelay = settings.powerOnDelay
  if type(feature.DefaultPowerOnDelay) ~= "number" then
    feature.DefaultPowerOnDelay = settings.powerOnDelay
  end
  feature.IsPowerAlwaysOn = settings.alwaysOn
  feature.IsPoweredOnBetweenActivities = settings.onBetweenActivities
  if inputs then
    applyInputs(entry, feature, inputs)
  end

  local deviceEtag = localEtag()
  local encoded, text = pcall(encodeDeviceList, deviceList)
  if not encoded then
    return {ok = false, localOnly = true, error = "could not encode DeviceList: " .. tostring(text)}
  end
  local saved, saveError = saveDeviceListText(text, deviceList, deviceEtag, localHetag())
  if not saved then
    local restored = saveDeviceListText(oldText, old.resource, old.etag, old.hetag)
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = saveError
    }
  end
  local sent, reloaded = pcall(system.sendMessage, "config_new", {"DeviceList"})
  if not sent or reloaded ~= true then
    local restored = saveDeviceListText(oldText, old.resource, old.etag, old.hetag)
    pcall(system.sendMessage, "config_new", {"DeviceList"})
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = "Harmony engine rejected the device settings reload"
    }
  end
  local engineReady = publishLocalRevision()
  return {
    ok = true,
    localOnly = true,
    reloaded = true,
    deviceId = deviceId,
    activityEngineReady = engineReady,
    configVersion = digest.configVersion,
    deviceEtag = deviceEtag
  }
end

local TOUCH_READ_BODY_FILE = "/var/volatile/codex-touch-read.bin"
local TOUCH_READ_TIMEOUT = 60000
local TOUCH_READ_MAX_BYTES = 512 * 1024
-- Read-only probe of the paired Touch over HOT. Only these exact paths may be
-- read; the op never issues a write verb. Paths come from the shared stock
-- resource layout (resourcemanager.lua, mode 4) plus hal status pseudo-files.
local TOUCH_READ_PATHS = {
  ["/data/resources/index.json"] = true,
  ["/data/resources/MapList.json"] = true,
  ["/data/resources/DeviceList.json"] = true,
  ["/data/resources/ActivityList.json"] = true,
  ["/data/resources/Settings.json"] = true,
  ["/data/resources/Context.json"] = true,
  ["/data/resources/AutomationConfig.json"] = true,
  ["/data/resources/ProtocolList.json"] = true,
  ["/data/resources/CapabilityList.json"] = true,
  ["/data/resources/FunctionList.json"] = true,
  ["/data/resources_1/MapList.json"] = true,
  ["/data/resources_1/index.json"] = true,
  ["/data/loggly/SyncCounter.json"] = true
}

local function writeBodyFile(path, data)
  local temporary = path .. ".new"
  local f = io.open(temporary, "wb")
  if not f then
    return nil, "could not open Touch read body file"
  end
  local ok, err = f:write(data)
  f:close()
  if not ok then
    os.remove(temporary)
    return nil, tostring(err or "could not write Touch read body file")
  end
  os.remove(path)
  local renamed, renameErr = os.rename(temporary, path)
  if not renamed then
    os.remove(temporary)
    return nil, tostring(renameErr or "could not publish Touch read body file")
  end
  return true
end

local function readTouchFile(request)
  local path = request.path
  if type(path) ~= "string" or not TOUCH_READ_PATHS[path] then
    return {
      ok = false,
      localOnly = true,
      error = "path is not on the read-only Touch allowlist"
    }
  end
  if resources.isAnySyncInProgress() then
    return {
      ok = false,
      localOnly = true,
      error = "a Harmony sync is in progress; try again when it finishes"
    }
  end
  local response, body = hbus:command(
    "hot.1.data.resource", {file = path}, nil, TOUCH_READ_TIMEOUT
  )
  if type(response) ~= "table" then
    return {
      ok = false,
      localOnly = true,
      error = "no reply from the Touch (is it awake?)"
    }
  end
  local code = tonumber(response.code) or 0
  if code ~= 200 then
    return {
      ok = false,
      localOnly = true,
      code = code,
      error = "Touch returned code " .. tostring(response.code)
    }
  end
  if type(body) ~= "string" then
    body = ""
  end
  if #body > TOUCH_READ_MAX_BYTES then
    return {
      ok = false,
      localOnly = true,
      error = "Touch reply exceeds the local size cap"
    }
  end
  local wrote, writeError = writeBodyFile(TOUCH_READ_BODY_FILE, body)
  if not wrote then
    return {ok = false, localOnly = true, error = writeError}
  end
  log.notice("codexactivity: read Touch file", path, #body, "bytes")
  return {
    ok = true,
    localOnly = true,
    readOnly = true,
    path = path,
    bytes = #body,
    bodyFile = TOUCH_READ_BODY_FILE
  }
end

local function processRequest(raw)
  local ok, request = pcall(json.decode, raw)
  if not ok or type(request) ~= "table" then
    return {ok = false, localOnly = true, error = "invalid local request JSON"}
  end
  local response
  if request.op == "CommitActivityResources" then
    response = commitActivityResources(request)
  elseif request.op == "CommitDeviceSettings" then
    response = commitDeviceSettings(request)
  elseif request.op == "ReadTouchFile" then
    response = readTouchFile(request)
  elseif request.op == "Status" then
    response = statusResponse()
  else
    response = {ok = false, localOnly = true, error = "unknown local operation"}
  end
  response.id = tostring(request.id or "")
  return response
end

-- Reload what codex_webui changed on disk. The flag stays put while the engine
-- isn't listening yet or a stock sync owns the resources, so the next pass
-- picks it up.
local function reloadRequestedResources()
  local data = readFile(RESOURCE_RELOAD_FLAG)
  if not data then
    return
  end
  if not system.isMessageRegistered("config_new") or
      resources.isAnySyncInProgress() then
    return
  end
  os.remove(RESOURCE_RELOAD_FLAG)
  local names = {}
  for name in string.gmatch(data, "[%w]+") do
    if name == "all" then
      names = "all"
      break
    end
    if RELOADABLE_RESOURCES[name] then
      table.insert(names, name)
    end
  end
  if type(names) == "table" and #names == 0 then
    names = {"DeviceList", "ProtocolList"}
  end
  local ok, result = pcall(system.sendMessage, "config_new", names)
  if not ok or result ~= true then
    log.warning("codexactivity: requested resource reload failed:", tostring(result))
    return
  end
  publishLocalRevision()
  log.notice("codexactivity: reloaded resources requested by codex_webui")
end

local function workerLoop()
  os.remove(REQUEST_FILE)
  os.remove(RESPONSE_FILE)
  while not stopRequested do
    local raw = readFile(REQUEST_FILE)
    if raw then
      os.remove(REQUEST_FILE)
      local ok, response = pcall(processRequest, raw)
      if not ok then
        response = {
          ok = false,
          localOnly = true,
          error = "offline activity writer failed: " .. tostring(response)
        }
      end
      local encodedOk, encoded = pcall(json.encode, response)
      if encodedOk then
        local wrote, writeError = writeFileAtomic(RESPONSE_FILE, encoded)
        if not wrote then
          log.error("codexactivity response failed:", tostring(writeError))
        end
      else
        log.error("codexactivity response encode failed:", tostring(encoded))
      end
    end
    local reloaded, reloadError = pcall(reloadRequestedResources)
    if not reloaded then
      log.error("codexactivity resource reload failed:", tostring(reloadError))
    end
    system.sleep(100)
  end
  workerTask = nil
end

local function start()
  stopRequested = false
  if not workerTask then
    workerTask = system.addTask("codexactivity", workerLoop)
  end
  return workerTask ~= nil
end

function discover(self)
  start()
  return {
    ["codex-activity"] = {
      id = "codex-activity",
      type = "codexactivity",
      name = "Codex Offline Activity Writer"
    }
  }
end

function pair(self, gatewayId, gateway)
  return start()
end

function monitor(self)
  start()
  while not stopRequested do
    system.sleep(60000)
  end
end

function status(self)
  return statusResponse()
end

function exit(self)
  stopRequested = true
  return true
end
