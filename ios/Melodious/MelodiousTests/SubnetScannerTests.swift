import Foundation
#if canImport(XCTest)
import XCTest
#endif
@testable import Melodious

final class SubnetScannerTests: XCTestCase {
    func testPrivateIPv4Classification() {
        XCTAssertTrue(SubnetScanner.isPrivateIPv4("192.168.0.1"))
        XCTAssertTrue(SubnetScanner.isPrivateIPv4("192.168.1.254"))
        XCTAssertTrue(SubnetScanner.isPrivateIPv4("10.0.0.15"))
        XCTAssertTrue(SubnetScanner.isPrivateIPv4("172.16.0.1"))
        XCTAssertTrue(SubnetScanner.isPrivateIPv4("172.31.255.250"))

        XCTAssertFalse(SubnetScanner.isPrivateIPv4("172.15.0.1"))
        XCTAssertFalse(SubnetScanner.isPrivateIPv4("172.32.0.1"))
        XCTAssertFalse(SubnetScanner.isPrivateIPv4("127.0.0.1"))
        XCTAssertFalse(SubnetScanner.isPrivateIPv4("8.8.8.8"))
        XCTAssertFalse(SubnetScanner.isPrivateIPv4("192.168.1.999"))
        XCTAssertFalse(SubnetScanner.isPrivateIPv4("not.an.ip.addr"))
    }

    func testSubnetCandidateGenerationExcludesSelfByDefault() {
        let candidates = SubnetScanner.candidates(forIPv4Address: "192.168.1.42", port: 8080, includeSelf: false)
        XCTAssertEqual(candidates.count, 253)
        XCTAssertEqual(candidates.first?.host, "192.168.1.1")
        XCTAssertEqual(candidates.last?.host, "192.168.1.254")
        XCTAssertFalse(candidates.contains(where: { $0.host == "192.168.1.42" }))
        XCTAssertTrue(candidates.allSatisfy { $0.webUiPort == 8080 && $0.hbusPort == 8088 })
    }

    func testSubnetCandidateGenerationIncludesSelfWhenRequested() {
        let candidates = SubnetScanner.candidates(forIPv4Address: "10.0.1.5", port: 8080, includeSelf: true)
        XCTAssertEqual(candidates.count, 254)
        XCTAssertTrue(candidates.contains(where: { $0.host == "10.0.1.5" }))
        XCTAssertEqual(candidates.first?.host, "10.0.1.1")
        XCTAssertEqual(candidates.last?.host, "10.0.1.254")
    }

    func testInvalidPrefixProducesEmptyCandidates() {
        XCTAssertTrue(SubnetScanner.candidates(forIPv4Address: "8.8.8.8").isEmpty)
        XCTAssertTrue(SubnetScanner.candidatesForPrefix("8.8.8").isEmpty)
        XCTAssertTrue(SubnetScanner.candidatesForPrefix("192.168").isEmpty)
    }
}
