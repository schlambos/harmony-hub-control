import Foundation
#if canImport(XCTest)
import XCTest
#endif
@testable import Melodious

final class RemoteKeyMappingAndHBusTests: XCTestCase {
    func testKeyBehaviorClassification() {
        let volUp = ResolvedButtonAction(
            buttonKey: "VolumeUp",
            buttonLabel: "Volume up",
            pressDeviceId: "81897247",
            pressDeviceName: "Nakamichi Amp",
            pressCommand: "VolumeUp"
        )
        XCTAssertEqual(RemoteKeyMapping.behavior(for: "VolumeUp", action: volUp), .holdRepeat)

        let mute = ResolvedButtonAction(
            buttonKey: "VolumeMute",
            buttonLabel: "Mute",
            pressDeviceId: "81897247",
            pressDeviceName: "Nakamichi Amp",
            pressCommand: "Mute"
        )
        XCTAssertEqual(RemoteKeyMapping.behavior(for: "VolumeMute", action: mute), .oneShot)

        let menuWithHoldHome = ResolvedButtonAction(
            buttonKey: "Menu",
            buttonLabel: "Menu",
            pressDeviceId: "66690268",
            pressDeviceName: "NVIDIA Game Console",
            pressCommand: "Menu",
            holdDeviceId: "66690268",
            holdDeviceName: "NVIDIA Game Console",
            holdCommand: "Home"
        )
        XCTAssertEqual(RemoteKeyMapping.behavior(for: "Menu", action: menuWithHoldHome), .longPressAction)

        let guide = ResolvedButtonAction(
            buttonKey: "Guide",
            buttonLabel: "Guide",
            pressDeviceId: "74521691",
            pressDeviceName: "LG TV",
            pressCommand: "Guide"
        )
        XCTAssertEqual(RemoteKeyMapping.behavior(for: "Guide", action: guide), .tap)
    }

    func testDeviceCommandAliasMatching() {
        let device = HubDevice(
            id: "74521691",
            name: "LG TV",
            commands: [
                DeviceCommand(name: "DirectionUp", functionId: 1),
                DeviceCommand(name: "VolumeUp", functionId: 2),
                DeviceCommand(name: "VolumeDown", functionId: 3),
                DeviceCommand(name: "Mute", functionId: 4),
                DeviceCommand(name: "Back", functionId: 5),
                DeviceCommand(name: "FastForward", functionId: 6)
            ]
        )
        let resolved = RemoteKeyMapping.resolveDeviceKeys(for: device)
        XCTAssertEqual(resolved["DirectionUp"]?.pressCommand, "DirectionUp")
        XCTAssertEqual(resolved["VolumeUp"]?.pressCommand, "VolumeUp")
        XCTAssertEqual(resolved["VolumeDown"]?.pressCommand, "VolumeDown")
        XCTAssertEqual(resolved["VolumeMute"]?.pressCommand, "Mute")
        XCTAssertEqual(resolved["PrevChannel"]?.pressCommand, "Back")
        XCTAssertEqual(resolved["FastForward"]?.pressCommand, "FastForward")
    }

    func testHBusHoldSequenceFrames() throws {
        let frames = HBusFrameBuilder.makeHoldSequence(
            hubId: "15390924",
            deviceId: "81897247",
            commandName: "VolumeUp",
            holdBeatCount: 2,
            baseRequestId: 100,
            baseTimestampMs: 1_700_000_000_000
        )
        XCTAssertEqual(frames.count, 4)

        let expectedStatuses = ["press", "hold", "hold", "release"]
        let expectedIds = ["100", "101", "102", "103"]

        for i in 0..<frames.count {
            let data = Data(frames[i].utf8)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let hbus = root["hbus"] as? [String: Any],
                  let params = hbus["params"] as? [String: Any],
                  let actionStr = params["action"] as? String,
                  let actionObj = try JSONSerialization.jsonObject(with: Data(actionStr.utf8)) as? [String: Any] else {
                XCTFail("Frame \(i) failed JSON decode")
                return
            }

            XCTAssertEqual(root["hubId"] as? String, "15390924")
            XCTAssertEqual(hbus["cmd"] as? String, "vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction")
            XCTAssertEqual(hbus["id"] as? String, expectedIds[i])
            XCTAssertEqual(params["status"] as? String, expectedStatuses[i])
            XCTAssertEqual(actionObj["deviceId"] as? String, "81897247")
            XCTAssertEqual(actionObj["command"] as? String, "VolumeUp")
            XCTAssertEqual(actionObj["type"] as? String, "IRCommand")
        }
    }

    func testHBusControlButtonAndStateDigestParsing() throws {
        let fireFrame = HBusFrameBuilder.makeControlButtonFrame(
            hubId: "15390924",
            requestId: "205",
            status: .fire,
            deviceId: "66690268",
            commandName: "Home",
            timestampMs: 1_700_000_001_000
        )
        let data = Data(fireFrame.utf8)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let hbus = try XCTUnwrap(root["hbus"] as? [String: Any])
        XCTAssertEqual(hbus["cmd"] as? String, "control.button?fire")

        let pushText = #"{"cmd":"connect.stateDigest?notify","data":{"activityId":"48113644","activityStatus":2,"stateVersion":19}}"#
        let event = try XCTUnwrap(HBusStateDigestEvent.parse(from: pushText))
        XCTAssertEqual(event.activityId, "48113644")
        XCTAssertEqual(event.activityStatus, 2)
        XCTAssertEqual(event.stateVersion, 19)
    }
}
