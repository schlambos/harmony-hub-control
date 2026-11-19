import Foundation
#if canImport(XCTest)
import XCTest
#endif
@testable import Melodious

final class HubUrlAndPersistenceTests: XCTestCase {
    func testParseAddressHandlesStandardIPv4AndPorts() {
        let bare = HubEndpoint.parseAddress("192.168.1.42")
        XCTAssertEqual(bare?.host, "192.168.1.42")
        XCTAssertEqual(bare?.port, 8080)

        let explicitPort = HubEndpoint.parseAddress("127.0.0.1:8787")
        XCTAssertEqual(explicitPort?.host, "127.0.0.1")
        XCTAssertEqual(explicitPort?.port, 8787)

        let withSchemeAndPath = HubEndpoint.parseAddress("  http://192.168.0.123:8080/api/version ")
        XCTAssertEqual(withSchemeAndPath?.host, "192.168.0.123")
        XCTAssertEqual(withSchemeAndPath?.port, 8080)

        let customDefault = HubEndpoint.parseAddress("harmony-hub.local", defaultPort: 8787)
        XCTAssertEqual(customDefault?.host, "harmony-hub.local")
        XCTAssertEqual(customDefault?.port, 8787)

        let bracketedIPv6 = HubEndpoint.parseAddress("[::1]:8787")
        XCTAssertEqual(bracketedIPv6?.host, "::1")
        XCTAssertEqual(bracketedIPv6?.port, 8787)
    }

    func testParseAddressRejectsInvalidInputs() {
        XCTAssertNil(HubEndpoint.parseAddress(""))
        XCTAssertNil(HubEndpoint.parseAddress("   "))
        XCTAssertNil(HubEndpoint.parseAddress("http://"))
        XCTAssertNil(HubEndpoint.parseAddress("192.168.1.10:0"))
        XCTAssertNil(HubEndpoint.parseAddress("192.168.1.10:70000"))
        XCTAssertNil(HubEndpoint.parseAddress("192.168.1.10:notaport"))
        XCTAssertNil(HubEndpoint.parseAddress("192.168.1.10/path", defaultPort: 0))
        XCTAssertNil(HubEndpoint.parseAddress("bad host name:8080"))
    }

    func testEndpointURLBuildersAndBasicAuth() {
        let epWithoutHubId = HubEndpoint(
            name: "Living Room",
            host: "192.168.1.50",
            webUiPort: 8080,
            hbusPort: 8088
        )
        XCTAssertEqual(epWithoutHubId.baseUrlString, "http://192.168.1.50:8080")
        XCTAssertEqual(epWithoutHubId.hbusWsUrlString, "ws://192.168.1.50:8088/")

        let epWithHubId = HubEndpoint(
            name: "Living Room",
            host: "192.168.1.50",
            webUiPort: 8080,
            hbusPort: 8088,
            hubId: "15390924"
        )
        XCTAssertEqual(
            epWithHubId.hbusWsUrlString,
            "ws://192.168.1.50:8088/?domain=svcs.myharmony.com&hubId=15390924"
        )

        let auth = HubEndpoint.buildBasicAuthHeader(username: "admin", password: "secret")
        XCTAssertEqual(auth, "Basic YWRtaW46c2VjcmV0")
    }

    func testSavedHubStorePersistenceAndAutoReconnectSelection() {
        let suiteName = "app.melodious.ios.tests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Could not create test UserDefaults suite")
            return
        }
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let store = SavedHubStore(defaults: defaults)
        XCTAssertTrue(store.savedHubs.isEmpty)
        XCTAssertNil(store.activeHub)

        let hubA = HubEndpoint(
            name: "Living Room Hub",
            host: "192.168.1.50",
            webUiPort: 8080,
            melodiousVersion: "2.5.0"
        )
        let hubB = HubEndpoint(
            name: "Simulator Hub",
            host: "127.0.0.1",
            webUiPort: 8787,
            melodiousVersion: "1.3.0",
            isSimulated: true
        )

        store.saveHub(hubA, setActive: true)
        XCTAssertEqual(store.savedHubs.count, 1)
        XCTAssertEqual(store.activeHub, hubA)

        store.saveHub(hubB, setActive: true)
        XCTAssertEqual(store.savedHubs.count, 2)
        XCTAssertEqual(store.activeHub, hubB)

        // Updating hubA with new firmware version preserves count and updates entry in-place
        var updatedHubA = hubA
        updatedHubA.firmware = "4.15.600"
        store.saveHub(updatedHubA, setActive: false)
        XCTAssertEqual(store.savedHubs.count, 2)
        XCTAssertEqual(store.activeHub, hubB)
        XCTAssertEqual(store.savedHubs.first(where: { $0.id == hubA.id })?.firmware, "4.15.600")

        // Verify a new SavedHubStore instance reading the same UserDefaults restores state
        let reloadedStore = SavedHubStore(defaults: defaults)
        XCTAssertEqual(reloadedStore.activeHub, hubB)
        XCTAssertEqual(reloadedStore.savedHubs.count, 2)

        // Removing active hub falls back to remaining saved hub
        reloadedStore.removeHub(id: hubB.id)
        XCTAssertEqual(reloadedStore.savedHubs.count, 1)
        XCTAssertEqual(reloadedStore.activeHub?.id, hubA.id)

        reloadedStore.clearAll()
        XCTAssertTrue(reloadedStore.savedHubs.isEmpty)
        XCTAssertNil(reloadedStore.activeHub)
    }
}
