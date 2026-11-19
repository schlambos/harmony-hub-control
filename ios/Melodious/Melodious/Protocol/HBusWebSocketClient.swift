import Foundation

/// Pure wire-frame builder for the Harmony Hub HBus WebSocket protocol (`:8088`).
public enum HBusFrameBuilder {
    public enum ButtonStatus: String, Equatable, Sendable {
        case press = "press"
        case hold = "hold"
        case release = "release"
        case fire = "fire"
    }

    /// Formats the inner `action` JSON string used in HBus button commands:
    /// `{"command":"<commandName>","type":"IRCommand","deviceId":"<deviceId>"}`
    public static func makeIRActionString(deviceId: String, commandName: String) -> String {
        let escapedCmd = escapeJSONString(commandName)
        let escapedDev = escapeJSONString(deviceId)
        return #"{"command":"\#(escapedCmd)","type":"IRCommand","deviceId":"\#(escapedDev)"}"#
    }

    /// Builds an HBus `vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction` frame
    /// matching `HBusWebSocketClient.kt` (`press` -> `hold` -> `release`).
    public static func makeHoldActionFrame(
        hubId: String,
        requestId: String,
        deviceId: String,
        commandName: String,
        status: ButtonStatus,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let actionJson = makeIRActionString(deviceId: deviceId, commandName: commandName)
        let envelope: [String: Any] = [
            "hubId": hubId.isEmpty ? "0" : hubId,
            "timeout": 30,
            "hbus": [
                "cmd": "vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction",
                "id": requestId,
                "params": [
                    "action": actionJson,
                    "status": status.rawValue,
                    "timestamp": String(timestampMs)
                ]
            ]
        ]
        return serializeJSON(envelope)
    }

    /// Builds an HBus `control.button?<press|hold|release|fire>` frame (`docs/PROTOCOLS.md` §4).
    public static func makeControlButtonFrame(
        hubId: String,
        requestId: String,
        status: ButtonStatus,
        deviceId: String,
        commandName: String,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let actionJson = makeIRActionString(deviceId: deviceId, commandName: commandName)
        let envelope: [String: Any] = [
            "hubId": hubId.isEmpty ? "0" : hubId,
            "timeout": 30,
            "hbus": [
                "cmd": "control.button?\(status.rawValue)",
                "id": requestId,
                "params": [
                    "action": actionJson,
                    "status": status.rawValue,
                    "timestamp": String(timestampMs)
                ]
            ]
        ]
        return serializeJSON(envelope)
    }

    /// Builds an HBus `connect.statedigest?get` request frame.
    public static func makeStateDigestFrame(hubId: String, requestId: String) -> String {
        let envelope: [String: Any] = [
            "hubId": hubId.isEmpty ? "0" : hubId,
            "timeout": 30,
            "hbus": [
                "cmd": "connect.statedigest?get",
                "id": requestId,
                "params": [
                    "format": "json"
                ]
            ]
        ]
        return serializeJSON(envelope)
    }

    /// Generates a deterministic sequence of HBus frames for a press/hold/release cycle, used by unit tests
    /// and the live WebSocket client.
    public static func makeHoldSequence(
        hubId: String,
        deviceId: String,
        commandName: String,
        holdBeatCount: Int,
        baseRequestId: Int = 100,
        baseTimestampMs: Int64 = 1_700_000_000_000
    ) -> [String] {
        var frames: [String] = []
        var reqId = baseRequestId
        var ts = baseTimestampMs

        // 1. Initial press on finger-down
        frames.append(
            makeHoldActionFrame(
                hubId: hubId,
                requestId: String(reqId),
                deviceId: deviceId,
                commandName: commandName,
                status: .press,
                timestampMs: ts
            )
        )

        // 2. Zero or more hold heartbeats every 200 ms
        for _ in 0..<max(0, holdBeatCount) {
            reqId += 1
            ts += 200
            frames.append(
                makeHoldActionFrame(
                    hubId: hubId,
                    requestId: String(reqId),
                    deviceId: deviceId,
                    commandName: commandName,
                    status: .hold,
                    timestampMs: ts
                )
            )
        }

        // 3. Release on finger-up
        reqId += 1
        ts += 50
        frames.append(
            makeHoldActionFrame(
                hubId: hubId,
                requestId: String(reqId),
                deviceId: deviceId,
                commandName: commandName,
                status: .release,
                timestampMs: ts
            )
        )
        return frames
    }

    /// Generates a new alphanumeric hold ID (8-40 chars) for `/api/ir-send` HTTP hold leases.
    public static func newHoldId() -> String {
        let chars = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<16).map { _ in chars.randomElement()! })
    }

    private static func escapeJSONString(_ str: String) -> String {
        str
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func serializeJSON(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }
}

/// Event pushed over HBus WebSocket (`connect.stateDigest?notify` or `connect.statedigest?get`).
public struct HBusStateDigestEvent: Equatable, Sendable {
    public let activityId: String
    public let activityStatus: Int
    public let stateVersion: Int?

    public init(activityId: String, activityStatus: Int, stateVersion: Int?) {
        self.activityId = activityId
        self.activityStatus = activityStatus
        self.stateVersion = stateVersion
    }

    public static func parse(from rawText: String) -> HBusStateDigestEvent? {
        guard let data = rawText.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObj = root["data"] as? [String: Any],
              let activityId = HubConfigParser.stringValue(dataObj["activityId"]),
              !activityId.isEmpty else {
            return nil
        }
        let status = HubConfigParser.intValue(dataObj["activityStatus"]) ?? 0
        let version = HubConfigParser.intValue(dataObj["stateVersion"])
        return HBusStateDigestEvent(activityId: activityId, activityStatus: status, stateVersion: version)
    }
}

/// Direct LAN WebSocket client to the hub's HBus engine (`<hub-ip>:8088`) using `URLSessionWebSocketTask`.
@MainActor
public final class HBusWebSocketClient {
    public enum ConnectionState: Equatable, Sendable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    private let session: URLSession
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var holdTask: Task<Void, Never>?
    private var activeHoldTarget: (deviceId: String, commandName: String)?
    private var requestIdCounter: Int = 100
    private var hubId: String = "0"

    public private(set) var connectionState: ConnectionState = .disconnected {
        didSet {
            onConnectionStateChange?(connectionState)
        }
    }

    public var onConnectionStateChange: ((ConnectionState) -> Void)?
    public var onStateDigest: ((HBusStateDigestEvent) -> Void)?

    public init(session: URLSession? = nil) {
        if let session = session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 15
            self.session = URLSession(configuration: config)
        }
    }

    public var isConnected: Bool {
        connectionState == .connected
    }

    public func connect(endpoint: HubEndpoint) {
        disconnect()
        hubId = endpoint.hubId.isEmpty ? "0" : endpoint.hubId
        if endpoint.isSimulated {
            // tools/webui-sim serves HTTP on :8787; HBus WebSocket is on real/QEMU hubs (:8088)
            connectionState = .disconnected
            return
        }
        guard let url = endpoint.hbusWsURL else {
            connectionState = .error("Invalid HBus WebSocket URL")
            return
        }
        connectionState = .connecting
        var request = URLRequest(url: url)
        request.setValue("http://sl.dhg.myharmony.com", forHTTPHeaderField: "Origin")

        let task = session.webSocketTask(with: request)
        self.webSocketTask = task
        task.resume()

        connectionState = .connected
        requestStateDigest()
        startReceiveLoop(for: task)
        startPingLoop(for: task)
    }

    public func disconnect() {
        stopButtonHold()
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        if connectionState != .disconnected {
            connectionState = .disconnected
        }
    }

    public func requestStateDigest() {
        let reqId = nextRequestId()
        let frame = HBusFrameBuilder.makeStateDigestFrame(hubId: hubId, requestId: reqId)
        sendFrame(frame)
    }

    /// Starts a continuous press-and-hold session (`press` immediately, then `hold` every 200ms).
    public func startButtonHold(deviceId: String, commandName: String) {
        stopButtonHold()
        activeHoldTarget = (deviceId: deviceId, commandName: commandName)
        sendButtonFrame(deviceId: deviceId, commandName: commandName, status: .press)

        holdTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: RemoteKeyMapping.repeatIntervalMs * 1_000_000)
                if Task.isCancelled { break }
                guard let self = self else { break }
                self.sendButtonFrame(deviceId: deviceId, commandName: commandName, status: .hold)
            }
        }
    }

    /// Ends an active button hold session and sends the `release` frame.
    public func stopButtonHold() {
        holdTask?.cancel()
        holdTask = nil
        if let target = activeHoldTarget {
            activeHoldTarget = nil
            sendButtonFrame(deviceId: target.deviceId, commandName: target.commandName, status: .release)
        }
    }

    private func sendButtonFrame(deviceId: String, commandName: String, status: HBusFrameBuilder.ButtonStatus) {
        let reqId = nextRequestId()
        let frame = HBusFrameBuilder.makeHoldActionFrame(
            hubId: hubId,
            requestId: reqId,
            deviceId: deviceId,
            commandName: commandName,
            status: status
        )
        sendFrame(frame)
    }

    private func sendFrame(_ text: String) {
        guard let task = webSocketTask else { return }
        task.send(.string(text)) { [weak self] error in
            if let error = error {
                Task { @MainActor [weak self] in
                    guard let self = self, self.webSocketTask === task else { return }
                    self.stopButtonHold()
                    self.connectionState = .error(error.localizedDescription)
                }
            }
        }
    }

    private func startReceiveLoop(for task: URLSessionWebSocketTask) {
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self = self, self.webSocketTask === task else { break }
                    switch message {
                    case .string(let text):
                        if let digest = HBusStateDigestEvent.parse(from: text) {
                            self.onStateDigest?(digest)
                        }
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8),
                           let digest = HBusStateDigestEvent.parse(from: text) {
                            self.onStateDigest?(digest)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self = self, self.webSocketTask === task else { break }
                    self.stopButtonHold()
                    self.connectionState = .error(error.localizedDescription)
                    break
                }
            }
        }
    }

    private func startPingLoop(for task: URLSessionWebSocketTask) {
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                if Task.isCancelled { break }
                guard let self = self, self.webSocketTask === task else { break }
                task.sendPing { [weak self] error in
                    if let error = error {
                        Task { @MainActor [weak self] in
                            guard let self = self, self.webSocketTask === task else { return }
                            self.connectionState = .error(error.localizedDescription)
                        }
                    }
                }
            }
        }
    }

    private func nextRequestId() -> String {
        requestIdCounter += 1
        return String(requestIdCounter)
    }
}
