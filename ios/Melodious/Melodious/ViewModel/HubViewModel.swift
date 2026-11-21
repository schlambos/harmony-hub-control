import Foundation
import SwiftUI
import UIKit

public enum HubConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case unreachable(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

public enum RemoteTarget: Equatable, Hashable, Sendable {
    case activity(String)
    case device(String)
}

public struct SendLogItem: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let timestamp: String
    public let label: String
    public let targetSummary: String
    public let isError: Bool

    public init(id: UUID = UUID(), timestamp: String, label: String, targetSummary: String, isError: Bool = false) {
        self.id = id
        self.timestamp = timestamp
        self.label = label
        self.targetSummary = targetSummary
        self.isError = isError
    }
}

public struct BannerMessage: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let text: String
    public let isError: Bool

    public init(id: UUID = UUID(), text: String, isError: Bool = false) {
        self.id = id
        self.text = text
        self.isError = isError
    }
}

@MainActor
public final class HubViewModel: ObservableObject {
    @Published public var connectionStatus: HubConnectionStatus = .disconnected
    @Published public var activeEndpoint: HubEndpoint?
    @Published public var savedHubs: [HubEndpoint] = []
    @Published public var discoveredHubs: [HubEndpoint] = []
    @Published public var isScanningSubnet: Bool = false
    @Published public var hbusConnected: Bool = false

    @Published public var versionInfo: HubVersionInfo?
    @Published public var systemStatus: HubSystemStatus?
    @Published public var configSnapshot: HubConfigSnapshot?

    @Published public var currentActivityId: String = "-1"
    @Published public var pendingActivityId: String?
    @Published public var activityStatus: Int?
    @Published public var previewActivityId: String?
    @Published public var selectedDeviceOverlayId: String?

    @Published public var statusLine: String = "Tap or hold a key to send commands"
    @Published public var bannerMessage: BannerMessage?
    @Published public var sendLog: [SendLogItem] = []

    public let restClient: HubRestClient

    /// Activity icons the hub stores (docs/REMOTE_IMAGES.md), decoded once per
    /// name. A new icon always gets a new name, so a cached image never goes
    /// stale.
    private let activityImages = NSCache<NSString, UIImage>()
    /// When the hub last didn't have an image: views redraw often, so a miss
    /// isn't asked for again for a minute.
    private var missingActivityImages: [String: Date] = [:]

    /// The activity's own icon from the hub, or nil (none, not stored, or unreachable).
    public func activityImage(_ activity: HubActivity) async -> UIImage? {
        guard let name = activity.imageName, let endpoint = activeEndpoint else { return nil }
        let key = "\(endpoint.displayAddress)/\(name)" as NSString
        if let cached = activityImages.object(forKey: key) { return cached }
        if let missedAt = missingActivityImages[key as String], Date().timeIntervalSince(missedAt) < 60 { return nil }
        guard let data = await restClient.getRemoteImage(endpoint: endpoint, name: name),
              let image = UIImage(data: data) else {
            missingActivityImages[key as String] = Date()
            return nil
        }
        missingActivityImages[key as String] = nil
        activityImages.setObject(image, forKey: key)
        return image
    }
    public let hbusClient: HBusWebSocketClient
    public let savedHubStore: SavedHubStore

    private var statePollTask: Task<Void, Never>?
    private var lastStateVersion: String?

    // Active key interaction tracking
    private var activePressKey: String?
    private var activePressConsumed: Bool = false
    private var holdTimerTask: Task<Void, Never>?
    private var httpHoldLoopTask: Task<Void, Never>?
    private var activeHttpHold: (endpoint: HubEndpoint, deviceId: String, command: String, functionId: Int, activityId: String?, holdId: String, pressTask: Task<Bool, Never>)?
    private var isHBusHolding: Bool = false

    public init(
        restClient: HubRestClient = HubRestClient(),
        hbusClient: HBusWebSocketClient? = nil,
        savedHubStore: SavedHubStore = SavedHubStore()
    ) {
        self.restClient = restClient
        self.hbusClient = hbusClient ?? HBusWebSocketClient()
        self.savedHubStore = savedHubStore
        self.savedHubs = savedHubStore.savedHubs

        self.hbusClient.onConnectionStateChange = { [weak self] state in
            guard let self = self else { return }
            self.hbusConnected = (state == .connected)
        }
        self.hbusClient.onStateDigest = { [weak self] digest in
            guard let self = self else { return }
            self.applyHubState(activityId: digest.activityId, status: digest.activityStatus)
        }
    }

    // MARK: - Computed Properties

    public var activities: [HubActivity] {
        configSnapshot?.activities ?? []
    }

    public var devices: [HubDevice] {
        configSnapshot?.devices ?? []
    }

    public var runningActivity: HubActivity? {
        guard currentActivityId != "-1" && !currentActivityId.isEmpty else { return nil }
        return activities.first { $0.id == currentActivityId }
    }

    public var displayedActivity: HubActivity? {
        if let running = runningActivity {
            return running
        }
        if let previewId = previewActivityId,
           let preview = activities.first(where: { $0.id == previewId }) {
            return preview
        }
        return nil
    }

    public var isEverythingOff: Bool {
        currentActivityId.isEmpty || currentActivityId == "-1"
    }

    // MARK: - Connection Lifecycle

    public func start() {
        if let envAddress = ProcessInfo.processInfo.environment["MELODIOUS_HUB_URL"],
           let parsed = HubEndpoint.parseAddress(envAddress) {
            let ep = HubEndpoint(
                name: parsed.port == 8787 ? "Hub Simulator (\(parsed.host))" : "Harmony Hub (\(parsed.host))",
                host: parsed.host,
                webUiPort: parsed.port,
                isSimulated: parsed.port == 8787
            )
            Task {
                let connected = await connect(to: ep)
                if let autoAct = ProcessInfo.processInfo.environment["MELODIOUS_AUTO_START_ACTIVITY"],
                   connected, !autoAct.isEmpty {
                    await startActivity(autoAct)
                }
            }
            return
        }

        if let saved = savedHubStore.activeHub {
            Task {
                let ok = await connect(to: saved)
                if !ok {
                    await scanSubnet(autoConnectIfSingle: true)
                }
            }
        } else {
            Task {
                await scanSubnet(autoConnectIfSingle: true)
            }
        }
    }

    @discardableResult
    public func connectManual(hostInput: String, portInput: String, username: String = "", password: String = "") async -> Bool {
        let trimmedHost = hostInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPort = portInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultPort: Int
        if trimmedPort.isEmpty {
            defaultPort = 8080
        } else if let p = Int(trimmedPort), (1...65535).contains(p) {
            defaultPort = p
        } else {
            let msg = "Port must be a number between 1 and 65535."
            connectionStatus = .unreachable(msg)
            showBanner(msg, isError: true)
            return false
        }

        guard let parsed = HubEndpoint.parseAddress(trimmedHost, defaultPort: defaultPort) else {
            let msg = "Enter a valid hub IP address or hostname (for example 192.168.1.50 or 127.0.0.1:8787)."
            connectionStatus = .unreachable(msg)
            showBanner(msg, isError: true)
            return false
        }

        let authHeader: String? = {
            let cleanUser = username.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanUser.isEmpty else { return nil }
            return HubEndpoint.buildBasicAuthHeader(username: cleanUser, password: password)
        }()

        let endpoint = HubEndpoint(
            name: parsed.port == 8787 ? "Hub Simulator (\(parsed.host))" : "Harmony Hub (\(parsed.host))",
            host: parsed.host,
            webUiPort: parsed.port,
            hbusPort: 8088,
            isSimulated: parsed.port == 8787,
            basicAuthHeader: authHeader
        )
        return await connect(to: endpoint)
    }

    @discardableResult
    public func connect(to endpoint: HubEndpoint) async -> Bool {
        cancelActiveKeyInteraction()
        statePollTask?.cancel()
        hbusClient.disconnect()

        connectionStatus = .connecting
        activeEndpoint = endpoint

        do {
            async let configTask = restClient.getActivityConfig(endpoint: endpoint)
            async let stateTask = restClient.getActivityState(endpoint: endpoint)
            async let versionTask = try? restClient.getVersion(endpoint: endpoint)
            async let sysTask = try? restClient.getSystemStatus(endpoint: endpoint)

            let config = try await configTask
            let currentId = (try? await stateTask) ?? "-1"
            let ver = await versionTask
            let sys = await sysTask

            let isSim = endpoint.isSimulated || endpoint.webUiPort == 8787 || (sys?.isSimulated == true)
            var updatedEndpoint = endpoint
            updatedEndpoint.isSimulated = isSim
            if let ver = ver {
                updatedEndpoint.melodiousVersion = ver.version
                updatedEndpoint.features = ver.features
            }
            if let sys = sys, !sys.firmware.isEmpty {
                updatedEndpoint.firmware = sys.firmware
            }
            if !isSim && updatedEndpoint.hubId.isEmpty {
                if let fetchedId = await restClient.fetchHubId(endpoint: updatedEndpoint) {
                    updatedEndpoint.hubId = fetchedId
                }
            }
            if updatedEndpoint.name.isEmpty || updatedEndpoint.name.hasPrefix("Hub (") {
                updatedEndpoint.name = isSim ? "Hub Simulator (\(updatedEndpoint.host))" : "Harmony Hub (\(updatedEndpoint.host))"
            }

            self.configSnapshot = config
            self.versionInfo = ver
            self.systemStatus = sys
            self.currentActivityId = currentId
            self.pendingActivityId = nil
            self.activityStatus = nil
            self.activeEndpoint = updatedEndpoint
            self.connectionStatus = .connected
            self.savedHubs = savedHubStore.saveHub(updatedEndpoint, setActive: true)

            self.hbusClient.connect(endpoint: updatedEndpoint)
            self.startStatePolling(for: updatedEndpoint)
            return true
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            self.connectionStatus = .unreachable(msg)
            self.showBanner(msg, isError: true)
            return false
        }
    }

    public func scanSubnet(autoConnectIfSingle: Bool = false) async {
        guard !isScanningSubnet else { return }
        isScanningSubnet = true
        defer { isScanningSubnet = false }

        let found = await SubnetScanner.scanLocalNetwork(
            restClient: restClient,
            port: 8080,
            extraCandidates: savedHubs,
            includeLoopbackSimulator: true
        )
        self.discoveredHubs = found

        if autoConnectIfSingle && !connectionStatus.isConnected {
            if let saved = savedHubStore.activeHub,
               let matched = found.first(where: { $0.id == saved.id }) {
                _ = await connect(to: matched)
            } else if let first = found.first {
                _ = await connect(to: first)
            }
        }
    }

    public func removeSavedHub(_ hub: HubEndpoint) {
        savedHubs = savedHubStore.removeHub(id: hub.id)
        if activeEndpoint?.id == hub.id {
            cancelActiveKeyInteraction()
            statePollTask?.cancel()
            hbusClient.disconnect()
            activeEndpoint = nil
            configSnapshot = nil
            versionInfo = nil
            systemStatus = nil
            connectionStatus = .disconnected
            if let next = savedHubStore.activeHub {
                Task { await connect(to: next) }
            }
        }
    }

    public func refreshHubState() async {
        guard let endpoint = activeEndpoint else { return }
        do {
            async let configTask = restClient.getActivityConfig(endpoint: endpoint)
            async let stateTask = restClient.getActivityState(endpoint: endpoint)
            async let versionTask = try? restClient.getVersion(endpoint: endpoint)
            async let sysTask = try? restClient.getSystemStatus(endpoint: endpoint)

            let config = try await configTask
            let stateId = try await stateTask
            self.configSnapshot = config
            self.versionInfo = await versionTask ?? self.versionInfo
            self.systemStatus = await sysTask ?? self.systemStatus
            applyHubState(activityId: stateId, status: nil)
            if !connectionStatus.isConnected {
                connectionStatus = .connected
            }
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            showBanner(msg, isError: true)
        }
    }

    // MARK: - Activities

    public func startActivity(_ activityId: String) async {
        guard let endpoint = activeEndpoint else {
            showBanner("Not connected to a Harmony Hub.", isError: true)
            return
        }
        pendingActivityId = activityId
        let actName = activities.first(where: { $0.id == activityId })?.name ?? "activity"
        statusLine = "Starting \(actName)…"
        do {
            try await restClient.runActivity(endpoint: endpoint, activityId: activityId)
            let updatedId = (try? await restClient.getActivityState(endpoint: endpoint)) ?? activityId
            applyHubState(activityId: updatedId, status: 2)
            previewActivityId = nil
            statusLine = "\(actName) is running"
        } catch {
            pendingActivityId = nil
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            statusLine = "Couldn't start \(actName): \(msg)"
            showBanner("Couldn't start \(actName) — \(msg)", isError: true)
        }
    }

    public func powerOff() async {
        guard let endpoint = activeEndpoint else {
            showBanner("Not connected to a Harmony Hub.", isError: true)
            return
        }
        pendingActivityId = "-1"
        statusLine = "Turning everything off…"
        do {
            try await restClient.powerOff(endpoint: endpoint)
            let updatedId = (try? await restClient.getActivityState(endpoint: endpoint)) ?? "-1"
            applyHubState(activityId: updatedId, status: 0)
            previewActivityId = nil
            statusLine = "Everything's off"
        } catch {
            pendingActivityId = nil
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            statusLine = "Power off failed: \(msg)"
            showBanner("Couldn't turn off — \(msg)", isError: true)
        }
    }

    private func applyHubState(activityId: String, status: Int?) {
        let finished = status == nil || status == 0 || status == 2
        if let pending = pendingActivityId, pending == activityId, finished {
            pendingActivityId = nil
        }
        currentActivityId = activityId
        activityStatus = status
    }

    private func startStatePolling(for endpoint: HubEndpoint) {
        statePollTask?.cancel()
        lastStateVersion = nil
        statePollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self = self else { break }
                let delayNs: UInt64 = (self.pendingActivityId != nil) ? 1_500_000_000 : 4_000_000_000
                try? await Task.sleep(nanoseconds: delayNs)
                if Task.isCancelled { break }
                do {
                    let poll = try await self.restClient.pollStateDigest(endpoint: endpoint, lastVersion: self.lastStateVersion)
                    self.lastStateVersion = poll.version
                    if poll.changed {
                        let actId: String
                        if let pollAct = poll.activityId {
                            actId = pollAct
                        } else {
                            actId = try await self.restClient.getActivityState(endpoint: endpoint)
                        }
                        self.applyHubState(activityId: actId, status: poll.activityStatus)
                    }
                } catch {
                    // Ignore transient background poll errors
                }
            }
        }
    }

    // MARK: - Remote Key Resolution & Press/Hold/Release

    public func keyMap(for target: RemoteTarget) -> [String: ResolvedButtonAction] {
        guard let snapshot = configSnapshot else { return [:] }
        switch target {
        case .activity(let activityId):
            return snapshot.resolvedKeyMap(forActivityId: activityId)
        case .device(let deviceId):
            guard let device = snapshot.device(id: deviceId) else { return [:] }
            return RemoteKeyMapping.resolveDeviceKeys(for: device)
        }
    }

    public func extraSoftButtons(for activityId: String) -> [SoftButton] {
        configSnapshot?.extraSoftButtons(forActivityId: activityId) ?? []
    }

    /// Called immediately when the user's finger touches down on a remote key.
    public func handleKeyTouchDown(target: RemoteTarget, buttonKey: String) {
        let map = keyMap(for: target)
        guard let resolved = map[buttonKey] else { return }

        cancelActiveKeyInteraction()
        activePressKey = buttonKey
        activePressConsumed = false

        let behavior = RemoteKeyMapping.behavior(for: buttonKey, action: resolved)
        let activityId: String? = {
            if case .activity(let id) = target { return id }
            return nil
        }()

        switch behavior {
        case .holdRepeat:
            // Repeatable keys (Volume, Channel, D-pad) act immediately on press-down!
            activePressConsumed = true
            if hbusConnected {
                // Fire initial tap and schedule HBus continuous hold after 380 ms
                dispatchSingleCommand(
                    deviceId: resolved.pressDeviceId,
                    deviceName: resolved.pressDeviceName,
                    commandName: resolved.pressCommand,
                    functionId: resolved.pressFunctionId,
                    activityId: activityId,
                    keyLabel: resolved.buttonLabel
                )
                holdTimerTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: RemoteKeyMapping.holdDelayMs * 1_000_000)
                    guard !Task.isCancelled, let self = self, self.activePressKey == buttonKey else { return }
                    self.isHBusHolding = true
                    self.statusLine = "Holding \(resolved.buttonLabel) → \(resolved.summaryText)"
                    self.hbusClient.startButtonHold(deviceId: resolved.pressDeviceId, commandName: resolved.pressCommand)
                }
            } else {
                // HTTP hold-lease protocol (`/api/ir-send` status=press -> hold every 200ms -> release)
                startHttpHoldSession(resolved: resolved, activityId: activityId)
            }

        case .longPressAction:
            statusLine = "\(resolved.buttonLabel) → \(resolved.summaryText) (hold for \(resolved.holdCommand ?? "long press"))"
            holdTimerTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: RemoteKeyMapping.longPressDelayMs * 1_000_000)
                guard !Task.isCancelled, let self = self, self.activePressKey == buttonKey else { return }
                self.activePressConsumed = true
                if let holdDevId = resolved.holdDeviceId, let holdCmd = resolved.holdCommand {
                    self.dispatchSingleCommand(
                        deviceId: holdDevId,
                        deviceName: resolved.holdDeviceName ?? resolved.pressDeviceName,
                        commandName: holdCmd,
                        functionId: resolved.holdFunctionId,
                        activityId: activityId,
                        keyLabel: "\(resolved.buttonLabel) (hold)"
                    )
                }
            }

        case .oneShot, .tap:
            statusLine = "\(resolved.buttonLabel) → \(resolved.summaryText)"
        }
    }

    /// Called when the user lifts their finger or slides off the key.
    public func handleKeyTouchUp(target: RemoteTarget, buttonKey: String, cancelled: Bool = false) {
        guard activePressKey == buttonKey else { return }
        let wasConsumed = activePressConsumed
        cancelActiveKeyInteraction()

        guard !cancelled, !wasConsumed else { return }
        let map = keyMap(for: target)
        guard let resolved = map[buttonKey] else { return }
        let activityId: String? = {
            if case .activity(let id) = target { return id }
            return nil
        }()

        dispatchSingleCommand(
            deviceId: resolved.pressDeviceId,
            deviceName: resolved.pressDeviceName,
            commandName: resolved.pressCommand,
            functionId: resolved.pressFunctionId,
            activityId: activityId,
            keyLabel: resolved.buttonLabel
        )
    }

    public func cancelActiveKeyInteraction() {
        holdTimerTask?.cancel()
        holdTimerTask = nil

        if isHBusHolding {
            isHBusHolding = false
            hbusClient.stopButtonHold()
        }

        httpHoldLoopTask?.cancel()
        httpHoldLoopTask = nil
        if let hold = activeHttpHold {
            activeHttpHold = nil
            let client = restClient
            Task {
                // Always let the initial HTTP press complete before sending release, so quick taps
                // never cancel the in-flight press request or deliver release out of order.
                let pressSucceeded = await hold.pressTask.value
                guard pressSucceeded else { return }
                try? await client.irSend(
                    endpoint: hold.endpoint,
                    deviceId: hold.deviceId,
                    command: hold.command,
                    functionId: hold.functionId,
                    activityId: hold.activityId,
                    status: "release",
                    holdId: hold.holdId
                )
            }
        }
        activePressKey = nil
        activePressConsumed = false
    }

    public func pressSoftButton(_ button: SoftButton, activityId: String?) {
        dispatchSingleCommand(
            deviceId: button.deviceId,
            deviceName: button.deviceName,
            commandName: button.command,
            functionId: button.functionId,
            activityId: activityId,
            keyLabel: button.label
        )
    }

    public func sendDeviceCommand(device: HubDevice, command: DeviceCommand, activityId: String? = nil) {
        dispatchSingleCommand(
            deviceId: device.id,
            deviceName: device.name,
            commandName: command.name,
            functionId: command.functionId,
            activityId: activityId,
            keyLabel: command.name
        )
    }

    private func startHttpHoldSession(resolved: ResolvedButtonAction, activityId: String?) {
        guard let endpoint = activeEndpoint else { return }
        let holdId = HBusFrameBuilder.newHoldId()
        let line = "\(resolved.buttonLabel) → \(resolved.summaryText)"
        statusLine = line
        appendSendLog(label: resolved.buttonLabel, targetSummary: resolved.summaryText, isError: false)

        let client = restClient
        let pressTask = Task<Bool, Never> { [weak self] in
            do {
                try await client.irSend(
                    endpoint: endpoint,
                    deviceId: resolved.pressDeviceId,
                    command: resolved.pressCommand,
                    functionId: resolved.pressFunctionId,
                    activityId: activityId,
                    status: "press",
                    holdId: holdId
                )
                return true
            } catch {
                if let self = self {
                    let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                    self.statusLine = "\(line) · \(msg)"
                    self.showBanner("Couldn't send \(resolved.pressCommand) — \(msg)", isError: true)
                }
                return false
            }
        }

        let holdInfo = (
            endpoint: endpoint,
            deviceId: resolved.pressDeviceId,
            command: resolved.pressCommand,
            functionId: resolved.pressFunctionId,
            activityId: activityId,
            holdId: holdId,
            pressTask: pressTask
        )
        activeHttpHold = holdInfo

        httpHoldLoopTask = Task { [weak self] in
            let pressSucceeded = await pressTask.value
            guard pressSucceeded, !Task.isCancelled, let self = self else { return }

            try? await Task.sleep(nanoseconds: RemoteKeyMapping.holdDelayMs * 1_000_000)
            while !Task.isCancelled {
                guard self.activeHttpHold?.holdId == holdId else { break }
                do {
                    try await self.restClient.irSend(
                        endpoint: endpoint,
                        deviceId: resolved.pressDeviceId,
                        command: resolved.pressCommand,
                        functionId: resolved.pressFunctionId,
                        activityId: activityId,
                        status: "hold",
                        holdId: holdId
                    )
                } catch {
                    break
                }
                try? await Task.sleep(nanoseconds: RemoteKeyMapping.repeatIntervalMs * 1_000_000)
            }
        }
    }

    private func dispatchSingleCommand(
        deviceId: String,
        deviceName: String,
        commandName: String,
        functionId: Int,
        activityId: String?,
        keyLabel: String
    ) {
        guard let endpoint = activeEndpoint else {
            showBanner("Not connected to a Harmony Hub.", isError: true)
            return
        }
        let summary = "\(deviceName) · \(commandName)"
        let line = "\(keyLabel) → \(summary)"
        statusLine = line

        Task {
            do {
                try await restClient.irSend(
                    endpoint: endpoint,
                    deviceId: deviceId,
                    command: commandName,
                    functionId: functionId,
                    activityId: activityId
                )
                self.statusLine = line
                self.appendSendLog(label: keyLabel, targetSummary: summary, isError: false)
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.statusLine = "\(line) · \(msg)"
                self.appendSendLog(label: keyLabel, targetSummary: "\(summary) (\(msg))", isError: true)
                self.showBanner("Couldn't send \(commandName) to \(deviceName) — \(msg)", isError: true)
            }
        }
    }

    private func appendSendLog(label: String, targetSummary: String, isError: Bool) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let item = SendLogItem(
            timestamp: formatter.string(from: Date()),
            label: label,
            targetSummary: targetSummary,
            isError: isError
        )
        sendLog.insert(item, at: 0)
        if sendLog.count > 40 {
            sendLog.removeLast(sendLog.count - 40)
        }
    }

    public func showBanner(_ text: String, isError: Bool = false) {
        let msg = BannerMessage(text: text, isError: isError)
        bannerMessage = msg
    }

    public func dismissBanner() {
        bannerMessage = nil
    }
}
