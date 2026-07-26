module(..., package.seeall)

local socket = require("socket")
local system = require("system")
local json = require("json")
local log = require("log").logger("auto.p.codexmqtt")

local engine = require("tasks.connectserver.core.engine")
local session = require("tasks.harmonywebservices.core.session")
local digest = require("tasks.harmonywebservices.core.statedigest"):instance()

local CONFIG_FILE = "/data/codexmqtt/config.json"
local RESOURCE_RELOAD_FLAG = "/data/codex/reload_resources"
local IR_EVENT_LOG = "/data/codex/ir-events.log"
local DEFAULT_BASE_TOPIC = "harmony/hub"
local DEFAULT_DISCOVERY_PREFIX = "homeassistant"
local DEFAULT_CLIENT_ID = "harmony-codexmqtt"
local DEFAULT_KEEPALIVE = 60
local DEFAULT_DUPLICATE_WINDOW_MS = 3000
local IR_EVENT_MAX_BYTES = 65536

local moduleObj
local mqttTask
local stopRequested = false
local stateCache = ""
local pktid = 1
local recentCommandKey = nil
local recentCommandAt = 0

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
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local data = f:read("*a")
  f:close()
  return data
end

local function checkResourceReload()
  local data = readFile(RESOURCE_RELOAD_FLAG)
  if not data then
    return
  end
  os.remove(RESOURCE_RELOAD_FLAG)
  local resources = {}
  for name in string.gmatch(data, "[%w]+") do
    if name == "all" or name == "DeviceList" or name == "FunctionList" or name == "ProtocolList" or name == "ActivityList" or name == "MapList" or name == "AutomationConfig" then
      table.insert(resources, name)
    end
  end
  if #resources == 0 then
    resources = {"DeviceList", "ProtocolList"}
  end
  log.notice("codexmqtt requesting config reload")
  system.broadcastMessage("config_new", resources)
end

local function readConfig()
  local data = readFile(CONFIG_FILE)
  if not data then
    return {enabled = false}
  end
  local ok, cfg = system.safeCall(json.decode, data)
  if not ok or type(cfg) ~= "table" then
    log.notice("invalid codexmqtt config")
    return {enabled = false}
  end
  cfg.broker = cfg.broker or {}
  cfg.baseTopic = cfg.baseTopic or DEFAULT_BASE_TOPIC
  cfg.discoveryPrefix = cfg.discoveryPrefix or DEFAULT_DISCOVERY_PREFIX
  cfg.clientId = cfg.clientId or DEFAULT_CLIENT_ID
  cfg.keepAlive = tonumber(cfg.keepAlive) or DEFAULT_KEEPALIVE
  cfg.pollSeconds = tonumber(cfg.pollSeconds) or 10
  cfg.duplicateWindowMs = tonumber(cfg.duplicateWindowMs) or DEFAULT_DUPLICATE_WINDOW_MS
  if cfg.duplicateWindowMs < 0 then
    cfg.duplicateWindowMs = 0
  elseif cfg.duplicateWindowMs > 60000 then
    cfg.duplicateWindowMs = 60000
  end
  cfg.name = cfg.name or system.getHostName() or "Harmony Hub"
  if cfg.haDiscovery == nil then
    cfg.haDiscovery = true
  end
  cfg.__raw = data
  return cfg
end

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
    if n > 0 then
      digit = digit + 128
    end
    out = out .. string.char(digit)
  until n == 0
  return out
end

local function packet(kind, body)
  return string.char(kind) .. remLen(#body) .. body
end

local function nextPktid()
  pktid = pktid + 1
  if pktid > 65535 then
    pktid = 1
  end
  return pktid
end

local function nowMillis()
  local ok, value = system.safeCall(function()
    return system.jiffies():tomillis()
  end)
  if ok and value then
    return tonumber(value) or 0
  end
  return (tonumber(os.time()) or 0) * 1000
end

local function appendIrEvent(event, fields)
  local row = fields or {}
  row.event = event
  row.ts = tonumber(os.time()) or 0
  local ok, encoded = system.safeCall(json.encode, row)
  if not ok or not encoded then
    return
  end
  local existing = io.open(IR_EVENT_LOG, "r")
  if existing then
    local size = existing:seek("end") or 0
    existing:close()
    if size > IR_EVENT_MAX_BYTES then
      os.remove(IR_EVENT_LOG .. ".1")
      os.rename(IR_EVENT_LOG, IR_EVENT_LOG .. ".1")
    end
  end
  local f = io.open(IR_EVENT_LOG, "a")
  if not f then
    return
  end
  f:write(encoded, "\n")
  f:close()
end

local function holdActionDetails(params)
  if type(params) ~= "table" then
    return {}
  end
  local details = {
    status = tostring(params.status or ""),
    count = tostring(params.count or ""),
    delayInMs = tostring(params.delayInMs or "")
  }
  if type(params.action) == "string" then
    local ok, action = system.safeCall(json.decode, params.action)
    if ok and type(action) == "table" then
      details.deviceId = tostring(action.deviceId or "")
      details.command = tostring(action.command or "")
      details.type = tostring(action.type or "")
    end
  end
  return details
end

local function recvBytes(sock, n)
  local data, err, partial = sock:receive(n)
  if data then
    return data
  end
  if err == "timeout" then
    return nil, "timeout"
  end
  return partial, err
end

local function recvPacket(sock)
  local h, err = recvBytes(sock, 1)
  if not h then
    return nil, err
  end
  local multiplier = 1
  local length = 0
  while true do
    local b
    b, err = recvBytes(sock, 1)
    if not b then
      return nil, err
    end
    local byte = string.byte(b, 1)
    length = length + (byte % 128) * multiplier
    if byte < 128 then
      break
    end
    multiplier = multiplier * 128
  end
  local body = ""
  if length > 0 then
    body, err = recvBytes(sock, length)
    if not body or #body ~= length then
      return nil, err or "short read"
    end
  end
  return {kind = math.floor(string.byte(h, 1) / 16), flags = string.byte(h, 1) % 16, body = body}
end

local function publish(sock, topic, payload, retain)
  payload = tostring(payload or "")
  local fixed = retain and 0x31 or 0x30
  return sock:send(packet(fixed, utf(topic) .. payload))
end

local function subscribe(sock, topics)
  local id = nextPktid()
  local body = u16(id)
  for _, topic in ipairs(topics) do
    body = body .. utf(topic) .. string.char(0)
  end
  return sock:send(packet(0x82, body))
end

local function connectMqtt(cfg)
  local host = cfg.broker.host
  local port = tonumber(cfg.broker.port) or 1883
  local sock, err = socket.tcp()
  if not sock then
    return nil, err
  end
  sock:settimeout(8)
  local ok
  ok, err = sock:connect(host, port)
  if not ok then
    sock:close()
    return nil, err
  end

  local flags = 0x02 + 0x04 + 0x20
  local payload = utf(cfg.clientId) .. utf(cfg.baseTopic .. "/status") .. utf("offline")
  if cfg.broker.username and cfg.broker.username ~= "" then
    flags = flags + 0x80
    if cfg.broker.password and cfg.broker.password ~= "" then
      flags = flags + 0x40
    end
  end
  if cfg.broker.username and cfg.broker.username ~= "" then
    payload = payload .. utf(cfg.broker.username)
    if cfg.broker.password and cfg.broker.password ~= "" then
      payload = payload .. utf(cfg.broker.password)
    end
  end

  local vh = utf("MQTT") .. string.char(4, flags) .. u16(cfg.keepAlive)
  sock:send(packet(0x10, vh .. payload))
  local ack
  ack, err = recvPacket(sock)
  if not ack or ack.kind ~= 2 or string.byte(ack.body, 2) ~= 0 then
    sock:close()
    return nil, err or "CONNACK failed"
  end
  sock:settimeout(1)
  return sock
end

local function safeId(s)
  s = tostring(s or "harmony_hub")
  s = string.lower(s)
  s = string.gsub(s, "[^%w_%-]+", "_")
  s = string.gsub(s, "_+", "_")
  return s
end

local function activityName(account, id)
  if tostring(id) == "-1" then
    return "PowerOff"
  end
  local act = account and account.activities and account.activities[tostring(id)]
  return act and act.label or tostring(id or "unknown")
end

local function activityOptions(account)
  local opts = {"PowerOff"}
  local tmp = {}
  if account and account.activities then
    for _, act in pairs(account.activities) do
      if act.label and act.label ~= "PowerOff" then
        tmp[#tmp + 1] = {order = tonumber(act.activityOrder) or 9999, label = act.label}
      end
    end
  end
  table.sort(tmp, function(a, b) return a.order < b.order end)
  for _, item in ipairs(tmp) do
    opts[#opts + 1] = item.label
  end
  return opts
end

local function inventoryCounts(account)
  local devices = 0
  local commands = 0
  if account and account.devices then
    for _, device in pairs(account.devices) do
      devices = devices + 1
      if device.commands then
        for _, _ in pairs(device.commands) do
          commands = commands + 1
        end
      end
    end
  end
  return devices, commands
end

local function findActivity(account, nameOrId)
  local value = tostring(nameOrId or "")
  if value == "-1" or string.lower(value) == "off" or value == "PowerOff" then
    return "-1"
  end
  if account and account.activities and account.activities[value] then
    return value
  end
  if account and account.activities then
    for id, act in pairs(account.activities) do
      if act.label == value then
        return tostring(id)
      end
    end
  end
  return nil
end

local function callEngine(cmd, params)
  local id = "codexmqtt-" .. tostring(system.jiffies():tomillis())
  local _, reply = engine.processMessage({
    transport = "internal",
    id = id,
    cmd = cmd,
    params = params or {}
  })
  return reply
end

local function startActivity(activityId)
  return callEngine("harmony.engine?startactivity", {
    activityId = tostring(activityId),
    timestamp = system.jiffies():tomillis()
  })
end

local function sendCommand(cmd)
  local status = cmd.status or "pressrelease"
  local action = {
    type = cmd.type or "IRCommand",
    deviceId = tostring(cmd.deviceId or ""),
    command = tostring(cmd.command or "")
  }
  return callEngine("harmony.engine?holdaction", {
    status = status,
    count = tonumber(cmd.count) or 1,
    delayInMs = tonumber(cmd.delayInMs),
    action = json.encode(action)
  })
end

local function statePayload(cfg)
  local account = session.getAccount()
  local id = account and account.currentActivityId or digest.activityId or "-1"
  local deviceCount, commandCount = inventoryCounts(account)
  local ip = system.getNetworkAttribute("ipaddr")
  local payload = {
    activityId = tostring(id or "-1"),
    activity = activityName(account, id),
    activityStatus = digest.activityStatus or 0,
    stateVersion = digest.stateVersion or 0,
    firmware = system.getFirmwareVersion(),
    ip = ip,
    hostname = system.getHostName(),
    webui = ip and ("http://" .. tostring(ip) .. ":8080/") or "",
    mqttClientId = cfg.clientId,
    baseTopic = cfg.baseTopic,
    discoveryPrefix = cfg.discoveryPrefix,
    deviceCount = deviceCount,
    commandCount = commandCount
  }
  return json.encode(payload)
end

local function publishState(sock, cfg, force)
  local payload = statePayload(cfg)
  if force or payload ~= stateCache then
    stateCache = payload
    publish(sock, cfg.baseTopic .. "/state", payload, true)
  end
end

local function publishDiscovery(sock, cfg)
  if not cfg.haDiscovery then
    return
  end
  local account = session.getAccount()
  local ident = safeId(cfg.clientId)
  local base = cfg.baseTopic
  local ip = system.getNetworkAttribute("ipaddr")
  local dev = {
    identifiers = {ident},
    name = cfg.name,
    manufacturer = "Logitech",
    model = "Harmony Hub",
    sw_version = system.getFirmwareVersion(),
    configuration_url = ip and ("http://" .. tostring(ip) .. ":8080/") or nil
  }
  local origin = {
    name = "codexmqtt",
    sw_version = "0.3",
    support_url = "http://" .. tostring(ip or "harmony-hub.local") .. ":8080/"
  }
  local availability = base .. "/status"

  local selectPayload = {
    name = "Activity",
    unique_id = ident .. "_activity",
    command_topic = base .. "/activity/set",
    state_topic = base .. "/state",
    value_template = "{{ value_json.activity }}",
    json_attributes_topic = base .. "/state",
    options = activityOptions(account),
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:remote-tv",
    origin = origin,
    device = dev
  }
  publish(sock, cfg.discoveryPrefix .. "/select/" .. ident .. "_activity/config", json.encode(selectPayload), true)

  local idPayload = {
    name = "Activity ID",
    unique_id = ident .. "_activity_id",
    state_topic = base .. "/state",
    value_template = "{{ value_json.activityId }}",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:identifier",
    entity_category = "diagnostic",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/sensor/" .. ident .. "_activity_id/config", json.encode(idPayload), true)

  local ipPayload = {
    name = "IP Address",
    unique_id = ident .. "_ip",
    state_topic = base .. "/state",
    value_template = "{{ value_json.ip }}",
    json_attributes_topic = base .. "/state",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:ip-network",
    entity_category = "diagnostic",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/sensor/" .. ident .. "_ip/config", json.encode(ipPayload), true)

  local firmwarePayload = {
    name = "Firmware",
    unique_id = ident .. "_firmware",
    state_topic = base .. "/state",
    value_template = "{{ value_json.firmware }}",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:chip",
    entity_category = "diagnostic",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/sensor/" .. ident .. "_firmware/config", json.encode(firmwarePayload), true)

  local devicesPayload = {
    name = "IR Devices",
    unique_id = ident .. "_ir_devices",
    state_topic = base .. "/state",
    value_template = "{{ value_json.deviceCount }}",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:remote",
    entity_category = "diagnostic",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/sensor/" .. ident .. "_ir_devices/config", json.encode(devicesPayload), true)

  local commandsPayload = {
    name = "IR Commands",
    unique_id = ident .. "_ir_commands",
    state_topic = base .. "/state",
    value_template = "{{ value_json.commandCount }}",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:counter",
    entity_category = "diagnostic",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/sensor/" .. ident .. "_ir_commands/config", json.encode(commandsPayload), true)

  local offPayload = {
    name = "Power Off",
    unique_id = ident .. "_power_off",
    command_topic = base .. "/activity/set",
    payload_press = "PowerOff",
    availability_topic = availability,
    payload_available = "online",
    payload_not_available = "offline",
    icon = "mdi:power",
    origin = origin,
    device = {identifiers = {ident}}
  }
  publish(sock, cfg.discoveryPrefix .. "/button/" .. ident .. "_power_off/config", json.encode(offPayload), true)
end

local function publishResult(sock, cfg, payload)
  publish(sock, cfg.baseTopic .. "/result", json.encode(payload), false)
end

local function handleActivity(sock, cfg, payload)
  log.notice("codexmqtt activity request", tostring(payload or ""))
  local account = session.getAccount()
  local activityId = findActivity(account, payload)
  if not activityId then
    publishResult(sock, cfg, {ok = false, error = "unknown activity", value = payload})
    return
  end
  local reply = startActivity(activityId)
  publishResult(sock, cfg, {ok = true, cmd = "startactivity", activityId = activityId, reply = reply})
end

local function handleCommand(sock, cfg, payload, topic)
  local ok, decoded = system.safeCall(json.decode, payload)
  if ok and type(decoded) == "table" then
    if decoded.cmd then
      log.notice("codexmqtt hbus command", tostring(decoded.cmd), "topic", tostring(topic or ""))
      local reply = callEngine(decoded.cmd, decoded.params or {})
      if tostring(decoded.cmd) == "harmony.engine?holdaction" then
        local details = holdActionDetails(decoded.params)
        details.source = "mqtt-hbus"
        details.topic = tostring(topic or "")
        details.reply = tostring(reply or "")
        appendIrEvent("ir_send", details)
      end
      publishResult(sock, cfg, {ok = true, cmd = decoded.cmd, reply = reply})
    elseif decoded.activity or decoded.activityId then
      handleActivity(sock, cfg, decoded.activityId or decoded.activity)
    elseif decoded.deviceId and decoded.command then
      log.notice("codexmqtt ir command", "device", tostring(decoded.deviceId), "command", tostring(decoded.command), "topic", tostring(topic or ""))
      local reply = sendCommand(decoded)
      appendIrEvent("ir_send", {
        source = "mqtt",
        topic = tostring(topic or ""),
        deviceId = tostring(decoded.deviceId or ""),
        command = tostring(decoded.command or ""),
        status = tostring(decoded.status or "pressrelease"),
        count = tostring(decoded.count or 1),
        delayInMs = tostring(decoded.delayInMs or ""),
        reply = tostring(reply or "")
      })
      publishResult(sock, cfg, {ok = true, cmd = "holdaction", reply = reply})
    else
      publishResult(sock, cfg, {ok = false, error = "unknown command shape"})
    end
    return
  end

  local activity = string.match(payload or "", "^activity:(.+)$")
  if activity then
    handleActivity(sock, cfg, activity)
    return
  end
  publishResult(sock, cfg, {ok = false, error = "payload must be JSON or activity:<name>"})
end

local function handlePublish(sock, cfg, pkt)
  local body = pkt.body
  if #body < 2 then
    return
  end
  local topicLen = string.byte(body, 1) * 256 + string.byte(body, 2)
  local topic = string.sub(body, 3, 2 + topicLen)
  local pos = 3 + topicLen
  local qos = math.floor(pkt.flags / 2) % 4
  if qos > 0 then
    pos = pos + 2
  end
  local payload = string.sub(body, pos)
  local retain = (pkt.flags % 2) == 1
  local isCommandTopic = topic == cfg.baseTopic .. "/activity/set" or topic == cfg.baseTopic .. "/command" or topic == cfg.baseTopic .. "/hbus"

  if retain and isCommandTopic then
    log.notice("codexmqtt ignored retained command", tostring(topic))
    appendIrEvent("ir_ignored", {source = "mqtt", reason = "retained command", topic = tostring(topic or "")})
    publishResult(sock, cfg, {ok = false, ignored = true, reason = "retained command", topic = topic})
    return
  end

  if isCommandTopic then
    local key = topic .. "\n" .. tostring(payload or "")
    local now = nowMillis()
    if cfg.duplicateWindowMs > 0 and recentCommandKey == key and now >= recentCommandAt and now - recentCommandAt < cfg.duplicateWindowMs then
      log.notice("codexmqtt ignored duplicate command", tostring(topic))
      appendIrEvent("ir_ignored", {source = "mqtt", reason = "duplicate command", topic = tostring(topic or ""), windowMs = tostring(cfg.duplicateWindowMs)})
      publishResult(sock, cfg, {ok = false, ignored = true, reason = "duplicate command", topic = topic})
      return
    end
    recentCommandKey = key
    recentCommandAt = now
  end

  if topic == cfg.baseTopic .. "/activity/set" then
    handleActivity(sock, cfg, payload)
  elseif topic == cfg.baseTopic .. "/command" or topic == cfg.baseTopic .. "/hbus" then
    handleCommand(sock, cfg, payload, topic)
  elseif topic == cfg.discoveryPrefix .. "/status" and payload == "online" then
    publishDiscovery(sock, cfg)
    publishState(sock, cfg, true)
  end
end

local function mqttLoop()
  while not stopRequested do
    local cfg = readConfig()
    if not cfg.enabled or not cfg.broker or not cfg.broker.host then
      log.notice("codexmqtt disabled or missing broker host")
      local cfgRaw = readFile(CONFIG_FILE) or ""
      for _ = 1, 60 do
        checkResourceReload()
        system.sleep(1000)
        if stopRequested or (readFile(CONFIG_FILE) or "") ~= cfgRaw then
          break
        end
      end
    else
      local sock, err = connectMqtt(cfg)
      if not sock then
        log.notice("codexmqtt connect failed:", err)
        system.sleep(15000)
      else
        log.notice("codexmqtt connected to", cfg.broker.host)
        publish(sock, cfg.baseTopic .. "/status", "online", true)
        publishDiscovery(sock, cfg)
        publishState(sock, cfg, true)
        subscribe(sock, {
          cfg.baseTopic .. "/activity/set",
          cfg.baseTopic .. "/command",
          cfg.baseTopic .. "/hbus",
          cfg.discoveryPrefix .. "/status"
        })

        local lastPing = os.time()
        local lastPoll = 0
        local lastConfigCheck = 0
        local cfgRaw = cfg.__raw or ""
        while not stopRequested do
          local pkt, perr = recvPacket(sock)
          if pkt and pkt.kind == 3 then
            local ok, herr = system.safeCall(handlePublish, sock, cfg, pkt)
            if not ok then
              log.notice("codexmqtt publish handler failed:", tostring(herr))
            end
          elseif pkt and pkt.kind == 13 then
          elseif pkt then
          elseif perr and perr ~= "timeout" then
            log.notice("codexmqtt receive failed:", perr)
            break
          end

          local now = os.time()
          if now - lastPoll >= cfg.pollSeconds then
            publishState(sock, cfg, false)
            lastPoll = now
          end
          if now - lastConfigCheck >= 1 then
            checkResourceReload()
            local nextRaw = readFile(CONFIG_FILE) or ""
            if nextRaw ~= cfgRaw then
              log.notice("codexmqtt config changed; reconnecting")
              break
            end
            lastConfigCheck = now
          end
          if now - lastPing >= math.floor(cfg.keepAlive / 2) then
            local ok, serr = sock:send(packet(0xC0, ""))
            if not ok then
              log.notice("codexmqtt ping failed:", serr)
              break
            end
            lastPing = now
          end
          system.sleep(100)
        end
        pcall(function() publish(sock, cfg.baseTopic .. "/status", "offline", true) end)
        pcall(function() sock:send(packet(0xE0, "")) end)
        pcall(function() sock:close() end)
        system.sleep(5000)
      end
    end
  end
  mqttTask = nil
end

local function start()
  stopRequested = false
  if not mqttTask then
    mqttTask = system.addTask("codexmqtt", mqttLoop)
  end
  return true
end

function discover(self)
  start()
  return {
    ["codex-mqtt"] = {
      id = "codex-mqtt",
      type = "codexmqtt",
      name = "Codex MQTT Bridge"
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
  return {state = mqttTask and "running" or "stopped", config = CONFIG_FILE}
end

function exit(self)
  stopRequested = true
  return true
end
