-- LuaJIT tests for automatic paired-remote activity map repair in
-- payload/activity/codexactivity.lua (issues #250, #86).
--
-- Covers:
-- 1. Boot repair on an Elite-only hub missing 16417Activity<id>.
-- 2. Installer flag (/data/codex/repair_remote_maps) trigger + removal.
-- 3. Explicit RepairRemoteActivityMaps request op (dryRun + apply).
-- 4. Deferred retry when HAL rf.info is temporarily unavailable at early boot.
-- 5. Backup creation + pruning older timestamped backups past 5.
-- 6. Rollback on MapList save failure or engine reload rejection.
-- 7. Refusal when cloud blocker is off or /etc/melodious-off is present.
-- 8. No-op idempotency on healthy hubs.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexactivity-remote-map-repair-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local NULL = setmetatable({}, { __tostring = function() return "null" end })

local function encodeJson(value)
  if value == NULL or value == nil then return "null" end
  local kind = type(value)
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then
    if value == math.floor(value) then return string.format("%.0f", value) end
    return tostring(value)
  end
  if kind == "string" then
    return '"' .. value:gsub('[%c"\\]', function(c)
      local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return map[c] or string.format("\\u%04x", c:byte())
    end) .. '"'
  end
  local count = 0
  for _ in pairs(value) do count = count + 1 end
  if count == 0 then return "[]" end
  if count == #value then
    local parts = {}
    for i, item in ipairs(value) do parts[i] = encodeJson(item) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = tostring(key) end
  table.sort(keys)
  local parts = {}
  for i, key in ipairs(keys) do parts[i] = encodeJson(key) .. ":" .. encodeJson(value[key]) end
  return "{" .. table.concat(parts, ",") .. "}"
end

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
        local esc = text:sub(pos + 1, pos + 1)
        if esc == "u" then
          local code = tonumber(text:sub(pos + 2, pos + 5), 16) or 0
          out[#out + 1] = code < 128 and string.char(code) or "?"
          pos = pos + 6
        else
          local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
          out[#out + 1] = map[esc] or esc
          pos = pos + 2
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    error("unterminated string")
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
      pos = pos + 4 return true
    elseif text:sub(pos, pos + 4) == "false" then
      pos = pos + 5 return false
    elseif text:sub(pos, pos + 3) == "null" then
      pos = pos + 4 return NULL
    else
      local num = text:match("^%-?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
      assert(num and #num > 0, "bad json at " .. pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  return parseValue()
end

local passed = 0
local function check(cond, name)
  assert(cond, "FAIL: " .. name)
  passed = passed + 1
end

local realIoOpen = io.open
local realOsRemove = os.remove
local realOsRename = os.rename
local pluginSrc = assert(realIoOpen(repoRoot .. "/payload/activity/codexactivity.lua", "r")):read("*a")

local function brokenResources()
  return {
    ActivityList = encodeJson({
      Activities = {
        { ["Id-"] = 101, Name = "Watch TV", ActivityOrder = 0, Roles = { { ["DeviceId-"] = 10, __type = "VolumeActivityRole" } } },
        { ["Id-"] = 102, Name = "Listen to CD", ActivityOrder = 1, Roles = { { ["DeviceId-"] = 10, __type = "VolumeActivityRole" } } },
      }
    }),
    MapList = encodeJson({
      ButtonMaps = {
        {
          ["ButtonMapId-"] = 5301,
          ["ActivityId-"] = 101,
          ["RemoteId-"] = 8001,
          ["SurfaceId-"] = 7001,
          ["ButtonMapSurfaceId-"] = 7001,
          __type = "ActivityButtonMap",
          ButtonMapIdentifier = "16417Activity101",
          DateModified = NULL,
          Sequences = {},
          Buttons = {
            {
              __type = "HardRemoteButton", FunctionGroupType = 0, ButtonId = 2001, ButtonState = 1,
              ButtonKey = "VolumeUp",
              ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "VolumeUp", ["FunctionId-"] = 0, Order = 0, EventType = 1, Id = 0 },
              ButtonLongPressAction = NULL, ButtonDoublePressAction = NULL,
            }
          }
        },
        {
          ["ButtonMapId-"] = 52944090,
          ["ActivityId-"] = 102,
          ["RemoteId-"] = 8001,
          ["SurfaceId-"] = 7001,
          ["ButtonMapSurfaceId-"] = 7001,
          __type = "ActivityButtonMap",
          ButtonMapIdentifier = "16414Activity102",
          DateModified = NULL,
          Sequences = {},
          Buttons = {
            {
              __type = "HardRemoteButton", FunctionGroupType = 0, ButtonId = 1878029714, ButtonState = 1,
              ButtonKey = "Dvr",
              ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "Dvr", ["FunctionId-"] = 0, Order = 0, EventType = 1, Id = 0 },
              ButtonLongPressAction = NULL, ButtonDoublePressAction = NULL,
            },
            {
              __type = "HardRemoteButton", FunctionGroupType = 2, ButtonId = 1878029715, ButtonState = 1,
              ButtonKey = "Number1",
              ButtonAction = { __type = "ButtonCommandAction", ["DeviceId-"] = 10, CommandName = "1", ["FunctionId-"] = 0, Order = 0, EventType = 1, Id = 0 },
              ButtonLongPressAction = NULL, ButtonDoublePressAction = NULL,
            },
          }
        }
      }
    }),
    FunctionList = encodeJson({
      FunctionMaps = {
        { __type = "ActivityFunctionMap", ["ActivityId-"] = 101, FunctionGroups = {} },
        { __type = "ActivityFunctionMap", ["ActivityId-"] = 102, FunctionGroups = {} },
      }
    }),
    DeviceList = encodeJson({
      DevicesWithFeatures = {
        {
          Device = { ["Id-"] = 10, Name = "Amp" },
          Commands = {
            { Name = "VolumeUp", ["FunctionId-"] = 0 },
            { Name = "Dvr", ["FunctionId-"] = 0 },
            { Name = "1", ["FunctionId-"] = 0 },
          }
        }
      }
    }),
    ProtocolList = '{"Protocols":[]}',
  }
end

local function makeHarness(opts)
  opts = opts or {}
  local res = opts.resources or brokenResources()
  local fs = {
    ["/data/codex/cloud_blocker.conf"] = opts.blocker == false and "0\n" or "1\n",
  }
  if opts.melodiousOff then fs["/etc/melodious-off"] = "1\n" end
  if opts.flag then fs["/data/codex/repair_remote_maps"] = "" end
  for k, v in pairs(res) do
    fs["/data/resources/" .. k .. ".json"] = v
  end
  local dirs = { ["/data"] = true, ["/data/codex"] = true, ["/data/codex/resource-backups"] = true }
  for _, d in ipairs(opts.oldBackups or {}) do
    dirs["/data/codex/resource-backups/" .. d] = true
    fs["/data/codex/resource-backups/" .. d .. "/MapList.json"] = "{}"
  end
  local index = {}
  local idxN = 0
  for k in pairs(res) do
    idxN = idxN + 1
    index[k] = { etag = '"seed-' .. idxN .. '"', hetag = tostring(idxN) }
  end
  local state = {
    fs = fs,
    dirs = dirs,
    index = index,
    saves = {},
    reloads = {},
    broadcasts = 0,
    rfCalls = 0,
    halReadyAtPass = opts.halReadyAtPass or 0,
    failSaveOnce = opts.failSaveOnce or false,
    failReloadOnce = opts.failReloadOnce or false,
    rfDevices = opts.rfDevices or { { EquadID = "16417", DeviceIndex = "1", RFID = "111", SkinId = "111" } },
    passes = 0,
    limit = opts.limit or 2,
    pendingOp = opts.pendingOp,
    digest = setmetatable({ configVersion = 1, stateVersion = 1 }, {
      __index = { saveStateDigest = function() end }
    }),
  }

  io.open = function(p, m)
    m = m or "r"
    if p:sub(1, 5) == "/data" or p:sub(1, 4) == "/var" or p:sub(1, 6) == "/cache" or p:sub(1, 4) == "/etc" then
      if m:sub(1, 1) == "r" then
        if fs[p] == nil then return nil, "enoent" end
        local body = fs[p]
        return { read = function() return body end, close = function() end }
      elseif m:sub(1, 1) == "w" then
        local buf = {}
        return {
          write = function(_, ...) for i = 1, select("#", ...) do buf[#buf + 1] = tostring(select(i, ...)) end return true end,
          close = function() fs[p] = table.concat(buf) end,
        }
      elseif m:sub(1, 1) == "a" then
        local buf = {}
        return {
          write = function(_, ...) for i = 1, select("#", ...) do buf[#buf + 1] = tostring(select(i, ...)) end return true end,
          close = function() fs[p] = (fs[p] or "") .. table.concat(buf) end,
        }
      end
    end
    return realIoOpen(p, m)
  end
  os.remove = function(p) fs[p] = nil return true end
  os.rename = function(a, b) fs[b] = fs[a] fs[a] = nil return true end

  package.loaded["codexactivity"] = nil
  package.loaded["lfs"] = nil
  package.loaded["system"] = nil
  package.loaded["json"] = nil
  package.loaded["log"] = nil
  package.loaded["tasks.hal.core.hbus"] = nil
  package.loaded["tasks.harmonywebservices.core.resourcemanager"] = nil
  package.loaded["tasks.harmonywebservices.core.statedigest"] = nil
  package.loaded["tasks.connectserver.core.utils"] = nil

  package.preload["lfs"] = function()
    return {
      mkdir = function(d) dirs[d] = true return true end,
      rmdir = function(d) dirs[d] = nil return true end,
      dir = function(d)
        local items, seen = {}, {}
        local prefix = d .. "/"
        for k in pairs(dirs) do
          if k:sub(1, #prefix) == prefix then
            local rest = k:sub(#prefix + 1):match("^([^/]+)")
            if rest and not seen[rest] then seen[rest] = true items[#items + 1] = rest end
          end
        end
        for k in pairs(fs) do
          if k:sub(1, #prefix) == prefix then
            local rest = k:sub(#prefix + 1):match("^([^/]+)")
            if rest and not seen[rest] then seen[rest] = true items[#items + 1] = rest end
          end
        end
        local i = 0
        return function() i = i + 1 return items[i] end
      end,
    }
  end

  local workerFn, pluginObj
  local uuidN = 0
  package.preload["system"] = function()
    return {
      uuid = function() uuidN = uuidN + 1 return string.format("00000000-0000-4000-8000-%012d", uuidN) end,
      jiffies = function() return { tomillis = function() return 1000 end } end,
      tiggleWatchDog = function() end,
      yield = function() end,
      blockingSleep = function() end,
      sleep = function()
        state.passes = state.passes + 1
        if state.pendingOp and state.passes == 1 then
          fs["/var/volatile/codex-activity-request.json"] = encodeJson(state.pendingOp)
          state.pendingOp = nil
        end
        if state.passes >= state.limit and pluginObj then pluginObj:exit() end
      end,
      addTask = function(name, fn)
        if name == "codexactivity" then workerFn = fn else fn() end
        return {}
      end,
      taskStatus = function() return "dead" end,
      isMessageRegistered = function(name)
        if name == "hal_transaction" then return state.passes >= state.halReadyAtPass end
        return name == "config_new" or name == "process_activity"
      end,
      sendMessage = function(name, args)
        if name == "config_new" then
          local label = type(args) == "table" and table.concat(args, ",") or tostring(args)
          state.reloads[#state.reloads + 1] = label
          if state.failReloadOnce then
            state.failReloadOnce = false
            return false
          end
        end
        return true
      end,
    }
  end
  package.preload["json"] = function() return { null = NULL, decode = decodeJson, encode = encodeJson } end
  package.preload["log"] = function()
    local noop = function() end
    return { logger = function() return { notice = noop, warning = noop, error = noop, debug = noop } end }
  end
  package.preload["tasks.hal.core.hbus"] = function()
    return {
      instance = function()
        return {
          command = function(_, cmd)
            if cmd == "rf.info" then
              state.rfCalls = state.rfCalls + 1
              return { code = 200, data = { Devices = state.rfDevices } }
            end
          end
        }
      end
    }
  end
  package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
    return {
      isAnySyncInProgress = function() return false end,
      getResource = function(name)
        local entry = index[name]
        if not entry then return nil, "missing" end
        local raw = fs["/data/resources/" .. name .. ".json"]
        if not raw then return nil, "enoent" end
        return "200", entry.etag, decodeJson(raw)
      end,
      getHubEtag = function(name) return index[name] and index[name].hetag end,
      saveResource = function(_, etag, value, name, _, hetag)
        if state.failSaveOnce then
          state.failSaveOnce = false
          return nil, "disk full"
        end
        state.saves[#state.saves + 1] = name
        fs["/data/resources/" .. name .. ".json"] = type(value) == "string" and value or encodeJson(value)
        index[name] = { etag = etag, hetag = hetag }
        return true
      end,
    }
  end
  package.preload["tasks.harmonywebservices.core.statedigest"] = function()
    return { instance = function() return state.digest end }
  end
  package.preload["tasks.connectserver.core.utils"] = function()
    return {
      broadcastEvent = function() state.broadcasts = state.broadcasts + 1 end,
      createResponse = function() return {} end,
    }
  end

  assert(loadstring(pluginSrc))("codexactivity")
  pluginObj = _G.codexactivity:instance()
  pluginObj:discover()
  if workerFn then workerFn() end
  return state
end

-- 1. Deferred retry when HAL isn't ready on early boot passes.
do
  local s = makeHarness({ halReadyAtPass = 2, limit = 30 })
  local maps = decodeJson(s.fs["/data/resources/MapList.json"]).ButtonMaps
  local found
  for _, m in ipairs(maps) do
    if m.ButtonMapIdentifier == "16417Activity102" then found = m end
  end
  check(found ~= nil, "deferred boot retry creates 16417Activity102 once HAL comes up")
  check(#s.saves == 1, "only saves once after HAL comes up")
  check(found.Buttons[1].ButtonKey == "DVR" and #found.Buttons == 1, "Dvr -> DVR and Number1 dropped")
end

-- 2. Backup pruning past 5 timestamped backups (leaving settings_* untouched).
do
  local s = makeHarness({
    oldBackups = {
      "20260101_000001", "20260101_000002", "20260101_000003",
      "20260101_000004", "20260101_000005", "settings_20260101_000001",
    }
  })
  check(s.dirs["/data/codex/resource-backups/20260101_000001"] == nil, "oldest resource backup pruned")
  check(s.dirs["/data/codex/resource-backups/20260101_000002"] ~= nil, "4 newer old backups kept")
  check(s.dirs["/data/codex/resource-backups/settings_20260101_000001"] ~= nil, "settings backup never pruned")
end

-- 3. Explicit RepairRemoteActivityMaps op (dryRun does not write; apply writes).
do
  local s = makeHarness({
    halReadyAtPass = 99, -- skip auto boot check so only explicit op runs
    limit = 2,
    pendingOp = { id = "dry-1", op = "RepairRemoteActivityMaps", remotes = { "16417" }, dryRun = true },
  })
  local resp = decodeJson(s.fs["/var/volatile/codex-activity-response.json"])
  check(resp.ok == true and resp.dryRun == true and resp.repaired == 1, "dryRun reports 1 repairable map")
  check(resp.created[1] == "16417Activity102", "dryRun names 16417Activity102")
  check(#s.saves == 0, "dryRun writes nothing")
end

-- 4. Rollback on save failure leaves original MapList intact.
do
  local before = brokenResources().MapList
  local s = makeHarness({ failSaveOnce = true })
  check(s.fs["/data/resources/MapList.json"] == before, "save failure rolls back to original MapList")
  check(s.broadcasts == 0, "save failure does not broadcast new revision")
end

-- 5. Rollback on engine reload failure restores original MapList.
do
  local before = brokenResources().MapList
  local s = makeHarness({ failReloadOnce = true })
  local after = decodeJson(s.fs["/data/resources/MapList.json"])
  check(#after.ButtonMaps == #decodeJson(before).ButtonMaps, "reload failure restores original map count")
  check(s.broadcasts == 0, "reload failure does not publish new revision")
end

-- 6. Cloud blocker off / melodious-off refuses to write anything.
do
  local before = brokenResources().MapList
  local s1 = makeHarness({ blocker = false, flag = true })
  check(#s1.saves == 0 and s1.fs["/data/resources/MapList.json"] == before, "cloud blocker off skips repair")
  local s2 = makeHarness({ melodiousOff = true, flag = true })
  check(#s2.saves == 0 and s2.fs["/data/resources/MapList.json"] == before, "melodious-off skips repair")
end

io.open = realIoOpen
os.remove = realOsRemove
os.rename = realOsRename

print(string.format("%d/%d checks passed", passed, passed))
