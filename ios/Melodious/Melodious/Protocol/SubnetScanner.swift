import Foundation
import Darwin

/// Subnet scanner for finding Harmony Hubs running Melodious on the local `/24` network.
///
/// Sideloaded iOS apps cannot obtain Apple's restricted `com.apple.developer.networking.multicast`
/// entitlement required for SSDP multicast (`239.255.255.250:1900`), so discovery probes the local
/// `/24` subnet on `:8080/api/version` directly (plus `127.0.0.1:8787` for simulator testing).
public enum SubnetScanner {
    /// Checks whether an IPv4 address string is a valid private RFC1918 LAN address
    /// (`192.168.x.x`, `10.x.x.x`, or `172.16.x.x`..`172.31.x.x`).
    public static func isPrivateIPv4(_ address: String) -> Bool {
        let parts = address.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }

        if octets[0] == 10 { return true }
        if octets[0] == 192 && octets[1] == 168 { return true }
        if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
        return false
    }

    /// Extracts the 3-octet `/24` prefix (e.g. `"192.168.1"`) and host octet from a private IPv4 address.
    public static func extractSubnetPrefix(from ipv4Address: String) -> (prefix: String, hostOctet: Int)? {
        let trimmed = ipv4Address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isPrivateIPv4(trimmed) else { return nil }
        let parts = trimmed.split(separator: ".")
        guard parts.count == 4, let hostOctet = Int(parts[3]) else { return nil }
        let prefix = "\(parts[0]).\(parts[1]).\(parts[2])"
        return (prefix: prefix, hostOctet: hostOctet)
    }

    /// Generates all `.1`..`.254` `HubEndpoint` probe candidates for a `/24` subnet prefix (e.g. `"192.168.1"`).
    public static func candidatesForPrefix(
        _ prefix: String,
        port: Int = 8080,
        excludedHostOctet: Int? = nil
    ) -> [HubEndpoint] {
        let parts = prefix.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return [] }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 3, octets.allSatisfy({ (0...255).contains($0) }) else { return [] }
        let testIp = "\(octets[0]).\(octets[1]).\(octets[2]).1"
        guard isPrivateIPv4(testIp) else { return [] }

        return (1...254).compactMap { hostOctet in
            if let excluded = excludedHostOctet, hostOctet == excluded {
                return nil
            }
            let ip = "\(octets[0]).\(octets[1]).\(octets[2]).\(hostOctet)"
            return HubEndpoint(
                name: "Hub (\(ip))",
                host: ip,
                webUiPort: port,
                hbusPort: 8088
            )
        }
    }

    /// Generates `/24` probe candidates for a device's local IPv4 address.
    public static func candidates(
        forIPv4Address ipv4Address: String,
        port: Int = 8080,
        includeSelf: Bool = false
    ) -> [HubEndpoint] {
        guard let (prefix, hostOctet) = extractSubnetPrefix(from: ipv4Address) else {
            return []
        }
        return candidatesForPrefix(
            prefix,
            port: port,
            excludedHostOctet: includeSelf ? nil : hostOctet
        )
    }

    /// Enumerates active non-loopback private IPv4 addresses on the device (`en0`, `en1`, etc.).
    public static func detectLocalIPv4Addresses() -> [String] {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let firstAddr = addrList else {
            return []
        }
        defer { freeifaddrs(addrList) }

        var preferred: [String] = []
        var others: [String] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = firstAddr

        while let ifa = cursor {
            defer { cursor = ifa.pointee.ifa_next }
            let flags = Int32(ifa.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            guard let sa = ifa.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                sa,
                socklen_t(sa.pointee.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let ip = String(cString: hostname)
            guard isPrivateIPv4(ip) else { continue }

            let ifName = String(cString: ifa.pointee.ifa_name)
            if ifName.hasPrefix("en") {
                if !preferred.contains(ip) { preferred.append(ip) }
            } else {
                if !others.contains(ip) && !preferred.contains(ip) { others.append(ip) }
            }
        }
        return preferred + others
    }

    /// Probes the local `/24` subnet (and optional loopback simulator `127.0.0.1:8787`) on `/api/version`.
    public static func scanLocalNetwork(
        restClient: HubRestClient,
        port: Int = 8080,
        extraCandidates: [HubEndpoint] = [],
        includeLoopbackSimulator: Bool = true,
        maxConcurrency: Int = 32
    ) async -> [HubEndpoint] {
        var allCandidates: [HubEndpoint] = []
        var seenIds = Set<String>()

        func appendCandidate(_ ep: HubEndpoint) {
            if !seenIds.contains(ep.id) {
                seenIds.insert(ep.id)
                allCandidates.append(ep)
            }
        }

        if includeLoopbackSimulator {
            appendCandidate(
                HubEndpoint(
                    name: "Local Simulator",
                    host: "127.0.0.1",
                    webUiPort: 8787,
                    hbusPort: 8088,
                    isSimulated: true
                )
            )
        }

        for extra in extraCandidates {
            appendCandidate(extra)
        }

        if let primaryIp = detectLocalIPv4Addresses().first {
            for candidate in candidates(forIPv4Address: primaryIp, port: port, includeSelf: false) {
                appendCandidate(candidate)
            }
        }

        guard !allCandidates.isEmpty else { return [] }

        let batchSize = max(1, maxConcurrency)
        var discovered: [HubEndpoint] = []

        var index = 0
        while index < allCandidates.count {
            if Task.isCancelled { break }
            let end = min(index + batchSize, allCandidates.count)
            let slice = Array(allCandidates[index..<end])
            index = end

            let batchResults = await withTaskGroup(of: HubEndpoint?.self, returning: [HubEndpoint].self) { group in
                for candidate in slice {
                    group.addTask {
                        await restClient.probeEndpoint(candidate)
                    }
                }
                var found: [HubEndpoint] = []
                for await res in group {
                    if let ep = res {
                        found.append(ep)
                    }
                }
                return found
            }
            discovered.append(contentsOf: batchResults)
        }

        return discovered.sorted { a, b in
            if a.isSimulated != b.isSimulated {
                return !a.isSimulated
            }
            return a.host < b.host
        }
    }
}
