import Foundation

/// Discovered or user-configured Harmony Hub endpoint on the local network.
public struct HubEndpoint: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { "\(host):\(webUiPort)" }
    public var name: String
    public var host: String
    public var webUiPort: Int
    public var hbusPort: Int
    public var hubId: String
    public var firmware: String
    public var melodiousVersion: String
    public var features: [String]
    public var isSimulated: Bool
    public var basicAuthHeader: String?

    public init(
        name: String,
        host: String,
        webUiPort: Int = 8080,
        hbusPort: Int = 8088,
        hubId: String = "",
        firmware: String = "",
        melodiousVersion: String = "",
        features: [String] = [],
        isSimulated: Bool = false,
        basicAuthHeader: String? = nil
    ) {
        self.name = name
        self.host = host
        self.webUiPort = webUiPort
        self.hbusPort = hbusPort
        self.hubId = hubId
        self.firmware = firmware
        self.melodiousVersion = melodiousVersion
        self.features = features
        self.isSimulated = isSimulated
        self.basicAuthHeader = basicAuthHeader
    }

    private var formattedHost: String {
        if host.contains(":") && !host.hasPrefix("[") {
            return "[\(host)]"
        }
        return host
    }

    public var baseUrlString: String {
        "http://\(formattedHost):\(webUiPort)"
    }

    public var baseURL: URL? {
        URL(string: baseUrlString)
    }

    public var hbusWsUrlString: String {
        let trimmedHubId = hubId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedHubId.isEmpty {
            let encoded = trimmedHubId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmedHubId
            return "ws://\(formattedHost):\(hbusPort)/?domain=svcs.myharmony.com&hubId=\(encoded)"
        }
        return "ws://\(formattedHost):\(hbusPort)/"
    }

    public var hbusWsURL: URL? {
        URL(string: hbusWsUrlString)
    }

    public var displayAddress: String {
        "\(host):\(webUiPort)"
    }

    /// Parses a user-entered address (e.g. `192.168.1.50`, `192.168.1.50:8080`, `http://127.0.0.1:8787/`)
    /// into a clean host and port.
    public static func parseAddress(_ rawInput: String, defaultPort: Int = 8080) -> (host: String, port: Int)? {
        var text = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        guard (1...65535).contains(defaultPort) else { return nil }

        if text.lowercased().hasPrefix("http://") {
            text = String(text.dropFirst("http://".count))
        } else if text.lowercased().hasPrefix("https://") {
            text = String(text.dropFirst("https://".count))
        } else if text.lowercased().hasPrefix("ws://") {
            text = String(text.dropFirst("ws://".count))
        }

        if let slashIndex = text.firstIndex(of: "/") {
            text = String(text[..<slashIndex])
        }

        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        // Reject embedded whitespace or control characters
        if text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) {
            return nil
        }

        var hostPart = text
        var portPart: Int = defaultPort

        if text.hasPrefix("[") {
            guard let closeBracket = text.firstIndex(of: "]") else { return nil }
            hostPart = String(text[text.index(after: text.startIndex)..<closeBracket])
            let remainder = String(text[text.index(after: closeBracket)...])
            if remainder.hasPrefix(":") {
                let portStr = String(remainder.dropFirst())
                guard let parsedPort = Int(portStr), (1...65535).contains(parsedPort) else { return nil }
                portPart = parsedPort
            } else if !remainder.isEmpty {
                return nil
            }
        } else if let colonIndex = text.lastIndex(of: ":") {
            let beforeColon = String(text[..<colonIndex])
            let afterColon = String(text[text.index(after: colonIndex)...])
            if beforeColon.contains(":") {
                // Unbracketed IPv6 literal unsupported with port
                return nil
            }
            guard !afterColon.isEmpty, let parsedPort = Int(afterColon), (1...65535).contains(parsedPort) else {
                return nil
            }
            hostPart = beforeColon
            portPart = parsedPort
        }

        hostPart = hostPart.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hostPart.isEmpty else { return nil }
        let allowedHostChars = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_:"))
        guard hostPart.unicodeScalars.allSatisfy({ allowedHostChars.contains($0) }) else {
            return nil
        }

        return (host: hostPart, port: portPart)
    }

    public static func buildBasicAuthHeader(username: String, password: String) -> String {
        let raw = "\(username):\(password)"
        let data = Data(raw.utf8)
        return "Basic \(data.base64EncodedString())"
    }
}

/// Melodious software version and capability flags from `GET /api/version`.
public struct HubVersionInfo: Codable, Equatable, Sendable {
    public let ok: Bool
    public let product: String
    public let version: String
    public let api: Int
    public let features: [String]

    public init(ok: Bool = true, product: String = "melodious", version: String, api: Int = 1, features: [String] = []) {
        self.ok = ok
        self.product = product
        self.version = version
        self.api = api
        self.features = features
    }
}

/// System status summary from `GET /api/system-status`.
public struct HubSystemStatus: Codable, Equatable, Sendable {
    public let ok: Bool
    public let firmware: String
    public let uptime: String
    public let uname: String
    public let authMode: String

    public init(
        ok: Bool = true,
        firmware: String = "",
        uptime: String = "",
        uname: String = "",
        authMode: String = "open on local network"
    ) {
        self.ok = ok
        self.firmware = firmware
        self.uptime = uptime
        self.uname = uname
        self.authMode = authMode
    }

    public var isSimulated: Bool {
        firmware.localizedCaseInsensitiveContains("SIMULATED") ||
        uname.localizedCaseInsensitiveContains("SIMULATED")
    }
}

/// Domain representation of a hub activity parsed from `GET /api/activity-config`.
public struct HubActivity: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let displayName: String
    public let type: Int
    public let activityOrder: Int
    public let roles: [HubRole]
    /// The activity's ImageKey ("Activity/<name>.png"), or nil. docs/REMOTE_PICTURES.md
    public let imageKey: String?

    public init(
        id: String,
        name: String,
        displayName: String? = nil,
        type: Int = 1,
        activityOrder: Int = 0,
        roles: [HubRole] = [],
        imageKey: String? = nil
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName ?? name
        self.type = type
        self.activityOrder = activityOrder
        self.roles = roles
        self.imageKey = imageKey
    }

    /// The name the hub stores this activity's own icon under, or nil.
    public var imageName: String? {
        guard let key = imageKey, key.hasPrefix("Activity/"), key.hasSuffix(".png") else { return nil }
        let name = String(key.dropFirst("Activity/".count).dropLast(".png".count))
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard (1...96).contains(name.count), !name.hasSuffix("_small"),
              name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return name
    }

    public var typeLabel: String {
        switch type {
        case 1: return "Watch TV"
        case 2: return "Watch a movie"
        case 3: return "Play a game"
        case 4: return "Listen to music"
        default: return "Activity"
        }
    }

    public var systemIconName: String {
        let lower = name.lowercased()
        if lower.contains("pc") || lower.contains("computer") {
            return "desktopcomputer"
        }
        switch type {
        case 1: return "tv"
        case 2: return "film"
        case 3: return "gamecontroller"
        case 4: return "music.note"
        default: return "play.fill"
        }
    }
}

public struct HubRole: Codable, Equatable, Hashable, Sendable {
    public let id: Int
    public let deviceId: String
    public let roleType: String
    public let selectedInput: String?
    public let powerOnOrder: Int
    public let powerOffOrder: Int

    public init(
        id: Int = 0,
        deviceId: String,
        roleType: String,
        selectedInput: String? = nil,
        powerOnOrder: Int = 1,
        powerOffOrder: Int = 1
    ) {
        self.id = id
        self.deviceId = deviceId
        self.roleType = roleType
        self.selectedInput = selectedInput
        self.powerOnOrder = powerOnOrder
        self.powerOffOrder = powerOffOrder
    }
}

public struct HubDevice: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let manufacturer: String
    public let model: String
    public let type: String
    public let transport: Int
    public let btAddress: String
    public let commands: [DeviceCommand]
    public let inputs: [String]
    public let autoDetectedId: String

    public init(
        id: String,
        name: String,
        manufacturer: String = "",
        model: String = "",
        type: String = "",
        transport: Int = 1,
        btAddress: String = "",
        commands: [DeviceCommand] = [],
        inputs: [String] = [],
        autoDetectedId: String = ""
    ) {
        self.id = id
        self.name = name
        self.manufacturer = manufacturer
        self.model = model
        self.type = type
        self.transport = transport
        self.btAddress = btAddress
        self.commands = commands
        self.inputs = inputs
        self.autoDetectedId = autoDetectedId
    }

    public var isBluetoothHid: Bool {
        transport == 32
    }

    public var isNetworkTv: Bool {
        autoDetectedId.hasPrefix("melodious-androidtv-")
    }

    public var isHomeAssistant: Bool {
        !isNetworkTv && (transport == 64 || manufacturer.localizedCaseInsensitiveContains("home assistant"))
    }

    public var transportBadge: String {
        if isHomeAssistant { return "Home Assistant" }
        if isNetworkTv { return "Network TV" }
        if isBluetoothHid { return "Bluetooth" }
        return "IR"
    }

    public var subtitle: String {
        let brandModel = [manufacturer, model]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !brandModel.isEmpty {
            return "\(brandModel) · \(commands.count) commands"
        }
        return "\(transportBadge) · \(commands.count) commands"
    }

    public var systemIconName: String {
        let lowerType = type.lowercased()
        let lowerName = "\(name) \(model)".lowercased()
        let streamers = ["shield", "google tv", "chromecast", "apple tv", "roku", "fire tv", "firestick"]
        if streamers.contains(where: { lowerName.contains($0) }) { return "appletv" }
        if lowerType.contains("television") || lowerType.contains("tv") || lowerType.contains("projector") { return "tv" }
        if lowerType.contains("amplifier") || lowerType.contains("receiver") || lowerType.contains("sound") || lowerType.contains("speaker") { return "hifispeaker" }
        if lowerType.contains("game") || lowerType.contains("console") { return "gamecontroller" }
        if lowerType.contains("computer") || lowerType.contains("pc") { return "desktopcomputer" }
        if isHomeAssistant { return "house" }
        if isBluetoothHid { return "keyboard" }
        return "av.remote"
    }
}

public struct DeviceCommand: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { "\(functionId)-\(name)" }
    public let name: String
    public let functionId: Int
    public let keyCode: String

    public init(name: String, functionId: Int = 0, keyCode: String = "") {
        self.name = name
        self.functionId = functionId
        self.keyCode = keyCode
    }
}

/// Resolved button action for a hard key or digit button in an activity or device remote.
public struct ResolvedButtonAction: Codable, Equatable, Hashable, Sendable {
    public let buttonKey: String
    public let buttonLabel: String
    public let pressDeviceId: String
    public let pressDeviceName: String
    public let pressCommand: String
    public let pressFunctionId: Int
    public let holdDeviceId: String?
    public let holdDeviceName: String?
    public let holdCommand: String?
    public let holdFunctionId: Int
    public let doublePressDeviceId: String?
    public let doublePressDeviceName: String?
    public let doublePressCommand: String?
    public let doublePressFunctionId: Int

    public init(
        buttonKey: String,
        buttonLabel: String,
        pressDeviceId: String,
        pressDeviceName: String,
        pressCommand: String,
        pressFunctionId: Int = 0,
        holdDeviceId: String? = nil,
        holdDeviceName: String? = nil,
        holdCommand: String? = nil,
        holdFunctionId: Int = 0,
        doublePressDeviceId: String? = nil,
        doublePressDeviceName: String? = nil,
        doublePressCommand: String? = nil,
        doublePressFunctionId: Int = 0
    ) {
        self.buttonKey = buttonKey
        self.buttonLabel = buttonLabel
        self.pressDeviceId = pressDeviceId
        self.pressDeviceName = pressDeviceName
        self.pressCommand = pressCommand
        self.pressFunctionId = pressFunctionId
        self.holdDeviceId = holdDeviceId
        self.holdDeviceName = holdDeviceName
        self.holdCommand = holdCommand
        self.holdFunctionId = holdFunctionId
        self.doublePressDeviceId = doublePressDeviceId
        self.doublePressDeviceName = doublePressDeviceName
        self.doublePressCommand = doublePressCommand
        self.doublePressFunctionId = doublePressFunctionId
    }

    public var hasHold: Bool {
        guard let holdCmd = holdCommand, let holdDev = holdDeviceId else { return false }
        return !holdCmd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
               !holdDev.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var summaryText: String {
        "\(pressDeviceName) · \(pressCommand)"
    }
}

/// An on-screen ("soft") button from an activity's touch-screen map (`16417Activity<id>`).
public struct SoftButton: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { "\(order)-\(deviceId)-\(command)-\(label)" }
    public let label: String
    public let deviceId: String
    public let deviceName: String
    public let command: String
    public let functionId: Int
    public let order: Int
    public let functionGroupType: Int?
    public let holdDeviceId: String?
    public let holdCommand: String?
    public let holdFunctionId: Int

    public init(
        label: String,
        deviceId: String,
        deviceName: String,
        command: String,
        functionId: Int = 0,
        order: Int = 0,
        functionGroupType: Int? = nil,
        holdDeviceId: String? = nil,
        holdCommand: String? = nil,
        holdFunctionId: Int = 0
    ) {
        self.label = label
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.command = command
        self.functionId = functionId
        self.order = order
        self.functionGroupType = functionGroupType
        self.holdDeviceId = holdDeviceId
        self.holdCommand = holdCommand
        self.holdFunctionId = holdFunctionId
    }

    /// Single digit keys on the number pad (`FunctionGroupType == 2`, or untyped bare digits),
    /// excluded from the soft-button list and merged into the number pad when not already mapped.
    public var digit: Int? {
        if functionGroupType == 0 { return nil }
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 1, let value = Int(trimmed), (0...9).contains(value) else { return nil }
        return value
    }
}

/// Parsed snapshot of `GET /api/activity-config`.
public struct HubConfigSnapshot: Equatable, Sendable {
    public let revision: String
    public let activities: [HubActivity]
    public let devices: [HubDevice]
    public let activityButtons: [String: [String: ResolvedButtonAction]]
    public let activitySoftButtons: [String: [SoftButton]]

    public init(
        revision: String,
        activities: [HubActivity],
        devices: [HubDevice],
        activityButtons: [String: [String: ResolvedButtonAction]] = [:],
        activitySoftButtons: [String: [SoftButton]] = [:]
    ) {
        self.revision = revision
        self.activities = activities
        self.devices = devices
        self.activityButtons = activityButtons
        self.activitySoftButtons = activitySoftButtons
    }

    public func activity(id: String) -> HubActivity? {
        activities.first { $0.id == id }
    }

    public func device(id: String) -> HubDevice? {
        devices.first { $0.id == id }
    }

    public func deviceNames(for activity: HubActivity) -> [String] {
        var seen = Set<String>()
        var names: [String] = []
        for role in activity.roles.sorted(by: { $0.powerOnOrder < $1.powerOnOrder }) {
            if let dev = device(id: role.deviceId), !seen.contains(dev.name) {
                seen.insert(dev.name)
                names.append(dev.name)
            }
        }
        return names
    }

    public func participatingDevices(for activity: HubActivity) -> [HubDevice] {
        let roleDeviceIds = Set(activity.roles.map(\.deviceId))
        var result: [HubDevice] = []
        var seen = Set<String>()
        for role in activity.roles.sorted(by: { $0.powerOnOrder < $1.powerOnOrder }) {
            if let dev = device(id: role.deviceId), !seen.contains(dev.id) {
                seen.insert(dev.id)
                result.append(dev)
            }
        }
        for dev in devices where roleDeviceIds.contains(dev.id) && !seen.contains(dev.id) {
            seen.insert(dev.id)
            result.append(dev)
        }
        return result
    }

    /// Returns all mapped remote keys for an activity (including number-pad digit fallback from soft buttons).
    public func resolvedKeyMap(forActivityId activityId: String) -> [String: ResolvedButtonAction] {
        var map = activityButtons[activityId] ?? [:]
        let soft = activitySoftButtons[activityId] ?? []
        for button in soft {
            if let d = button.digit {
                let key = "Number\(d)"
                if map[key] == nil {
                    map[key] = ResolvedButtonAction(
                        buttonKey: key,
                        buttonLabel: "\(d)",
                        pressDeviceId: button.deviceId,
                        pressDeviceName: button.deviceName,
                        pressCommand: button.command,
                        pressFunctionId: button.functionId
                    )
                }
            }
        }
        return map
    }

    /// Returns on-screen extra soft buttons for an activity (excluding number-pad digits).
    public func extraSoftButtons(forActivityId activityId: String) -> [SoftButton] {
        (activitySoftButtons[activityId] ?? []).filter { $0.digit == nil }
    }
}

/// Poll result from `GET /api/state?version=...`.
public struct HubStatePoll: Equatable, Sendable {
    public let changed: Bool
    public let version: String?
    public let activityId: String?
    public let activityStatus: Int?

    public init(changed: Bool, version: String?, activityId: String?, activityStatus: Int?) {
        self.changed = changed
        self.version = version
        self.activityId = activityId
        self.activityStatus = activityStatus
    }
}
