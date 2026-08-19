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
local ACTIVITY_ENGINE_BARRIER_MESSAGE = "process_activity"

local moduleObj
local workerTask
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

local function waitForActivityEngine()
  if not system.isMessageRegistered(ACTIVITY_ENGINE_BARRIER_MESSAGE) then
    return nil, "Harmony activity execution barrier is unavailable"
  end
  local ok, result = pcall(
    system.sendMessage,
    ACTIVITY_ENGINE_BARRIER_MESSAGE,
    {}
  )
  if not ok then
    return nil, "Harmony activity engine did not finish rebuilding: " ..
      tostring(result)
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
  ok, err = waitForActivityEngine()
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

  digest.configVersion = previousConfigVersion + 1
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
    activityEngineReady = true,
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

local function processRequest(raw)
  local ok, request = pcall(json.decode, raw)
  if not ok or type(request) ~= "table" then
    return {ok = false, localOnly = true, error = "invalid local request JSON"}
  end
  local response
  if request.op == "CommitActivityResources" then
    response = commitActivityResources(request)
  elseif request.op == "Status" then
    response = statusResponse()
  else
    response = {ok = false, localOnly = true, error = "unknown local operation"}
  end
  response.id = tostring(request.id or "")
  return response
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
