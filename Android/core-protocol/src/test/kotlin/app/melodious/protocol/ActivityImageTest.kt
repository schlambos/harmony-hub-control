package app.melodious.protocol

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.model.HubActivity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** An activity's own icon (docs/REMOTE_PICTURES.md): ImageKey is read, and only its plain form names a picture. */
class ActivityImageTest {
    @Test
    fun parsesImageKeyAndNull() {
        val list = Json.parseToJsonElement(
            """{"Activities":[
              {"Id-":1,"Name":"Watch TV","Type":1,"ImageKey":"Activity/123_ab-cd.png","BaseImageUri":"https://images.example.invalid/"},
              {"Id-":2,"Name":"Music","Type":4,"ImageKey":null},
              {"Id-":3,"Name":"Game","Type":3}
            ]}""",
        ).jsonObject
        val activities = ActivityGraphBuilder.parseActivities(list).associateBy { it.id }
        assertEquals("Activity/123_ab-cd.png", activities.getValue("1").imageKey)
        assertEquals("123_ab-cd", activities.getValue("1").imageName)
        assertNull(activities.getValue("2").imageKey)
        assertNull(activities.getValue("2").imageName)
        assertNull(activities.getValue("3").imageName)
    }

    @Test
    fun onlyPlainActivityKeysNameAPicture() {
        fun name(key: String?) = HubActivity("1", "A", "A", imageKey = key).imageName
        assertEquals("1_x", name("Activity/1_x.png"))
        assertNull(name("Activity/1_x_small.png"))
        assertNull(name("Activity/../x.png"))
        assertNull(name("UserImages/x.png"))
        assertNull(name("Activity/x.jpg"))
        assertNull(name(""))
        assertNull(name(null))
    }
}
