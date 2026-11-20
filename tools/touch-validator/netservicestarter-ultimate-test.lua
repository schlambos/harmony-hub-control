-- LuaJIT regression tests for #219: never-activated Harmony Ultimate (skin 100)
-- offline first sync on a FRESH_HUB_ACTIVATION hub, plus proof that Touch
-- (skin 99) and Elite/950 (skins 111/112) behaviour is unchanged.
--
-- Exercises payload/scripts/netservicestarter.lua directly against fixture
-- stubs modelled on re/luaworks (hub 4.15.600) and re/touch-fw (remote 4.15.330).
--
-- Run from the repo root:
--   luajit tools/touch-validator/netservicestarter-ultimate-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

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

local function noop() return nil end
local function anything()
  return setmetatable({}, { __index = function() return noop end })
end

-- Minimal JSON encoder + decoder sufficient for firmware/resource fixtures.
local function encode(v)
  local t = type(v)
  if t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t ~= "table" then return "null" end
  if #v > 0 or next(v) == nil then
    local parts = {}
    for i = 1, #v do parts[i] = encode(v[i]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do parts[#parts + 1] = encode(k) .. ":" .. encode(v[k]) end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function decodeJson(str)
  local pos = 1
  local function skip() pos = str:match("^%s*()", pos) end
  local parseVal
  local function parseStr()
    pos = pos + 1
    local out = {}
    while pos <= #str do
      local c = str:sub(pos, pos)
      if c == '"' then pos = pos + 1; return table.concat(out) end
      if c == "\\" then
        pos = pos + 1
        local esc = str:sub(pos, pos)
        if esc == "u" then
          local hex = str:sub(pos + 1, pos + 4)
          out[#out + 1] = string.char(tonumber(hex, 16) % 256)
          pos = pos + 5
        else
          local map = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', n = '\n', r = '\r', t = '\t' }
          out[#out + 1] = map[esc] or esc
          pos = pos + 1
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    error("unterminated string")
  end
  local function parseArr()
    pos = pos + 1
    local arr = {}
    skip()
    if str:sub(pos, pos) == "]" then pos = pos + 1; return arr end
    while true do
      skip()
      arr[#arr + 1] = parseVal()
      skip()
      local c = str:sub(pos, pos)
      if c == "]" then pos = pos + 1; return arr end
      assert(c == ",", "expected , in array at " .. pos)
      pos = pos + 1
    end
  end
  local function parseObj()
    pos = pos + 1
    local obj = {}
    skip()
    if str:sub(pos, pos) == "}" then pos = pos + 1; return obj end
    while true do
      skip()
      local k = parseStr()
      skip()
      assert(str:sub(pos, pos) == ":", "expected : at " .. pos)
      pos = pos + 1
      skip()
      obj[k] = parseVal()
      skip()
      local c = str:sub(pos, pos)
      if c == "}" then pos = pos + 1; return obj end
      assert(c == ",", "expected , in object at " .. pos)
      pos = pos + 1
    end
  end
  parseVal = function()
    skip()
    local c = str:sub(pos, pos)
    if c == '"' then return parseStr() end
    if c == "[" then return parseArr() end
    if c == "{" then return parseObj() end
    if str:sub(pos, pos + 3) == "true" then pos = pos + 4; return true end
    if str:sub(pos, pos + 4) == "false" then pos = pos + 5; return false end
    if str:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil end
    local num, nextPos = str:match("^(-?%d+%.?%d*)()", pos)
    assert(num, "bad json at " .. pos .. ": " .. str:sub(pos, pos + 20))
    pos = nextPos
    return tonumber(num)
  end
  return parseVal()
end

local realOs = os

local function loadEnv(opts)
  opts = opts or {}
  local env = {
    blocker = opts.blocker ~= nil and opts.blocker or "1",
    now = opts.now or 1792850000,
    files = opts.files or {},
    stored = opts.stored or {},
    handlers = {},
    nativeFwCalls = {},
    resSaves = {},
    digestSaves = 0,
    digest = {
      tz = "EST5EDT,M3.2.0,M11.1.0",
      stateVersion = opts.stateVersion or 55,
      configVersion = opts.configVersion or 55,
      isSetupComplete = opts.isSetupComplete == true,
      activitySetupState = false,
      syncStatus = 0,
    },
    pref = {
      mode = opts.mode,
      remoteId = opts.remoteId,
      accountId = opts.accountId,
      name = opts.name,
      email = opts.email,
      language = opts.language,
      save = noop,
    },
  }
  env.digest.saveStateDigest = function()
    env.digestSaves = env.digestSaves + 1
  end

  package.loaded["os"] = setmetatable({
    time = function(...)
      if select("#", ...) == 0 then return env.now end
      return realOs.time(...)
    end,
  }, { __index = realOs })

  for _, mod in ipairs({
    "system", "json", "log", "socket.http", "socket",
    "tasks.connectserver.core.engine", "tasks.connectserver.core.utils",
    "tasks.mfg.core.mfgdata", "tasks.hal.core.hbus",
    "tasks.harmonywebservices.core.preferencemanager",
    "tasks.harmonywebservices.core.resourcemanager",
    "tasks.harmonywebservices.core.statedigest",
    "tasks.harmonywebservices.core.session",
    "tasks.harmonywebservices.apihandler.resource",
    "tasks.setup.apihandler.sync",
    "tasks.setup.apihandler.firmware",
    "tasks.harmonyengine.apihandler.harmonyengine",
  }) do
    package.loaded[mod] = nil
  end

  package.preload["system"] = function()
    local s = anything()
    rawset(s, "io", {
      open = function(path)
        if env.files[path] ~= nil then
          local body = env.files[path]
          return {
            read = function() return body end,
            seek = function(_, whence) return whence == "end" and #body or 0 end,
            close = noop,
          }
        end
        if path == "/data/codex/cloud_blocker.conf" and env.blocker ~= nil then
          return { read = function() return env.blocker end, close = noop }
        end
        return nil
      end,
    })
    rawset(s, "getFirmwareVersion", function() return "4.15.600" end)
    rawset(s, "uuid", function() return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" end)
    return s
  end
  package.preload["json"] = function() return { encode = encode, decode = decodeJson, null = {} } end
  package.preload["log"] = function()
    local logger = { notice = noop, error = noop, warning = noop, debug = noop, info = noop }
    return { logger = function() return logger end }
  end
  package.preload["socket.http"] = function() return { request = noop } end
  package.preload["socket"] = function() return anything() end
  package.preload["tasks.hal.core.hbus"] = function() return { instance = function() return anything() end } end
  package.preload["tasks.connectserver.core.utils"] = function()
    return {
      createResponse = function(cmd, code, msg, data, identity, binary)
        return { cmd = cmd, code = code, msg = msg, data = data, identity = identity, binary = binary }
      end,
      fixHbusData = noop,
    }
  end
  package.preload["tasks.connectserver.core.engine"] = function()
    return { registerMessage = function(mime, _, fn) env.handlers[mime] = fn end }
  end
  package.preload["tasks.mfg.core.mfgdata"] = function() return { hasNetwork = false } end
  package.preload["tasks.harmonywebservices.core.preferencemanager"] = function() return env.pref end
  package.preload["tasks.harmonywebservices.core.statedigest"] = function()
    return { instance = function() return env.digest end }
  end
  package.preload["tasks.harmonywebservices.core.resourcemanager"] = function()
    return {
      getResource = function(name)
        local entry = env.stored[name]
        if not entry then return nil, "indexInfo not available for the resource " .. name end
        return "200", entry.etag, entry.resource
      end,
      getHubEtag = function(name) return env.stored[name] and env.stored[name].hetag end,
      getEtag = function(name) return env.stored[name] and env.stored[name].etag end,
      isAnySyncInProgress = function()
        if opts.syncCheckError then error("sync lookup failed") end
        return opts.syncing or false
      end,
      saveResource = function(mime, etag, body, name, _, hetag)
        if opts.failSave and opts.failSave[name] then
          return false, "disk full"
        end
        env.resSaves[#env.resSaves + 1] = {
          mime = mime, etag = etag, body = body, name = name, hetag = hetag
        }
        local decoded = type(body) == "string" and decodeJson(body) or body
        env.stored[name] = { etag = etag, hetag = hetag, resource = decoded, raw = body }
        env.files["/data/resources/" .. name .. ".json"] = type(body) == "string" and body or encode(body)
        return true
      end,
    }
  end
  package.preload["tasks.setup.apihandler.firmware"] = function()
    return {
      processCmdDefault = function(cmd, verb, params)
        env.nativeFwCalls[#env.nativeFwCalls + 1] = { cmd = cmd, verb = verb, params = params }
        return { cmd = cmd, code = "506", msg = '["Wi-Fi is not available"]', native = true }
      end,
    }
  end
  for _, name in ipairs({
    "tasks.harmonywebservices.apihandler.resource",
    "tasks.setup.apihandler.sync",
    "tasks.harmonywebservices.core.session",
    "tasks.harmonyengine.apihandler.harmonyengine",
  }) do
    package.preload[name] = function() return anything() end
  end

  local chunk = assert(loadfile(repoRoot .. "/payload/scripts/netservicestarter.lua"))
  chunk()
  return env
end

-- Exact replica of the remote's firmwareCheckCallback decision tree from
-- re/touch-fw appscommon/harmony.lua:5332-5388.
local function simulateRemoteFirmwareCallback(susReply, fwReply)
  local remoteData = susReply and susReply.data or nil
  local hubData = fwReply and (type(fwReply.data) == "string" and decodeJson(fwReply.data) or fwReply.data) or nil
  if not remoteData or not hubData then
    return "aborted"
  end
  if not remoteData.canUpdateOta and not hubData.canUpdateOta then
    if remoteData.isCritical == true and remoteData.canUpdateOta == false then
      return "myharmony_screen"
    end
    if remoteData.status == 0 and hubData.status == 0 then
      return "resync_auto"
    end
    return "stalled"
  end
  return "ota_branch"
end

-- 1. Never-activated Harmony Ultimate (skin 100) on a FRESH_HUB_ACTIVATION hub:
--    has ActivityList/DeviceList/MapList/FunctionList/ProtocolList/AutomationConfig,
--    no Context/Settings/CapabilityList, isSetupComplete=false, mode=3.
local fresh = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local-20261111",
  name = "Hub 2",
  email = "hub2@local",
  language = "en",
  isSetupComplete = false,
  stored = {
    ActivityList = { etag = '"a1"', hetag = "1", resource = { Activities = {} } },
    DeviceList = { etag = '"d1"', hetag = "1", resource = { DevicesWithFeatures = {} } },
    MapList = { etag = '"m1"', hetag = "1", resource = { ButtonMaps = {} } },
    FunctionList = { etag = '"f1"', hetag = "1", resource = { FunctionMaps = {} } },
    ProtocolList = { etag = '"p1"', hetag = "1", resource = { Protocols = {} } },
    AutomationConfig = { etag = '"ac1"', hetag = "1", resource = { id = "20264150" } },
  },
})

check("fresh mode-3 hub: statedigest isSetupComplete is flipped to true and persisted",
  fresh.digest.isSetupComplete == true and fresh.digestSaves == 1,
  "isSetupComplete=" .. tostring(fresh.digest.isSetupComplete) .. " saves=" .. tostring(fresh.digestSaves))

check("fresh mode-3 hub: Context seeded with SetupSession.Type=0 and hyphenated Language",
  fresh.stored.Context ~= nil and
  type(fresh.stored.Context.resource.SetupSession) == "table" and
  fresh.stored.Context.resource.SetupSession.Type == 0 and
  fresh.stored.Context.resource.Language == "en-US" and
  type(fresh.stored.Context.resource["HouseholdId-"]) == "number" and
  fresh.stored.Context.resource["HouseholdId-"] > 0,
  encode(fresh.stored.Context and fresh.stored.Context.resource))

check("fresh mode-3 hub: Settings seeded so remote syncJuniperWithHub does not 404",
  fresh.stored.Settings ~= nil and
  type(fresh.stored.Settings.resource.Settings) == "table" and
  #fresh.stored.Settings.resource.Settings >= 10,
  encode(fresh.stored.Settings))

check("fresh mode-3 hub: CapabilityList seeded on disk for hot.1.data.resource",
  fresh.stored.CapabilityList ~= nil and
  fresh.files["/data/resources/CapabilityList.json"] == '{"MaxActivities":null,"Capabilities":[]}',
  tostring(fresh.files["/data/resources/CapabilityList.json"]))

local getResource = fresh.handlers["proxy.resource?get"]
local fwCheck = fresh.handlers["setup.firmware?check"]
check("setup.firmware?check guard is registered while other firmware commands remain stock",
  type(fwCheck) == "function" and
  fresh.handlers["setup.firmware"] == nil and
  fresh.handlers["harmony.firmware"] == nil)

if type(fwCheck) == "function" then
  -- Exact Ultimate (skin 100) handshake: sus://product/100/... then setup.firmware?check.
  local ultSus = getResource("proxy.resource?get", nil, {
    uri = "sus://product/100/unit/UNIT100/image/latest/SysBuild=4.15.330",
  })
  check("Ultimate (skin 100) sus:// returns stock no-update packageInfo (status=0, no canUpdateOta/isCritical)",
    ultSus.code == "200" and type(ultSus.data) == "table" and
    ultSus.data.status == 0 and ultSus.data.name == "base" and
    ultSus.data.productId == "100" and ultSus.data.currentVersion == "4.15.330" and
    ultSus.data.canUpdateOta == nil and ultSus.data.isCritical == nil,
    encode(ultSus))

  local ultFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  local ultFwBody = type(ultFw.data) == "string" and decodeJson(ultFw.data) or nil
  check("Ultimate (skin 100) setup.firmware?check returns stock no-update JSON (status=0, packages={})",
    ultFw.code == "200" and type(ultFwBody) == "table" and
    ultFwBody.status == 0 and ultFwBody.currentVersion == "4.15.600" and
    ultFw.data:find('"packages":{}', 1, true) ~= nil and #fresh.nativeFwCalls == 0,
    encode(ultFw))

  check("Ultimate remote firmwareCheckCallback proceeds directly to resync('auto') (no myharmony trap)",
    simulateRemoteFirmwareCallback(ultSus, ultFw) == "resync_auto",
    simulateRemoteFirmwareCallback(ultSus, ultFw))

  -- Verify all 9 resources pulled by syncJuniperWithHub succeed (InstallerInfo 404 is stock-optional).
  local pullUris = {
    { uri = "harmony://Account/hub2-local-20261111/ActivityList", expect = "200" },
    { uri = "harmony://Account/hub2-local-20261111/DeviceList", expect = "200" },
    { uri = "harmony://Account/hub2-local-20261111/MapList?excludeFunctionMaps=true", expect = "200" },
    { uri = "harmony://Remote/20264150/Context", expect = "200" },
    { uri = "harmony://Account/hub2-local-20261111/Remote/20264150/Settings", expect = "200" },
    { uri = "dynamite://HomeAutomationService/Config/harmony://Account/hub2-local-20261111", expect = "200" },
    { uri = "harmony://Account/hub2-local-20261111/ProtocolList", expect = "200" },
    { uri = "harmony://Account/hub2-local-20261111/InstallerInfo", expect = "404" },
    { uri = "harmony://Account/hub2-local-20261111/CapabilityList", expect = "200" },
  }
  local allPullOk = true
  for _, item in ipairs(pullUris) do
    local reply = getResource("proxy.resource?get", nil, { uri = item.uri })
    if not (reply and reply.code == "200" and reply.data and reply.data.code == item.expect) then
      allPullOk = false
      print("  pull mismatch for " .. item.uri .. ": " .. encode(reply))
    end
  end
  check("all 9 resources pulled by Ultimate setup.sync?begin resolve as expected", allPullOk)

  -- Single-use token: a second setup.firmware?check without a new skin-100 sus:// falls back to stock.
  local secondFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  check("second setup.firmware?check without fresh skin-100 sus:// defers to stock handler",
    secondFw.native == true and secondFw.code == "506" and #fresh.nativeFwCalls == 1,
    encode(secondFw))

  -- Touch (skin 99) behaviour MUST NOT change: sus:// -> 304, setup.firmware?check -> stock 506!
  local touchSus = getResource("proxy.resource?get", nil, {
    uri = "sus://product/99/unit/TOUCH99/image/latest/SysBuild=4.15.330",
  })
  check("Touch (skin 99) sus:// unchanged: still bare 304",
    touchSus.code == "200" and touchSus.data.code == "304" and touchSus.data.status == nil,
    encode(touchSus))
  local touchFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  check("Touch (skin 99) setup.firmware?check unchanged: defers to stock handler (506)",
    touchFw.native == true and touchFw.code == "506" and #fresh.nativeFwCalls == 2,
    encode(touchFw))

  -- Elite (skin 111) and 950 (skin 112) behaviour MUST NOT change!
  for _, skin in ipairs({ "111", "112" }) do
    local s = getResource("proxy.resource?get", nil, {
      uri = "sus://product/" .. skin .. "/unit/U" .. skin .. "/image/latest/SysBuild=4.15.330",
    })
    check("Elite/950 (skin " .. skin .. ") sus:// unchanged: still bare 304",
      s.code == "200" and s.data.code == "304" and s.data.status == nil, encode(s))
    local before = #fresh.nativeFwCalls
    local f = fwCheck("setup.firmware?check", "check", { package = { "base" } })
    check("Elite/950 (skin " .. skin .. ") setup.firmware?check unchanged: defers to stock handler",
      f.native == true and f.code == "506" and #fresh.nativeFwCalls == before + 1, encode(f))
  end

  -- Interleaving: Ultimate sus:// followed by Touch sus:// cancels the Ultimate token!
  getResource("proxy.resource?get", nil, { uri = "sus://product/100/unit/U100/image/latest/SysBuild=4.15.330" })
  getResource("proxy.resource?get", nil, { uri = "sus://product/99/unit/U99/image/latest/SysBuild=4.15.330" })
  local before = #fresh.nativeFwCalls
  local afterInterleave = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  check("Touch sus:// clears a pending Ultimate token so Touch still gets stock 506",
    afterInterleave.native == true and #fresh.nativeFwCalls == before + 1, encode(afterInterleave))

  -- Expired window (> 60s): falls back to stock.
  getResource("proxy.resource?get", nil, { uri = "sus://product/100/unit/U100/image/latest/SysBuild=4.15.330" })
  fresh.now = fresh.now + 61
  before = #fresh.nativeFwCalls
  local expiredFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  check("expired Ultimate sus:// token (>60s) defers to stock handler",
    expiredFw.native == true and #fresh.nativeFwCalls == before + 1, encode(expiredFw))

  -- Cloud blocker OFF: defers to stock even for skin 100.
  fresh.blocker = "0"
  getResource("proxy.resource?get", nil, { uri = "sus://product/100/unit/U100/image/latest/SysBuild=4.15.330" })
  before = #fresh.nativeFwCalls
  local blockerOffFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
  check("cloud blocker off: setup.firmware?check defers to stock handler",
    blockerOffFw.native == true and #fresh.nativeFwCalls == before + 1, encode(blockerOffFw))

  -- Reviewer finding 1: other remote resource -> Ultimate resource -> other remote fw check -> Ultimate fw check
  -- on the same/unspecified peer must NEVER give Touch (99), Elite (111), or 950 (112) the Ultimate's 200!
  fresh.blocker = "1"
  for _, skin in ipairs({ "99", "111", "112" }) do
    fresh.now = fresh.now + 120
    local otherSus = getResource("proxy.resource?get", nil, {
      uri = "sus://product/" .. skin .. "/unit/OTHER" .. skin .. "/image/latest/SysBuild=4.15.330",
    })
    local ultSus2 = getResource("proxy.resource?get", nil, {
      uri = "sus://product/100/unit/ULT100/image/latest/SysBuild=4.15.330",
    })
    local beforeOther = #fresh.nativeFwCalls
    local otherFw = fwCheck("setup.firmware?check", "check", { package = { "base" } })
    local ultFw2 = fwCheck("setup.firmware?check", "check", { package = { "base" } })
    check("ambiguous interleave (skin " .. skin .. " then 100, shared peer): skin " .. skin .. " gets stock 506",
      otherSus.data.code == "304" and ultSus2.data.status == 0 and
      otherFw.native == true and otherFw.code == "506" and
      ultFw2.native == true and ultFw2.code == "506" and
      #fresh.nativeFwCalls == beforeOther + 2,
      "other=" .. encode(otherFw) .. " ult=" .. encode(ultFw2))
  end

  -- Distinct clientId peers: Touch (c99) and Ultimate (c100) do not interfere with each other.
  fresh.now = fresh.now + 120
  getResource("proxy.resource?get", nil, {
    clientId = "c99",
    uri = "sus://product/99/unit/TOUCH99/image/latest/SysBuild=4.15.330",
  })
  getResource("proxy.resource?get", nil, {
    clientId = "c100",
    uri = "sus://product/100/unit/ULT100/image/latest/SysBuild=4.15.330",
  })
  local beforePeers = #fresh.nativeFwCalls
  local peerTouchFw = fwCheck("setup.firmware?check", "check", { clientId = "c99", package = { "base" } })
  local peerUltFw = fwCheck("setup.firmware?check", "check", { clientId = "c100", package = { "base" } })
  check("distinct clientId peers: Touch gets stock 506 while Ultimate gets 200 status=0",
    peerTouchFw.native == true and peerTouchFw.code == "506" and
    peerUltFw.code == "200" and peerUltFw.native == nil and
    #fresh.nativeFwCalls == beforePeers + 1,
    "touch=" .. encode(peerTouchFw) .. " ult=" .. encode(peerUltFw))
end

-- 2. Already-activated hub (Touch/Elite/950): Context, Settings, CapabilityList
--    and isSetupComplete=true already exist -> ZERO resources written, ZERO digest writes!
local activated = loadEnv({
  mode = 3,
  remoteId = 13279029,
  accountId = "13279029",
  isSetupComplete = true,
  stored = {
    AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} },
    Context = { etag = '"ctx"', hetag = "1", resource = { SetupSession = { Type = 0 } } },
    Settings = { etag = '"set"', hetag = "1", resource = { Settings = {} } },
    CapabilityList = { etag = '"cap"', hetag = "1", resource = { Capabilities = {} } },
  },
})
check("already-activated Touch/Elite hub: boot writes 0 resources and 0 digest saves",
  #activated.resSaves == 0 and activated.digestSaves == 0 and activated.digest.isSetupComplete == true,
  "resSaves=" .. #activated.resSaves .. " digestSaves=" .. activated.digestSaves)

-- 3. Hub where user already placed Context.json (like @jrx-code's experiment)
--    but Settings/CapabilityList are absent and isSetupComplete is still false:
--    existing Context is never overwritten, missing Settings/CapabilityList are
--    seeded, and isSetupComplete flips to true.
local partial = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local",
  isSetupComplete = false,
  files = {
    ["/data/resources/Context.json"] = '{"HouseholdId-":777}',
  },
  stored = {
    AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} },
    Context = { etag = '"user-ctx"', hetag = "2", resource = { ["HouseholdId-"] = 777 } },
  },
})
check("partial hub with existing Context: Context untouched, Settings + CapabilityList seeded, isSetupComplete=true",
  partial.stored.Context.etag == '"user-ctx"' and
  partial.stored.Settings ~= nil and
  partial.stored.CapabilityList ~= nil and
  partial.digest.isSetupComplete == true and partial.digestSaves == 1,
  "saves=" .. #partial.resSaves .. " isSetupComplete=" .. tostring(partial.digest.isSetupComplete))

-- 4. Reviewer finding 2: save failure must NOT mark isSetupComplete=true.
local saveFail = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local",
  isSetupComplete = false,
  failSave = { CapabilityList = true },
  stored = { AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} } },
})
check("save failure on required resource: does NOT mark isSetupComplete=true",
  saveFail.digest.isSetupComplete == false and saveFail.digestSaves == 0,
  "isSetupComplete=" .. tostring(saveFail.digest.isSetupComplete) .. " digestSaves=" .. saveFail.digestSaves)

-- 5. Reviewer finding 2: sync-status lookup error must fail closed (no writes, no isSetupComplete).
local syncErr = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local",
  isSetupComplete = false,
  syncCheckError = true,
  stored = { AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} } },
})
check("sync-status lookup error: fails closed with 0 resource writes and isSetupComplete=false",
  #syncErr.resSaves == 0 and syncErr.digest.isSetupComplete == false and syncErr.digestSaves == 0,
  "resSaves=" .. #syncErr.resSaves .. " isSetupComplete=" .. tostring(syncErr.digest.isSetupComplete))

-- 6. Reviewer finding 2: orphan disk file (not readable via getResource) is preserved,
--    AND does NOT mark isSetupComplete=true.
local orphanFile = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local",
  isSetupComplete = false,
  files = { ["/data/resources/Context.json"] = '{"user":true}' },
  stored = { AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} } },
})
check("orphan disk Context.json without indexed resource: preserved, isSetupComplete stays false",
  orphanFile.files["/data/resources/Context.json"] == '{"user":true}' and
  orphanFile.stored.Context == nil and
  orphanFile.digest.isSetupComplete == false and orphanFile.digestSaves == 0,
  "isSetupComplete=" .. tostring(orphanFile.digest.isSetupComplete))

-- 7. Reviewer finding 2: indexed CapabilityList without disk copy is NOT marked complete.
local noDiskCopy = loadEnv({
  mode = 3,
  remoteId = 20264150,
  accountId = "hub2-local",
  isSetupComplete = false,
  stored = {
    AutomationConfig = { etag = '"ac"', hetag = "1", resource = {} },
    CapabilityList = { etag = '"cap"', hetag = "1", resource = { Capabilities = {} } },
  },
})
check("indexed CapabilityList missing disk copy: preserved, isSetupComplete stays false",
  noDiskCopy.digest.isSetupComplete == false and noDiskCopy.digestSaves == 0,
  "isSetupComplete=" .. tostring(noDiskCopy.digest.isSetupComplete))

print(string.format("%d/%d checks passed", count - failures, count))
if failures > 0 then os.exit(1) end
