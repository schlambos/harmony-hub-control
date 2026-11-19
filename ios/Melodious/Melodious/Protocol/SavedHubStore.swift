import Foundation

/// Persists saved hubs and the last-active hub in `UserDefaults` so Melodious auto-reconnects on launch.
public final class SavedHubStore: @unchecked Sendable {
    private static let savedHubsKey = "melodious.ios.savedHubs.v1"
    private static let activeHubIdKey = "melodious.ios.activeHubId.v1"

    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var savedHubs: [HubEndpoint] {
        lock.lock()
        defer { lock.unlock() }
        return loadHubsUnlocked()
    }

    public var activeHubId: String? {
        lock.lock()
        defer { lock.unlock() }
        return defaults.string(forKey: Self.activeHubIdKey)
    }

    public var activeHub: HubEndpoint? {
        lock.lock()
        defer { lock.unlock() }
        let hubs = loadHubsUnlocked()
        if let activeId = defaults.string(forKey: Self.activeHubIdKey),
           let matching = hubs.first(where: { $0.id == activeId }) {
            return matching
        }
        return hubs.first
    }

    /// Saves or updates a hub in the saved list and optionally marks it as the active auto-reconnect hub.
    @discardableResult
    public func saveHub(_ endpoint: HubEndpoint, setActive: Bool = true) -> [HubEndpoint] {
        lock.lock()
        defer { lock.unlock() }
        var hubs = loadHubsUnlocked()
        if let existingIndex = hubs.firstIndex(where: { $0.id == endpoint.id }) {
            hubs[existingIndex] = endpoint
        } else {
            hubs.insert(endpoint, at: 0)
        }
        persistHubsUnlocked(hubs)
        if setActive {
            defaults.set(endpoint.id, forKey: Self.activeHubIdKey)
        }
        return hubs
    }

    /// Sets the active hub ID if it exists in the saved list.
    public func setActiveHub(id: String) {
        lock.lock()
        defer { lock.unlock() }
        let hubs = loadHubsUnlocked()
        if hubs.contains(where: { $0.id == id }) {
            defaults.set(id, forKey: Self.activeHubIdKey)
        }
    }

    /// Removes a saved hub by ID and updates the active hub pointer if needed.
    @discardableResult
    public func removeHub(id: String) -> [HubEndpoint] {
        lock.lock()
        defer { lock.unlock() }
        var hubs = loadHubsUnlocked()
        hubs.removeAll { $0.id == id }
        persistHubsUnlocked(hubs)

        if defaults.string(forKey: Self.activeHubIdKey) == id {
            if let next = hubs.first {
                defaults.set(next.id, forKey: Self.activeHubIdKey)
            } else {
                defaults.removeObject(forKey: Self.activeHubIdKey)
            }
        }
        return hubs
    }

    public func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: Self.savedHubsKey)
        defaults.removeObject(forKey: Self.activeHubIdKey)
    }

    private func loadHubsUnlocked() -> [HubEndpoint] {
        guard let data = defaults.data(forKey: Self.savedHubsKey),
              let decoded = try? JSONDecoder().decode([HubEndpoint].self, from: data) else {
            return []
        }
        return decoded
    }

    private func persistHubsUnlocked(_ hubs: [HubEndpoint]) {
        if let data = try? JSONEncoder().encode(hubs) {
            defaults.set(data, forKey: Self.savedHubsKey)
        }
    }
}
