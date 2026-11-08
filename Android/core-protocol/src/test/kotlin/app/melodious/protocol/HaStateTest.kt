package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.model.FixIt
import app.melodious.protocol.model.HaState
import app.melodious.protocol.model.HaStateEnvelope
import app.melodious.protocol.model.HubDevice
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as the web UI's tools/webui-sim/test/ha-state.test.mjs. */
class HaStateTest {
    private val key = "media_player.living_room_tv"

    private val config = Json.parseToJsonElement(
        """{
          "revision": "r1",
          "activityList": {"Activities": [{"Id-": 100, "Name": "Watch TV", "Roles": [
            {"DeviceId-": 90000001, "__type": "DisplayActivityRole", "PowerOnOrder": 1, "SelectedInput": {"Name": "HDMI 1"}}]}]},
          "mapList": {}, "functionList": {},
          "deviceList": {"DevicesWithFeatures": [
            {"Device": {"Id-": 90000001, "Name": "Living Room TV", "Manufacturer": "Home Assistant", "Transport": 64,
                        "AutoDetectedDevice": {"Id": "melodious-ha-90000001"},
                        "Tokens": {"Parameters": [{"Key": "{d}", "Value": "$key"}]}},
             "Commands": [{"Name": "PowerOn"}, {"Name": "PowerOff"}, {"Name": "Input HDMI 1"}, {"Name": "Input HDMI 4"},
                          {"Name": "Play"}, {"Name": "Pause"}, {"Name": "VolumeUp"}, {"Name": "Mute"}],
             "DeviceFeatures": [{"Inputs": [
               {"InputName": "HDMI 1", "InputOrder": 1, "Actions": [{"IRCommandName": "Input HDMI 1"}]},
               {"InputName": "HDMI 4", "InputOrder": 2, "Actions": [{"IRCommandName": "Input HDMI 4"}]}]}]},
            {"Device": {"Id-": 81897247, "Name": "Nakamichi Amp", "Transport": 1}, "Commands": []},
            {"Device": {"Id-": 91684097, "Name": "Living Room TV box", "Transport": 1}, "Commands": []},
            {"Device": {"Id-": 5, "Name": "Den TV", "Transport": 64, "AutoDetectedDevice": {"Id": "melodious-androidtv-5"}}, "Commands": []}
          ]},
          "haStateVersion": 7,
          "haState": {"version": 7, "stale": false, "states": [{"key": "$key", "available": true, "power": "on"}]}
        }""",
    ).jsonObject
    private val snapshot = ActivityGraphBuilder.parseConfigSnapshot(config)
    private val tv = snapshot.devices.first { it.id == "90000001" }
    private val amp = snapshot.devices.first { it.id == "81897247" }
    private val box = snapshot.devices.first { it.id == "91684097" }

    private fun env(json: String): HaStateEnvelope = HaState.parseEnvelope(Json.parseToJsonElement(json).jsonObject)!!
    private fun states(vararg snaps: String, stale: Boolean = false, version: Int = 10) =
        env("""{"version": $version, "stale": $stale, "states": [${snaps.joinToString(",")}]}""")

    @Test
    fun `config parsing reads the key, the HA flag and haState`() {
        assertEquals(key, tv.haKey)
        assertTrue(tv.isHomeAssistant)
        assertFalse(amp.isHomeAssistant)
        val den = snapshot.devices.first { it.id == "5" }
        assertTrue(den.isNetworkTv)
        assertFalse("a network TV is an IP device but not Home Assistant's", den.isHomeAssistant)
        assertEquals(7L, snapshot.haState?.version)
        assertEquals("on", HaState.describe(tv, snapshot.haState)?.power)
    }

    @Test
    fun `non-HA devices have no state`() {
        assertNull(HaState.describe(amp, states()))
    }

    @Test
    fun `missing, stale, unavailable or unknown power is State unknown, never Off`() {
        val cases = listOf(
            null,
            states(stale = true, version = 0),
            states("""{"key": "$key", "available": true, "power": "on", "source": "HDMI 1"}""", stale = true),
            states("""{"key": "$key", "available": false, "power": "off"}"""),
            states("""{"key": "$key", "available": true, "power": "unknown"}"""),
        )
        for (envelope in cases) {
            val info = HaState.describe(tv, envelope)!!
            assertFalse(info.known)
            assertEquals("unknown", info.power)
            assertEquals("State unknown", info.badge)
            assertEquals(listOf("State unknown"), info.chips.map { it.label })
            assertFalse(info.summary.lowercase().contains("off"))
        }
    }

    @Test
    fun `fresh state shows power, source, app, playing and volume`() {
        val info = HaState.describe(tv, states(
            """{"key": "$key", "available": true, "power": "on", "source": "HDMI 1", "activity": "Netflix",
                "playing": "playing", "volume": 0.35, "muted": false}""",
        ))!!
        assertTrue(info.known)
        assertEquals(35, info.volume)
        assertEquals(listOf("On", "HDMI 1", "Netflix", "Playing", "Vol 35%"), info.chips.map { it.label })
    }

    @Test
    fun `app matching the source isn't repeated, and muted shows the level`() {
        val info = HaState.describe(tv, states(
            """{"key": "$key", "available": true, "power": "on", "source": "YouTube", "activity": "YouTube",
                "playing": "paused", "volume": 0.2, "muted": true}""",
        ))!!
        assertEquals(listOf("On", "YouTube", "Paused", "Muted (20%)"), info.chips.map { it.label })
    }

    private val theater = """{
        "active_input": {"id": "HDMI_1", "label": "Living Room TV"},
        "ports": [
          {"id": "HDMI_1", "label": "Living Room TV", "connected": true, "signal": true, "cec_name": "Living Room TV", "cec_type": 8},
          {"id": "HDMI_2", "label": "Nakamichi Sound Bar", "connected": true, "signal": false, "cec_name": "NAKAMICHI", "cec_type": 5},
          {"id": "HDMI_3", "label": "Switch2 Game Console", "connected": false, "signal": false, "cec_name": null, "cec_type": null},
          {"id": "HDMI_4", "label": "HDMI 4", "connected": false, "signal": false}],
        "sound": {"output": "external_arc", "label": "Nakamichi Sound Bar", "port": "HDMI_2", "volume": 14, "muted": false},
        "foreground_app": "com.webos.app.hdmi1"}"""

    private fun theaterState(extra: String = "", stale: Boolean = false) = states(
        """{"key": "$key", "available": true, "power": "on", "source": "Living Room TV", "volume": 0.14, "muted": false,
            "theater": $theater, "theater_links": [{"port": "HDMI_2", "device_id": "81897247"}, {"port": "HDMI_1", "device_id": 91684097}]
            $extra}""",
        stale = stale, version = 20,
    )

    @Test
    fun `LG theater shows the live port, ports and the TV-reported ARC volume`() {
        val info = HaState.describe(tv, theaterState())!!
        assertEquals("HDMI 1", info.activeInputId)
        val labels = info.chips.map { it.label }
        assertTrue(labels.joinToString("|"), "Sound: Nakamichi Sound Bar (ARC) · Vol 14" in labels)
        assertFalse(labels.joinToString("|"), labels.any { "%" in it })
        val ports = info.theater!!.portsText
        assertTrue(ports, "HDMI 1 Living Room TV (live)" in ports)
        assertTrue(ports, "HDMI 2 Nakamichi Sound Bar (connected)" in ports)
        assertTrue(ports, "HDMI 3 Switch2 Game Console (not connected)" in ports)
    }

    @Test
    fun `Input HDMI 1 is redundant from the port id, not the CEC label`() {
        val info = HaState.describe(tv, theaterState())
        assertTrue(HaState.isCommandRedundant("Input HDMI 1", info))
        assertFalse(HaState.isCommandRedundant("Input HDMI 4", info))
    }

    @Test
    fun `theater state is never invented when stale, unavailable or absent`() {
        for (envelope in listOf(theaterState(stale = true), theaterState(""", "available": false"""), theaterState(""", "theater": null"""))) {
            val info = HaState.describe(tv, envelope)!!
            assertNull(info.theater)
            assertNull(info.activeInputId)
        }
    }

    @Test
    fun `a soundbar link shows ARC and its TV-reported volume, never power`() {
        val info = HaState.describeTheaterLink(amp, theaterState())!!
        assertTrue(info.known)
        assertEquals("unknown", info.power)
        val labels = info.chips.map { it.label }
        assertTrue(labels.joinToString("|"), labels.any { it.startsWith("On ARC") })
        assertTrue(labels.joinToString("|"), labels.any { "Vol 14" in it })
        assertFalse(labels.joinToString("|"), labels.any { it == "On" || it == "Off" })
    }

    @Test
    fun `a playback link shows live and signal, with a numeric device id`() {
        val labels = HaState.describeTheaterLink(box, theaterState())!!.chips.map { it.label }
        assertTrue(labels.joinToString("|"), "HDMI 1 · live on the TV" in labels)
        assertTrue(labels.joinToString("|"), "Signal present" in labels)
    }

    @Test
    fun `links are unknown when stale or without theater, and absent when unlinked`() {
        assertFalse(HaState.describeTheaterLink(amp, theaterState(stale = true))!!.known)
        assertFalse(HaState.describeTheaterLink(amp, theaterState(""", "theater": null"""))!!.known)
        assertNull(HaState.describeTheaterLink(HubDevice("1", "Other"), theaterState()))
        assertNull(HaState.describeTheaterLink(amp, null))
    }

    @Test
    fun `the strip merges a device's own state with its link`() {
        val linkedTv = theaterState().let { e ->
            e.copy(states = e.states.map { s ->
                JsonObject(s + ("theater_links" to Json.parseToJsonElement("""[{"port": "HDMI_1", "device_id": "90000001"}]""")))
            })
        }
        val info = HaState.stripFor(tv, linkedTv)!!
        val labels = info.chips.map { it.label }
        assertEquals("On", labels.first())
        assertTrue(labels.joinToString("|"), "HDMI 1 · live on the TV" in labels)
        assertNotNull(info.theaterLink)
        assertEquals("Linked", HaState.stripFor(amp, theaterState())!!.badge)
    }

    @Test
    fun `PowerOn, Play and the current input are redundant only when fresh`() {
        val on = HaState.describe(tv, states(
            """{"key": "$key", "available": true, "power": "on", "source": "HDMI 1", "playing": "playing"}""",
        ))
        assertTrue(HaState.isCommandRedundant("PowerOn", on))
        assertFalse(HaState.isCommandRedundant("PowerOff", on))
        assertTrue(HaState.isCommandRedundant("Input HDMI 1", on))
        assertFalse(HaState.isCommandRedundant("Input HDMI 4", on))
        assertTrue(HaState.isCommandRedundant("Play", on))
        assertFalse(HaState.isCommandRedundant("Pause", on))
        val unknown = HaState.describe(tv, states(stale = true))
        assertFalse(HaState.isCommandRedundant("PowerOn", unknown))
        assertFalse(HaState.isCommandRedundant("PowerOff", unknown))
    }

    @Test
    fun `Fix it hints come from fresh or stale state`() {
        val activity = snapshot.activities.single()
        fun hint(envelope: HaStateEnvelope) =
            FixIt.devicesFor(activity, snapshot.devices, { it }, haState = envelope).single().haHint
        assertEquals(
            "Living Room TV is already on · on HDMI 1",
            hint(states("""{"key": "$key", "available": true, "power": "on", "source": "HDMI 1"}""")),
        )
        assertEquals("Living Room TV is off", hint(states("""{"key": "$key", "available": true, "power": "off"}""")))
        assertEquals("State unknown", hint(states(stale = true)))
        assertNull(FixIt.devicesFor(activity, snapshot.devices, { it }).single().haHint)
    }
}
