package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.model.ActivityWizardDraft
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.RemoteLayout
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #234: the "--" and "E" keys either side of 0 on the remotes without a screen. hal names them
 * from its key table (re/bin/hal VA 0x461AE8): NumberPlus and NumberEnter. Mirrors
 * tools/webui-sim/test/issue234-dash-enter-keys.test.mjs.
 */
class DashEnterKeysTest {
    private val newKeys = listOf("NumberPlus", "NumberEnter")

    @Test
    fun `the activity editor offers the -- and E keys without guessing a command for them`() {
        val offered = ActivityGraphBuilder.BUTTON_GROUPS.flatMap { it.second }
        assertTrue(offered.containsAll(newKeys))
        assertEquals("NumberPlus", RemoteLayout.BUTTON_KEY_BY_LABEL["Dash"])
        assertEquals("NumberEnter", RemoteLayout.BUTTON_KEY_BY_LABEL["Enter"])
        assertEquals("NumberPlus", RemoteLayout.REMOTE_BUTTONS.first { it.label == "Dash" }.canonicalButtonKey)
        assertEquals("NumberEnter", RemoteLayout.REMOTE_BUTTONS.first { it.label == "Enter" }.canonicalButtonKey)
        val player = HubDevice(
            id = "1",
            name = "Player",
            commands = listOf("Play", "Enter", "Dash", "-").mapIndexed { i, n -> DeviceCommand(name = n, functionId = i) },
        )
        val defaults = ActivityGraphBuilder.deriveDefaultButtons(
            listOf(WizardRoleDraft(roleType = "PlayMovieActivityRole", deviceId = "1")),
            listOf(player),
        )
        for (key in newKeys) assertNull(key, defaults[key])
    }

    @Test
    fun `the activity editor saves the -- and E keys to the Smart Control map, not the Touch's, and reads them back`() {
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(fixture())
        val draft = ActivityWizardDraft(
            editActivityId = "100",
            name = "Old",
            type = 1,
            roles = listOf(WizardRoleDraft(roleType = "PlayMovieActivityRole", deviceId = "7001")),
            buttons = mapOf(
                "NumberPlus" to WizardButtonMapping(deviceId = "7001", commandName = "Dash", functionId = 30),
                "NumberEnter" to WizardButtonMapping(deviceId = "7001", commandName = "Enter", functionId = 31),
            ),
        )
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, draft)
        val maps = (built.mapList["ButtonMaps"] as JsonArray).map { it.jsonObject }
        fun keys(id: String): Map<String, String> = maps.first { it["ButtonMapIdentifier"]?.jsonPrimitive?.content == id }
            .let { it["Buttons"]!!.jsonArray.map { b -> b.jsonObject } }
            .filter { it["__type"]?.jsonPrimitive?.content == "HardRemoteButton" }
            .associate { it["ButtonKey"]!!.jsonPrimitive.content to it["ButtonAction"]!!.jsonObject["CommandName"]!!.jsonPrimitive.content }
        assertEquals("Dash", keys("16414Activity100")["NumberPlus"])
        assertEquals("Enter", keys("16414Activity100")["NumberEnter"])
        assertTrue(keys("16417Activity100").keys.none { it in newKeys })
        assertEquals("Play", keys("16417Activity100")["Play"])

        val reread = ActivityGraphBuilder.resolveActivityButtons(
            ActivityGraphBuilder.parseConfigSnapshot(
                JsonObject(fixture() + ("mapList" to built.mapList)),
            ),
            "100",
        )
        assertEquals("Dash", reread["NumberPlus"]?.pressCommand)
        assertEquals("Enter", reread["NumberEnter"]?.pressCommand)
    }

    private fun fixture(): JsonObject = Json.parseToJsonElement(
        """
        {
          "revision": "rev-1",
          "activityList": { "Activities": [ { "Id-": 100, "Name": "Old", "ActivityOrder": 0, "Roles": [] } ] },
          "mapList": { "ButtonMaps": [
            { "ButtonMapId-": 50000001, "ActivityId-": 100, "__type": "ActivityButtonMap",
              "ButtonMapIdentifier": "16414Activity100", "Buttons": [] },
            { "ButtonMapId-": 52944100, "ActivityId-": 100, "__type": "ActivityButtonMap",
              "ButtonMapIdentifier": "16417Activity100", "SurfaceId-": 14551427,
              "ButtonMapSurfaceId-": 14551427, "RemoteId-": 15390924, "Buttons": [
                { "ButtonId": 1878030001, "ButtonKey": "Play", "ButtonState": 1, "__type": "HardRemoteButton",
                  "ButtonAction": { "DeviceId-": 7001, "__type": "ButtonCommandAction", "CommandName": "Play", "EventType": 1, "Id": 0 } }
              ] }
          ] },
          "functionList": { "FunctionMaps": [] },
          "deviceList": { "DevicesWithFeatures": [
            { "Device": { "Id-": 7001, "Name": "Box", "Transport": 1 },
              "Commands": [ { "Name": "Play", "FunctionId-": 10 }, { "Name": "Dash", "FunctionId-": 30 }, { "Name": "Enter", "FunctionId-": 31 } ] }
          ] }
        }
        """.trimIndent(),
    ).jsonObject
}
