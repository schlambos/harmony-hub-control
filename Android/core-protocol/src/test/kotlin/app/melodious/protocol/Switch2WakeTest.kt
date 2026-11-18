package app.melodious.protocol

import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.DeviceSettingsModel
import app.melodious.protocol.model.DeviceTouchScreen
import app.melodious.protocol.model.DeviceTouchScreens
import app.melodious.protocol.model.FixIt
import app.melodious.protocol.model.HubActivity
import app.melodious.protocol.model.HubConfigSnapshot
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.HubRole
import app.melodious.protocol.model.PowerType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Switch2WakeTest {

    @Test
    fun `Switch 2 wake device is distinct from Home Assistant and has a managed Touch screen`() {
        val device = HubDevice(
            id = "39000010",
            name = "Nintendo Switch 2",
            manufacturer = "Nintendo",
            model = "Switch 2",
            type = "GameConsole",
            transport = 64,
            commands = listOf(DeviceCommand(name = "Wake")),
            autoDetectedId = "melodious-switch2-39000010",
        )
        assertTrue(device.isSwitch2Wake)
        assertFalse(device.isHomeAssistant)
        assertFalse(device.isNetworkTv)
        assertFalse(device.isBluetoothHid)

        val deviceList = Json.decodeFromString<JsonObject>(
            """
            {"DevicesWithFeatures":[{
              "Device":{
                "Id-":39000010,
                "Name":"Nintendo Switch 2",
                "Transport":64,
                "AutoDetectedDevice":{"Id":"melodious-switch2-39000010"}
              },
              "Commands":[{"Name":"Wake"}],
              "DeviceFeatures":[{
                "__type":"PowerFeature",
                "PowerTypeId":1,
                "PowerOnActions":[{"__type":"IRPressAction","IRCommandName":"Wake"}],
                "PowerOffActions":[]
              }]
            }]}
            """.trimIndent(),
        )
        val activity = HubActivity(
            id = "900",
            name = "Play Switch 2",
            displayName = "Play Switch 2",
            type = 3,
            roles = listOf(HubRole(deviceId = "39000010", roleType = "PlayGameActivityRole", powerOnOrder = 1)),
        )
        val snap = HubConfigSnapshot(
            revision = "rev-1",
            rawRoot = JsonObject(emptyMap()),
            activityList = JsonObject(emptyMap()),
            mapList = JsonObject(mapOf("ButtonMaps" to JsonArray(emptyList()))),
            functionList = JsonObject(emptyMap()),
            deviceList = deviceList,
            activities = listOf(activity),
            devices = listOf(device),
        )
        assertEquals(DeviceTouchScreen.MANAGED, DeviceTouchScreens.state(snap, "39000010"))

        val entry = DeviceSettingsModel.deviceEntry(snap, "39000010")!!
        val settings = DeviceSettingsModel.read(entry)
        assertEquals(PowerType.DISCRETE, settings.powerType)
        assertEquals("Wake", settings.powerOn)
        assertEquals("", settings.powerOff)
        assertTrue(DeviceSettingsModel.validate(settings, listOf("Wake"), wakeOnly = true).isEmpty())

        val req = DeviceSettingsModel.requestBody("39000010", settings)
        val powerObj = ((req["settings"] as JsonObject)["power"] as JsonObject)
        assertEquals(JsonNull, powerObj["off"])

        val fixes = FixIt.devicesFor(
            activity = activity,
            devices = listOf(device),
            roleLabel = { "Plays games" },
            powerOverrides = mapOf("39000010" to settings),
        )
        assertEquals(1, fixes.size)
        assertEquals("Wake", fixes.first().powerOn?.name)
    }
}
