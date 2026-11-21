import Foundation

public struct HubApiError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public let statusCode: Int
    public let isRestricted: Bool

    public init(message: String, statusCode: Int = 0, isRestricted: Bool = false) {
        self.message = message
        self.statusCode = statusCode
        self.isRestricted = isRestricted
    }

    public var errorDescription: String? {
        message
    }
}

/// Native `URLSession` REST client for `codex_webui` (`:8080`) and `tools/webui-sim` (`:8787`).
public final class HubRestClient: Sendable {
    private let session: URLSession
    private let probeSession: URLSession

    public init(session: URLSession? = nil, probeSession: URLSession? = nil) {
        if let session = session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 10
            config.timeoutIntervalForResource = 20
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }

        if let probeSession = probeSession {
            self.probeSession = probeSession
        } else {
            let probeConfig = URLSessionConfiguration.ephemeral
            probeConfig.timeoutIntervalForRequest = 2.5
            probeConfig.timeoutIntervalForResource = 3.0
            probeConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.probeSession = URLSession(configuration: probeConfig)
        }
    }

    /// `GET /api/version`: fetches Melodious version and supported feature flags.
    public func getVersion(endpoint: HubEndpoint, isProbe: Bool = false) async throws -> HubVersionInfo {
        let data = try await getRawData(endpoint: endpoint, path: "/api/version", useProbeSession: isProbe)
        return try HubConfigParser.parseVersion(data: data)
    }

    /// `GET /api/system-status`: fetches firmware and system status summary.
    public func getSystemStatus(endpoint: HubEndpoint, isProbe: Bool = false) async throws -> HubSystemStatus {
        let data = try await getRawData(endpoint: endpoint, path: "/api/system-status", useProbeSession: isProbe)
        return try HubConfigParser.parseSystemStatus(data: data)
    }

    /// `GET /api/activity-config`: fetches activities, devices, button maps, and revision.
    public func getActivityConfig(endpoint: HubEndpoint) async throws -> HubConfigSnapshot {
        let data = try await getRawData(endpoint: endpoint, path: "/api/activity-config")
        return try HubConfigParser.parseActivityConfig(data: data)
    }

    /// `GET /api/activity-state`: returns the running activity ID (`"-1"` when everything is off).
    public func getActivityState(endpoint: HubEndpoint) async throws -> String {
        let data = try await getRawData(endpoint: endpoint, path: "/api/activity-state")
        let text = String(data: data, encoding: .utf8) ?? ""
        let actId = HubStateExtractor.extractCurrentActivityId(text)
        guard !actId.isEmpty else {
            throw HubApiError(message: "Couldn't read the current activity from hub.")
        }
        return actId
    }

    /// `GET /api/state?version=<lastVersion>`: lightweight state digest poll.
    public func pollStateDigest(endpoint: HubEndpoint, lastVersion: String?) async throws -> HubStatePoll {
        var path = "/api/state"
        if let v = lastVersion, !v.isEmpty {
            let encoded = v.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? v
            path += "?version=\(encoded)"
        }
        let data = try await getRawData(endpoint: endpoint, path: path)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HubApiError(message: "Invalid JSON from /api/state")
        }
        let changed = HubConfigParser.boolValue(obj["changed"]) ?? false
        let replyText: String
        if let replyStr = obj["reply"] as? String {
            replyText = replyStr
        } else if let replyObj = obj["reply"],
                  let replyData = try? JSONSerialization.data(withJSONObject: replyObj),
                  let serialized = String(data: replyData, encoding: .utf8) {
            replyText = serialized
        } else {
            replyText = ""
        }
        let version = HubStateExtractor.extractStateVersion(replyText) ?? lastVersion
        let activityId = changed ? {
            let id = HubStateExtractor.extractCurrentActivityId(replyText)
            return id.isEmpty ? nil : id
        }() : nil
        let activityStatus = changed ? HubStateExtractor.extractActivityStatus(replyText) : nil
        return HubStatePoll(
            changed: changed,
            version: version,
            activityId: activityId,
            activityStatus: activityStatus
        )
    }

    /// `POST /api/activity-run`: starts an activity or powers off (`activityId == "-1"`).
    public func runActivity(endpoint: HubEndpoint, activityId: String) async throws {
        _ = try await postForm(
            endpoint: endpoint,
            path: "/api/activity-run",
            fields: [("activityId", activityId)]
        )
    }

    /// `POST /api/activity-run` with `activityId=-1`.
    public func powerOff(endpoint: HubEndpoint) async throws {
        try await runActivity(endpoint: endpoint, activityId: "-1")
    }

    /// `POST /api/ir-send`: sends a command (or press/hold/release lease frame) through the hub.
    public func irSend(
        endpoint: HubEndpoint,
        deviceId: String,
        command: String,
        functionId: Int? = nil,
        activityId: String? = nil,
        status: String? = nil,
        holdId: String? = nil
    ) async throws {
        var fields: [(String, String)] = [
            ("deviceId", deviceId),
            ("command", command)
        ]
        if let functionId = functionId, functionId > 0 {
            fields.append(("functionId", String(functionId)))
        }
        if let activityId = activityId, !activityId.isEmpty {
            fields.append(("activityId", activityId))
        }
        if let status = status, !status.isEmpty {
            fields.append(("status", status))
        }
        if let holdId = holdId, !holdId.isEmpty {
            fields.append(("holdId", holdId))
        }
        _ = try await postForm(endpoint: endpoint, path: "/api/ir-send", fields: fields)
    }

    /// Queries the stock HBus HTTP port (`:8088`) for `setup.account?getProvisionInfo` to read `activeRemoteId`.
    public func fetchHubId(endpoint: HubEndpoint) async -> String? {
        guard !endpoint.isSimulated,
              let url = URL(string: "http://\(endpoint.host):\(endpoint.hbusPort)/") else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("http://sl.dhg.myharmony.com", forHTTPHeaderField: "Origin")
        request.httpBody = Data(#"{"id":1,"cmd":"setup.account?getProvisionInfo","params":{}}"#.utf8)

        guard let (data, response) = try? await probeSession.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObj = root["data"] as? [String: Any],
              let activeRemoteId = HubConfigParser.stringValue(dataObj["activeRemoteId"]),
              !activeRemoteId.isEmpty,
              activeRemoteId != "null" else {
            return nil
        }
        return activeRemoteId
    }

    /// Probes a candidate endpoint via `GET /api/version` (and optional `/api/system-status`) for subnet discovery.
    public func probeEndpoint(_ candidate: HubEndpoint) async -> HubEndpoint? {
        do {
            let versionInfo = try await getVersion(endpoint: candidate, isProbe: true)
            let sysStatus = try? await getSystemStatus(endpoint: candidate, isProbe: true)
            let isSim = candidate.isSimulated || candidate.webUiPort == 8787 || (sysStatus?.isSimulated == true)
            let fw = sysStatus?.firmware ?? candidate.firmware
            let name = isSim ? "Hub Simulator (\(candidate.host))" : "Harmony Hub (\(candidate.host))"
            return HubEndpoint(
                name: name,
                host: candidate.host,
                webUiPort: candidate.webUiPort,
                hbusPort: candidate.hbusPort,
                hubId: candidate.hubId,
                firmware: fw,
                melodiousVersion: versionInfo.version,
                features: versionInfo.features,
                isSimulated: isSim,
                basicAuthHeader: candidate.basicAuthHeader
            )
        } catch {
            return nil
        }
    }

    // MARK: - Private HTTP transport

    /// `GET /api/remote-pictures/image?name=`: an activity's own icon as PNG data,
    /// or nil when the hub doesn't hold it or can't be reached. docs/REMOTE_PICTURES.md
    public func getRemotePicture(endpoint: HubEndpoint, name: String) async -> Data? {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard (1...96).contains(name.count), name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        guard let data = try? await getRawData(endpoint: endpoint, path: "/api/remote-pictures/image?name=\(name)") else {
            return nil
        }
        let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        guard data.count <= 512 * 1024, data.count >= 8, Array(data.prefix(8)) == signature else { return nil }
        return data
    }

    private func getRawData(endpoint: HubEndpoint, path: String, useProbeSession: Bool = false) async throws -> Data {
        guard let url = URL(string: "\(endpoint.baseUrlString)\(path)") else {
            throw HubApiError(message: "Invalid hub URL: \(endpoint.baseUrlString)\(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let auth = endpoint.basicAuthHeader, !auth.isEmpty {
            request.setValue(auth, forHTTPHeaderField: "Authorization")
        }

        let targetSession = useProbeSession ? probeSession : session
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await targetSession.data(for: request)
        } catch {
            throw HubApiError(message: "Can't reach hub at \(endpoint.displayAddress): \(error.localizedDescription)", statusCode: 0)
        }

        guard let http = response as? HTTPURLResponse else {
            throw HubApiError(message: "Invalid response from \(endpoint.displayAddress)")
        }
        if !(200...299).contains(http.statusCode) {
            throw extractApiError(from: data, statusCode: http.statusCode)
        }
        return data
    }

    private func postForm(endpoint: HubEndpoint, path: String, fields: [(String, String)]) async throws -> Data {
        guard let url = URL(string: "\(endpoint.baseUrlString)\(path)") else {
            throw HubApiError(message: "Invalid hub URL: \(endpoint.baseUrlString)\(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
        if let auth = endpoint.basicAuthHeader, !auth.isEmpty {
            request.setValue(auth, forHTTPHeaderField: "Authorization")
        }

        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.0, value: $0.1) }
        let formString = components.percentEncodedQuery ?? ""
        request.httpBody = Data(formString.utf8)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw HubApiError(message: "Can't reach hub at \(endpoint.displayAddress): \(error.localizedDescription)", statusCode: 0)
        }

        guard let http = response as? HTTPURLResponse else {
            throw HubApiError(message: "Invalid response from \(endpoint.displayAddress)")
        }
        if !(200...299).contains(http.statusCode) {
            throw extractApiError(from: data, statusCode: http.statusCode)
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           HubConfigParser.boolValue(obj["ok"]) == false {
            throw extractApiError(from: data, statusCode: http.statusCode)
        }
        return data
    }

    private func extractApiError(from data: Data, statusCode: Int) -> HubApiError {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let msg = HubConfigParser.stringValue(obj["error"])
                ?? HubConfigParser.stringValue(obj["message"])
                ?? "HTTP \(statusCode)"
            let restricted = HubConfigParser.boolValue(obj["restricted"]) ?? false
            return HubApiError(message: msg, statusCode: statusCode, isRestricted: restricted)
        }
        let raw = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if statusCode == 401 {
            return HubApiError(message: "Authentication required (HTTP 401). Check your username and password in Settings.", statusCode: 401)
        }
        let clipped = String(raw.prefix(120))
        return HubApiError(message: clipped.isEmpty ? "HTTP \(statusCode)" : clipped, statusCode: statusCode)
    }
}
