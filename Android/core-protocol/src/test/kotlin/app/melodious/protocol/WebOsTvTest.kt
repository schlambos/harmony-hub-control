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
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebOsTvTest {

    @Test
    fun `native LG webOS TV is distinct from Home Assistant, has managed Touch screen, and supports discrete power`() {
        val webos = HubDevice(
            id = "39000050",
            name = "Living Room LG",
            manufacturer = "LG",
            model = "webOS TV",
            type = "Television",
            transport = 64,
            commands = listOf(
                DeviceCommand(name = "PowerOn"),
                DeviceCommand(name = "PowerOff"),
                DeviceCommand(name = "VolumeUp"),
                DeviceCommand(name = "Input HDMI 1"),
                DeviceCommand(name = "App Netflix"),
            ),
            autoDetectedId = "melodious-webos-39000050",
        )
        val haLg = HubDevice(
            id = "39000001",
            name = "Living Room LG (HA)",
            manufacturer = "Home Assistant",
            model = "Home Assistant device",
            type = "Home Appliance",
            transport = 64,
            commands = listOf(DeviceCommand(name = "PowerOff")),
            autoDetectedId = "melodious-ha-39000001",
        )

        assertTrue(webos.isWebOsTv)
        assertFalse(webos.isHomeAssistant)
        assertFalse(webos.isNetworkTv)
        assertFalse(webos.isSwitch2Wake)
        assertFalse(webos.isBluetoothHid)

        // Coexistence: HA-bridged LG remains Home Assistant
        assertTrue(haLg.isHomeAssistant)
        assertFalse(haLg.isWebOsTv)

        val deviceList = Json.decodeFromString<JsonObject>(
            """
            {"DevicesWithFeatures":[{
              "Device":{
                "Id-":39000050,
                "Name":"Living Room LG",
                "Transport":64,
                "AutoDetectedDevice":{"Id":"melodious-webos-39000050"}
              },
              "Commands":[
                {"Name":"PowerOn"},
                {"Name":"PowerOff"},
                {"Name":"VolumeUp"},
                {"Name":"Input HDMI 1"},
                {"Name":"App Netflix"}
              ],
              "DeviceFeatures":[{
                "__type":"PowerFeature",
                "PowerTypeId":1,
                "PowerOnActions":[{"__type":"IRPressAction","IRCommandName":"PowerOn"}],
                "PowerOffActions":[{"__type":"IRPressAction","IRCommandName":"PowerOff"}]
              }]
            }]}
            """.trimIndent(),
        )
        val activity = HubActivity(
            id = "901",
            name = "Watch LG",
            displayName = "Watch LG",
            type = 1,
            roles = listOf(HubRole(deviceId = "39000050", roleType = "DisplayActivityRole", powerOnOrder = 1)),
        )
        val snap = HubConfigSnapshot(
            revision = "rev-webos-1",
            rawRoot = JsonObject(emptyMap()),
            activityList = JsonObject(emptyMap()),
            mapList = JsonObject(mapOf("ButtonMaps" to JsonArray(emptyList()))),
            functionList = JsonObject(emptyMap()),
            deviceList = deviceList,
            activities = listOf(activity),
            devices = listOf(webos, haLg),
        )

        assertEquals(DeviceTouchScreen.MANAGED, DeviceTouchScreens.state(snap, "39000050"))

        val entry = DeviceSettingsModel.deviceEntry(snap, "39000050")!!
        val settings = DeviceSettingsModel.read(entry)
        assertEquals(PowerType.DISCRETE, settings.powerType)
        assertEquals("PowerOn", settings.powerOn)
        assertEquals("PowerOff", settings.powerOff)
        assertTrue(DeviceSettingsModel.validate(settings, webos.commands.map { it.name }).isEmpty())

        val fixes = FixIt.devicesFor(
            activity = activity,
            devices = listOf(webos),
            roleLabel = { "Displays video" },
            powerOverrides = mapOf("39000050" to settings),
        )
        assertEquals(1, fixes.size)
        assertEquals("PowerOn", fixes.first().powerOn?.name)
    }
}
