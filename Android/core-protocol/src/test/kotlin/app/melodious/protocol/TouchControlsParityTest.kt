package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.graph.TouchScreenGraph
import app.melodious.protocol.model.ActivityWizardDraft
import app.melodious.protocol.model.ButtonMappingSource
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/** P06 #7 / P13 / P11 parity: extra controls, self-long, double-press, fixed slots. */
class TouchControlsParityTest {
    private fun device(id: String, vararg names: String) = HubDevice(
        id = id, name = "Device $id",
        commands = names.map { DeviceCommand(it, 1) },
    )

    @Test
    fun `reconcile keeps non-member extra and never fills defaults when disabled`() {
        val player = device("10", "Play", "Pause")
        val volume = device("20", "VolumeUp")
        val lamp = device("99", "PowerToggle", "BrightnessUp")
        val roles = listOf(
            WizardRoleDraft("PlayMovieActivityRole", "10"),
            WizardRoleDraft("VolumeActivityRole", "20"),
        )
        val buttons = mapOf(
            "Play" to WizardButtonMapping("10", "Play", source = ButtonMappingSource.EXISTING),
            "Red" to WizardButtonMapping("99", "PowerToggle", source = ButtonMappingSource.USER),
        )
        val kept = ActivityGraphBuilder.reconcileWizardButtons(buttons, roles, listOf(player, volume, lamp), fillDefaults = false)
        assertTrue(kept.containsKey("Red"))
        assertEquals(true, kept["Red"]?.extra)
        assertEquals(false, kept["Play"]?.extra)
        assertFalse(kept.containsKey("VolumeUp"))
        val filled = ActivityGraphBuilder.reconcileWizardButtons(buttons, roles, listOf(player, volume, lamp), fillDefaults = true)
        assertTrue(filled.containsKey("VolumeUp"))
    }

    @Test
    fun `isOneShot defaults toggles to self-long`() {
        assertTrue(ActivityGraphBuilder.isOneShotCommand("PowerToggle"))
        assertTrue(ActivityGraphBuilder.isOneShotCommand("mute"))
        assertEquals("oneShot", ActivityGraphBuilder.recommendedPressMode("PlayPause"))
        assertEquals("standard", ActivityGraphBuilder.recommendedPressMode("VolumeUp"))
    }

    @Test
    fun `touch graph keeps fixed slots and malformed rows`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","activityList":{"Activities":[{"Id-":5,"Name":"W","Roles":[]}]},"functionList":{"FunctionMaps":[]},
             "deviceList":{"DevicesWithFeatures":[{"Device":{"Id-":9,"Name":"G"},"Commands":[{"Name":"Home"}]}]},
             "mapList":{"ButtonMaps":[{"ButtonMapId-":1,"ActivityId-":5,"ButtonMapIdentifier":"16417Activity5","SurfaceId-":1,"ButtonMapSurfaceId-":1,"RemoteId-":1,"__type":"ActivityButtonMap","Sequences":[],"Buttons":[
               {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":100,"TextOnRemote":"Home","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Home"}},
               {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":101,"TextOnRemote":"Bad","MenuItem":{"IndexInMenu":4},"ButtonAction":{"__type":"ButtonCommandAction","CommandName":"NoDevice"}},
               {"__type":"GestureRemoteButton","ButtonKey":"SwipeUp","ButtonId":102,"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Home"}}
             ]}]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val read = TouchScreenGraph.read(snapshot, "5")
        // Malformed Bad row is not editable, so only Home is editable.
        assertEquals(listOf("Home"), read.buttons.map { it.label })
        val draft = read.copy(buttons = read.buttons + app.melodious.protocol.graph.SoftButtonDraft(
            "Toggle", app.melodious.protocol.graph.SoftButtonAction.Command(app.melodious.protocol.graph.SequenceStep.Command("9", "PowerToggle"))
        ))
        val built = TouchScreenGraph.build(snapshot, draft)
        val maps = built.mapList["ButtonMaps"]!!.jsonArray.map { it.jsonObject }
        val touch = maps.first { it["ButtonMapIdentifier"]!!.jsonPrimitive.content == "16417Activity5" }
        val buttons = touch["Buttons"]!!.jsonArray.map { it.jsonObject }
        // Gap slot 1 goes to the new Toggle (lowest free), Home stays at 0, Bad stays at 4, gesture survives.
        val toggle = buttons.first { it["TextOnRemote"]?.jsonPrimitive?.content == "Toggle" }
        assertEquals(1, toggle["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt())
        // New one-shot defaults to self-long.
        assertEquals("PowerToggle", (toggle["ButtonLongPressAction"] as JsonObject)["CommandName"]!!.jsonPrimitive.content)
        assertEquals(2, (toggle["ButtonLongPressAction"] as JsonObject)["EventType"]!!.jsonPrimitive.content.toInt())
        assertTrue(buttons.any { it["TextOnRemote"]?.jsonPrimitive?.content == "Bad" })
        assertTrue(buttons.any { it["ButtonKey"]?.jsonPrimitive?.content == "SwipeUp" })
        // Home keeps its slot and id.
        val home = buttons.first { it["TextOnRemote"]?.jsonPrimitive?.content == "Home" }
        assertEquals(0, home["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt())
        assertEquals("100", home["ButtonId"]!!.jsonPrimitive.content)
    }

    private val twoRowConfig = """
        {"revision":"r","activityList":{"Activities":[{"Id-":5,"Name":"W","Roles":[]}]},"functionList":{"FunctionMaps":[]},
         "deviceList":{"DevicesWithFeatures":[{"Device":{"Id-":9,"Name":"G"},"Commands":[{"Name":"PowerToggle"},{"Name":"BrightnessUp"},{"Name":"Mute"},{"Name":"PowerOn"}]}]},
         "mapList":{"ButtonMaps":[{"ButtonMapId-":1,"ActivityId-":5,"ButtonMapIdentifier":"16417Activity5","SurfaceId-":1,"ButtonMapSurfaceId-":1,"RemoteId-":1,"__type":"ActivityButtonMap","Sequences":[],"Buttons":[
           {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":100,"TextOnRemote":"Toggle","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"PowerToggle","FunctionId-":0,"EventType":0},"ButtonLongPressAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"PowerToggle","FunctionId-":0,"EventType":2}},
           {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":101,"TextOnRemote":"Up","MenuItem":{"IndexInMenu":1},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"BrightnessUp","FunctionId-":0,"EventType":0},"ButtonLongPressAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"PowerOn","FunctionId-":0,"EventType":2}},
           {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":102,"TextOnRemote":"Plain","MenuItem":{"IndexInMenu":3},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"PowerOn","FunctionId-":0,"EventType":0}}
         ]}]}}
    """.trimIndent()

    private fun builtButtons(snapshot: app.melodious.protocol.model.HubConfigSnapshot, draft: app.melodious.protocol.graph.TouchScreenDraft): Map<String, JsonObject> {
        val maps = TouchScreenGraph.build(snapshot, draft).mapList["ButtonMaps"]!!.jsonArray.map { it.jsonObject }
        val touch = maps.first { it["ButtonMapIdentifier"]!!.jsonPrimitive.content == "16417Activity5" }
        return touch["Buttons"]!!.jsonArray.map { it.jsonObject }.associateBy { it["ButtonId"]!!.jsonPrimitive.content }
    }

    private fun slot(b: JsonObject) = b["MenuItem"]!!.jsonObject["IndexInMenu"]!!.jsonPrimitive.content.toInt()
    private fun longCommand(b: JsonObject) = (b["ButtonLongPressAction"] as? JsonObject)?.get("CommandName")?.jsonPrimitive?.contentOrNull

    @Test
    fun `moving a row swaps the two slots and nothing else`() {
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(Json.parseToJsonElement(twoRowConfig).jsonObject)
        val read = TouchScreenGraph.read(snapshot, "5")
        // Move "Plain" (slot 3) up past "Up" (slot 1).
        val moved = read.copy(buttons = listOf(read.buttons[0], read.buttons[2], read.buttons[1]))
        val out = builtButtons(snapshot, moved)
        assertEquals(0, slot(out.getValue("100")))
        assertEquals(1, slot(out.getValue("102")))
        assertEquals(3, slot(out.getValue("101")))
        // Unmoved, nothing changes.
        val same = builtButtons(snapshot, read)
        assertEquals(listOf(0, 1, 3), listOf("100", "101", "102").map { slot(same.getValue(it)) })
    }

    @Test
    fun `re-pointing a row moves its self-long with it and keeps a separate long`() {
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(Json.parseToJsonElement(twoRowConfig).jsonObject)
        val read = TouchScreenGraph.read(snapshot, "5")
        fun pointAt(i: Int, command: String) = read.buttons[i].copy(
            action = app.melodious.protocol.graph.SoftButtonAction.Command(app.melodious.protocol.graph.SequenceStep.Command("9", command))
        )
        // Self-long row re-pointed at a step command: the old toggle long goes.
        var out = builtButtons(snapshot, read.copy(buttons = listOf(pointAt(0, "BrightnessUp"), read.buttons[1], read.buttons[2])))
        assertEquals(null, longCommand(out.getValue("100")))
        // Re-pointed at another one-shot command: the self-long follows it.
        out = builtButtons(snapshot, read.copy(buttons = listOf(pointAt(0, "Mute"), read.buttons[1], read.buttons[2])))
        assertEquals("Mute", longCommand(out.getValue("100")))
        assertEquals(2, (out.getValue("100")["ButtonLongPressAction"] as JsonObject)["EventType"]!!.jsonPrimitive.content.toInt())
        // A separate long the owner chose stays when the press changes.
        out = builtButtons(snapshot, read.copy(buttons = listOf(read.buttons[0], pointAt(1, "Mute"), read.buttons[2])))
        assertEquals("PowerOn", longCommand(out.getValue("101")))
        // A plain row re-pointed at a toggle becomes one-shot, like the web editor.
        out = builtButtons(snapshot, read.copy(buttons = listOf(read.buttons[0], read.buttons[1], pointAt(2, "PowerToggle"))))
        assertEquals("PowerToggle", longCommand(out.getValue("102")))
        // A rename alone keeps every long press as it is.
        out = builtButtons(snapshot, read.copy(buttons = listOf(read.buttons[0].copy(label = "Renamed"), read.buttons[1], read.buttons[2])))
        assertEquals("PowerToggle", longCommand(out.getValue("100")))
        assertEquals("PowerOn", longCommand(out.getValue("101")))
        assertEquals(null, longCommand(out.getValue("102")))
    }

    @Test
    fun `ordinary FGT0 on-screen digit button supports Standard hold-repeat and Separate Hold for LG Quick Access without touching FGT2 pad (#190)`() {
        val root = Json.parseToJsonElement(
            """
            {"revision":"r","activityList":{"Activities":[{"Id-":5,"Name":"Watch TV","Roles":[]}]},"functionList":{"FunctionMaps":[]},
             "deviceList":{"DevicesWithFeatures":[{"Device":{"Id-":9,"Name":"LG TV"},"Commands":[{"Name":"1"},{"Name":"2"},{"Name":"App Netflix"}]}]},
             "mapList":{"ButtonMaps":[{"ButtonMapId-":1,"ActivityId-":5,"ButtonMapIdentifier":"16417Activity5","SurfaceId-":1,"ButtonMapSurfaceId-":1,"RemoteId-":1,"__type":"ActivityButtonMap","Sequences":[],"Buttons":[
               {"__type":"SoftRemoteButton","FunctionGroupType":2,"ButtonId":200,"TextOnRemote":"1","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"1","FunctionId-":0,"EventType":0}},
               {"__type":"SoftRemoteButton","FunctionGroupType":0,"ButtonId":100,"TextOnRemote":"Home","MenuItem":{"IndexInMenu":0},"ButtonAction":{"__type":"ButtonCommandAction","DeviceId-":9,"CommandName":"Home","FunctionId-":0,"EventType":0}}
             ]}]}}
            """.trimIndent()
        ).jsonObject
        val snapshot = ActivityGraphBuilder.parseConfigSnapshot(root)
        val read = TouchScreenGraph.read(snapshot, "5")
        // FGT2 number pad is excluded from editable rows.
        assertEquals(listOf("Home"), read.buttons.map { it.label })

        val quick1 = app.melodious.protocol.graph.SoftButtonDraft(
            label = "Quick 1",
            action = app.melodious.protocol.graph.SoftButtonAction.Command(app.melodious.protocol.graph.SequenceStep.Command("9", "1")),
            pressMode = "custom",
            longPress = app.melodious.protocol.graph.SequenceStep.Command("9", "App Netflix"),
        )
        val hold2 = app.melodious.protocol.graph.SoftButtonDraft(
            label = "Digit 2 Hold",
            action = app.melodious.protocol.graph.SoftButtonAction.Command(app.melodious.protocol.graph.SequenceStep.Command("9", "2")),
            pressMode = "standard",
        )
        val built = TouchScreenGraph.build(snapshot, read.copy(buttons = read.buttons + listOf(quick1, hold2)))
        val touch = built.mapList["ButtonMaps"]!!.jsonArray.map { it.jsonObject }.single()
        val buttons = touch["Buttons"]!!.jsonArray.map { it.jsonObject }

        // FGT2 number pad at slot 0 is preserved untouched with no ButtonLongPressAction.
        val fgt2 = buttons.single { (it["FunctionGroupType"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "2" }
        assertEquals(0, slot(fgt2))
        assertEquals(null, longCommand(fgt2))

        // Quick 1 is FGT0 at slot 1 with short="1" (EventType 0) and long="App Netflix" (EventType 2).
        val savedQuick1 = buttons.single { it["TextOnRemote"]?.jsonPrimitive?.content == "Quick 1" }
        assertEquals("0", savedQuick1["FunctionGroupType"]!!.jsonPrimitive.content)
        assertEquals(1, slot(savedQuick1))
        assertEquals("1", savedQuick1["ButtonAction"]!!.jsonObject["CommandName"]!!.jsonPrimitive.content)
        assertEquals("App Netflix", longCommand(savedQuick1))
        assertEquals(2, savedQuick1["ButtonLongPressAction"]!!.jsonObject["EventType"]!!.jsonPrimitive.content.toInt())

        // Digit 2 Hold is FGT0 at slot 2 with short="2" and null long press (hold repeats).
        val savedHold2 = buttons.single { it["TextOnRemote"]?.jsonPrimitive?.content == "Digit 2 Hold" }
        assertEquals("0", savedHold2["FunctionGroupType"]!!.jsonPrimitive.content)
        assertEquals(2, slot(savedHold2))
        assertEquals("2", savedHold2["ButtonAction"]!!.jsonObject["CommandName"]!!.jsonPrimitive.content)
        assertEquals(null, longCommand(savedHold2))

        // resolveActivitySoftButtons keeps the FGT0 digit buttons visible (digit == null) while FGT2 stays digit == 1.
        val resolved = ActivityGraphBuilder.resolveActivitySoftButtons(
            ActivityGraphBuilder.parseConfigSnapshot(JsonObject(root.toMutableMap().apply { put("mapList", built.mapList) })),
            "5",
        )
        val extras = resolved.filter { it.digit == null }
        assertEquals(listOf("Home", "Quick 1", "Digit 2 Hold"), extras.map { it.label })
    }
}
