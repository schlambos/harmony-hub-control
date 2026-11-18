import Foundation
#if canImport(XCTest)
import XCTest
#endif
@testable import Melodious

final class HubJsonParsingTests: XCTestCase {
    // Recorded JSON fixtures matching tools/webui-sim/server.mjs and tools/webui-sim/fixtures/activity-config.json
    private let versionFixture = """
    {
      "ok": true,
      "product": "melodious",
      "version": "1.3.0",
      "api": 1,
      "update": { "protocol": 0 },
      "features": [
        "activity-save", "activity-sync", "catalog-import", "device-commands",
        "androidtv-devices", "androidtv-inputs", "device-screen", "device-settings",
        "ha-devices", "ha-devices-v2", "ha-state", "irdb-import", "remote-background", "remote-pair"
      ]
    }
    """

    private let systemStatusFixture = """
    {
      "ok": true,
      "firmware": "SIMULATED HUB",
      "uptime": "0h 0m",
      "memTotal": "",
      "memory": "",
      "uname": "SIMULATED HUB — no live device",
      "mounts": "",
      "processes": "",
      "logs": "SIMULATED HUB — no logs",
      "authMode": "open on local network"
    }
    """

    private let activityConfigFixture = """
    {
      "ok": true,
      "revision": "d99944e4-d3d4f70e",
      "activityList": {
        "Activities": [
          {
            "Id-": 48113650,
            "Name": "Smart TV",
            "Type": 1,
            "ActivityOrder": 1,
            "Roles": [
              {
                "Id-": 286507630,
                "DeviceId-": 74521691,
                "__type": "DisplayActivityRole",
                "SelectedInput": { "Name": "HDMI 3" },
                "PowerOnOrder": 1,
                "PowerOffOrder": 1
              }
            ]
          },
          {
            "Id-": 48113644,
            "Name": "NVIDIA Shield",
            "Type": 2,
            "ActivityOrder": 0,
            "Roles": [
              {
                "Id-": 286507625,
                "DeviceId-": 74521691,
                "__type": "DisplayActivityRole",
                "SelectedInput": { "Name": "HDMI 1" },
                "PowerOnOrder": 1,
                "PowerOffOrder": 1
              },
              {
                "Id-": 286507627,
                "DeviceId-": 81897247,
                "__type": "VolumeActivityRole",
                "SelectedInput": { "Name": "D.IN" },
                "PowerOnOrder": 2,
                "PowerOffOrder": 2
              },
              {
                "Id-": 286507626,
                "DeviceId-": 66690268,
                "__type": "PlayMovieActivityRole",
                "SelectedInput": null,
                "PowerOnOrder": 3,
                "PowerOffOrder": 3
              }
            ]
          }
        ]
      },
      "deviceList": {
        "DevicesWithFeatures": [
          {
            "Device": {
              "Id-": 66690268,
              "Name": "NVIDIA Game Console",
              "Manufacturer": "NVIDIA",
              "Model": "SHIELD TV",
              "DeviceTypeDisplayName": "Game Console",
              "Transport": 32
            },
            "Commands": [
              { "Name": "DirectionUp", "FunctionId-": 65, "KeyCode": "101" },
              { "Name": "DirectionDown", "FunctionId-": 62, "KeyCode": "102" },
              { "Name": "Select", "FunctionId-": 139, "KeyCode": "103" },
              { "Name": "Home", "FunctionId-": 195, "KeyCode": "104" },
              { "Name": "Menu", "FunctionId-": 90, "KeyCode": "105" },
              { "Name": "Back", "FunctionId-": 39, "KeyCode": "106" }
            ]
          },
          {
            "Device": {
              "Id-": 74521691,
              "Name": "LG TV",
              "Manufacturer": "LG",
              "Model": "OLED65C8PUA",
              "DeviceTypeDisplayName": "Television",
              "Transport": 1
            },
            "DeviceFeatures": [
              {
                "Inputs": [
                  { "InputName": "HDMI 1", "InputOrder": 1 },
                  { "InputName": "HDMI 3", "InputOrder": 2 }
                ]
              }
            ],
            "Commands": [
              { "Name": "PowerOff", "FunctionId-": 10, "KeyCode": "201" },
              { "Name": "PowerOn", "FunctionId-": 11, "KeyCode": "202" },
              { "Name": "Aspect", "FunctionId-": 36, "KeyCode": "203" }
            ]
          },
          {
            "Device": {
              "Id-": 81897247,
              "Name": "Nakamichi Amp",
              "Manufacturer": "Nakamichi",
              "Model": "Shockwafe Pro 7.1",
              "DeviceTypeDisplayName": "Amplifier",
              "Transport": 1
            },
            "Commands": [
              { "Name": "VolumeUp", "FunctionId-": 151, "KeyCode": "301" },
              { "Name": "VolumeDown", "FunctionId-": 150, "KeyCode": "302" },
              { "Name": "Mute", "FunctionId-": 91, "KeyCode": "303" }
            ]
          }
        ]
      },
      "mapList": {
        "ButtonMaps": [
          {
            "__type": "ActivityButtonMap",
            "ActivityId-": 48113644,
            "ButtonMapIdentifier": "16414Activity48113644",
            "Buttons": [
              {
                "__type": "HardRemoteButton",
                "ButtonKey": "Menu",
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "Menu", "FunctionId-": 90 },
                "ButtonLongPressAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "Home", "FunctionId-": 195 }
              },
              {
                "__type": "HardRemoteButton",
                "ButtonKey": "DirectionUp",
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "DirectionUp", "FunctionId-": 65 }
              },
              {
                "__type": "HardRemoteButton",
                "ButtonKey": "VolumeUp",
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 81897247, "CommandName": "VolumeUp", "FunctionId-": 151 }
              },
              {
                "__type": "HardRemoteButton",
                "ButtonKey": "VolumeMute",
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 81897247, "CommandName": "Mute", "FunctionId-": 91 }
              },
              {
                "__type": "HardRemoteButton",
                "ButtonKey": "PrevChannel",
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "Back", "FunctionId-": 39 }
              }
            ]
          },
          {
            "__type": "ActivityButtonMap",
            "ActivityId-": 48113644,
            "ButtonMapIdentifier": "16417Activity48113644",
            "Buttons": [
              {
                "__type": "SoftRemoteButton",
                "TextOnRemote": "1",
                "FunctionGroupType": 2,
                "MenuItem": { "IndexInMenu": 0 },
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "1", "FunctionId-": 20 }
              },
              {
                "__type": "SoftRemoteButton",
                "TextOnRemote": "Home",
                "FunctionGroupType": 0,
                "MenuItem": { "IndexInMenu": 1 },
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 66690268, "CommandName": "Home", "FunctionId-": 195 }
              },
              {
                "__type": "SoftRemoteButton",
                "TextOnRemote": "Aspect",
                "FunctionGroupType": 0,
                "MenuItem": { "IndexInMenu": 2 },
                "ButtonAction": { "__type": "ButtonCommandAction", "DeviceId-": 74521691, "CommandName": "Aspect", "FunctionId-": 36 }
              }
            ]
          }
        ]
      },
      "functionList": { "FunctionMaps": [] }
    }
    """

    func testParseVersionAndSystemStatus() throws {
        let ver = try HubConfigParser.parseVersion(data: Data(versionFixture.utf8))
        XCTAssertTrue(ver.ok)
        XCTAssertEqual(ver.product, "melodious")
        XCTAssertEqual(ver.version, "1.3.0")
        XCTAssertEqual(ver.api, 1)
        XCTAssertEqual(ver.features.count, 14)
        XCTAssertTrue(ver.features.contains("activity-save"))
        XCTAssertTrue(ver.features.contains("ha-state"))

        let sys = try HubConfigParser.parseSystemStatus(data: Data(systemStatusFixture.utf8))
        XCTAssertTrue(sys.ok)
        XCTAssertEqual(sys.firmware, "SIMULATED HUB")
        XCTAssertTrue(sys.isSimulated)
    }

    func testParseActivityConfigSnapshot() throws {
        let snapshot = try HubConfigParser.parseActivityConfig(data: Data(activityConfigFixture.utf8))
        XCTAssertEqual(snapshot.revision, "d99944e4-d3d4f70e")

        // Activities sorted by ActivityOrder (0: NVIDIA Shield, 1: Smart TV)
        XCTAssertEqual(snapshot.activities.map(\.id), ["48113644", "48113650"])
        let shield = snapshot.activities[0]
        XCTAssertEqual(shield.name, "NVIDIA Shield")
        XCTAssertEqual(shield.typeLabel, "Watch a movie")
        XCTAssertEqual(
            snapshot.deviceNames(for: shield),
            ["LG TV", "Nakamichi Amp", "NVIDIA Game Console"]
        )

        // Devices & features
        XCTAssertEqual(snapshot.devices.count, 3)
        let lgTv = snapshot.device(id: "74521691")
        XCTAssertEqual(lgTv?.inputs, ["HDMI 1", "HDMI 3"])
        XCTAssertEqual(lgTv?.transportBadge, "IR")

        let shieldDev = snapshot.device(id: "66690268")
        XCTAssertEqual(shieldDev?.transportBadge, "Bluetooth")

        // Resolved key map (hard buttons + soft-button digit fallback)
        let keys = snapshot.resolvedKeyMap(forActivityId: "48113644")
        XCTAssertEqual(keys["Menu"]?.pressCommand, "Menu")
        XCTAssertEqual(keys["Menu"]?.holdCommand, "Home")
        XCTAssertTrue(keys["Menu"]?.hasHold == true)
        XCTAssertEqual(keys["PrevChannel"]?.buttonLabel, "Back")
        XCTAssertEqual(keys["PrevChannel"]?.pressCommand, "Back")
        XCTAssertEqual(keys["Number1"]?.pressCommand, "1")

        // Extra on-screen soft buttons exclude numpad digit 1
        let extras = snapshot.extraSoftButtons(forActivityId: "48113644")
        XCTAssertEqual(extras.map(\.label), ["Home", "Aspect"])
    }

    func testExtractCurrentActivityIdAndStateDigest() {
        // Simulator /api/activity-state format
        let simReply = #"{"ok":true,"reply":"{\"result\":\"48113644\",\"code\":200,\"msg\":\"OK\"}"}"#
        XCTAssertEqual(HubStateExtractor.extractCurrentActivityId(simReply), "48113644")

        // Real hub state digest format
        let digestReply = #"{"changed":true,"reply":"{\"data\":{\"activityId\":\"-1\",\"activityStatus\":0,\"stateVersion\":42}}"}"#
        XCTAssertEqual(HubStateExtractor.extractCurrentActivityId(digestReply), "-1")
        XCTAssertEqual(HubStateExtractor.extractActivityStatus(digestReply), 0)
        XCTAssertEqual(HubStateExtractor.extractStateVersion(digestReply), "42")
    }
}
