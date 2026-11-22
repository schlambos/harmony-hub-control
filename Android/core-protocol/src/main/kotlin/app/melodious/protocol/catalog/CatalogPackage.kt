package app.melodious.protocol.catalog

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

const val PACKAGE_SCHEMA = "0.2.0"
const val PACKAGE_SOURCE = "logitech-catalog-via-melodious-android"

private val SECRET_KEY_RE = Regex(
    "(authorization|cookie|password|passwd|secret|access.?token|refresh.?token|id.?token|auth.?token|account.?id)",
    RegexOption.IGNORE_CASE,
)

fun redact(value: JsonElement): JsonElement = when (value) {
    is JsonArray -> JsonArray(value.map { redact(it) })
    is JsonObject -> JsonObject(
        value.mapValues { (k, v) ->
            if (SECRET_KEY_RE.containsMatchIn(k)) JsonPrimitive("[REDACTED]") else redact(v)
        }
    )
    else -> value
}

fun redactNullable(value: JsonElement?): JsonElement = value?.let { redact(it) } ?: kotlinx.serialization.json.JsonNull

fun buildPackage(
    manufacturer: String,
    model: String,
    searchResult: JsonElement?,
    selectedMatch: JsonElement?,
    globalDevice: JsonElement?,
    languageCommands: JsonElement?,
    generatedAt: String,
    source: String = PACKAGE_SOURCE,
    protocols: JsonArray? = null,
): JsonObject = buildJsonObject {
    put("schema_version", PACKAGE_SCHEMA)
    put("generated_at", generatedAt)
    put("source", source)
    put("query", buildJsonObject {
        put("manufacturer", manufacturer)
        put("model", model)
    })
    put("resources", buildJsonObject {
        put("search_result", redactNullable(searchResult))
        put("selected_match", redactNullable(selectedMatch))
        put("global_device", redactNullable(globalDevice))
        put("global_language_commands", redactNullable(languageCommands))
        if (protocols != null) {
            put("protocols", redact(protocols))
        }
    })
}

fun isCatalogPackage(pkg: JsonElement?): Boolean {
    val obj = pkg as? JsonObject ?: return false
    val schema = (obj["schema_version"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (schema != PACKAGE_SCHEMA) return false
    val resources = obj["resources"] as? JsonObject ?: return false
    return resources["global_language_commands"] is JsonArray
}
