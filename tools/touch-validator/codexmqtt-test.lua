-- LuaJIT tests for the MQTT / Home Assistant discovery bridge in
-- payload/mqtt/codexmqtt.lua.
--
-- Stubs the hub modules (socket, system, json, log, engine, session,
-- statedigest) and runs mqttLoop inside a Lua coroutine so sleeps, clock ticks,
-- file changes and raw MQTT wire frames execute deterministically in memory.
-- No hub or broker is contacted and nothing is written to disk.
--
-- Run from the repo root:
--   luajit tools/touch-validator/codexmqtt-test.lua

local scriptDir = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local repoRoot = scriptDir .. "../.."

local NULL = setmetatable({}, { __tostring = function() return "null" end })

local function encodeJson(value)
  if value == NULL or value == nil then return "null" end
  local kind = type(value)
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then
    if value == math.floor(value) then return string.format("%d", value) end
    return tostring(value)
  end
  if kind == "string" then
    return '"' .. value:gsub('[%c"\\]', function(c)
      local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return map[c] or string.format("\\u%04x", c:byte())
    end) .. '"'
  end
  local n = 0
  for _ in pairs(value) do n = n + 1 end
  if n == 0 then return "[]" end
  local isArr = true
  for i = 1, n do
    if value[i] == nil then isArr = false break end
  end
  if isArr then
    local parts = {}
    for i = 1, n do parts[i] = encodeJson(value[i]) end
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
  assert(type(text) == "string" and #text > 0, "empty json")
  local pos = 1
  local parseValue
  local function skipWs()
    while pos <= #text and text:sub(pos, pos):match("%s") do pos = pos + 1 end
  end
  local function parseString()
    assert(text:sub(pos, pos) == '"', "expected string at " .. pos)
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
        assert(text:sub(pos, pos) == ":", "expected ':'")
        pos = pos + 1
        obj[key] = parseValue()
        skipWs()
        local sep = text:sub(pos, pos)
        if sep == "}" then pos = pos + 1 return obj end
        assert(sep == ",", "expected ',' or '}'")
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
        local sep = text:sub(pos, pos)
        if sep == "]" then pos = pos + 1 return arr end
        assert(sep == ",", "expected ',' or ']'")
        pos = pos + 1
      end
    elseif c == '"' then
      return parseString()
    elseif text:sub(pos, pos + 3) == "true" then
      pos = pos + 4
      return true
    elseif text:sub(pos, pos + 4) == "false" then
      pos = pos + 5
      return false
    elseif text:sub(pos, pos + 3) == "null" then
      pos = pos + 4
      return NULL
    else
      local num = text:match("^%-?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
      assert(num and #num > 0, "invalid json token at " .. pos)
      pos = pos + #num
      return assert(tonumber(num))
    end
  end
  local result = parseValue()
  skipWs()
  assert(pos == #text + 1, "trailing json characters")
  return result
end

-- MQTT wire frame helpers for driving and inspecting codexmqtt's socket ------
local function u16(n)
  return string.char(math.floor(n / 256) % 256, n % 256)
end

local function utf(s)
  s = tostring(s or "")
  return u16(#s) .. s
end

local function remLen(n)
  local out = ""
  repeat
    local digit = n % 128
    n = math.floor(n / 128)
    if n > 0 then digit = digit + 128 end
    out = out .. string.char(digit)
  until n == 0
  return out
end

local function mqttPacket(headerByte, body)
  return string.char(headerByte) .. remLen(#body) .. body
end

local function makeConnack(returnCode)
  return mqttPacket(0x20, string.char(0, returnCode or 0))
end

local function makeIncomingPublish(topic, payload, opts)
  opts = opts or {}
  local qos = opts.qos or 0
  local retain = opts.retain and 1 or 0
  local flags = qos * 2 + retain
  local body = utf(topic)
  if qos > 0 then
    body = body .. u16(opts.pktId or 7)
  end
  body = body .. tostring(payload or "")
  return mqttPacket(0x30 + flags, body)
end

local function parseMqttStream(raw)
  local pkts = {}
  local i = 1
  while i <= #raw do
    local b1 = raw:byte(i)
    i = i + 1
    local mult, len = 1, 0
    repeat
      local digit = raw:byte(i)
      i = i + 1
      len = len + (digit % 128) * mult
      mult = mult * 128
    until digit < 128
    local body = raw:sub(i, i + len - 1)
    i = i + len
    local kind = math.floor(b1 / 16)
    local flags = b1 % 16
    local entry = { kind = kind, flags = flags, rawBody = body }
    if kind == 1 then -- CONNECT
      local pLen = body:byte(1) * 256 + body:byte(2)
      entry.protocol = body:sub(3, 2 + pLen)
      local vhPos = 3 + pLen
      entry.level = body:byte(vhPos)
      entry.connectFlags = body:byte(vhPos + 1)
      entry.keepAlive = body:byte(vhPos + 2) * 256 + body:byte(vhPos + 3)
      local p = vhPos + 4
      local function readStr()
        local l = body:byte(p) * 256 + body:byte(p + 1)
        local s = body:sub(p + 2, p + 1 + l)
        p = p + 2 + l
        return s
      end
      entry.clientId = readStr()
      if math.floor(entry.connectFlags / 4) % 2 == 1 then
        entry.willTopic = readStr()
        entry.willPayload = readStr()
        entry.willRetain = math.floor(entry.connectFlags / 32) % 2 == 1
      end
      if math.floor(entry.connectFlags / 128) % 2 == 1 then
        entry.username = readStr()
      end
      if math.floor(entry.connectFlags / 64) % 2 == 1 then
        entry.password = readStr()
      end
    elseif kind == 3 then -- PUBLISH
      local tLen = body:byte(1) * 256 + body:byte(2)
      entry.topic = body:sub(3, 2 + tLen)
      local pos = 3 + tLen
      local qos = math.floor(flags / 2) % 4
      if qos > 0 then pos = pos + 2 end
      entry.payload = body:sub(pos)
      entry.retain = (flags % 2) == 1
    elseif kind == 8 then -- SUBSCRIBE
      entry.pktId = body:byte(1) * 256 + body:byte(2)
      entry.topics = {}
      local p = 3
      while p <= #body do
        local l = body:byte(p) * 256 + body:byte(p + 1)
        local t = body:sub(p + 2, p + 1 + l)
        local q = body:byte(p + 2 + l)
        entry.topics[#entry.topics + 1] = { topic = t, qos = q }
        p = p + 3 + l
      end
    end
    pkts[#pkts + 1] = entry
  end
  return pkts
end

-- In-memory hub state & module stubs -----------------------------------------
local hub = {
  files = {},
  nowSec = 1763000000,
  nowMs = 100000,
  ip = "192.168.1.50",
  hostname = "Harmony-Test",
  firmware = "4.15.600",
  account = nil,
  digest = { activityId = "-1", activityStatus = 0, stateVersion = 1 },
  engineCalls = {},
  engineReply = { code = 200, msg = "OK" },
  broadcasts = {},
  sockets = {},
  nextConnackCode = 0,
  connectFails = false,
  tasks = {},
}

local realIo = io
local realOs = os

io = setmetatable({
  open = function(path, mode)
    mode = mode or "r"
    if mode == "r" then
      local content = hub.files[path]
      if content == nil then return nil end
      local cursor = 1
      return {
        read = function(_, fmt)
          if fmt == "*a" then
            local rest = content:sub(cursor)
            cursor = #content + 1
            return rest
          end
          return content
        end,
        seek = function(_, whence)
          if whence == "end" then
            cursor = #content + 1
            return #content
          end
          return cursor - 1
        end,
        close = function() end,
      }
    elseif mode == "a" or mode == "w" then
      local buf = mode == "a" and (hub.files[path] or "") or ""
      return {
        write = function(_, ...)
          for i = 1, select("#", ...) do
            buf = buf .. tostring(select(i, ...))
          end
        end,
        close = function()
          hub.files[path] = buf
        end,
      }
    end
    return realIo.open(path, mode)
  end,
}, { __index = realIo })

os = setmetatable({
  time = function(...)
    if select("#", ...) == 0 then return hub.nowSec end
    return realOs.time(...)
  end,
  remove = function(path)
    hub.files[path] = nil
    return true
  end,
  rename = function(oldPath, newPath)
    hub.files[newPath] = hub.files[oldPath]
    hub.files[oldPath] = nil
    return true
  end,
}, { __index = realOs })

package.preload["socket"] = function()
  return {
    tcp = function()
      local s = {
        connectedHost = nil,
        connectedPort = nil,
        closed = false,
        timeout = nil,
        tx = "",
        rx = "",
      }
      function s:settimeout(t) self.timeout = t end
      function s:connect(host, port)
        if hub.connectFails then
          return nil, "connection refused"
        end
        self.connectedHost = host
        self.connectedPort = port
        self.rx = self.rx .. makeConnack(hub.nextConnackCode)
        return 1
      end
      function s:send(data)
        if self.closed then return nil, "closed" end
        self.tx = self.tx .. data
        return #data
      end
      function s:receive(n)
        if self.closed then return nil, "closed" end
        if #self.rx < n then
          return nil, "timeout"
        end
        local chunk = self.rx:sub(1, n)
        self.rx = self.rx:sub(n + 1)
        return chunk
      end
      function s:close()
        self.closed = true
      end
      hub.sockets[#hub.sockets + 1] = s
      return s
    end,
  }
end

package.preload["system"] = function()
  return {
    safeCall = function(fn, ...) return pcall(fn, ...) end,
    jiffies = function()
      return { tomillis = function() return hub.nowMs end }
    end,
    getFirmwareVersion = function() return hub.firmware end,
    getHostName = function() return hub.hostname end,
    getNetworkAttribute = function(key)
      if key == "ipaddr" then return hub.ip end
      return nil
    end,
    broadcastMessage = function(name, payload)
      hub.broadcasts[#hub.broadcasts + 1] = { name = name, payload = payload }
    end,
    addTask = function(name, fn)
      local co = coroutine.create(fn)
      local handle = { name = name, co = co }
      hub.tasks[#hub.tasks + 1] = handle
      return handle
    end,
    taskStatus = function(handle)
      if not handle or not handle.co then return "dead" end
      return coroutine.status(handle.co)
    end,
    sleep = function(ms)
      coroutine.yield("sleep", ms)
    end,
  }
end

package.preload["json"] = function()
  return { encode = encodeJson, decode = decodeJson, null = NULL }
end

package.preload["log"] = function()
  local noop = function() end
  local logger = { notice = noop, warning = noop, error = noop, info = noop, debug = noop }
  return { logger = function() return logger end }
end

package.preload["tasks.connectserver.core.engine"] = function()
  return {
    processMessage = function(msg)
      hub.engineCalls[#hub.engineCalls + 1] = msg
      return true, hub.engineReply
    end,
  }
end

package.preload["tasks.harmonywebservices.core.session"] = function()
  return {
    getAccount = function() return hub.account end,
  }
end

package.preload["tasks.harmonywebservices.core.statedigest"] = function()
  return {
    instance = function() return hub.digest end,
  }
end

local chunk = assert(loadfile(repoRoot .. "/payload/mqtt/codexmqtt.lua"))
chunk("codexmqtt")
local plugin = assert(package.loaded["codexmqtt"]):instance()

-- Test helpers ---------------------------------------------------------------
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

local function stepTask(handle)
  handle = handle or hub.tasks[#hub.tasks]
  assert(handle and coroutine.status(handle.co) ~= "dead", "no live mqtt task")
  local ok, why, ms = coroutine.resume(handle.co)
  assert(ok, tostring(why))
  return why, ms
end

local function resetState()
  if hub.tasks[#hub.tasks] and coroutine.status(hub.tasks[#hub.tasks].co) ~= "dead" then
    plugin:exit()
    for _ = 1, 8 do
      if coroutine.status(hub.tasks[#hub.tasks].co) == "dead" then break end
      coroutine.resume(hub.tasks[#hub.tasks].co)
    end
  end
  hub.files = {}
  hub.nowSec = 1763000000
  hub.nowMs = 100000
  hub.ip = "192.168.1.50"
  hub.hostname = "Harmony-Test"
  hub.firmware = "4.15.600"
  hub.account = {
    currentActivityId = "-1",
    activities = {
      ["102"] = { label = "Listen to Music", activityOrder = 2 },
      ["101"] = { label = "Watch Movie", activityOrder = 1 },
      ["-1"] = { label = "PowerOff", activityOrder = 0 },
    },
    devices = {
      ["201"] = {
        commands = { PowerOn = {}, PowerOff = {}, VolumeUp = {} },
      },
      ["202"] = {
        commands = { Play = {}, Pause = {} },
      },
    },
  }
  hub.digest.activityId = "-1"
  hub.digest.activityStatus = 0
  hub.digest.stateVersion = 1
  hub.engineCalls = {}
  hub.broadcasts = {}
  hub.sockets = {}
  hub.nextConnackCode = 0
  hub.connectFails = false
  hub.tasks = {}
end

local function publishedByTopic(sock)
  local map = {}
  local list = {}
  for _, p in ipairs(parseMqttStream(sock.tx)) do
    if p.kind == 3 then
      map[p.topic] = p
      list[#list + 1] = p
    end
  end
  return map, list
end

-- 1. Melodious-off, disabled and missing-broker handling ---------------------
resetState()
hub.files["/etc/melodious-off"] = "1\n"
local offDiscovered = plugin:discover()
check("melodious-off: discover returns empty and spawns no task",
  next(offDiscovered) == nil and #hub.tasks == 0 and #hub.sockets == 0)
check("melodious-off: pair returns false and status reports stopped",
  plugin:pair("codex-mqtt", {}) == false and plugin:status().state == "stopped")

resetState()
local discovered = plugin:discover()
check("discover registers codex-mqtt gateway and starts worker task",
  type(discovered["codex-mqtt"]) == "table" and
    discovered["codex-mqtt"].type == "codexmqtt" and
    #hub.tasks == 1 and plugin:status().state == "running")

-- Missing config.json: disabled, no socket, still services reload_resources.
hub.files["/data/codex/reload_resources"] = "DeviceList ActivityList UnknownThing\n"
local _, sleepMs = stepTask()
check("missing config: sleeps without opening a broker socket",
  sleepMs == 1000 and #hub.sockets == 0)
check("disabled loop still processes reload_resources and removes flag",
  hub.files["/data/codex/reload_resources"] == nil and
    #hub.broadcasts == 1 and hub.broadcasts[1].name == "config_new" and
    #hub.broadcasts[1].payload == 2 and
    hub.broadcasts[1].payload[1] == "DeviceList" and
    hub.broadcasts[1].payload[2] == "ActivityList")

-- Enabled without broker.host: still disabled, zero sockets.
resetState()
hub.files["/data/codexmqtt/config.json"] = encodeJson({
  enabled = true,
  broker = { port = 1883 },
})
plugin:discover()
stepTask()
check("missing broker.host: does not open a broker socket", #hub.sockets == 0)

-- Invalid JSON in config.json: treated as disabled, zero sockets.
resetState()
hub.files["/data/codexmqtt/config.json"] = "{broken json"
plugin:discover()
stepTask()
check("invalid config JSON: treated as disabled without crashing", #hub.sockets == 0)

-- Explicit enabled = false with broker.host present: zero sockets.
resetState()
hub.files["/data/codexmqtt/config.json"] = encodeJson({
  enabled = false,
  broker = { host = "192.168.1.10", port = 1883 },
})
plugin:discover()
stepTask()
check("enabled=false with broker host: does not connect", #hub.sockets == 0)

-- Connection failure backs off 15 s and closes the failed socket cleanly.
resetState()
hub.connectFails = true
hub.files["/data/codexmqtt/config.json"] = encodeJson({
  enabled = true,
  broker = { host = "192.168.1.10", port = 1883 },
})
plugin:discover()
local _, retrySleep = stepTask()
check("broker connect failure closes socket and sleeps 15s before retry",
  #hub.sockets == 1 and hub.sockets[1].closed == true and retrySleep == 15000)

-- 2. HA MQTT discovery payload generation & initial state/subscriptions ------
resetState()
hub.files["/data/codexmqtt/config.json"] = encodeJson({
  enabled = true,
  name = "Living Room Hub",
  clientId = "Living Room Hub!",
  baseTopic = "harmony/living",
  discoveryPrefix = "homeassistant",
  keepAlive = 60,
  pollSeconds = 10,
  duplicateWindowMs = 3000,
  broker = {
    host = "192.168.1.10",
    port = 1883,
    username = "mqttuser",
    password = "mqttpass",
  },
})
plugin:discover()
stepTask() -- connects, sends CONNECT + status + discovery + initial state + SUBSCRIBE + first poll

check("opens TCP connection to configured broker host and port",
  #hub.sockets == 1 and hub.sockets[1].connectedHost == "192.168.1.10" and
    hub.sockets[1].connectedPort == 1883)

local sock = hub.sockets[1]
local wirePkts = parseMqttStream(sock.tx)
local connectPkt = wirePkts[1]
check("sends MQTT 3.1.1 CONNECT with auth and retained offline LWT",
  connectPkt and connectPkt.kind == 1 and connectPkt.protocol == "MQTT" and
    connectPkt.level == 4 and connectPkt.clientId == "Living Room Hub!" and
    connectPkt.willTopic == "harmony/living/status" and
    connectPkt.willPayload == "offline" and connectPkt.willRetain == true and
    connectPkt.username == "mqttuser" and connectPkt.password == "mqttpass")

local pubByTopic = publishedByTopic(sock)
check("publishes retained online availability status",
  pubByTopic["harmony/living/status"] ~= nil and
    pubByTopic["harmony/living/status"].payload == "online" and
    pubByTopic["harmony/living/status"].retain == true)

local ident = "living_room_hub_"
local selectPkt = pubByTopic["homeassistant/select/" .. ident .. "_activity/config"]
check("publishes retained HA discovery config for Activity selector",
  selectPkt ~= nil and selectPkt.retain == true)
local selectCfg = selectPkt and decodeJson(selectPkt.payload) or {}
check("Activity selector has ordered options starting with PowerOff",
  type(selectCfg.options) == "table" and #selectCfg.options == 3 and
    selectCfg.options[1] == "PowerOff" and
    selectCfg.options[2] == "Watch Movie" and
    selectCfg.options[3] == "Listen to Music" and
    selectCfg.command_topic == "harmony/living/activity/set" and
    selectCfg.state_topic == "harmony/living/state" and
    selectCfg.availability_topic == "harmony/living/status" and
    selectCfg.device.name == "Living Room Hub" and
    selectCfg.device.configuration_url == "http://192.168.1.50:8080/",
  selectPkt and selectPkt.payload)

local expectedSensors = {
  { suffix = "_activity_id", name = "Activity ID", tpl = "{{ value_json.activityId }}" },
  { suffix = "_ip", name = "IP Address", tpl = "{{ value_json.ip }}" },
  { suffix = "_firmware", name = "Firmware", tpl = "{{ value_json.firmware }}" },
  { suffix = "_ir_devices", name = "IR Devices", tpl = "{{ value_json.deviceCount }}" },
  { suffix = "_ir_commands", name = "IR Commands", tpl = "{{ value_json.commandCount }}" },
}
for _, s in ipairs(expectedSensors) do
  local topic = "homeassistant/sensor/" .. ident .. s.suffix .. "/config"
  local pkt = pubByTopic[topic]
  local body = pkt and decodeJson(pkt.payload) or {}
  check("publishes retained HA diagnostic sensor " .. s.name,
    pkt ~= nil and pkt.retain == true and body.name == s.name and
      body.value_template == s.tpl and body.entity_category == "diagnostic" and
      body.state_topic == "harmony/living/state",
    pkt and pkt.payload)
end

local offBtnPkt = pubByTopic["homeassistant/button/" .. ident .. "_power_off/config"]
local offBtnCfg = offBtnPkt and decodeJson(offBtnPkt.payload) or {}
check("publishes retained HA Power Off button discovery payload",
  offBtnPkt ~= nil and offBtnPkt.retain == true and
    offBtnCfg.name == "Power Off" and
    offBtnCfg.command_topic == "harmony/living/activity/set" and
    offBtnCfg.payload_press == "PowerOff")

local subPkt
for _, p in ipairs(wirePkts) do
  if p.kind == 8 then subPkt = p end
end
check("subscribes to activity/set, command, hbus and HA birth status topics",
  subPkt ~= nil and #subPkt.topics == 4 and
    subPkt.topics[1].topic == "harmony/living/activity/set" and
    subPkt.topics[2].topic == "harmony/living/command" and
    subPkt.topics[3].topic == "harmony/living/hbus" and
    subPkt.topics[4].topic == "homeassistant/status")

-- 3. State publication on initial connect and digest/activity updates --------
local initialStatePkt = pubByTopic["harmony/living/state"]
local initialState = initialStatePkt and decodeJson(initialStatePkt.payload) or {}
check("publishes initial retained hub state with device and command counts",
  initialStatePkt ~= nil and initialStatePkt.retain == true and
    initialState.activityId == "-1" and initialState.activity == "PowerOff" and
    initialState.deviceCount == 2 and initialState.commandCount == 5 and
    initialState.firmware == "4.15.600" and initialState.ip == "192.168.1.50",
  initialStatePkt and initialStatePkt.payload)

sock.tx = ""
hub.nowSec = hub.nowSec + 11
stepTask()
local _, unchangedPubs = publishedByTopic(sock)
check("unchanged state is not republished on poll", #unchangedPubs == 0)

hub.account.currentActivityId = "101"
hub.digest.activityId = "101"
hub.digest.activityStatus = 2
hub.digest.stateVersion = 9
hub.nowSec = hub.nowSec + 11
stepTask()
local updatedMap, updatedPubs = publishedByTopic(sock)
local updatedState = updatedMap["harmony/living/state"] and decodeJson(updatedMap["harmony/living/state"].payload) or {}
check("activity/digest change publishes updated retained state",
  #updatedPubs == 1 and updatedMap["harmony/living/state"].retain == true and
    updatedState.activityId == "101" and updatedState.activity == "Watch Movie" and
    updatedState.activityStatus == 2 and updatedState.stateVersion == 9,
  updatedMap["harmony/living/state"] and updatedMap["harmony/living/state"].payload)

-- Home Assistant birth status ("online") forces discovery + state republish.
sock.tx = ""
sock.rx = sock.rx .. makeIncomingPublish("homeassistant/status", "online")
stepTask()
local birthMap = publishedByTopic(sock)
check("HA birth message republishes discovery and forced state",
  birthMap["homeassistant/select/" .. ident .. "_activity/config"] ~= nil and
    birthMap["harmony/living/state"] ~= nil)

-- 4. Incoming activity/hbus/IR commands + retained & duplicate filtering -----
-- Retained command on /activity/set must be ignored without calling engine.
sock.tx = ""
hub.engineCalls = {}
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "Watch Movie", { retain = true })
stepTask()
local retMap = publishedByTopic(sock)
local retRes = retMap["harmony/living/result"] and decodeJson(retMap["harmony/living/result"].payload) or {}
check("ignores retained command on activity/set and reports reason",
  #hub.engineCalls == 0 and retRes.ok == false and retRes.ignored == true and
    retRes.reason == "retained command" and retMap["harmony/living/result"].retain == false,
  retMap["harmony/living/result"] and retMap["harmony/living/result"].payload)

-- Retained command on /command is also ignored.
sock.tx = ""
sock.rx = sock.rx .. makeIncomingPublish(
  "harmony/living/command",
  encodeJson({ deviceId = "201", command = "VolumeUp" }),
  { retain = true }
)
stepTask()
retMap = publishedByTopic(sock)
retRes = retMap["harmony/living/result"] and decodeJson(retMap["harmony/living/result"].payload) or {}
check("ignores retained command on /command",
  #hub.engineCalls == 0 and retRes.ignored == true and retRes.reason == "retained command")

-- Non-retained /activity/set by activity label starts activity 101.
sock.tx = ""
hub.nowMs = 200000
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "Watch Movie")
stepTask()
local actMap = publishedByTopic(sock)
local actRes = actMap["harmony/living/result"] and decodeJson(actMap["harmony/living/result"].payload) or {}
check("activity/set by label calls startactivity and publishes result",
  #hub.engineCalls == 1 and
    hub.engineCalls[1].cmd == "harmony.engine?startactivity" and
    hub.engineCalls[1].params.activityId == "101" and
    actRes.ok == true and actRes.activityId == "101",
  actMap["harmony/living/result"] and actMap["harmony/living/result"].payload)

-- Duplicate command within duplicateWindowMs (3000 ms) is filtered out.
sock.tx = ""
hub.nowMs = 201500
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "Watch Movie")
stepTask()
local dupMap = publishedByTopic(sock)
local dupRes = dupMap["harmony/living/result"] and decodeJson(dupMap["harmony/living/result"].payload) or {}
check("duplicate command inside duplicateWindowMs is filtered out",
  #hub.engineCalls == 1 and dupRes.ok == false and dupRes.ignored == true and
    dupRes.reason == "duplicate command")

-- Same command after duplicateWindowMs elapses executes again.
sock.tx = ""
hub.nowMs = 203500
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "Watch Movie")
stepTask()
check("same command after duplicateWindowMs executes again", #hub.engineCalls == 2)

-- PowerOff / off alias resolves to activityId "-1".
sock.tx = ""
hub.nowMs = 210000
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "off")
stepTask()
check("activity/set 'off' resolves to activityId -1",
  #hub.engineCalls == 3 and hub.engineCalls[3].params.activityId == "-1")

-- Unknown activity name fails closed without calling engine.
sock.tx = ""
hub.nowMs = 215000
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/activity/set", "Does Not Exist")
stepTask()
local unkMap = publishedByTopic(sock)
local unkRes = unkMap["harmony/living/result"] and decodeJson(unkMap["harmony/living/result"].payload) or {}
check("unknown activity publishes error result without calling engine",
  #hub.engineCalls == 3 and unkRes.ok == false and unkRes.error == "unknown activity")

-- /command with QoS 1 IR command JSON parses packet-id header and calls holdaction.
sock.tx = ""
hub.nowMs = 220000
sock.rx = sock.rx .. makeIncomingPublish(
  "harmony/living/command",
  encodeJson({ deviceId = "201", command = "VolumeUp", status = "press", count = 2, delayInMs = 120 }),
  { qos = 1, pktId = 42 }
)
stepTask()
local irCall = hub.engineCalls[4]
local irAction = irCall and decodeJson(irCall.params.action) or {}
check("/command QoS 1 IR JSON dispatches holdaction with encoded IRCommand",
  irCall ~= nil and irCall.cmd == "harmony.engine?holdaction" and
    irCall.params.status == "press" and irCall.params.count == 2 and
    irCall.params.delayInMs == 120 and
    irAction.type == "IRCommand" and irAction.deviceId == "201" and irAction.command == "VolumeUp")

-- /command with shorthand "activity:<name>" string routes to startactivity.
sock.tx = ""
hub.nowMs = 225000
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/command", "activity:Listen to Music")
stepTask()
check("/command 'activity:<label>' shorthand starts matching activity",
  #hub.engineCalls == 5 and hub.engineCalls[5].cmd == "harmony.engine?startactivity" and
    hub.engineCalls[5].params.activityId == "102")

-- /hbus raw engine command forwards cmd + params and logs holdaction details.
sock.tx = ""
hub.nowMs = 230000
sock.rx = sock.rx .. makeIncomingPublish(
  "harmony/living/hbus",
  encodeJson({
    cmd = "harmony.engine?holdaction",
    params = {
      status = "hold",
      count = 1,
      delayInMs = 50,
      action = encodeJson({ type = "IRCommand", deviceId = "202", command = "Play" }),
    },
  })
)
stepTask()
local hbusMap = publishedByTopic(sock)
local hbusRes = hbusMap["harmony/living/result"] and decodeJson(hbusMap["harmony/living/result"].payload) or {}
check("/hbus forwards raw engine command and logs ir_send event",
  #hub.engineCalls == 6 and hub.engineCalls[6].cmd == "harmony.engine?holdaction" and
    hbusRes.ok == true and hbusRes.cmd == "harmony.engine?holdaction" and
    type(hub.files["/data/codex/ir-events.log"]) == "string" and
    hub.files["/data/codex/ir-events.log"]:find('"mqtt%-hbus"') ~= nil)

-- Malformed payload on /command publishes error without crashing loop.
sock.tx = ""
hub.nowMs = 235000
sock.rx = sock.rx .. makeIncomingPublish("harmony/living/command", "not-json")
stepTask()
local badMap = publishedByTopic(sock)
local badRes = badMap["harmony/living/result"] and decodeJson(badMap["harmony/living/result"].payload) or {}
check("invalid /command payload publishes error result cleanly",
  #hub.engineCalls == 6 and badRes.ok == false and
    badRes.error == "payload must be JSON or activity:<name>")

-- Clean exit publishes retained offline status, sends DISCONNECT, closes socket.
sock.tx = ""
plugin:exit()
stepTask()
local exitPkts = parseMqttStream(sock.tx)
local hasOffline, hasDisconnect = false, false
for _, p in ipairs(exitPkts) do
  if p.kind == 3 and p.topic == "harmony/living/status" and p.payload == "offline" and p.retain then
    hasOffline = true
  elseif p.kind == 14 then
    hasDisconnect = true
  end
end
check("exit publishes retained offline status, sends DISCONNECT and closes socket",
  hasOffline and hasDisconnect and sock.closed == true)

-- haDiscovery = false suppresses discovery topics while still publishing state.
resetState()
hub.files["/data/codexmqtt/config.json"] = encodeJson({
  enabled = true,
  haDiscovery = false,
  baseTopic = "harmony/nodisc",
  broker = { host = "192.168.1.10", port = 1883 },
})
plugin:discover()
stepTask()
local noDiscMap = publishedByTopic(hub.sockets[1])
local anyHomeAssistant = false
for topic in pairs(noDiscMap) do
  if topic:find("^homeassistant/") then anyHomeAssistant = true end
end
check("haDiscovery=false suppresses HA discovery while still publishing state",
  not anyHomeAssistant and noDiscMap["harmony/nodisc/state"] ~= nil and
    noDiscMap["harmony/nodisc/status"] ~= nil)

print(string.format("%d/%d checks passed", count - failures, count))
os.exit(failures == 0 and 0 or 1)
