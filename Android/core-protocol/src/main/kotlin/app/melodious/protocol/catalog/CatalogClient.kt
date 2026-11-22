package app.melodious.protocol.catalog

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

const val DISCOVERY_CLIENT_TYPE = "Redbull 1.0"
const val SEARCH_OPERATION = "DeviceManager/SearchGlobalDevices"
const val GLOBAL_DEVICES_OPERATION = "DeviceManager/GetGlobalDevices"
const val GLOBAL_LANGUAGE_COMMANDS_OPERATION = "DeviceManager/GetGlobalLanguageCommands"
const val COMMANDS_OPERATION = "DeviceManager/GetCommands"
const val PROTOCOL_LIST_OPERATION = "UserAccountDirector/ProtocolList"
private val ACCOUNT_ID_RE = Regex("^[A-Za-z0-9._-]+$")

val DEVICE_TYPE_LABELS: Map<Long, String> = mapOf(
    1L to "Television",
    2L to "VCR",
    3L to "CD player",
    4L to "DVD",
    5L to "Receiver",
    6L to "Tape deck",
    7L to "Projector",
    8L to "Computer",
    9L to "Game console",
    10L to "Laptop",
    12L to "Set-top box",
    13L to "Monitor",
    14L to "Cable box",
    16L to "Satellite",
    18L to "PVR",
    19L to "Amplifier",
    22L to "Game console",
    23L to "Light controller",
    29L to "AV switch",
    32L to "Music server",
    33L to "DVD recorder",
    34L to "Media center PC",
    35L to "Radio tuner",
    43L to "Home appliance",
    44L to "Climate control",
)

fun formatDeviceType(value: JsonElement?): String {
    val prim = value as? JsonPrimitive ?: return ""
    if (prim.isString) return prim.content.trim()
    val asLong = parseIntegerElement(prim) ?: return ""
    return DEVICE_TYPE_LABELS[asLong] ?: if (asLong > 0) "Type $asLong" else ""
}

/** Integer value of a numeric (or numeric-string) primitive, JS `Number`-ish. */
internal fun parseIntegerElement(prim: JsonPrimitive): Long? {
    if (prim is JsonNull || prim.booleanOrNull != null) return null
    val text = if (prim.isString) prim.content.trim() else prim.content
    if (text.isEmpty()) return null
    text.toLongOrNull()?.let { return it }
    val d = text.toDoubleOrNull() ?: return null
    if (d.isNaN() || d.isInfinite() || d != Math.floor(d)) return null
    return d.toLong()
}

internal fun JsonElement?.asObject(): JsonObject? = this as? JsonObject

internal fun JsonObject.stringFieldAny(vararg names: String): String? {
    for (name in names) {
        val prim = this[name] as? JsonPrimitive ?: continue
        if (prim.isString) return prim.content
    }
    return null
}

fun swapHost(address: String, hosts: Set<String>, newHost: String): String {
    val url = address.toHttpUrlOrNull() ?: return address
    if (url.host !in hosts) return address
    return url.newBuilder().host(newHost).build().toString()
}

fun loadBalancerAddress(address: String): String =
    swapHost(address, setOf("svcs.myharmony.com", "cf-svcs.myharmony.com"), "lb-svcs.myharmony.com")

data class CatalogOperation(
    val identifier: String,
    val address: String,
    val name: String,
) {
    fun endpoint(json2: Boolean = false): String {
        var url = swapHost(address, setOf("svcs.myharmony.com"), "cf-svcs.myharmony.com")
        if (json2) url = url.replace("/json/", "/json2/")
        return url + name
    }
}

fun parseOperations(payload: JsonElement?): Map<String, CatalogOperation> {
    val obj = payload as? JsonObject
        ?: throw CatalogError("discovery did not return an operation table")
    val raw = obj["GetJsonOperationsResult"] as? JsonArray
        ?: throw CatalogError("discovery did not return an operation table")
    val operations = LinkedHashMap<String, CatalogOperation>()
    for (item in raw) {
        val entry = item as? JsonObject ?: continue
        val identifier = entry.stringFieldAny("Identifier")?.takeIf { it.isNotEmpty() } ?: continue
        val address = entry.stringFieldAny("Address")?.takeIf { it.isNotEmpty() } ?: continue
        val name = entry.stringFieldAny("Name")?.takeIf { it.isNotEmpty() } ?: continue
        operations[identifier] = CatalogOperation(identifier, address, name)
    }
    if (operations.isEmpty()) throw CatalogError("discovery carried no usable operation")
    return operations
}

class GlobalCatalogClient(
    private val http: CatalogHttp,
    private val session: CatalogSession,
    cachedOperations: Map<String, CatalogOperation>? = null,
) {
    private var operationsCache: Map<String, CatalogOperation>? = cachedOperations

    val bearer: String get() = session.tokens.accessToken

    suspend fun operations(): Map<String, CatalogOperation> {
        operationsCache?.let { return it }
        val body = buildJsonObject { put("clientTypeId", DISCOVERY_CLIENT_TYPE) }
        val (status, payload) = http.postJson(
            DISCOVERY_URL,
            body,
            bearer = bearer,
            extraHeaders = mapOf(
                "Content-Type" to "application/json; charset=utf-8",
                "x-logitech-api-version" to "1",
            ),
        )
        if (status != 200) throw CatalogError("discovery failed with HTTP $status")
        val parsed = parseOperations(payload)
        operationsCache = parsed
        return parsed
    }

    private suspend fun postOperation(
        identifier: String,
        data: JsonElement,
        json2: Boolean = false,
        fallbackName: String? = null,
    ): JsonElement {
        val table = operations()
        var operation = table[identifier]
        if (operation == null && fallbackName != null) {
            val sibling = table[COMMANDS_OPERATION]
            if (sibling != null) {
                operation = CatalogOperation(identifier, sibling.address, fallbackName)
            }
        }
        if (operation == null) throw CatalogError("unknown catalog operation: $identifier")
        val endpoint = loadBalancerAddress(operation.endpoint(json2))
        val (status, payload) = http.postJson(endpoint, data, bearer = bearer)
        val message = (payload as? JsonObject)?.let { (it["Message"] as? JsonPrimitive) }
            ?.takeIf { it.isString }?.content
        if (status == 400 && message != null && message.contains("Access is denied")) {
            throw CatalogError(
                "Logitech refused the catalog session; sign in again",
                accessDenied = true,
            )
        }
        if (status != 200) throw CatalogError("$identifier failed with HTTP $status")
        if (payload == null) throw CatalogError("$identifier returned HTTP 200 without JSON")
        if (payload is JsonObject) {
            val resultKey = "${operation.name}Result"
            if (resultKey in payload) return payload[resultKey] ?: JsonNull
            if ("Data" in payload) return payload["Data"] ?: JsonNull
        }
        return payload
    }

    suspend fun search(manufacturer: String, model: String): JsonElement {
        val mfr = manufacturer.trim()
        val mdl = model.trim()
        if (mfr.isEmpty() || mdl.isEmpty()) {
            throw CatalogError(
                "the catalog searches by manufacturer AND model; both are needed (part of the model is enough)"
            )
        }
        val body = buildJsonObject {
            put("manufacturer", mfr)
            put("modelNumber", mdl)
            put("deviceType", JsonPrimitive(0))
            put("searchType", JsonPrimitive(2))
            put("maxResults", JsonPrimitive(50))
        }
        return postOperation(SEARCH_OPERATION, body, json2 = true)
    }

    suspend fun globalDevices(ids: List<Long>): JsonElement {
        val body = buildJsonArray { for (id in ids) add(JsonPrimitive(id)) }
        return postOperation(GLOBAL_DEVICES_OPERATION, body, json2 = true)
    }

    suspend fun globalLanguageCommands(versionId: JsonElement): JsonElement {
        val body = buildJsonObject {
            put("globalLanguageVersionId", buildJsonObject { put("Value", versionId) })
        }
        return postOperation(
            GLOBAL_LANGUAGE_COMMANDS_OPERATION,
            body,
            fallbackName = "GetGlobalLanguageCommands",
        )
    }

    suspend fun protocolList(): List<JsonObject> {
        val table = operations()
        val operation = table[PROTOCOL_LIST_OPERATION] ?: return emptyList()
        val accountId = session.accountId.trim()
        if (accountId.isEmpty() || !ACCOUNT_ID_RE.matches(accountId)) {
            throw CatalogError("the Harmony session carries an invalid AccountId")
        }
        val endpoint = loadBalancerAddress(
            operation.endpoint(json2 = true)
                .replace(Regex("\\{accountId\\}|%7BaccountId%7D", RegexOption.IGNORE_CASE), accountId)
        )
        val (status, payload) = http.get(
            endpoint,
            bearer = bearer,
            extraHeaders = mapOf("x-logitech-api-version" to "1"),
            authenticated = true,
        )
        val message = (payload as? JsonObject)?.let { it["Message"] as? JsonPrimitive }
            ?.takeIf { it.isString }?.content
        if (status == 400 && message != null && message.contains("Access is denied")) {
            throw CatalogError(
                "Logitech refused the catalog session; sign in again",
                accessDenied = true,
            )
        }
        if (status != 200) throw CatalogError("$PROTOCOL_LIST_OPERATION failed with HTTP $status")
        return extractProtocolList(payload)
    }
}

fun extractProtocolList(payload: JsonElement?): List<JsonObject> {
    if (payload is JsonArray) return payload.mapNotNull { it as? JsonObject }
    val obj = payload as? JsonObject ?: return emptyList()
    for (key in listOf("ProtocolListResult", "Data")) {
        val inner = obj[key]
        if (inner is JsonObject) {
            (inner["Protocols"] as? JsonArray)?.let { arr ->
                return arr.mapNotNull { it as? JsonObject }
            }
        } else if (inner is JsonArray) {
            return inner.mapNotNull { it as? JsonObject }
        }
    }
    return (obj["Protocols"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
}

data class CatalogModelCheck(val found: Boolean, val manufacturer: String, val model: String)

suspend fun checkDeviceModel(
    http: CatalogHttp,
    manufacturer: String,
    model: String,
): CatalogModelCheck {
    val mfr = manufacturer.trim()
    val mdl = model.trim()
    if (mfr.isEmpty() || mdl.isEmpty()) {
        throw CatalogError("manufacturer and model are required")
    }
    val base = SEARCH_DEVICE_BASE_URL.toHttpUrlOrNull()
        ?: throw CatalogError("Logitech's model check is unavailable; try again")
    val url = base.newBuilder()
        .addPathSegment("manf")
        .addPathSegment(mfr)
        .addPathSegment("model")
        .addPathSegment(mdl)
        .addPathSegment("iface")
        .addPathSegment("IR")
        .build()
        .toString()
    val (status, payload) = http.get(url)
    val obj = payload as? JsonObject
    if (status != 200 || obj == null) {
        throw CatalogError("Logitech's model check is unavailable; try again")
    }
    val devices = (obj["devices"] as? JsonArray)
        ?: ((obj["SearchDeviceResult"] as? JsonObject)?.get("devices") as? JsonArray)
        ?: JsonArray(emptyList())
    if (devices.isEmpty()) {
        return CatalogModelCheck(found = false, manufacturer = mfr, model = mdl)
    }
    val first = devices[0] as? JsonObject ?: JsonObject(emptyMap())
    val aliases = first["aliases"] as? JsonArray
    val alias = (aliases?.firstOrNull() as? JsonObject) ?: first
    val canonicalManufacturer = alias.stringFieldAny("manf", "Manufacturer")?.trim()
        ?.takeIf { it.isNotEmpty() } ?: mfr
    val canonicalModel = alias.stringFieldAny("model", "Model")?.trim()
        ?.takeIf { it.isNotEmpty() } ?: mdl
    return CatalogModelCheck(found = true, manufacturer = canonicalManufacturer, model = canonicalModel)
}

fun searchMatches(searchResult: JsonElement?): List<JsonObject> {
    val obj = searchResult as? JsonObject
        ?: throw CatalogError("SearchGlobalDevices did not return an object")
    if (!obj.containsKey("Matches") || obj["Matches"] is JsonNull) {
        throw CatalogError(
            "Logitech's catalog did not search: it needs the manufacturer AND the model"
        )
    }
    val matches = obj["Matches"] as? JsonArray
        ?: throw CatalogError("SearchGlobalDevices did not return Matches")
    return matches.mapNotNull { it as? JsonObject }
}

data class CatalogSearchMatch(
    val id: Long,
    val manufacturer: String,
    val model: String,
    val displayText: String,
    val deviceType: String,
    val description: String,
)

fun formatSearchMatches(
    matches: List<JsonObject>,
    fallbackManufacturer: String = "",
    fallbackModel: String = "",
): List<CatalogSearchMatch> {
    return matches.mapNotNull { m ->
        val rawId = (m["Id-"] ?: m["Id"]) as? JsonPrimitive ?: return@mapNotNull null
        val id = parseIntegerElement(rawId) ?: return@mapNotNull null
        if (id <= 0) return@mapNotNull null
        val manufacturer = (m.stringFieldAny("Manufacturer") ?: fallbackManufacturer).trim()
        val model = (m.stringFieldAny("DeviceModel", "Model") ?: fallbackModel).trim()
        val displayText = (m.stringFieldAny("DisplayText", "SelectedText")
            ?: "$manufacturer $model".trim()).trim()
        val deviceType = formatDeviceType(m["DeviceType"])
        val descriptionPrim = m["Description"] as? JsonPrimitive
        val description = if (descriptionPrim != null && descriptionPrim !is JsonNull) {
            descriptionPrim.content.trim()
        } else {
            ""
        }
        CatalogSearchMatch(id, manufacturer, model, displayText, deviceType, description)
    }
}
