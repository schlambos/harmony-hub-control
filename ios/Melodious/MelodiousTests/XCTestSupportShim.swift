import Foundation
#if !canImport(XCTest)
import Testing

open class XCTestCase {
    public init() {}
}

public struct XCTUnwrapError: Error, CustomStringConvertible {
    public let description: String
}

public func XCTAssertEqual<T: Equatable>(
    _ expression1: @autoclosure () throws -> T,
    _ expression2: @autoclosure () throws -> T,
    _ message: @autoclosure () -> String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) {
    do {
        let lhs = try expression1()
        let rhs = try expression2()
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        #expect(lhs == rhs, Comment(rawValue: message()), sourceLocation: loc)
    } catch {
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        Issue.record(error, sourceLocation: loc)
    }
}

public func XCTAssertTrue(
    _ expression: @autoclosure () throws -> Bool,
    _ message: @autoclosure () -> String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) {
    do {
        let val = try expression()
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        #expect(val, Comment(rawValue: message()), sourceLocation: loc)
    } catch {
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        Issue.record(error, sourceLocation: loc)
    }
}

public func XCTAssertFalse(
    _ expression: @autoclosure () throws -> Bool,
    _ message: @autoclosure () -> String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) {
    do {
        let val = try expression()
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        #expect(!val, Comment(rawValue: message()), sourceLocation: loc)
    } catch {
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        Issue.record(error, sourceLocation: loc)
    }
}

public func XCTAssertNil<T>(
    _ expression: @autoclosure () throws -> T?,
    _ message: @autoclosure () -> String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) {
    do {
        let val = try expression()
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        #expect(val == nil, Comment(rawValue: message()), sourceLocation: loc)
    } catch {
        let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
        Issue.record(error, sourceLocation: loc)
    }
}

public func XCTUnwrap<T>(
    _ expression: @autoclosure () throws -> T?,
    _ message: @autoclosure () -> String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) throws -> T {
    if let val = try expression() {
        return val
    }
    let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
    let err = XCTUnwrapError(description: message().isEmpty ? "Expected non-nil value" : message())
    Issue.record(err, sourceLocation: loc)
    throw err
}

public func XCTFail(
    _ message: String = "",
    fileID: String = #fileID,
    filePath: String = #filePath,
    line: Int = #line,
    column: Int = #column
) {
    let loc = SourceLocation(fileID: fileID, filePath: filePath, line: line, column: column)
    Issue.record(Comment(rawValue: message.isEmpty ? "Test failed" : message), sourceLocation: loc)
}

@Suite("Melodious iOS Unit Tests")
struct MelodiousCLTSuiteRunner {
    @Test func testParseAddressHandlesStandardIPv4AndPorts() {
        HubUrlAndPersistenceTests().testParseAddressHandlesStandardIPv4AndPorts()
    }

    @Test func testParseAddressRejectsInvalidInputs() {
        HubUrlAndPersistenceTests().testParseAddressRejectsInvalidInputs()
    }

    @Test func testEndpointURLBuildersAndBasicAuth() {
        HubUrlAndPersistenceTests().testEndpointURLBuildersAndBasicAuth()
    }

    @Test func testSavedHubStorePersistenceAndAutoReconnectSelection() {
        HubUrlAndPersistenceTests().testSavedHubStorePersistenceAndAutoReconnectSelection()
    }

    @Test func testPrivateIPv4Classification() {
        SubnetScannerTests().testPrivateIPv4Classification()
    }

    @Test func testSubnetCandidateGenerationExcludesSelfByDefault() {
        SubnetScannerTests().testSubnetCandidateGenerationExcludesSelfByDefault()
    }

    @Test func testSubnetCandidateGenerationIncludesSelfWhenRequested() {
        SubnetScannerTests().testSubnetCandidateGenerationIncludesSelfWhenRequested()
    }

    @Test func testInvalidPrefixProducesEmptyCandidates() {
        SubnetScannerTests().testInvalidPrefixProducesEmptyCandidates()
    }

    @Test func testParseVersionAndSystemStatus() throws {
        try HubJsonParsingTests().testParseVersionAndSystemStatus()
    }

    @Test func testParseActivityConfigSnapshot() throws {
        try HubJsonParsingTests().testParseActivityConfigSnapshot()
    }

    @Test func testExtractCurrentActivityIdAndStateDigest() {
        HubJsonParsingTests().testExtractCurrentActivityIdAndStateDigest()
    }

    @Test func testKeyBehaviorClassification() {
        RemoteKeyMappingAndHBusTests().testKeyBehaviorClassification()
    }

    @Test func testDeviceCommandAliasMatching() {
        RemoteKeyMappingAndHBusTests().testDeviceCommandAliasMatching()
    }

    @Test func testHBusHoldSequenceFrames() throws {
        try RemoteKeyMappingAndHBusTests().testHBusHoldSequenceFrames()
    }

    @Test func testHBusControlButtonAndStateDigestParsing() throws {
        try RemoteKeyMappingAndHBusTests().testHBusControlButtonAndStateDigestParsing()
    }
}
#endif
