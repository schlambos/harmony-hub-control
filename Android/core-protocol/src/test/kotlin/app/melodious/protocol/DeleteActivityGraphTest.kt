package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as the web's deleteActivityResources tests (remotes-model.test.mjs), on the same fixture. */
class DeleteActivityGraphTest {
    private val fixture: JsonObject = run {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        repeat(8) {
            val candidate = File(dir, "tools/webui-sim/fixtures/activity-config.json")
            if (candidate.isFile) return@run Json.parseToJsonElement(candidate.readText()) as JsonObject
            dir = dir?.parentFile
        }
        error("tools/webui-sim/fixtures/activity-config.json not found above ${System.getProperty("user.dir")}")
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.buttons(): List<JsonObject> = (this["Buttons"] as? JsonArray).orEmpty().map { it.jsonObject }
    private fun maps(mapList: JsonObject): List<JsonObject> = mapList["ButtonMaps"]!!.jsonArray.map { it.jsonObject }
    private fun map(mapList: JsonObject, id: String) = maps(mapList).first { it.text("ButtonMapIdentifier") == id }
    private val ids = fixture["activityList"]!!.jsonObject["Activities"]!!.jsonArray.map { it.jsonObject.text("Id-")!! }

    /** The fixture with `edit` applied to its MapList's maps. */
    private fun withMaps(edit: (List<JsonObject>) -> List<JsonObject>): JsonObject {
        val mapList = fixture["mapList"]!!.jsonObject
        return JsonObject(fixture.toMutableMap().apply {
            put("mapList", JsonObject(mapList.toMutableMap().apply { put("ButtonMaps", JsonArray(edit(maps(mapList)))) }))
        })
    }

    private fun JsonObject.withButtons(buttons: List<JsonObject>) = JsonObject(toMutableMap().apply { put("Buttons", JsonArray(buttons)) })

    @Test
    fun deletingAnActivityClearsTheRootButtonsThatStartIt() {
        val tv = ids[0]
        val built = ActivityGraphBuilder.buildDeleteActivityGraph(ActivityGraphBuilder.parseConfigSnapshot(fixture), tv)
        val root = map(built.mapList, "16414Root")
        val button = root.buttons().first { it.text("ButtonKey") == "WatchTVActivity" }
        assertEquals(JsonNull, button["ButtonAction"])
        assertEquals(ids[1], (button["ButtonLongPressAction"] as JsonObject).text("ActivityId-"))
        assertEquals(map(fixture["mapList"]!!.jsonObject, "16414Root").buttons().size, root.buttons().size)
        assertFalse(built.mapList.toString().contains("\"ActivityId-\":$tv"))
    }

    @Test
    fun deletingAnActivityDropsAnActivityMapButtonThatOnlyStartedIt() {
        val touchId = "16417Activity${ids[1]}"
        val soft = Json.parseToJsonElement(
            """{"ButtonId":1999999999,"__type":"SoftRemoteButton","ButtonAction":{"__type":"ButtonActivityAction","ActivityId-":${ids[2]},"Order":0},""" +
                """"ButtonLongPressAction":null,"ButtonDoublePressAction":null,"MenuItem":{"IndexInMenu":40,"MenuName":"Activity.${ids[1]}"}}"""
        ).jsonObject
        val root = withMaps { list -> list.map { if (it.text("ButtonMapIdentifier") == touchId) it.withButtons(it.buttons() + soft) else it } }
        val before = map(root["mapList"]!!.jsonObject, touchId).buttons().size
        val built = ActivityGraphBuilder.buildDeleteActivityGraph(ActivityGraphBuilder.parseConfigSnapshot(root), ids[2])
        val after = map(built.mapList, touchId).buttons()
        assertEquals(before - 1, after.size)
        assertTrue(after.none { it.text("ButtonId") == "1999999999" })
    }
}
