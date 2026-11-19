import Foundation

/// Press/hold semantics for a remote key, matching the Android and Web Melodious clients.
public enum KeyPressBehavior: String, Equatable, Sendable {
    /// Standard key: fires once when the finger lifts (cancelled if finger slides off).
    case tap
    /// Repeatable key (Volume, Channel, D-pad without a distinct long-press action):
    /// fires immediately on press-down, and if held past 380 ms repeats every 200 ms until release.
    case holdRepeat
    /// Key with a distinct `ButtonLongPressAction`: short press fires `pressCommand` on release (< 500 ms);
    /// holding >= 500 ms fires `holdCommand` once.
    case longPressAction
    /// Hardware-proven one-shot toggle (`PowerToggle`, `PlayPause`, `Mute`, etc.):
    /// fires once and never repeats on hold.
    case oneShot
}

/// Pure remote key mapping, alias matching, and `/api/activity-config` parser.
public enum RemoteKeyMapping {
    public static let holdDelayMs: UInt64 = 380
    public static let repeatIntervalMs: UInt64 = 200
    public static let longPressDelayMs: UInt64 = 500

    public static let repeatableKeys: Set<String> = [
        "VolumeUp", "VolumeDown", "ChannelUp", "ChannelDown",
        "DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight"
    ]

    public static let oneShotCommandKeys: Set<String> = [
        "powertoggle", "playpause", "mute", "skipforward", "skipback", "run", "activate", "press"
    ]

    /// Canonical firmware `ButtonKey` -> human-readable label.
    /// Note: the physical Harmony remote stores Back/Return as `PrevChannel` in `MapList.json`.
    public static let keyLabels: [String: String] = [
        "Rewind": "Rewind",
        "Play": "Play",
        "Pause": "Pause",
        "FastForward": "Fast forward",
        "Record": "Record",
        "Stop": "Stop",
        "Red": "Red",
        "Green": "Green",
        "Yellow": "Yellow",
        "Blue": "Blue",
        "Dvr": "DVR",
        "Guide": "Guide",
        "Info": "Info",
        "Exit": "Exit",
        "Menu": "Menu",
        "DirectionUp": "Up",
        "DirectionDown": "Down",
        "DirectionLeft": "Left",
        "DirectionRight": "Right",
        "Select": "OK",
        "VolumeUp": "Volume up",
        "VolumeDown": "Volume down",
        "VolumeMute": "Mute",
        "PrevChannel": "Back",
        "ChannelUp": "Channel up",
        "ChannelDown": "Channel down",
        "Number1": "1",
        "Number2": "2",
        "Number3": "3",
        "Number4": "4",
        "Number5": "5",
        "Number6": "6",
        "Number7": "7",
        "Number8": "8",
        "Number9": "9",
        "Number0": "0",
        "Dash": "–",
        "Enter": "Enter"
    ]

    private static let canonicalByLower: [String: String] = {
        var map: [String: String] = [:]
        for key in keyLabels.keys {
            map[key.lowercased()] = key
        }
        return map
    }()

    public struct KeyAliasSpec: Sendable {
        public let canonicalKey: String
        public let label: String
        public let aliases: String
    }

    public static let deviceKeyAliases: [KeyAliasSpec] = [
        KeyAliasSpec(canonicalKey: "Rewind", label: "Rewind", aliases: "rewind|rev|skipback|previous track"),
        KeyAliasSpec(canonicalKey: "Play", label: "Play", aliases: "play"),
        KeyAliasSpec(canonicalKey: "FastForward", label: "Fast forward", aliases: "fastforward|forward|ffwd|next track|skipforward"),
        KeyAliasSpec(canonicalKey: "Record", label: "Record", aliases: "record|rec"),
        KeyAliasSpec(canonicalKey: "Pause", label: "Pause", aliases: "pause"),
        KeyAliasSpec(canonicalKey: "Stop", label: "Stop", aliases: "stop"),
        KeyAliasSpec(canonicalKey: "Red", label: "Red", aliases: "red"),
        KeyAliasSpec(canonicalKey: "Green", label: "Green", aliases: "green"),
        KeyAliasSpec(canonicalKey: "Yellow", label: "Yellow", aliases: "yellow"),
        KeyAliasSpec(canonicalKey: "Blue", label: "Blue", aliases: "blue"),
        KeyAliasSpec(canonicalKey: "Dvr", label: "DVR", aliases: "dvr|recordings"),
        KeyAliasSpec(canonicalKey: "Guide", label: "Guide", aliases: "guide|epg"),
        KeyAliasSpec(canonicalKey: "Info", label: "Info", aliases: "info|information|displayinfo|settings|setting|setup|option|options"),
        KeyAliasSpec(canonicalKey: "Exit", label: "Exit", aliases: "exit|clear|cancel"),
        KeyAliasSpec(canonicalKey: "Menu", label: "Menu", aliases: "menu"),
        KeyAliasSpec(canonicalKey: "DirectionUp", label: "Up", aliases: "up|directionup|arrowup|cursorup"),
        KeyAliasSpec(canonicalKey: "DirectionLeft", label: "Left", aliases: "left|directionleft|arrowleft|cursorleft"),
        KeyAliasSpec(canonicalKey: "DirectionRight", label: "Right", aliases: "right|directionright|arrowright|cursorright"),
        KeyAliasSpec(canonicalKey: "DirectionDown", label: "Down", aliases: "down|directiondown|arrowdown|cursordown"),
        KeyAliasSpec(canonicalKey: "Select", label: "OK", aliases: "ok|select|enter"),
        KeyAliasSpec(canonicalKey: "VolumeUp", label: "Volume up", aliases: "volumeup|volup|vol up|vol_up|volume up"),
        KeyAliasSpec(canonicalKey: "VolumeDown", label: "Volume down", aliases: "volumedown|voldown|voldn|vol down|vol_down|vol_dn|volume down"),
        KeyAliasSpec(canonicalKey: "ChannelUp", label: "Channel up", aliases: "channelup|chup|chnext|ch_next|ch up|channel next|channelnext|pageup|pgup"),
        KeyAliasSpec(canonicalKey: "ChannelDown", label: "Channel down", aliases: "channeldown|chdown|chdn|chprev|ch_prev|ch down|ch_dn|channel prev|channel previous|channel down|channelprev|channeldn|pagedown|pgdown"),
        KeyAliasSpec(canonicalKey: "VolumeMute", label: "Mute", aliases: "mute"),
        KeyAliasSpec(canonicalKey: "PrevChannel", label: "Back", aliases: "back|return|previous"),
        KeyAliasSpec(canonicalKey: "Number1", label: "1", aliases: "1|digit1|number1|num1"),
        KeyAliasSpec(canonicalKey: "Number2", label: "2", aliases: "2|digit2|number2|num2"),
        KeyAliasSpec(canonicalKey: "Number3", label: "3", aliases: "3|digit3|number3|num3"),
        KeyAliasSpec(canonicalKey: "Number4", label: "4", aliases: "4|digit4|number4|num4"),
        KeyAliasSpec(canonicalKey: "Number5", label: "5", aliases: "5|digit5|number5|num5"),
        KeyAliasSpec(canonicalKey: "Number6", label: "6", aliases: "6|digit6|number6|num6"),
        KeyAliasSpec(canonicalKey: "Number7", label: "7", aliases: "7|digit7|number7|num7"),
        KeyAliasSpec(canonicalKey: "Number8", label: "8", aliases: "8|digit8|number8|num8"),
        KeyAliasSpec(canonicalKey: "Number9", label: "9", aliases: "9|digit9|number9|num9"),
        KeyAliasSpec(canonicalKey: "Dash", label: "–", aliases: "dash|hyphen|separator|dot|period|minus"),
        KeyAliasSpec(canonicalKey: "Number0", label: "0", aliases: "0|digit0|number0|num0"),
        KeyAliasSpec(canonicalKey: "Enter", label: "Enter", aliases: "enter|e")
    ]

    /// Maps stored `ButtonKey` (e.g. `"DVR"` or `"Dvr"`) to canonical keypad key.
    public static func canonicalKey(for rawKey: String?) -> String? {
        guard let rawKey = rawKey?.trimmingCharacters(in: .whitespacesAndNewlines), !rawKey.isEmpty else {
            return nil
        }
        return canonicalByLower[rawKey.lowercased()]
    }

    /// Lowercase alphanumeric command key, matching `ir_command_key` in `codex_webui.c` and `remote-layout.js`.
    public static func commandKey(_ name: String?) -> String {
        guard let name = name else { return "" }
        return String(name.lowercased().unicodeScalars.filter {
            ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57)
        })
    }

    /// True when the command is a toggle/preset that needs one-shot protection.
    public static func isOneShotCommand(_ commandName: String?) -> Bool {
        let key = commandKey(commandName)
        guard !key.isEmpty else { return false }
        if oneShotCommandKeys.contains(key) {
            return true
        }
        let stepSuffixes = ["step", "increment", "decrement", "next", "previous"]
        if stepSuffixes.contains(where: { key.hasSuffix($0) }) {
            return false
        }
        let discretePrefixes = [
            "brightnesspct", "position", "tilt", "temperature", "percentage",
            "setvalue", "volumeset", "soundmode", "hvacmode", "presetmode",
            "selectoption", "effect", "colortemp"
        ]
        if discretePrefixes.contains(where: { key.hasPrefix($0) }) {
            return true
        }
        return false
    }

    /// Determines how a key should respond to touch-down, hold, and release.
    public static func behavior(for buttonKey: String, action: ResolvedButtonAction?) -> KeyPressBehavior {
        guard let action = action else { return .tap }
        if action.hasHold {
            // Self-long (hold command == press command) on a one-shot command is one-shot protection
            if action.holdCommand == action.pressCommand &&
               action.holdDeviceId == action.pressDeviceId &&
               isOneShotCommand(action.pressCommand) {
                return .oneShot
            }
            return .longPressAction
        }
        if isOneShotCommand(action.pressCommand) {
            return .oneShot
        }
        if repeatableKeys.contains(buttonKey) {
            return .holdRepeat
        }
        return .tap
    }

    /// Checks whether a command key matches a pipe-separated alias list.
    public static func aliasMatch(cmdKey: String, aliases: String) -> Bool {
        guard !cmdKey.isEmpty else { return false }
        for raw in aliases.split(separator: "|") {
            let key = commandKey(String(raw))
            if key.isEmpty { continue }
            if key == cmdKey { return true }
            if key.count > 4 && cmdKey.contains(key) { return true }
        }
        return false
    }

    /// Finds the first device command matching any alias, preferring an exact alias match over substring match.
    public static func matchCommand(in commands: [DeviceCommand], aliases: String) -> DeviceCommand? {
        let exactSet = Set(aliases.split(separator: "|").map { commandKey(String($0)) }.filter { !$0.isEmpty })
        if let exact = commands.first(where: { exactSet.contains(commandKey($0.name)) }) {
            return exact
        }
        return commands.first(where: { aliasMatch(cmdKey: commandKey($0.name), aliases: aliases) })
    }

    /// Builds a key map for driving a single device directly from the remote keypad.
    public static func resolveDeviceKeys(for device: HubDevice) -> [String: ResolvedButtonAction] {
        var out: [String: ResolvedButtonAction] = [:]
        for spec in deviceKeyAliases {
            if out[spec.canonicalKey] != nil { continue }
            guard let cmd = matchCommand(in: device.commands, aliases: spec.aliases) else { continue }
            out[spec.canonicalKey] = ResolvedButtonAction(
                buttonKey: spec.canonicalKey,
                buttonLabel: spec.label,
                pressDeviceId: device.id,
                pressDeviceName: device.name,
                pressCommand: cmd.name,
                pressFunctionId: cmd.functionId
            )
        }
        return out
    }

    /// `"PreviousTrack"` -> `"Previous Track"`; labels that already contain spaces are unchanged.
    public static func humanizeLabel(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains(" ") || trimmed.isEmpty { return trimmed }
        var result = ""
        var prevIsLower = false
        for scalar in trimmed.unicodeScalars {
            let isUpper = CharacterSet.uppercaseLetters.contains(scalar)
            let isLower = CharacterSet.lowercaseLetters.contains(scalar)
            if prevIsLower && isUpper {
                result.append(" ")
            }
            result.unicodeScalars.append(scalar)
            prevIsLower = isLower
        }
        return result
    }

    /// True when an activity maps `Menu` or `Exit` to a `Home` command.
    public static func sendsHome(in keyMap: [String: ResolvedButtonAction], key: String) -> Bool {
        guard let cmd = keyMap[key]?.pressCommand else { return false }
        return cmd.localizedCaseInsensitiveContains("home")
    }
}

// MARK: - JSON Parser for /api/activity-config & state endpoints

public enum HubConfigParserError: Error, LocalizedError, Equatable {
    case invalidJSON
    case hubError(String)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "Invalid JSON response from hub."
        case .hubError(let message):
            return message
        }
    }
}

public enum HubConfigParser {
    /// Converts a JSON value (`String`, `Int`, `NSNumber`) to a String if present.
    public static func stringValue(_ any: Any?) -> String? {
        guard let any = any, !(any is NSNull) else { return nil }
        if let s = any as? String { return s }
        if let n = any as? NSNumber { return n.stringValue }
        return nil
    }

    public static func intValue(_ any: Any?) -> Int? {
        guard let any = any, !(any is NSNull) else { return nil }
        if let i = any as? Int { return i }
        if let n = any as? NSNumber { return n.intValue }
        if let s = any as? String { return Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    public static func boolValue(_ any: Any?) -> Bool? {
        guard let any = any, !(any is NSNull) else { return nil }
        if let b = any as? Bool { return b }
        if let n = any as? NSNumber { return n.boolValue }
        if let s = any as? String {
            switch s.lowercased() {
            case "true", "1": return true
            case "false", "0": return false
            default: return nil
            }
        }
        return nil
    }

    /// Parses `GET /api/version` JSON response.
    public static func parseVersion(data: Data) throws -> HubVersionInfo {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HubConfigParserError.invalidJSON
        }
        if boolValue(obj["ok"]) == false {
            let msg = stringValue(obj["error"]) ?? stringValue(obj["message"]) ?? "Version check failed"
            throw HubConfigParserError.hubError(msg)
        }
        guard let version = stringValue(obj["version"]), !version.isEmpty else {
            throw HubConfigParserError.invalidJSON
        }
        let product = stringValue(obj["product"]) ?? "melodious"
        let api = intValue(obj["api"]) ?? 1
        let features = (obj["features"] as? [Any])?.compactMap { stringValue($0) } ?? []
        return HubVersionInfo(ok: true, product: product, version: version, api: api, features: features)
    }

    /// Parses `GET /api/system-status` JSON response.
    public static func parseSystemStatus(data: Data) throws -> HubSystemStatus {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HubConfigParserError.invalidJSON
        }
        if boolValue(obj["ok"]) == false {
            let msg = stringValue(obj["error"]) ?? stringValue(obj["message"]) ?? "System status check failed"
            throw HubConfigParserError.hubError(msg)
        }
        return HubSystemStatus(
            ok: boolValue(obj["ok"]) ?? true,
            firmware: stringValue(obj["firmware"]) ?? "",
            uptime: stringValue(obj["uptime"]) ?? "",
            uname: stringValue(obj["uname"]) ?? "",
            authMode: stringValue(obj["authMode"]) ?? "open on local network"
        )
    }

    /// Parses `GET /api/activity-config` JSON response into `HubConfigSnapshot`.
    public static func parseActivityConfig(data: Data) throws -> HubConfigSnapshot {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HubConfigParserError.invalidJSON
        }
        if boolValue(root["ok"]) == false {
            let msg = stringValue(root["error"]) ?? stringValue(root["message"]) ?? "Failed to load activity config"
            throw HubConfigParserError.hubError(msg)
        }

        let revision = stringValue(root["revision"]) ?? ""
        let activityList = root["activityList"] as? [String: Any] ?? [:]
        let deviceList = root["deviceList"] as? [String: Any] ?? [:]
        let mapList = root["mapList"] as? [String: Any] ?? [:]

        let devices = parseDevices(deviceList: deviceList)
        let activities = parseActivities(activityList: activityList)
        let devicesById = Dictionary(uniqueKeysWithValues: devices.map { ($0.id, $0) })

        var activityButtons: [String: [String: ResolvedButtonAction]] = [:]
        var activitySoftButtons: [String: [SoftButton]] = [:]

        for activity in activities {
            activityButtons[activity.id] = resolveActivityButtons(
                mapList: mapList,
                activityId: activity.id,
                devicesById: devicesById
            )
            activitySoftButtons[activity.id] = resolveActivitySoftButtons(
                mapList: mapList,
                activityId: activity.id,
                devicesById: devicesById
            )
        }

        return HubConfigSnapshot(
            revision: revision,
            activities: activities,
            devices: devices,
            activityButtons: activityButtons,
            activitySoftButtons: activitySoftButtons
        )
    }

    public static func parseActivities(activityList: [String: Any]) -> [HubActivity] {
        guard let rawActivities = activityList["Activities"] as? [[String: Any]] else {
            return []
        }
        var parsed: [(index: Int, activity: HubActivity)] = []
        for (idx, obj) in rawActivities.enumerated() {
            guard let id = stringValue(obj["Id-"]) ?? stringValue(obj["Id"]), !id.isEmpty else {
                continue
            }
            let name = stringValue(obj["Name"])?.takeIfNonEmpty
                ?? stringValue(obj["ActivityDisplayName"])?.takeIfNonEmpty
                ?? "Activity \(id)"
            let displayName = stringValue(obj["ActivityDisplayName"])?.takeIfNonEmpty ?? name
            let type = intValue(obj["Type"]) ?? 1
            let order = intValue(obj["ActivityOrder"]) ?? idx
            let rawRoles = obj["Roles"] as? [[String: Any]] ?? []
            let roles: [HubRole] = rawRoles.compactMap { rObj in
                guard let devId = stringValue(rObj["DeviceId-"]) ?? stringValue(rObj["DeviceId"]), !devId.isEmpty else {
                    return nil
                }
                let roleType = stringValue(rObj["__type"]) ?? "DisplayActivityRole"
                let selInputObj = rObj["SelectedInput"] as? [String: Any]
                let selectedInput = stringValue(selInputObj?["Name"])?.takeIfNonEmpty
                return HubRole(
                    id: intValue(rObj["Id-"]) ?? 0,
                    deviceId: devId,
                    roleType: roleType,
                    selectedInput: selectedInput,
                    powerOnOrder: intValue(rObj["PowerOnOrder"]) ?? 1,
                    powerOffOrder: intValue(rObj["PowerOffOrder"]) ?? 1
                )
            }
            parsed.append((
                index: idx,
                activity: HubActivity(
                    id: id,
                    name: name,
                    displayName: displayName,
                    type: type,
                    activityOrder: order,
                    roles: roles
                )
            ))
        }
        return parsed.sorted {
            if $0.activity.activityOrder != $1.activity.activityOrder {
                return $0.activity.activityOrder < $1.activity.activityOrder
            }
            return $0.index < $1.index
        }.map(\.activity)
    }

    public static func parseDevices(deviceList: [String: Any]) -> [HubDevice] {
        guard let rawList = deviceList["DevicesWithFeatures"] as? [[String: Any]] else {
            return []
        }
        return rawList.compactMap { entry in
            let dev = (entry["Device"] as? [String: Any]) ?? entry
            guard let id = stringValue(dev["Id-"]) ?? stringValue(dev["Id"]), !id.isEmpty else {
                return nil
            }
            let name = stringValue(dev["Name"])?.takeIfNonEmpty
                ?? stringValue(dev["FriendlyName"])?.takeIfNonEmpty
                ?? "Device \(id)"
            let rawCommands = entry["Commands"] as? [[String: Any]] ?? []
            let commands: [DeviceCommand] = rawCommands.compactMap { cObj in
                guard let cName = (stringValue(cObj["Name"]) ?? stringValue(cObj["CommandName"]))?.takeIfNonEmpty else {
                    return nil
                }
                return DeviceCommand(
                    name: cName,
                    functionId: intValue(cObj["FunctionId-"]) ?? intValue(cObj["Id-"]) ?? 0,
                    keyCode: stringValue(cObj["KeyCode"]) ?? ""
                )
            }
            let featureInputs = parseFeatureInputs(entry: entry)
            let inputs: [String]
            if !featureInputs.isEmpty {
                inputs = featureInputs
            } else {
                var seen = Set<String>()
                var derived: [String] = []
                for cmd in commands where cmd.name.lowercased().hasPrefix("input") {
                    let stripped = String(cmd.name.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    let val = stripped.isEmpty ? cmd.name : stripped
                    if !seen.contains(val) {
                        seen.insert(val)
                        derived.append(val)
                    }
                }
                inputs = derived
            }
            let autoDetectedObj = dev["AutoDetectedDevice"] as? [String: Any]
            let autoDetectedId = stringValue(autoDetectedObj?["Id"]) ?? ""
            return HubDevice(
                id: id,
                name: name,
                manufacturer: stringValue(dev["Manufacturer"]) ?? "",
                model: stringValue(dev["Model"]) ?? "",
                type: stringValue(dev["DeviceTypeDisplayName"]) ?? stringValue(dev["DeviceType"]) ?? "",
                transport: intValue(dev["Transport"]) ?? 1,
                btAddress: stringValue(dev["BTAddress"]) ?? "",
                commands: commands,
                inputs: inputs,
                autoDetectedId: autoDetectedId
            )
        }
    }

    private static func parseFeatureInputs(entry: [String: Any]) -> [String] {
        guard let features = entry["DeviceFeatures"] as? [[String: Any]] else { return [] }
        let rawInputs: [[String: Any]] = features.flatMap { feature in
            (feature["Inputs"] as? [[String: Any]]) ?? []
        }
        let sorted = rawInputs.sorted {
            (intValue($0["InputOrder"]) ?? Int.max) < (intValue($1["InputOrder"]) ?? Int.max)
        }
        var seen = Set<String>()
        var names: [String] = []
        for input in sorted {
            if let name = stringValue(input["InputName"])?.takeIfNonEmpty, !seen.contains(name) {
                seen.insert(name)
                names.append(name)
            }
        }
        return names
    }

    public static func resolveActivityButtons(
        mapList: [String: Any],
        activityId: String,
        devicesById: [String: HubDevice]
    ) -> [String: ResolvedButtonAction] {
        guard let buttonMaps = mapList["ButtonMaps"] as? [[String: Any]] else { return [:] }
        let ownIdentifier = "16414Activity\(activityId)"
        let touchIdentifier = "16417Activity\(activityId)"

        let activityMaps = buttonMaps.filter { map in
            let mapActId = stringValue(map["ActivityId-"])
            let mapType = stringValue(map["__type"]) ?? ""
            return mapActId == activityId && mapType.contains("ActivityButtonMap")
        }.sorted { a, b in
            let idA = stringValue(a["ButtonMapIdentifier"]) ?? ""
            let idB = stringValue(b["ButtonMapIdentifier"]) ?? ""
            let rankA = idA == ownIdentifier ? 0 : (idA == touchIdentifier ? 1 : 2)
            let rankB = idB == ownIdentifier ? 0 : (idB == touchIdentifier ? 1 : 2)
            return rankA < rankB
        }

        var out: [String: ResolvedButtonAction] = [:]
        for map in activityMaps {
            guard let buttons = map["Buttons"] as? [[String: Any]] else { continue }
            for btn in buttons {
                let btnType = stringValue(btn["__type"]) ?? ""
                if !btnType.isEmpty && btnType != "HardRemoteButton" { continue }
                guard let key = RemoteKeyMapping.canonicalKey(for: stringValue(btn["ButtonKey"])) else { continue }
                if out[key] != nil { continue }

                guard let pressAction = btn["ButtonAction"] as? [String: Any],
                      let pressDevId = stringValue(pressAction["DeviceId-"])?.takeIfNonEmpty,
                      let pressCmd = stringValue(pressAction["CommandName"])?.takeIfNonEmpty else {
                    continue
                }
                let pressFnId = intValue(pressAction["FunctionId-"]) ?? 0

                let holdAction = btn["ButtonLongPressAction"] as? [String: Any]
                let holdDevId = stringValue(holdAction?["DeviceId-"])?.takeIfNonEmpty
                let holdCmd = stringValue(holdAction?["CommandName"])?.takeIfNonEmpty
                let holdFnId = intValue(holdAction?["FunctionId-"]) ?? 0

                let doubleAction = btn["ButtonDoublePressAction"] as? [String: Any]
                let doubleDevId = stringValue(doubleAction?["DeviceId-"])?.takeIfNonEmpty
                let doubleCmd = stringValue(doubleAction?["CommandName"])?.takeIfNonEmpty
                let doubleFnId = intValue(doubleAction?["FunctionId-"]) ?? 0

                out[key] = ResolvedButtonAction(
                    buttonKey: key,
                    buttonLabel: RemoteKeyMapping.keyLabels[key] ?? key,
                    pressDeviceId: pressDevId,
                    pressDeviceName: devicesById[pressDevId]?.name ?? "Device \(pressDevId)",
                    pressCommand: pressCmd,
                    pressFunctionId: pressFnId,
                    holdDeviceId: holdDevId,
                    holdDeviceName: holdDevId.map { devicesById[$0]?.name ?? "Device \($0)" },
                    holdCommand: holdCmd,
                    holdFunctionId: holdFnId,
                    doublePressDeviceId: doubleDevId,
                    doublePressDeviceName: doubleDevId.map { devicesById[$0]?.name ?? "Device \($0)" },
                    doublePressCommand: doubleCmd,
                    doublePressFunctionId: doubleFnId
                )
            }
        }
        return out
    }

    public static func resolveActivitySoftButtons(
        mapList: [String: Any],
        activityId: String,
        devicesById: [String: HubDevice]
    ) -> [SoftButton] {
        guard let buttonMaps = mapList["ButtonMaps"] as? [[String: Any]] else { return [] }
        let touchMaps = buttonMaps.filter { map in
            let mapActId = stringValue(map["ActivityId-"])
            let identifier = stringValue(map["ButtonMapIdentifier"]) ?? ""
            return mapActId == activityId && identifier.hasPrefix("16417")
        }

        var out: [SoftButton] = []
        var seen = Set<String>()

        for map in touchMaps {
            guard let buttons = map["Buttons"] as? [[String: Any]] else { continue }
            for btn in buttons {
                guard stringValue(btn["__type"]) == "SoftRemoteButton",
                      let action = btn["ButtonAction"] as? [String: Any],
                      stringValue(action["__type"]) == "ButtonCommandAction",
                      let deviceId = stringValue(action["DeviceId-"])?.takeIfNonEmpty,
                      let command = stringValue(action["CommandName"])?.takeIfNonEmpty else {
                    continue
                }
                let rawLabel = stringValue(btn["TextOnRemote"])?.takeIfNonEmpty ?? command
                let fgt = intValue(btn["FunctionGroupType"])
                let menuItem = btn["MenuItem"] as? [String: Any]
                let order = intValue(menuItem?["IndexInMenu"]) ?? Int.max

                let holdAction = btn["ButtonLongPressAction"] as? [String: Any]
                let holdDevId = stringValue(holdAction?["DeviceId-"])?.takeIfNonEmpty
                let holdCmd = stringValue(holdAction?["CommandName"])?.takeIfNonEmpty
                let holdFnId = intValue(holdAction?["FunctionId-"]) ?? 0

                let soft = SoftButton(
                    label: RemoteKeyMapping.humanizeLabel(rawLabel),
                    deviceId: deviceId,
                    deviceName: devicesById[deviceId]?.name ?? "Device \(deviceId)",
                    command: command,
                    functionId: intValue(action["FunctionId-"]) ?? 0,
                    order: order,
                    functionGroupType: fgt,
                    holdDeviceId: holdDevId,
                    holdCommand: holdCmd,
                    holdFunctionId: holdFnId
                )

                let dedupeKey: String
                if soft.digit != nil {
                    dedupeKey = "pad:\(deviceId):\(command)"
                } else {
                    dedupeKey = "soft:\(deviceId):\(command):\(holdDevId ?? ""):\(holdCmd ?? "")"
                }

                if !seen.contains(dedupeKey) {
                    seen.insert(dedupeKey)
                    out.append(soft)
                }
            }
        }
        return out.sorted { $0.order < $1.order }
    }
}

// MARK: - State Digest & Activity State Extraction

public enum HubStateExtractor {
    private static let activityIdPattern = try! NSRegularExpression(
        pattern: #""(?:current)?activityId"\s*:\s*"?(-?\d+)"?"#,
        options: [.caseInsensitive]
    )
    private static let resultIdPattern = try! NSRegularExpression(
        pattern: #""result"\s*:\s*"?(-?\d+)"?"#,
        options: [.caseInsensitive]
    )
    private static let activityStatusPattern = try! NSRegularExpression(
        pattern: #""activityStatus"\s*:\s*"?(\d+)"?"#,
        options: [.caseInsensitive]
    )
    private static let stateVersionPattern = try! NSRegularExpression(
        pattern: #""stateVersion"\s*:\s*"?(\d+)"?"#,
        options: [.caseInsensitive]
    )
    private static let bareIntPattern = try! NSRegularExpression(
        pattern: #"^-?\d+$"#
    )

    /// Extracts the current activity ID from `/api/activity-state` or `/api/state` replies.
    /// `codex_webui` wraps the HBus reply as an escaped JSON string, so backslashes are stripped first.
    public static func extractCurrentActivityId(_ payloadText: String) -> String {
        let unescaped = payloadText.replacingOccurrences(of: "\\", with: "")
        if let id = firstCapture(in: unescaped, regex: activityIdPattern) ??
                    firstCapture(in: unescaped, regex: resultIdPattern) {
            return id
        }
        let trimmed = payloadText.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"")))
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        if bareIntPattern.firstMatch(in: trimmed, range: range) != nil {
            return trimmed
        }
        return ""
    }

    public static func extractActivityStatus(_ payloadText: String) -> Int? {
        let unescaped = payloadText.replacingOccurrences(of: "\\", with: "")
        guard let str = firstCapture(in: unescaped, regex: activityStatusPattern) else { return nil }
        return Int(str)
    }

    public static func extractStateVersion(_ payloadText: String) -> String? {
        let unescaped = payloadText.replacingOccurrences(of: "\\", with: "")
        return firstCapture(in: unescaped, regex: stateVersionPattern)
    }

    private static func firstCapture(in text: String, regex: NSRegularExpression) -> String? {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[captureRange])
    }
}

private extension String {
    var takeIfNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
