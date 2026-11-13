module(..., package.seeall)

local system = require("system")
local json = require("json")
local log = require("log").logger("auto.p.codexactivity")
local resources = require("tasks.harmonywebservices.core.resourcemanager")
local digest = require("tasks.harmonywebservices.core.statedigest"):instance()
local connect = require("tasks.connectserver.core.utils")

local REQUEST_FILE = "/var/volatile/codex-activity-request.json"
local RESPONSE_FILE = "/var/volatile/codex-activity-response.json"
local CLOUD_BLOCKER_FILE = "/data/codex/cloud_blocker.conf"
local MELODIOUS_OFF_FILE = "/etc/melodious-off"
-- The activityengine task is the only listener for process_activity, so a
-- synchronous send is a FIFO barrier behind the init_activity_engine that
-- harmonyengine broadcasts while handling config_new.
local ACTIVITY_ENGINE_BARRIER_MESSAGE = "process_activity"
-- A long activity start can hold the engine; bound the wait. codex_webui
-- gives the whole transaction 45 s (offline_writer_request) and rolls the
-- save back when no answer comes, even though the reloaded engine already
-- runs the new config. So the wait ends well inside that, by the clock;
-- the step count only backs it up if the clock can't be read.
local ACTIVITY_ENGINE_BARRIER_MS = 25000
local ACTIVITY_ENGINE_BARRIER_STEPS = 250
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

local function melodiousOff()
  local f = io.open(MELODIOUS_OFF_FILE, "r")
  if not f then
    return false
  end
  f:close()
  return true
end

local function blockerActive()
  if melodiousOff() then
    return false
  end
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

-- Milliseconds since boot, or nil when the clock can't be read.
local function nowMillis()
  local ok, millis = pcall(function()
    return system.jiffies():tomillis()
  end)
  return ok and tonumber(millis) or nil
end

local function localHetag()
  local millis = nowMillis() or 0
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
  local started = nowMillis()
  local steps = 0
  while not state.done do
    local now = nowMillis()
    if steps >= ACTIVITY_ENGINE_BARRIER_STEPS or
        (started and now and now - started >= ACTIVITY_ENGINE_BARRIER_MS) then
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
    -- The stock reader that builds the hub's and the Touch's button maps
    -- throws on maps and buttons shaped unlike the ones below, and a map
    -- it cannot load leaves the Touch without a screen until the next
    -- good sync. Reject those shapes here, before anything is saved.
    local mapLabel = tostring(
      buttonMap.ButtonMapIdentifier or buttonMap["ButtonMapId-"] or "unknown"
    )
    local mapType = type(buttonMap.__type) == "string" and buttonMap.__type or ""
    local isActivityMap = string.find(mapType, "ActivityButtonMap", 1, true) ~= nil
    if not isActivityMap and
        not string.find(mapType, "DeviceButtonMap", 1, true) and
        not string.find(mapType, "RootButtonMap", 1, true) then
      return nil, "MapList map " .. mapLabel .. " has an unknown or missing __type"
    end
    if type(buttonMap.Buttons) ~= "table" then
      return nil, "MapList map " .. mapLabel .. " is missing its Buttons array"
    end
    local sequenceIds = {}
    if buttonMap.Sequences ~= nil and buttonMap.Sequences ~= json.null then
      if type(buttonMap.Sequences) ~= "table" then
        return nil, "MapList map " .. mapLabel .. " has an invalid Sequences value"
      end
      for _, sequence in ipairs(buttonMap.Sequences) do
        if type(sequence) ~= "table" or sequence.SequenceId == nil or
            sequence.SequenceId == json.null then
          return nil, "MapList map " .. mapLabel .. " has a sequence without a SequenceId"
        end
        local sequenceLabel = tostring(sequence.SequenceId)
        if type(sequence.Actions) ~= "table" then
          return nil, "MapList map " .. mapLabel .. " sequence " ..
            sequenceLabel .. " is missing its Actions array"
        end
        sequenceIds[sequenceLabel] = true
        for _, step in ipairs(sequence.Actions) do
          local stepType = type(step) == "table" and step.__type or nil
          if type(stepType) ~= "string" then
            return nil, "MapList map " .. mapLabel .. " sequence " ..
              sequenceLabel .. " has a step with an unknown or missing __type"
          end
          if string.find(stepType, "ButtonCommandAction", 1, true) then
            local stepDeviceOk, stepDeviceError = validateDeviceReference(
              deviceIds,
              step["DeviceId-"],
              "MapList sequence " .. sequenceLabel .. " step"
            )
            if not stepDeviceOk then
              return nil, stepDeviceError
            end
          elseif string.find(stepType, "ButtonDelayAction", 1, true) then
            if type(step.Duration) ~= "number" then
              return nil, "MapList map " .. mapLabel .. " sequence " ..
                sequenceLabel .. " has a delay step without a numeric Duration"
            end
          else
            return nil, "MapList map " .. mapLabel .. " sequence " ..
              sequenceLabel .. " has a step with an unknown or missing __type"
          end
        end
      end
    end
    local seenSlots = {}
    for _, button in ipairs(buttonMap.Buttons) do
      if type(button) ~= "table" then
        return nil, "MapList map " .. mapLabel .. " contains a non-object button"
      end
      local buttonType = type(button.__type) == "string" and button.__type or ""
      local isSoft = string.find(buttonType, "SoftRemoteButton", 1, true) ~= nil
      local isHard = string.find(buttonType, "HardRemoteButton", 1, true) ~= nil
      local isGesture = string.find(buttonType, "GestureRemoteButton", 1, true) ~= nil
      if not isSoft and not isHard and not isGesture then
        return nil, "MapList map " .. mapLabel ..
          " has a button with an unknown or missing __type"
      end
      if isHard or isGesture then
        if type(button.ButtonKey) ~= "string" or button.ButtonKey == "" then
          return nil, "MapList map " .. mapLabel .. " button is missing ButtonKey"
        end
      end
      if isSoft then
        local menuItem = button.MenuItem
        local index = type(menuItem) == "table" and menuItem ~= json.null and
          menuItem.IndexInMenu or nil
        if type(index) ~= "number" or index ~= math.floor(index) or index < 0 then
          return nil, "MapList map " .. mapLabel ..
            " soft button has an invalid MenuItem.IndexInMenu"
        end
        -- The stock reader keys on-screen buttons by IndexInMenu alone, so
        -- two buttons in one activity map that share a slot shadow each
        -- other. Device maps keep their existing slots until the device
        -- screen editor sets their rule, so only activity maps are
        -- rejected here. The number pad is keyed separately and has its
        -- own slot space.
        if isActivityMap then
          local slotKey = (button.FunctionGroupType == 2 and "pad:" or "soft:") ..
            tostring(index)
          if seenSlots[slotKey] then
            return nil, "MapList map " .. mapLabel ..
              " has duplicate IndexInMenu " .. tostring(index) ..
              " for on-screen buttons"
          end
          seenSlots[slotKey] = true
        end
      end
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
          local actionType = type(action.__type) == "string" and action.__type or ""
          if string.find(actionType, "ButtonSequenceAction", 1, true) and
              not sequenceIds[tostring(action.SequenceId)] then
            return nil, "MapList map " .. mapLabel ..
              " button references missing sequence " .. tostring(action.SequenceId)
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

-- Touch device screens. The Touch opens a device (Devices, then the device)
-- from its 16417Device<id> map alone: its sync never pulls FunctionList
-- (sync.lua getResourceListForHub), so no DeviceFunctionMap is needed. A
-- device without the map is listed but opens nothing.
local TOUCH_SCREEN_PREFIX = "16417Device"
-- Logitech issued every map and button ID at or below these floors, so a
-- screen above the floor was made here and may be rebuilt. Same floors as
-- the web wizard's createAllocator.
local MAP_ID_FLOOR = 52944089
local BUTTON_ID_FLOOR = 1878029713
local ID_CEILING = 2147483000
local IDENTITY_KEYS = {
  Id = true,
  ["Id-"] = true,
  ButtonId = true,
  ButtonMapId = true,
  ["ButtonMapId-"] = true
}
-- The Touch's hard keys and the command names the activity wizard matches
-- to each (remote-layout.js REMOTE_BUTTONS, in its order). A lamp's
-- brightness rides on the volume keys.
local TOUCH_SCREEN_KEYS = {
  {"Rewind", "rewind|rev|skipback|previous track"},
  {"Play", "play"},
  {"FastForward", "fastforward|forward|ffwd|next track|skipforward"},
  {"Record", "record|rec"},
  {"Pause", "pause"},
  {"Stop", "stop"},
  {"Red", "red"},
  {"Green", "green"},
  {"Yellow", "yellow"},
  {"Blue", "blue"},
  {"DVR", "dvr|recordings"},
  {"Guide", "guide|epg"},
  {"Info", "info|information|displayinfo|settings|setting|setup|option|options"},
  {"Exit", "exit|clear|cancel"},
  -- Home is its own Touch hard key (the firmware's 29-name key table has both
  -- Menu and Home), so a Home-named command gets a real Home key instead of
  -- hiding behind Menu.
  {"Home", "home"},
  {"Menu", "menu"},
  {"DirectionUp", "up|directionup|arrowup|cursorup"},
  {"DirectionLeft", "left|directionleft|arrowleft|cursorleft"},
  {"DirectionRight", "right|directionright|arrowright|cursorright"},
  {"DirectionDown", "down|directiondown|arrowdown|cursordown"},
  {"Select", "ok|select|enter"},
  {"VolumeUp", "volumeup|volup|vol up|vol_up|volume up|brightnessup"},
  {"VolumeDown", "volumedown|voldown|voldn|vol down|vol_down|vol_dn|volume down|brightnessdown"},
  {"ChannelUp", "channelup|chup|chnext|ch_next|ch up|channel next|channelnext|pageup|pgup"},
  {"ChannelDown", "channeldown|chdown|chdn|chprev|ch_prev|ch down|ch_dn|channel prev|" ..
    "channel previous|channel down|channelprev|channeldn|pagedown|pgdown"},
  {"VolumeMute", "mute"},
  -- Logitech's maps store the Back key as PrevChannel.
  {"PrevChannel", "back|return|previous"}
}

-- One-shot HA / toggle commands (P11, proven G3/G4/S1/S3/S5/S6): a plain
-- button double-fires when held >=300ms. Giving the generated device screen
-- a self-long (ButtonLongPressAction == ButtonAction, EventType 2) makes the
-- hub fire exactly once per press (short at release <600ms, long at 2nd hold).
local ONE_SHOT_COMMANDS = {
  powertoggle = true,
  playpause = true,
  mute = true,
  skipforward = true,
  skipback = true,
  run = true,
  activate = true,
  press = true,
}

local function isOneShotCommand(name)
  if type(name) ~= "string" or name == "" then return false end
  local key = string.lower(name):gsub("[^%w]", "")
  return ONE_SHOT_COMMANDS[key] == true
end

-- Gesture keys the Touch resolves locally (P18, proven G1d & S4).
local GESTURE_KEYS = {
  SwipeUp = true,
  SwipeDown = true,
  SwipeLeft = true,
  SwipeRight = true,
  Tap = true,
}

-- Every map and button ID in use, and the next free one above the floors.
local function identityAllocator(...)
  local seen, nextMap, nextButton = {}, MAP_ID_FLOOR + 1, BUTTON_ID_FLOOR + 1
  local function walk(value)
    if type(value) ~= "table" then
      return
    end
    for key, child in pairs(value) do
      if IDENTITY_KEYS[key] then
        local n = tonumber(child)
        if n and n > 0 then
          seen[n] = true
          if string.sub(key, 1, 11) == "ButtonMapId" then
            nextMap = math.max(nextMap, n + 1)
          else
            nextButton = math.max(nextButton, n + 1)
          end
        end
      else
        walk(child)
      end
    end
  end
  for i = 1, select("#", ...) do
    walk((select(i, ...)))
  end
  local function take(cursor)
    while seen[cursor] do
      cursor = cursor + 1
    end
    if cursor >= ID_CEILING then
      return nil
    end
    seen[cursor] = true
    return cursor
  end
  return {
    mapId = function()
      local id = take(nextMap)
      nextMap = (id or nextMap) + 1
      return id
    end,
    buttonId = function()
      local id = take(nextButton)
      nextButton = (id or nextButton) + 1
      return id
    end
  }
end

-- ir_command_key: lower case, letters and digits only.
local function screenCommandKey(name)
  return (string.gsub(string.lower(tostring(name or "")), "[^%w]", ""))
end

-- The first command named exactly as one of the aliases. Unlike the
-- wizard, no substring matches: "right" is in "BrightnessUp" and "clear" in
-- "ClearVoice", and a command no key takes is still on screen.
local function screenCommandFor(commands, aliases)
  local keys = {}
  for alias in string.gmatch(aliases, "[^|]+") do
    keys[screenCommandKey(alias)] = true
  end
  for _, command in ipairs(commands) do
    local name = screenCommandKey(command.Name)
    if name ~= "" and keys[name] then
      return command
    end
  end
  return nil
end

local function isTouchScreenId(identifier)
  return type(identifier) == "string" and
    string.sub(identifier, 1, #TOUCH_SCREEN_PREFIX) == TOUCH_SCREEN_PREFIX
end

local function touchScreenOf(buttonMaps, deviceId)
  for _, map in ipairs(buttonMaps) do
    if type(map) == "table" and map.ButtonMapIdentifier == TOUCH_SCREEN_PREFIX .. deviceId then
      return map
    end
  end
  return nil
end

-- Logitech's own screens are never rebuilt or removed.
local function isLocalTouchScreen(map)
  local id = tonumber(map["ButtonMapId-"])
  return id ~= nil and id > MAP_ID_FLOOR
end

-- A new screen copies its surface and remote from one the Touch already has.
local function touchScreenTemplate(buttonMaps)
  local found
  for _, map in ipairs(buttonMaps) do
    if type(map) == "table" and type(map.ButtonMapIdentifier) == "string" and
        string.sub(map.ButtonMapIdentifier, 1, 5) == "16417" and
        tonumber(map["SurfaceId-"]) and tonumber(map["RemoteId-"]) then
      if isTouchScreenId(map.ButtonMapIdentifier) then
        return map
      end
      found = found or map
    end
  end
  return found
end

-- Build a device's screen from its commands: the hard keys the wizard's
-- aliases find, and every other command on screen in the device's order,
-- one to a slot, so no two buttons share an IndexInMenu. Buttons that keep
-- their key or command keep their ButtonId.
local function touchScreenMap(entry, old, template, alloc)
  local deviceId = normalizedId(entry.Device["Id-"])
  local commands = {}
  for _, command in ipairs(type(entry.Commands) == "table" and entry.Commands or {}) do
    if type(command) == "table" and type(command.Name) == "string" and command.Name ~= "" then
      commands[#commands + 1] = command
    end
  end
  if not deviceId or #commands == 0 then
    return nil, "the device has no commands to put on its screen"
  end
  local oldIds = {}
  for _, button in ipairs(old and type(old.Buttons) == "table" and old.Buttons or {}) do
    local kind = type(button) == "table" and tostring(button.__type or "") or ""
    local action = type(button) == "table" and button.ButtonAction or nil
    local id = type(button) == "table" and tonumber(button.ButtonId) or nil
    if id and id > 0 then
      if string.find(kind, "HardRemoteButton", 1, true) and type(button.ButtonKey) == "string" then
        oldIds["hard:" .. button.ButtonKey] = id
      elseif string.find(kind, "SoftRemoteButton", 1, true) and type(action) == "table" and
          type(action.CommandName) == "string" then
        oldIds["soft:" .. string.lower(action.CommandName)] = oldIds["soft:" .. string.lower(action.CommandName)] or id
      end
    end
  end
  local function buttonId(key)
    return oldIds[key] or alloc.buttonId()
  end
  local function commandAction(command, eventType)
    return {
      ["DeviceId-"] = tonumber(deviceId),
      __type = "ButtonCommandAction",
      ["FunctionId-"] = tonumber(command.FunctionId) or 0,
      Order = 0,
      CommandName = command.Name,
      EventType = eventType,
      Id = 0
    }
  end
  local hard, onKey = {}, {}
  for _, key in ipairs(TOUCH_SCREEN_KEYS) do
    local command = screenCommandFor(commands, key[2])
    if command then
      onKey[command] = true
      -- P11 Option B: one-shot commands get a self-long so the hub fires
      -- exactly once per press (proven S1/S6 on hard and soft rows).
      local longPress = json.null
      if isOneShotCommand(command.Name) then
        longPress = commandAction(command, 2)
      end
      hard[#hard + 1] = {
        ButtonId = buttonId("hard:" .. key[1]),
        __type = "HardRemoteButton",
        ButtonAction = commandAction(command, 1),
        ButtonDoublePressAction = json.null,
        FunctionGroupType = 0,
        ButtonState = 1,
        ButtonKey = key[1],
        ButtonLongPressAction = longPress
      }
    end
  end
  local buttons = {}
  for _, command in ipairs(commands) do
    if not onKey[command] then
      local longPress = json.null
      if isOneShotCommand(command.Name) then
        longPress = commandAction(command, 2)
      end
      buttons[#buttons + 1] = {
        FunctionGroupType = 0,
        ButtonImageKey = json.null,
        ["ImageId-"] = 0,
        MenuItem = {IndexInMenu = #buttons, MenuName = "Device." .. deviceId},
        ButtonId = buttonId("soft:" .. string.lower(command.Name)),
        ButtonState = 1,
        ButtonAction = commandAction(command, 0),
        TextOnRemote = command.Name,
        __type = "SoftRemoteButton",
        ButtonImagePath = json.null,
        ButtonDoublePressAction = json.null,
        ButtonLongPressAction = longPress
      }
    end
  end
  for _, button in ipairs(hard) do
    buttons[#buttons + 1] = button
  end
  local surface = old or template
  local map = {
    ["ButtonMapId-"] = old and tonumber(old["ButtonMapId-"]) or alloc.mapId(),
    ["ButtonMapSurfaceId-"] = surface["ButtonMapSurfaceId-"],
    ["DeviceId-"] = tonumber(deviceId),
    __type = "DeviceButtonMap",
    ["RemoteId-"] = surface["RemoteId-"],
    ButtonMapIdentifier = TOUCH_SCREEN_PREFIX .. deviceId,
    DateModified = json.null,
    Sequences = json.null,
    ["SurfaceId-"] = surface["SurfaceId-"],
    Buttons = buttons
  }
  for _, button in ipairs(buttons) do
    if not button.ButtonId then
      return nil, "no free button IDs are left"
    end
  end
  if not map["ButtonMapId-"] then
    return nil, "no free map IDs are left"
  end
  return map
end

-- The map list with a device's screen put in place of its old one, or
-- after the other device screens; map nil takes the screen out.
local function withTouchScreen(buttonMaps, deviceId, map)
  local identifier = TOUCH_SCREEN_PREFIX .. deviceId
  local out, at = {}, nil
  for _, existing in ipairs(buttonMaps) do
    if type(existing) == "table" and existing.ButtonMapIdentifier == identifier then
      at = at or #out + 1
    else
      out[#out + 1] = existing
    end
  end
  if map then
    if not at then
      at = #out + 1
      for i, existing in ipairs(out) do
        if type(existing) == "table" and isTouchScreenId(existing.ButtonMapIdentifier) then
          at = i + 1
        end
      end
    end
    table.insert(out, at, map)
  end
  return out
end

local function touchScreenSummary(map)
  local summary = {hardKeys = {}, onScreen = 0}
  for _, button in ipairs(map and map.Buttons or {}) do
    if button.ButtonKey then
      summary.hardKeys[#summary.hardKeys + 1] = button.ButtonKey
    else
      summary.onScreen = summary.onScreen + 1
    end
  end
  return summary
end

-- Touch Gesture Lookup Simulator (P18): replicate juniper/gesturepad.lua +
-- harmony.lua key-gate over a MapList. Returns {ok, reason, deviceId, command,
-- functionId, resolved, hardKey, hardGateOk, warnings[]}.
local function simulateGestureLookup(mapList, activityId, gestureKey)
  local id = tostring(activityId or "")
  local maps = type(mapList) == "table" and mapList.ButtonMaps or {}
  local activityMap
  for _, m in ipairs(type(maps) == "table" and maps or {}) do
    if type(m) == "table" and m.ButtonMapIdentifier == "16417Activity" .. id then
      activityMap = m
      break
    end
  end
  if not activityMap then
    return {ok = false, reason = "no-activity-map", warnings = {"No Touch screen for this activity yet."}}
  end
  local gesture
  for _, b in ipairs(type(activityMap.Buttons) == "table" and activityMap.Buttons or {}) do
    if type(b) == "table" and tostring(b.__type or ""):find("GestureRemoteButton", 1, true)
        and tostring(b.ButtonKey or "") == tostring(gestureKey) then
      gesture = b
      break
    end
  end
  if not gesture then
    return {ok = false, reason = "no-gesture", warnings = {"No " .. tostring(gestureKey) .. " gesture on this activity yet."}}
  end
  local action = type(gesture) == "table" and gesture.ButtonAction or nil
  if type(action) ~= "table" or type(action.CommandName) ~= "string" or action.CommandName == "" then
    return {ok = false, reason = "no-action", warnings = {tostring(gestureKey) .. " has no command assigned."}}
  end
  local deviceId = tostring(action["DeviceId-"] or "")
  local command = tostring(action.CommandName or "")
  local functionId = tonumber(action["FunctionId-"]) or 0
  local deviceMap
  for _, m in ipairs(type(maps) == "table" and maps or {}) do
    if type(m) == "table" and m.ButtonMapIdentifier == "16417Device" .. deviceId then
      deviceMap = m
      break
    end
  end
  if not deviceMap then
    return {ok = false, reason = "no-device-screen", deviceId = deviceId, command = command,
      functionId = functionId, warnings = {"Device " .. deviceId .. " has no Touch screen, so " .. tostring(gestureKey) .. " does nothing."}}
  end
  local buttons = type(deviceMap.Buttons) == "table" and deviceMap.Buttons or {}
  local target
  if functionId > 0 then
    for _, b in ipairs(buttons) do
      local a = type(b) == "table" and b.ButtonAction or nil
      if type(a) == "table" and tonumber(a["FunctionId-"]) == functionId then
        target = b
        break
      end
    end
  end
  if not target then
    local want = string.lower(command)
    for _, b in ipairs(buttons) do
      if type(b) == "table" then
        local a = b.ButtonAction
        if type(a) == "table" and type(a.__type) == "string" and not a.__type:find("ButtonClientAction", 1, true) then
          if type(a.CommandName) == "string" and string.lower(a.CommandName) == want then
            target = b
            break
          end
          if type(b.ButtonKey) == "string" and string.lower(b.ButtonKey) == want then
            target = b
            break
          end
        end
      end
    end
  end
  if not target then
    return {ok = false, reason = "no-command-on-screen", deviceId = deviceId, command = command,
      functionId = functionId, warnings = {"Device " .. deviceId .. " has no " .. command .. " on its Touch screen."}}
  end
  local warnings = {}
  if isOneShotCommand(command) then
    warnings[#warnings + 1] = "Raw toggles (" .. command .. ") on gestures can double-fire: gestures cannot use hub one-shot protection. Prefer discrete On/Off or Up/Down."
  end
  local isHard = type(target.__type) == "string" and target.__type:find("HardRemoteButton", 1, true) ~= nil
  if isHard then
    local key = tostring(target.ButtonKey or "")
    local activityHard = {}
    for _, b in ipairs(type(activityMap.Buttons) == "table" and activityMap.Buttons or {}) do
      if type(b) == "table" and tostring(b.__type or ""):find("HardRemoteButton", 1, true) then
        activityHard[tostring(b.ButtonKey or "")] = true
      end
    end
    if not activityHard[key] then
      return {ok = false, reason = "hard-gate-blocked", deviceId = deviceId, command = command,
        functionId = functionId, resolved = "hard", hardKey = key, hardGateOk = false,
        warnings = {tostring(gestureKey) .. " resolves to hard key " .. key .. ", which is not mapped in this activity (Touch key gate drops it)."}}
    end
    return {ok = true, reason = "hard", deviceId = deviceId, command = command,
      functionId = functionId, resolved = "hard", hardKey = key, hardGateOk = true, warnings = warnings}
  end
  return {ok = true, reason = "soft", deviceId = deviceId, command = command,
    functionId = functionId, resolved = "soft", hardGateOk = true, warnings = warnings}
end

-- Warnings for every gesture in an activity map (P07 warning, P18).
local function gestureWarningsForActivity(mapList, activityId)
  local out = {}
  local id = tostring(activityId or "")
  local maps = type(mapList) == "table" and mapList.ButtonMaps or {}
  local activityMap
  for _, m in ipairs(type(maps) == "table" and maps or {}) do
    if type(m) == "table" and m.ButtonMapIdentifier == "16417Activity" .. id then
      activityMap = m
      break
    end
  end
  if not activityMap then return out end
  for _, b in ipairs(type(activityMap.Buttons) == "table" and activityMap.Buttons or {}) do
    if type(b) == "table" and tostring(b.__type or ""):find("GestureRemoteButton", 1, true) then
      local key = tostring(b.ButtonKey or "")
      if not GESTURE_KEYS[key] then
        out[#out + 1] = {key = key, level = "warn", message = "Unknown gesture key " .. key .. "; the Touch only resolves SwipeUp/Down/Left/Right and Tap."}
      else
        local sim = simulateGestureLookup(mapList, id, key)
        for _, w in ipairs(sim.warnings or {}) do
          out[#out + 1] = {key = key, level = sim.ok and "warn" or "error", message = w}
        end
      end
    end
  end
  return out
end

-- Make, rebuild or remove one device's Touch screen. Only MapList changes,
-- with a new etag, so the Touch pulls just that list.
local function commitDeviceScreen(request)
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
  local snapshots = {}
  for _, name in ipairs({"ActivityList", "MapList", "FunctionList", "DeviceList"}) do
    local snapshot, readError = resourceSnapshot(name)
    if not snapshot then
      return {ok = false, localOnly = true, error = readError}
    end
    snapshots[name] = snapshot
  end
  local oldMaps = snapshots.MapList
  if type(oldMaps.resource.ButtonMaps) ~= "table" then
    return {ok = false, localOnly = true, error = "MapList.ButtonMaps must be an array"}
  end
  local old = touchScreenOf(oldMaps.resource.ButtonMaps, deviceId)
  if old and not isLocalTouchScreen(old) then
    return {
      ok = false,
      localOnly = true,
      error = "device " .. deviceId .. " keeps the Touch screen Logitech made for it"
    }
  end
  local map
  if request.remove ~= true then
    local entry = deviceEntry(snapshots.DeviceList.resource, deviceId)
    if not entry then
      return {ok = false, localOnly = true, error = "DeviceList has no device " .. deviceId}
    end
    local template = touchScreenTemplate(oldMaps.resource.ButtonMaps)
    if not template then
      return {ok = false, localOnly = true, error = "this hub has no Harmony Touch screens to copy"}
    end
    local mapError
    map, mapError = touchScreenMap(entry, old, template, identityAllocator(
      snapshots.ActivityList.resource, oldMaps.resource,
      snapshots.FunctionList.resource, snapshots.DeviceList.resource
    ))
    if not map then
      return {ok = false, localOnly = true, error = mapError}
    end
  end
  local mapList = {}
  for key, value in pairs(oldMaps.resource) do
    mapList[key] = value
  end
  mapList.ButtonMaps = withTouchScreen(oldMaps.resource.ButtonMaps, deviceId, map)
  local summary = touchScreenSummary(map)
  local result = {
    ok = true,
    localOnly = true,
    deviceId = deviceId,
    changed = not sameValue(old, map),
    removed = map == nil and old ~= nil,
    hardKeys = summary.hardKeys,
    onScreen = summary.onScreen
  }
  if request.dryRun == true or not result.changed then
    result.dryRun = request.dryRun == true
    return result
  end
  local valid, validationError = validateGraph(
    snapshots.ActivityList.resource, mapList,
    snapshots.FunctionList.resource, snapshots.DeviceList.resource
  )
  if not valid then
    return {ok = false, localOnly = true, error = validationError}
  end
  local mapEtag = localEtag()
  local saved, saveError = saveResource("MapList", mapList, mapEtag, localHetag())
  if not saved then
    local restored = saveResource("MapList", oldMaps.resource, oldMaps.etag, oldMaps.hetag)
    return {ok = false, localOnly = true, rolledBack = restored and true or false, error = saveError}
  end
  local sent, reloaded = pcall(system.sendMessage, "config_new", {"MapList"})
  if not sent or reloaded ~= true then
    local restored = saveResource("MapList", oldMaps.resource, oldMaps.etag, oldMaps.hetag)
    pcall(system.sendMessage, "config_new", {"MapList"})
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = "Harmony engine rejected the Touch screen reload"
    }
  end
  result.reloaded = true
  result.activityEngineReady = publishLocalRevision()
  result.configVersion = digest.configVersion
  result.mapEtag = mapEtag
  return result
end

-- Home Assistant devices. Each entity the HA integration exposes becomes an
-- ordinary device whose commands are TransportType 64. The engine renders
-- their protocol's ControlSection into an HTTP POST to the integration's
-- webhook (harmonyengine core/ipmanager.lua getRequest), filling {d} from
-- the device's Tokens and {c} from the command's Parameters with
-- string.gsub.
local HA_PROTOCOL_NAME = "Melodious Home Assistant"
local HA_DEVICE_TAG = "melodious-ha-"
local HA_MANUFACTURER = "Home Assistant"
local HA_DEFAULT_MODEL = "Home Assistant entity"
local HA_MAX_DEVICES = 64
local HA_MAX_COMMANDS = 128
-- codex_webui numbers new commands from here too.
local HA_MIN_ID = 39000000
local HA_REFERENCE_RESOURCES = {"ActivityList", "MapList", "FunctionList"}

-- Android and Google TVs on the network (codex_androidtv). They are written the same
-- way as Home Assistant devices: TransportType 64 commands rendered into an
-- HTTP POST, here to codex_androidtv on the hub itself, which turns each command
-- into an Android TV Remote key. {d} is the TV's id in codex_androidtv (androidtv<hex>),
-- {c} the command name codex_androidtv knows. The command set is fixed apart
-- from the inputs: a request names the TV, its name and model, and may list its
-- inputs (the device Settings page does). Each input is a slot command,
-- InputHdmi1-4 or Input5-Input32; codex_androidtv's input profile for the TV
-- says what the slot does. Without inputs a commit keeps the TV's current ones
-- (a new TV gets HDMI 1-4), and an Input<n> command exists while an input uses it.
local ANDROIDTV_INPUTS = {
  {name = "HDMI 1", command = "InputHdmi1"}, {name = "HDMI 2", command = "InputHdmi2"},
  {name = "HDMI 3", command = "InputHdmi3"}, {name = "HDMI 4", command = "InputHdmi4"}
}
local ANDROIDTV_COMMAND_NAMES = {
  "PowerOn", "PowerOff", "PowerToggle", "DirectionUp", "DirectionDown", "DirectionLeft",
  "DirectionRight", "Select", "Back", "Home", "Menu", "Settings", "Info", "Guide",
  "VolumeUp", "VolumeDown", "Mute", "ChannelUp", "ChannelDown", "PrevChannel", "Play",
  "Pause", "PlayPause", "Stop", "FastForward", "Rewind", "SkipForward", "SkipBack",
  "Record", "Captions", "Search", "Assistant", "InputHdmi1", "InputHdmi2", "InputHdmi3",
  "InputHdmi4", "InputNext", "Red", "Green", "Yellow", "Blue", "Number0", "Number1",
  "Number2", "Number3", "Number4", "Number5", "Number6", "Number7", "Number8", "Number9"
}

-- What differs between the two kinds of devices this writer owns. Only the
-- Home Assistant family takes v2 (merged) devices.
local HA_FAMILY = {
  label = "Home Assistant", tag = HA_DEVICE_TAG, protocolName = HA_PROTOCOL_NAME,
  manufacturer = HA_MANUFACTURER, defaultModel = HA_DEFAULT_MODEL,
  deviceType = 44, typeName = "Home Appliance", icon = 44, mergedDevices = true,
  idPattern = "^[a-z0-9_]+%.[a-z0-9_]+$", idHint = "an entity ID such as light.kitchen"
}
local ANDROIDTV_FAMILY = {
  label = "Android TV", tag = "melodious-androidtv-", protocolName = "Melodious Android TV",
  defaultManufacturer = "Android TV", defaultModel = "Android TV",
  deviceType = 1, typeName = "Television", icon = 1,
  idPattern = "^androidtv[0-9a-f]+$", idHint = "a paired TV id such as androidtv1a2b3c4d",
  webhook = "http://127.0.0.1:8095/cmd",
  commandNames = ANDROIDTV_COMMAND_NAMES, inputs = ANDROIDTV_INPUTS, slotInputs = true,
  power = {on = "PowerOn", off = "PowerOff"}
}

-- The engine clears capodDeviceList[uid] after every answered IP command,
-- and a device without AutoDetectedDevice.Id has no uid: that throws and
-- kills the IP command task until the hub reboots. The tag is never a real
-- SSDP uuid, so nothing else matches it, and it marks the devices this
-- writer owns.
local function isHaDevice(entry, family)
  local tag = (family or HA_FAMILY).tag
  local device = type(entry) == "table" and entry.Device or nil
  local detected = type(device) == "table" and device.AutoDetectedDevice or nil
  return type(detected) == "table" and type(detected.Id) == "string" and
    string.sub(detected.Id, 1, #tag) == tag
end

local function isHaProtocol(protocol, family)
  return type(protocol) == "table" and protocol.Name == (family or HA_FAMILY).protocolName
end

-- A placeholder value lands in a JSON body and in string.gsub's
-- replacement, so it may not carry quotes, backslashes, % or braces.
local function haValue(value, maxLength)
  if type(value) ~= "string" or value == "" or #value > maxLength or
      string.find(value, '[%c"\\%%{}]') then
    return nil
  end
  return value
end

local function haLabel(value, maxLength)
  local text = type(value) == "string" and string.match(value, "^%s*(.-)%s*$") or ""
  if text == "" or #text > maxLength or string.find(text, '[%c"\\]') then
    return nil
  end
  return text
end

-- The hub's trust store lacks the Let's Encrypt root, so plain http only.
local function haWebhook(value)
  local host, path = string.match(type(value) == "string" and value or "", "^http://([^/]+)(/.*)$")
  if not host or #value > 256 or
      not (string.match(host, "^[%w%.%-]+$") or string.match(host, "^[%w%.%-]+:%d+$")) or
      not string.match(path, "^/[%w%-%._~/]*$") then
    return nil
  end
  return value
end

local function haList(value)
  if value == nil or value == json.null then
    return {}
  end
  if type(value) ~= "table" or (next(value) ~= nil and #value == 0) then
    return nil
  end
  return value
end

-- Check one device of the set; command references resolve to the spelling
-- the device itself uses. v1 devices carry {entity}; v2 devices carry
-- {key, entities = {{alias, entity}}} and command values <alias>:<action>.
local HA_DEFAULT_V2_MODEL = "Home Assistant device"

local function haAlias(value)
  if type(value) ~= "string" or value == "" or #value > 64 or
      string.find(value, ":") or not string.match(value, "^[a-z0-9_.]+$") then
    return nil
  end
  return value
end

-- A network TV's input slot command: InputHdmi1-4, then Input5-Input32, in
-- that spelling. nil for anything else.
local function androidTvSlotCommand(name)
  if type(name) ~= "string" then
    return nil
  end
  local hdmi = string.match(string.lower(name), "^inputhdmi([1-4])$")
  if hdmi then
    return "InputHdmi" .. hdmi
  end
  local n = tonumber(string.match(string.lower(name), "^input(%d%d?)$"))
  if n and n >= 5 and n <= MAX_INPUTS then
    return "Input" .. n
  end
  return nil
end

-- A network TV's inputs from a request: nil when it lists none (keep the TV's
-- current inputs), else names, order and one slot command each.
local function androidTvInputsFrom(raw, label)
  if raw == nil or raw == json.null then
    return nil
  end
  local list = haList(raw)
  if not list or #list > MAX_INPUTS then
    return nil, label .. ": inputs must list at most " .. MAX_INPUTS .. " inputs"
  end
  local inputs, names, slots = {}, {}, {}
  for i, input in ipairs(list) do
    local name = type(input) == "table" and haLabel(input.name, 64)
    if not name then
      return nil, label .. ": input names must be 1-64 characters without quotes or backslashes"
    end
    if names[string.lower(name)] then
      return nil, label .. ": input " .. name .. " is listed twice"
    end
    names[string.lower(name)] = true
    local command = androidTvSlotCommand(input.command)
    if not command then
      return nil, label .. ": input " .. name .. " needs an input slot command (InputHdmi1-4, Input5-Input" .. MAX_INPUTS .. ")"
    end
    if slots[command] then
      return nil, label .. ": two inputs use " .. command
    end
    slots[command] = true
    inputs[i] = {name = name, command = command}
  end
  return inputs
end

local function haDeviceSpecFrom(raw, index, family)
  family = family or HA_FAMILY
  local label = "device " .. index
  if type(raw) ~= "table" then
    return nil, label .. " must be an object"
  end
  local isV2 = family.mergedDevices and (raw.key ~= nil or raw.entities ~= nil) or false
  local spec = {
    name = haLabel(raw.name, 64),
    model = (raw.model == nil or raw.model == json.null) and
      (isV2 and HA_DEFAULT_V2_MODEL or family.defaultModel) or
      haLabel(raw.model, 64),
    manufacturer = family.manufacturer or
      ((raw.manufacturer == nil or raw.manufacturer == json.null) and family.defaultManufacturer or
        haLabel(raw.manufacturer, 64)),
    commands = {},
    inputs = {}
  }
  if isV2 then
    spec.key = haValue(raw.key, 128)
    if not spec.key or not string.match(spec.key, "^[a-z0-9_]+%.[a-z0-9_]+$") then
      return nil, label .. " needs a key such as media_player.living_room"
    end
    label = spec.key
    local entities = haList(raw.entities)
    if not entities or #entities == 0 or #entities > 32 then
      return nil, label .. ": entities must list 1 to 32 objects"
    end
    spec.entities = {}
    spec.aliasToEntity = {}
    local seenAlias, seenEntity = {}, {}
    for i, item in ipairs(entities) do
      if type(item) ~= "table" then
        return nil, label .. ": entity " .. i .. " must be an object"
      end
      local alias = haAlias(item.alias)
      local entity = haValue(item.entity, 128)
      if not alias then
        return nil, label .. ": entity " .. i .. " needs an alias of letters, digits, . or _"
      end
      if not entity or not string.match(entity, "^[a-z0-9_]+%.[a-z0-9_]+$") then
        return nil, label .. ": entity " .. i .. " needs an entity ID such as light.kitchen"
      end
      if seenAlias[string.lower(alias)] then
        return nil, label .. ": alias " .. alias .. " is listed twice"
      end
      if seenEntity[entity] then
        return nil, label .. ": " .. entity .. " is listed twice"
      end
      seenAlias[string.lower(alias)] = true
      seenEntity[entity] = true
      spec.entities[i] = {alias = alias, entity = entity}
      spec.aliasToEntity[alias] = entity
    end
  else
    spec.key = nil
    spec.entity = haValue(raw.entity, 128)
    if not spec.entity or not string.match(spec.entity, family.idPattern) then
      return nil, label .. " needs " .. family.idHint
    end
    label = spec.entity
    spec.entities = {{alias = spec.entity, entity = spec.entity}}
    spec.aliasToEntity = {[spec.entity] = spec.entity}
  end
  if not spec.name then
    return nil, label .. ": name must be 1-64 characters without quotes or backslashes"
  end
  if not spec.model then
    return nil, label .. ": model must be 1-64 characters without quotes or backslashes"
  end
  if not spec.manufacturer then
    return nil, label .. ": manufacturer must be 1-64 characters without quotes or backslashes"
  end
  if family.commandNames then
    -- A fixed command set: each command's value is its own name.
    for i, name in ipairs(family.commandNames) do
      spec.commands[i] = {name = name, value = name}
    end
    spec.power = {type = 1, on = family.power.on, off = family.power.off}
    if family.slotInputs then
      local inputs, inputsError = androidTvInputsFrom(raw.inputs, label)
      if inputsError then
        return nil, inputsError
      end
      -- nil: keep the TV's current inputs; settled once the old device is known.
      spec.inputs = inputs
      if raw.inputDelay ~= nil and raw.inputDelay ~= json.null then
        local delay = tonumber(raw.inputDelay)
        if not delay or delay < 0 or delay > 60000 or delay % 1 ~= 0 then
          return nil, label .. ": inputDelay must be 0-60000 ms"
        end
        spec.inputDelay = delay
      end
    else
      for i, input in ipairs(family.inputs) do
        spec.inputs[i] = {name = input.name, command = input.command}
      end
    end
    return spec
  end
  local commands = haList(raw.commands)
  if not commands or #commands == 0 or #commands > HA_MAX_COMMANDS then
    return nil, label .. ": commands must list 1 to " .. HA_MAX_COMMANDS .. " commands"
  end
  local byName = {}
  for i, command in ipairs(commands) do
    local name = type(command) == "table" and command.name
    if type(name) ~= "string" or #name > 48 or not string.match(name, "^[%w][%w _%.%+%-]*$") then
      return nil, label .. ": command " .. i ..
        " needs a name of letters, digits, spaces, . _ + or -"
    end
    if byName[string.lower(name)] then
      return nil, label .. ": command " .. name .. " is listed twice"
    end
    local value = haValue(command.value, 96)
    if not value then
      return nil, label .. ": command " .. name ..
        " needs a value without quotes, backslashes, % or braces"
    end
    if isV2 then
      local alias = string.match(value, "^([^:]+):(.+)$")
      if not alias or not spec.aliasToEntity[alias] then
        return nil, label .. ": command " .. name ..
          " must start with a known alias"
      end
      local action = string.sub(value, #alias + 2)
      if action == "" then
        return nil, label .. ": command " .. name .. " needs an action after the alias"
      end
    end
    byName[string.lower(name)] = name
    spec.commands[i] = {name = name, value = value}
  end
  local function commandNamed(name)
    return type(name) == "string" and byName[string.lower(name)] or nil
  end
  local power = raw.power
  if power == nil or power == json.null then
    spec.power = {type = 0}
  elseif type(power) ~= "table" then
    return nil, label .. ": power must be an object"
  elseif power.toggle ~= nil and power.toggle ~= json.null then
    spec.power = {type = 2, toggle = commandNamed(power.toggle)}
    if not spec.power.toggle then
      return nil, label .. ": power.toggle must name one of its commands"
    end
  else
    spec.power = {type = 1, on = commandNamed(power.on), off = commandNamed(power.off)}
    if not spec.power.on or not spec.power.off or spec.power.on == spec.power.off then
      return nil, label .. ": power needs separate on and off commands from its list"
    end
  end
  local inputs = haList(raw.inputs)
  if not inputs or #inputs > MAX_INPUTS then
    return nil, label .. ": inputs must list at most " .. MAX_INPUTS .. " inputs"
  end
  local seen = {}
  for i, input in ipairs(inputs) do
    local name = type(input) == "table" and haLabel(input.name, 64)
    if not name then
      return nil, label .. ": input names must be 1-64 characters without quotes or backslashes"
    end
    if seen[string.lower(name)] then
      return nil, label .. ": input " .. name .. " is listed twice"
    end
    seen[string.lower(name)] = true
    local command = commandNamed(input.command)
    if not command then
      return nil, label .. ": input " .. name .. " must name one of its commands"
    end
    spec.inputs[i] = {name = name, command = command}
  end
  return spec
end

local function haSetFrom(set, family)
  family = family or HA_FAMILY
  if type(set) ~= "table" then
    return nil, "the device set must be an object"
  end
  local devices = haList(set.devices)
  if not devices or #devices > HA_MAX_DEVICES then
    return nil, "devices must be a list of at most " .. HA_MAX_DEVICES .. " devices"
  end
  local out = {devices = {}, webhook = family.webhook or haWebhook(set.webhook)}
  if #devices > 0 and not out.webhook then
    return nil, "webhook must be a plain http:// URL the hub can reach"
  end
  local keys, entities, names = {}, {}, {}
  for i, raw in ipairs(devices) do
    local spec, specError = haDeviceSpecFrom(raw, i, family)
    if not spec then
      return nil, specError
    end
    local key = spec.key or spec.entity
    if keys[key] then
      return nil, key .. " is listed twice"
    end
    if names[string.lower(spec.name)] then
      return nil, "two devices are named " .. spec.name
    end
    keys[key] = true
    names[string.lower(spec.name)] = true
    for _, item in ipairs(spec.entities) do
      if entities[item.entity] then
        return nil, item.entity .. " is listed in two devices"
      end
      entities[item.entity] = key
    end
    out.devices[i] = spec
  end
  return out
end

local function haEntityOf(entry)
  local tokens = type(entry.Device.Tokens) == "table" and entry.Device.Tokens.Parameters
  for _, token in ipairs(type(tokens) == "table" and tokens or {}) do
    if type(token) == "table" and token.Key == "{d}" then
      return token.Value
    end
  end
  return nil
end

local function copyValue(value)
  if type(value) ~= "table" then
    return value
  end
  local out = {}
  for key, item in pairs(value) do
    out[key] = copyValue(item)
  end
  return out
end

local function maxId(value, found)
  if type(value) ~= "table" then
    return found
  end
  for key, item in pairs(value) do
    if key == "Id-" and type(item) == "number" and item > found then
      found = item
    else
      found = maxId(item, found)
    end
  end
  return found
end

-- Every device and command each activity, map and function list names, so
-- a device or command that is still in use is never dropped. A device's
-- own Touch screen is rebuilt with it, so it doesn't count.
local function haReferences()
  local refs = {}
  for _, name in ipairs(HA_REFERENCE_RESOURCES) do
    local snapshot, readError = resourceSnapshot(name)
    if not snapshot then
      return nil, readError
    end
    local function visit(value, screenOf)
      if type(value) ~= "table" then
        return
      end
      if isTouchScreenId(value.ButtonMapIdentifier) and isLocalTouchScreen(value) then
        screenOf = string.sub(value.ButtonMapIdentifier, #TOUCH_SCREEN_PREFIX + 1)
      end
      local id = normalizedId(value["DeviceId-"])
      if id and id ~= screenOf then
        local ref = refs[id] or {resources = {}, commands = {}}
        refs[id] = ref
        ref.resources[name] = true
        if type(value.CommandName) == "string" then
          ref.commands[string.lower(value.CommandName)] = true
        end
      end
      for _, item in pairs(value) do
        visit(item, screenOf)
      end
    end
    visit(snapshot.resource)
  end
  return refs
end

local function haDeviceTable(spec, deviceId, now, family)
  family = family or HA_FAMILY
  return {
    DongleIndex = 0, InterDeviceDelay = 0, HoldInterKeyDelay = 0, DeviceType = family.deviceType,
    RegisterSection = json.null, ContentProfileKey = tonumber(deviceId), DeviceOrder = 0,
    DeviceProfileUri = "", SetupState = 1, DeviceSearchType = -1,
    ["GlobalDeviceVersionId-"] = 0, DeviceTypeDisplayName = family.typeName,
    FriendlyName = json.null, PressMinRepeats = 0, PrivateAddType = 1,
    RegionalCharset = json.null, BTAddress = json.null, DongleRFID = 0,
    ["GlobalLanguageVersionId-"] = 0, ParentDeviceId = json.null, DecodedEdid = json.null,
    DefaultPressMinRepeats = 0, ParentDeviceModel = "", RenewSection = json.null,
    IsMultiCode = false, GroupName = json.null, DefaultInterDeviceDelay = 0,
    ["ParentDevice-"] = 0, DeviceAddedDate = now, AppLaunchConfigs = json.null,
    PictureId = json.null, IsKeyboardAssociated = false, IsScartCableSupported = false,
    Icon = family.icon, ["Id-"] = tonumber(deviceId), IsInterKeyDelayOptimized = false,
    SuggestedDisplay = "DEFAULT", ControlPort = 7, EncodedEdid = json.null,
    InterKeyDelay = 0, DeviceClassification = 0, DeviceCapabilitiesWithPriority = {},
    CopiedDeviceSource = -1, State = 1, HoldInterDeviceDelay = 0, ActivityIds = json.null,
    Characterization = 0, HoldMinRepeats = -1, DefaultInterKeyDelay = 0
  }
end

-- A network TV's inputs once the old device is known: the request's, or the
-- device's current ones (input commands it still has), or HDMI 1-4 for a new
-- TV; then every slot command an input uses joins the command list.
local function androidTvResolveInputs(spec, family, old)
  local feature = old and featureOf(old, "InputFeature")
  if spec.inputs == nil then
    spec.inputs = {}
    if old then
      local base = {}
      for _, command in ipairs(spec.commands) do
        base[string.lower(command.name)] = command.name
      end
      local current = {}
      for _, input in ipairs(feature and type(feature.Inputs) == "table" and feature.Inputs or {}) do
        local action = type(input) == "table" and type(input.Actions) == "table" and input.Actions[1]
        local name = action and action.IRCommandName
        local command = androidTvSlotCommand(name) or (type(name) == "string" and base[string.lower(name)])
        if type(input.InputName) == "string" and command then
          current[#current + 1] = {name = input.InputName, command = command, order = tonumber(input.InputOrder) or 0}
        end
      end
      table.sort(current, function(a, b) return a.order < b.order end)
      for i, input in ipairs(current) do
        spec.inputs[i] = {name = input.name, command = input.command}
      end
    else
      for i, input in ipairs(family.inputs) do
        spec.inputs[i] = {name = input.name, command = input.command}
      end
    end
  end
  if spec.inputDelay == nil and feature then
    spec.inputDelay = tonumber(feature.InputDelay)
  end
  local have = {}
  for _, command in ipairs(spec.commands) do
    have[string.lower(command.name)] = true
  end
  for _, input in ipairs(spec.inputs) do
    if not have[string.lower(input.command)] then
      spec.commands[#spec.commands + 1] = {name = input.command, value = input.command}
      have[string.lower(input.command)] = true
    end
  end
end

-- Build one device entry from its spec, keeping the IDs, dates and timing
-- an earlier commit or the device settings editor left on it.
local function haDeviceEntry(spec, old, deviceId, protocolId, nextId, now, family)
  family = family or HA_FAMILY
  local entry = old or {Device = haDeviceTable(spec, deviceId, now, family), DeviceFeatures = {}}
  local device = entry.Device
  device.Name = spec.name
  device.Model = spec.model
  device.Manufacturer = spec.manufacturer
  device.ParentDeviceManufacturer = spec.manufacturer
  device.Transport = 64
  device.Tokens = {Parameters = {{Key = "{d}", Value = spec.key or spec.entity}}}
  device.AutoDetectedDevice = {Id = family.tag .. deviceId}
  local previous = {}
  for _, command in ipairs(type(entry.Commands) == "table" and entry.Commands or {}) do
    if type(command) == "table" and type(command.Name) == "string" then
      previous[string.lower(command.Name)] = command
    end
  end
  entry.Commands = {}
  for i, command in ipairs(spec.commands) do
    local before = previous[string.lower(command.name)] or {}
    entry.Commands[i] = {
      -- Raw must be present: the engine string.subs Raw unless it is null.
      Raw = json.null,
      ["Id-"] = before["Id-"] or nextId(),
      KeyCode = "",
      DateTaught = before.DateTaught or now,
      FunctionId = json.null,
      Parameters = {{Key = "{c}", Value = command.value}},
      Name = command.name,
      FunctionGroupId = 0,
      TransportType = 64,
      ProtocolId = protocolId,
      CommandTypeId = "",
      IsLearned = false
    }
  end
  if type(entry.DeviceFeatures) ~= "table" then
    entry.DeviceFeatures = {}
  end
  local power = powerFeatureOf(entry)
  power.PowerTypeId = spec.power.type
  power.PowerOnActions = pressActions(spec.power.on)
  power.PowerOffActions = pressActions(spec.power.off)
  power.PowerToggleActions = pressActions(spec.power.toggle)
  if not old then
    power.PowerOnDelay = 0
    power.DefaultPowerOnDelay = 0
    power.IsPowerAlwaysOn = false
    power.IsPoweredOnBetweenActivities = false
  end
  local inputFeature = featureOf(entry, "InputFeature")
  applyInputs(entry, power, {
    type = #spec.inputs > 0 and "discrete" or "none",
    delay = spec.inputDelay or inputFeature and tonumber(inputFeature.InputDelay) or 0,
    list = spec.inputs
  })
  return entry
end

local function haProtocol(protocolId, webhook, family)
  return {
    Attributes = {}, IsPadded = false, IsFullSequence = false, Rating = json.null,
    NumberOfLinkedLanguage = 0, Status = json.null, IsPublic = false, HoldDelay = json.null,
    PressMinimumRepeats = 0, SendingType = 0, Name = (family or HA_FAMILY).protocolName,
    ControlSection = {
      Url = webhook,
      Method = "POST",
      -- The engine JSON-decodes Header after filling placeholders.
      Header = '{"Content-Type":"application/json"}',
      Body = '{"device":"{d}","command":"{c}"}',
      Timeout = "2"
    },
    Flags = {},
    -- Loaded as an IR protocol: the engine divides by the carrier and walks
    -- both segment lists, so none of them may be missing.
    __type = "IrProtocol", CarrierFrequency = 38000, ["Id-"] = protocolId,
    KeyCode = json.null, HoldMinimumRepeats = json.null, RelatedProtocols = {},
    IRSegments = {}, CodeSegments = {}
  }
end

-- Make the hub's Home Assistant (or Android TV) devices match the requested
-- set: add, update and remove the devices this writer owns for that family,
-- and keep one protocol that points at the webhook. Other devices, including
-- the other family's, are never touched.
local function commitHaDevices(request, family)
  family = family or HA_FAMILY
  if not blockerActive() then
    return {
      ok = false,
      localOnly = true,
      error = "offline device writer refused to run because the cloud blocker is not active"
    }
  end
  local set, setError = haSetFrom(request.set, family)
  if not set then
    return {ok = false, localOnly = true, error = setError}
  end
  if resources.isAnySyncInProgress() then
    return {
      ok = false,
      localOnly = true,
      error = "a Harmony sync is in progress; try again when it finishes"
    }
  end
  local oldDevices, deviceReadError = resourceSnapshot("DeviceList")
  local oldText = readFile(DEVICE_LIST_FILE)
  local oldProtocols, protocolReadError = resourceSnapshot("ProtocolList")
  if not oldDevices or not oldText or not oldProtocols then
    return {
      ok = false,
      localOnly = true,
      error = deviceReadError or protocolReadError or "could not read the local DeviceList"
    }
  end
  local copied, deviceList = pcall(json.decode, oldText)
  if not copied or type(deviceList) ~= "table" or
      type(deviceList.DevicesWithFeatures) ~= "table" or
      type(oldProtocols.resource.Protocols) ~= "table" then
    return {ok = false, localOnly = true, error = "could not copy the local DeviceList"}
  end
  local refs, refError = haReferences()
  if not refs then
    return {ok = false, localOnly = true, error = refError}
  end
  local oldMaps, mapReadError = resourceSnapshot("MapList")
  local activities, activityReadError = resourceSnapshot("ActivityList")
  local functions, functionReadError = resourceSnapshot("FunctionList")
  if not oldMaps or not activities or not functions or
      type(oldMaps.resource.ButtonMaps) ~= "table" then
    return {
      ok = false,
      localOnly = true,
      error = mapReadError or activityReadError or functionReadError or
        "MapList.ButtonMaps must be an array"
    }
  end

  local owned, ownedByEntity, kept, otherNames = {}, {}, {}, {}
  for _, entry in ipairs(deviceList.DevicesWithFeatures) do
    local device = type(entry) == "table" and entry.Device or {}
    if isHaDevice(entry, family) and haEntityOf(entry) then
      owned[haEntityOf(entry)] = entry
      ownedByEntity[haEntityOf(entry)] = entry
    else
      kept[#kept + 1] = entry
      if type(device.Name) == "string" then
        otherNames[string.lower(device.Name)] = true
      end
    end
  end
  local counter = math.max(
    maxId(deviceList, 0), maxId(oldProtocols.resource, 0), HA_MIN_ID
  )
  local function nextId()
    counter = counter + 1
    return counter
  end
  local protocolList = {}
  for key, value in pairs(oldProtocols.resource) do
    protocolList[key] = value
  end
  protocolList.Protocols = {}
  local protocolId
  for _, protocol in ipairs(oldProtocols.resource.Protocols) do
    if isHaProtocol(protocol, family) then
      protocolId = protocolId or protocol["Id-"]
    else
      protocolList.Protocols[#protocolList.Protocols + 1] = protocol
    end
  end
  if #set.devices > 0 then
    protocolId = protocolId or nextId()
    protocolList.Protocols[#protocolList.Protocols + 1] = haProtocol(protocolId, set.webhook, family)
  end

  local now = "/Date(" .. tostring(os.time() or 0) .. "000+0000)/"
  local result = {added = {}, updated = {}, removed = {}, unchanged = {}, retained = {}, devices = {}}
  local wanted, screens, gone = {}, {}, {}
  for _, spec in ipairs(set.devices) do
    if otherNames[string.lower(spec.name)] then
      return {
        ok = false,
        localOnly = true,
        error = "another device is already named " .. spec.name
      }
    end
    local key = spec.key or spec.entity
    -- Exact key match first; otherwise the first old device whose {d}
    -- equals an entity of the spec (v1 migration, in spec order).
    local old = owned[key]
    local migratedFrom
    if not old then
      for _, item in ipairs(spec.entities) do
        if ownedByEntity[item.entity] and ownedByEntity[item.entity] ~= true then
          old = ownedByEntity[item.entity]
          migratedFrom = item.entity
          break
        end
      end
    end
    local absorbedOwns = {}
    if old then
      for entity, entry in pairs(ownedByEntity) do
        if entry ~= old and entry ~= true then
          for _, item in ipairs(spec.entities) do
            if item.entity == entity then
              absorbedOwns[#absorbedOwns + 1] = {entity = entity, entry = entry}
              break
            end
          end
        end
      end
    end
    if family.slotInputs then
      androidTvResolveInputs(spec, family, old)
    end
    local deviceId
    if old then
      -- {d} may differ from the spec key after migration; the entry
      -- writer updates it, so match the old device by key from here on.
      deviceId = normalizedId(old.Device["Id-"])
      local ref = refs[deviceId]
      for name in pairs(ref and ref.commands or {}) do
        local stillThere = false
        for _, command in ipairs(spec.commands) do
          if string.lower(command.name) == name then
            stillThere = true
          end
        end
        if not stillThere then
          return {
            ok = false,
            localOnly = true,
            error = spec.name .. ": an activity, button or sequence still uses command " .. name
          }
        end
      end
      local problems = inputsInUse(deviceId, {list = spec.inputs})
      if #problems > 0 then
        return {
          ok = false,
          localOnly = true,
          error = spec.name .. ": activities still use inputs this change removes: " ..
            table.concat(problems, "; ")
        }
      end
    else
      -- One counter for devices, commands and the protocol keeps every new
      -- ID above all existing ones.
      deviceId = tostring(nextId())
    end
    local before = old and copyValue(old) or nil
    local entry = haDeviceEntry(spec, old, deviceId, protocolId, nextId, now, family)
    wanted[key] = true
    for _, item in ipairs(spec.entities) do
      wanted[item.entity] = true
    end
    kept[#kept + 1] = entry
    screens[#screens + 1] = {deviceId = deviceId, entry = entry}
    local bucket = not old and result.added or
      (sameValue(before, entry) and result.unchanged or result.updated)
    bucket[#bucket + 1] = spec.name
    local record = {
      key = key,
      deviceId = deviceId,
      name = spec.name
    }
    if spec.key then
      record.entities = {}
      for _, item in ipairs(spec.entities) do
        record.entities[#record.entities + 1] = {alias = item.alias, entity = item.entity}
      end
    else
      record.entity = spec.entity
    end
    if migratedFrom then
      record.migratedFrom = migratedFrom
    end
    result.devices[#result.devices + 1] = record
    -- Absorbed old devices: retain when referenced, else drop with screens.
    for _, absorbed in ipairs(absorbedOwns) do
      local absorbedId = normalizedId(absorbed.entry.Device["Id-"])
      local ref = refs[absorbedId]
      if ref then
        local where = {}
        for name in pairs(ref.resources) do
          where[#where + 1] = name
        end
        table.sort(where)
        kept[#kept + 1] = absorbed.entry
        ownedByEntity[absorbed.entity] = true
        result.retained[#result.retained + 1] = {
          name = tostring(absorbed.entry.Device.Name),
          deviceId = absorbedId,
          usedBy = where
        }
      else
        result.removed[#result.removed + 1] = tostring(absorbed.entry.Device.Name)
        gone[#gone + 1] = absorbedId
        owned[absorbed.entity] = nil
        ownedByEntity[absorbed.entity] = true
      end
    end
    if old then
      owned[key] = true
    end
  end
  for entity, entry in pairs(ownedByEntity) do
    if entry ~= true and not wanted[entity] then
      local deviceId = normalizedId(entry.Device["Id-"])
      local ref = refs[deviceId]
      if ref then
        local where = {}
        for name in pairs(ref.resources) do
          where[#where + 1] = name
        end
        table.sort(where)
        return {
          ok = false,
          localOnly = true,
          error = tostring(entry.Device.Name) .. " is still used by " ..
            table.concat(where, ", ") .. "; remove it from its activities and buttons first"
        }
      end
      result.removed[#result.removed + 1] = tostring(entry.Device.Name)
      gone[#gone + 1] = deviceId
    end
  end
  deviceList.DevicesWithFeatures = kept

  -- Each device gets a Touch screen built from its commands, on a hub with
  -- a Touch, and a removed device's screen goes with it.
  local buttonMaps = oldMaps.resource.ButtonMaps
  for _, deviceId in ipairs(gone) do
    local old = touchScreenOf(buttonMaps, deviceId)
    if old and isLocalTouchScreen(old) then
      buttonMaps = withTouchScreen(buttonMaps, deviceId, nil)
    end
  end
  local template = touchScreenTemplate(buttonMaps)
  local alloc = identityAllocator(
    activities.resource, oldMaps.resource, functions.resource, deviceList
  )
  for _, screen in ipairs(template and screens or {}) do
    local old = touchScreenOf(buttonMaps, screen.deviceId)
    if not old or isLocalTouchScreen(old) then
      local map, mapError = touchScreenMap(screen.entry, old, template, alloc)
      if not map then
        return {ok = false, localOnly = true, error = mapError}
      end
      buttonMaps = withTouchScreen(buttonMaps, screen.deviceId, map)
    end
  end
  local mapList = {}
  for key, value in pairs(oldMaps.resource) do
    mapList[key] = value
  end
  mapList.ButtonMaps = buttonMaps

  local devicesChanged = #result.added > 0 or #result.updated > 0 or #result.removed > 0
  local protocolsChanged = not sameValue(oldProtocols.resource, protocolList)
  local mapsChanged = not sameValue(oldMaps.resource.ButtonMaps, buttonMaps)
  result.ok = true
  result.localOnly = true
  result.screensChanged = mapsChanged
  result.changed = devicesChanged or protocolsChanged or mapsChanged
  if mapsChanged then
    local valid, validationError = validateGraph(
      activities.resource, mapList, functions.resource, deviceList
    )
    if not valid then
      return {ok = false, localOnly = true, error = validationError}
    end
  end
  if request.dryRun == true or not result.changed then
    result.dryRun = request.dryRun == true
    return result
  end

  local encoded, text = pcall(encodeDeviceList, deviceList)
  if not encoded then
    return {ok = false, localOnly = true, error = "could not encode DeviceList: " .. tostring(text)}
  end
  local function restore()
    local protocolsOk = not protocolsChanged or saveResource(
      "ProtocolList", oldProtocols.resource, oldProtocols.etag, oldProtocols.hetag
    )
    local devicesOk = not devicesChanged or
      saveDeviceListText(oldText, oldDevices.resource, oldDevices.etag, oldDevices.hetag)
    local mapsOk = not mapsChanged or
      saveResource("MapList", oldMaps.resource, oldMaps.etag, oldMaps.hetag)
    return protocolsOk and devicesOk and mapsOk
  end
  -- Save only what changed: each new etag makes the Touch pull that list.
  -- The protocol goes first, so the engine never loads a device without it,
  -- and the screens last, after the devices they name.
  local saved, saveError = true, nil
  if protocolsChanged then
    saved, saveError = saveResource("ProtocolList", protocolList, localEtag(), localHetag())
  end
  if saved and devicesChanged then
    tokenCounter = tokenCounter + 1
    saved, saveError = saveDeviceListText(text, deviceList, localEtag(), localHetag())
  end
  if saved and mapsChanged then
    tokenCounter = tokenCounter + 1
    saved, saveError = saveResource("MapList", mapList, localEtag(), localHetag())
  end
  if not saved then
    local restored = restore()
    return {ok = false, localOnly = true, rolledBack = restored and true or false, error = saveError}
  end
  local reload = {"DeviceList", "ProtocolList"}
  if mapsChanged then
    reload[#reload + 1] = "MapList"
  end
  local sent, reloaded = pcall(system.sendMessage, "config_new", reload)
  if not sent or reloaded ~= true then
    local restored = restore()
    pcall(system.sendMessage, "config_new", reload)
    return {
      ok = false,
      localOnly = true,
      rolledBack = restored and true or false,
      error = "Harmony engine rejected the " .. family.label .. " device reload"
    }
  end
  -- New etags plus a new revision: the Touch pulls both lists on its own.
  result.reloaded = true
  result.activityEngineReady = publishLocalRevision()
  result.configVersion = digest.configVersion
  return result
end

local function processRequest(raw)
  local ok, request = pcall(json.decode, raw)
  if not ok or type(request) ~= "table" then
    -- Answer with the id when it can be read, so codex_webui stops waiting.
    return {
      ok = false,
      localOnly = true,
      id = type(raw) == "string" and string.match(raw, '^%s*{%s*"id"%s*:%s*"([^"]*)"') or "",
      error = "invalid local request JSON"
    }
  end
  local response
  if request.op == "CommitActivityResources" then
    response = commitActivityResources(request)
  elseif request.op == "CommitDeviceSettings" then
    response = commitDeviceSettings(request)
  elseif request.op == "CommitHaDevices" then
    response = commitHaDevices(request, HA_FAMILY)
  elseif request.op == "CommitAndroidTvDevices" then
    response = commitHaDevices(request, ANDROIDTV_FAMILY)
  elseif request.op == "CommitDeviceScreen" then
    response = commitDeviceScreen(request)
  elseif request.op == "Status" then
    response = statusResponse()
  elseif request.op == "SimulateGesture" then
    -- Read-only P18 helper for editors and tests (no writes, no publish).
    local sim = simulateGestureLookup(request.mapList or {ButtonMaps = {}}, request.activityId, request.gestureKey)
    response = {ok = true, localOnly = true, simulation = sim}
  elseif request.op == "GestureWarnings" then
    local warnings = gestureWarningsForActivity(request.mapList or {ButtonMaps = {}}, request.activityId)
    response = {ok = true, localOnly = true, warnings = warnings}
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
  while not stopRequested and not melodiousOff() do
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

-- Home-control keys (docs/HOME_CONTROL_BUTTONS.md), first the Companion's.
-- Light 1, Light 2, Plug 1 and Plug 2 are Ha1-Ha4; + and - are RockerUp and
-- RockerDown. Their actions live in the Companion's 16422 button maps like
-- every other key's: 16422Root for all the time, 16422Activity<id> to
-- override them while that activity runs.
local HOME_EQUAD = "16422"
local HOME_ROOT_MAP = HOME_EQUAD .. "Root"
local MAP_LIST_FILE = "/data/resources/MapList.json"
local HOME_KEYS = {"Ha1", "Ha2", "Ha3", "Ha4"}
-- + and - adjust the last pressed home key when it has <key>Up/<key>Down,
-- else they send HcUp/HcDown.
local FIXED_ROCKER_PREFIX = "Hc"
-- The remotes with home-control keys, by EquadID: their four keys and what
-- their + and - are called. A Harmony Elite or 950 (16417, like every remote
-- with a screen) has the same six keys under other names; a Touch has none
-- and never sends them. Their actions live in the 16417 maps the same way.
--   swallowNothing: a key that does nothing is answered here. A remote with
--     a screen waits for the engine to finish a key it knows as a sequence,
--     so there the engine runs it.
--   ownRocker: + and - are sent only while the root map has them, so a
--     rocker with no action of its own is in the map doing nothing; it is
--     answered here.
local HOME_REMOTES = {
  ["16422"] = {
    keys = {Ha1 = true, Ha2 = true, Ha3 = true, Ha4 = true},
    rockers = {RockerUp = "Up", RockerDown = "Down"},
    swallowNothing = true,
  },
  ["16417"] = {
    keys = {HomeControl1 = true, HomeControl2 = true, HomeControl3 = true, HomeControl4 = true},
    rockers = {HomeControlPlus = "Up", HomeControlMinus = "Down"},
    ownRocker = true,
  },
}

-- The engine's account, as it hands it to the AutomationConfig pass on
-- every config load: the same object its session serves, which this
-- plugin may not require (tools/activity_offline_guard.sh). Until the
-- first load after this plugin starts, keys are left to the engine.
local engineAccount = nil
-- The home key pressed last, per EquadID.
local lastHomeKey = {}
-- The key each rocker was renamed to at its press (false: left as it is),
-- so its holds and release go to the same key.
local rockerAliases = {}

local function requestResourceReload(name)
  local pending = readFile(RESOURCE_RELOAD_FLAG) or ""
  -- One name per line; writeFileAtomic ends the file with a newline.
  return writeFileAtomic(RESOURCE_RELOAD_FLAG, pending .. "\n" .. name)
end

local function rootButtons(account)
  local root = type(account) == "table" and type(account.buttonMaps) == "table" and
    account.buttonMaps[HOME_ROOT_MAP] or nil
  return root and type(root.buttons) == "table" and root.buttons or nil
end

-- A key AutomationConfig binds (a Logitech home-control device) keeps the
-- engine's own handling.
local function isAutomationBinding(button)
  local first = type(button.actions) == "table" and button.actions[1] or nil
  return type(first) == "table" and type(first.parameters) == "table" and
    first.parameters.haDeviceId ~= nil
end

-- After every MapList load the engine's reader removes Ha1-Ha4 from the
-- Companion's root map and rebuilds them from AutomationConfig only. Put
-- back the MapList's own keys it removed; a key AutomationConfig binds (a
-- Logitech home-control device) keeps that binding. The account it gets
-- is remembered for the key hook below.
local function keepRootHomeKeys(original)
  return function(jsonData, account)
    if type(account) == "table" then
      engineAccount = account
    end
    local kept = {}
    local before = rootButtons(account)
    if before then
      for _, key in ipairs(HOME_KEYS) do
        if type(before[key]) == "table" and not isAutomationBinding(before[key]) then
          kept[key] = before[key]
        end
      end
    end
    local result = original(jsonData, account)
    local after = rootButtons(account)
    if after then
      local restored = {}
      for _, key in ipairs(HOME_KEYS) do
        if kept[key] and after[key] == nil then
          after[key] = kept[key]
          restored[#restored + 1] = key
        end
      end
      if #restored > 0 then
        log.notice("codexactivity: kept home-control keys", table.concat(restored, " "))
      end
    end
    return result
  end
end

local function installRootHomeKeysHook()
  local ok, reader = pcall(require, "tasks.harmonyengine.loader.userconfigreader")
  if not ok or type(reader) ~= "table" or reader.codexHomeKeysHook or
      type(reader.getAutomationConfiguration) ~= "function" then
    return false
  end
  reader.getAutomationConfiguration = keepRootHomeKeys(reader.getAutomationConfiguration)
  reader.codexHomeKeysHook = true
  return true
end

-- The maps the engine looks a remote's key up in, in its order: the
-- running activity's map, then the root map.
local function homeControlMaps(equad)
  equad = equad or HOME_EQUAD
  local account = engineAccount
  if type(account) ~= "table" or type(account.buttonMaps) ~= "table" then
    return {}
  end
  local maps = {}
  local activityId = account.currentActivityId
  if activityId ~= nil and tostring(activityId) ~= "-1" then
    maps[#maps + 1] = account.buttonMaps[equad .. "Activity" .. tostring(activityId)]
  end
  maps[#maps + 1] = account.buttonMaps[equad .. "Root"]
  return maps -- a missing activity map adds no entry, so the list has no gap
end

local function resolveButton(maps, key)
  for _, map in ipairs(maps) do
    if type(map.buttons) == "table" and map.buttons[key] ~= nil then
      return map.buttons[key]
    end
  end
  return nil
end

-- "Nothing" in an activity is a sequence of one zero delay: the engine
-- drops a key without actions and would fall back to the root map.
local function doesNothing(button)
  local actions = type(button) == "table" and button.actions or nil
  if type(actions) ~= "table" or #actions == 0 then
    return false
  end
  for _, action in ipairs(actions) do
    if action.name ~= "SendDelay" then
      return false
    end
  end
  return true
end

local function hasLongPress(button)
  return type(button.longActions) == "table" and #button.longActions > 0
end

local function rockerAlias(maps, equad, suffix)
  local last = lastHomeKey[equad]
  if last and resolveButton(maps, last .. suffix) then
    return last .. suffix
  end
  if resolveButton(maps, FIXED_ROCKER_PREFIX .. suffix) then
    return FIXED_ROCKER_PREFIX .. suffix
  end
  return false
end

-- The engine re-sends a key on every hold (about every 220 ms) unless the
-- key has a long-press action, which would flip a toggle several times.
-- A home key fires once per press; its holds are answered here.
local function homeKeyAnswer(cmd, verb, params, maps, equad, remote)
  local key = params.buttonKey
  if verb == "press" then
    lastHomeKey[equad] = key
  end
  local button = resolveButton(maps, key)
  if button == nil then
    return nil
  end
  if doesNothing(button) then
    if remote.swallowNothing or verb == "hold" then
      return connect.createResponse(cmd, "200", "OK", nil)
    end
    return nil
  end
  if verb == "hold" and not hasLongPress(button) and not isAutomationBinding(button) then
    return connect.createResponse(cmd, "200", "OK", nil)
  end
  return nil
end

-- The engine hands every key named "Rocker" to its home-automation
-- manager before the button maps are read, so a rocker with an action in
-- the maps is renamed to that plain key first. The answer for a rocker
-- handled here, or nil to let the engine handle it.
local function renameRocker(cmd, verb, params, maps, equad, remote)
  local rocker = params.buttonKey
  local slot = equad .. rocker
  local alias = rockerAliases[slot]
  if verb == "press" or alias == nil then
    alias = rockerAlias(maps, equad, remote.rockers[rocker])
    rockerAliases[slot] = alias
  end
  if verb == "release" then
    rockerAliases[slot] = nil
  end
  if alias then
    params.buttonKey = alias
    return nil
  end
  if remote.ownRocker then
    local own = resolveButton(maps, rocker)
    if own ~= nil and doesNothing(own) then
      return connect.createResponse(cmd, "200", "OK", nil)
    end
  end
  return nil
end

-- The answer for a key handled here, or nil to let the engine handle it.
local function routeHomeControlKey(cmd, verb, params)
  if type(params) ~= "table" then
    return nil
  end
  local equad = tostring(params.equadId)
  local remote = HOME_REMOTES[equad]
  if not remote then
    return nil
  end
  local key = params.buttonKey
  if remote.keys[key] then
    return homeKeyAnswer(cmd, verb, params, homeControlMaps(equad), equad, remote)
  end
  if remote.rockers[key] then
    return renameRocker(cmd, verb, params, homeControlMaps(equad), equad, remote)
  end
  return nil
end

-- A failure here must never cost the remote its keys: the engine then
-- handles the key as it would without this plugin.
local function homeControlCommand(original)
  return function(cmd, verb, params)
    local ok, answer = pcall(routeHomeControlKey, cmd, verb, params)
    if not ok then
      log.error("codexactivity: home-control key failed:", tostring(answer))
    elseif answer ~= nil then
      return answer
    end
    return original(cmd, verb, params)
  end
end

local function installButtonCommandHook()
  local ok, handler = pcall(require, "tasks.harmonyengine.apihandler.activity")
  if not ok or type(handler) ~= "table" or handler.codexHomeControlHook or
      type(handler.processButtonCommand) ~= "function" then
    return false
  end
  handler.processButtonCommand = homeControlCommand(handler.processButtonCommand)
  handler.codexHomeControlHook = true
  return true
end

-- Whether the hub's MapList gives the Companion's root map home keys.
local function hasRootHomeKeys()
  local text = readFile(MAP_LIST_FILE) or ""
  return text:find(HOME_ROOT_MAP, 1, true) ~= nil and
    text:find('"ButtonKey"%s*:%s*"Ha[1-4]"') ~= nil
end

-- The engine loaded MapList before this plugin started, so the root keys
-- are already gone: one MapList reload brings them back.
local function installHomeControlHooks()
  local keysOk, keysInstalled = pcall(installRootHomeKeysHook)
  if not keysOk then
    log.error("codexactivity: home-control key hook failed:", tostring(keysInstalled))
  elseif keysInstalled then
    log.notice("codexactivity: home-control key hook installed")
    if hasRootHomeKeys() then
      local requested, requestError = requestResourceReload("MapList")
      if not requested then
        log.warning("codexactivity: MapList reload request failed:", tostring(requestError))
      end
    end
  end
  local commandOk, commandInstalled = pcall(installButtonCommandHook)
  if not commandOk then
    log.error("codexactivity: home-control command hook failed:", tostring(commandInstalled))
  elseif commandInstalled then
    log.notice("codexactivity: home-control command hook installed")
  end
end

local function start()
  if melodiousOff() then
    return false
  end
  stopRequested = false
  installHomeControlHooks()
  if not workerTask then
    workerTask = system.addTask("codexactivity", workerLoop)
  end
  return workerTask ~= nil
end

function discover(self)
  if melodiousOff() then
    return {}
  end
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
  if melodiousOff() then
    return
  end
  start()
  while not stopRequested and not melodiousOff() do
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
