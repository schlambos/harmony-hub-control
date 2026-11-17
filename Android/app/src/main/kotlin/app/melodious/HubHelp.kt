package app.melodious

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The engine owns the power/input diff, including toggle-only devices. */
internal suspend fun requestHubHelp(
    activityId: String,
    request: suspend (String, JsonObject, Long) -> JsonObject?,
): JsonObject? = request("harmony.engine?helpdiscretes", JsonObject(mapOf("activityId" to JsonPrimitive(activityId))), 30_000)
