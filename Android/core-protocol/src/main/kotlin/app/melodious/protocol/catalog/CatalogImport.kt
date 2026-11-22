package app.melodious.protocol.catalog

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

data class CatalogCommandRow(
    val name: String,
    val keycode: String,
    val raw: String,
    val protocol: String,
)

data class CatalogSkipped(val name: String, val reason: String)

data class CatalogRowsResult(
    val rows: List<CatalogCommandRow>,
    val skipped: List<CatalogSkipped>,
    val protocolsUsed: List<String>,
    val missingProtocols: List<String>,
    val protocolsToAdd: List<JsonObject> = emptyList(),
)

/**
 * Protocols the hub knows natively (BUILTIN_PROTOCOLS /
 * ensure_builtin_protocol_for_id in payload/source/codex_webui.c) and
 * automatically writes to ProtocolList.json on import, even on a brand-new
 * blank hub whose ProtocolList starts empty.
 */
val BUILTIN_HUB_PROTOCOLS: List<String> = listOf(
    "Toshiba 32 Bit",
    "Sony 15 Bit",
    "Sony 20 Bit",
    "Saitek 11 Bit",
    "MemorexO1 32 Bit",
    "Samsung 16 and 20 Bit",
)

private val INVALID_PROTOCOL_NAME_RE = Regex("[:\\\\\"\\u0000-\\u001f\\u007f]")

/** True when [record] looks like a usable Harmony IrProtocol definition. */
fun isValidProtocolRecord(record: JsonElement?): Boolean {
    val obj = record as? JsonObject ?: return false
    val type = (obj["__type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (type != "IrProtocol") return false
    val idPrim = obj["Id-"] as? JsonPrimitive ?: return false
    if (idPrim.isString) return false
    val pid = parseIntegerElement(idPrim) ?: return false
    if (pid <= 0 || pid > 999999) return false
    val name = (obj["Name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
    if (name.isEmpty() || name.length > 127 || INVALID_PROTOCOL_NAME_RE.containsMatchIn(name)) return false
    val freqPrim = obj["CarrierFrequency"] as? JsonPrimitive ?: return false
    if (freqPrim.isString) return false
    val freq = freqPrim.doubleOrNull ?: return false
    if (!freq.isFinite() || freq < 10000.0 || freq > 500000.0) return false
    if (obj["KeyCode"] !is JsonObject) return false
    val irSegments = obj["IRSegments"] as? JsonArray ?: return false
    val codeSegmentsEl = obj["CodeSegments"]
    if (codeSegmentsEl != null && codeSegmentsEl !is JsonNull && codeSegmentsEl !is JsonArray) return false
    val hasIr = irSegments.any { it is JsonObject }
    val hasCode = (codeSegmentsEl as? JsonArray)?.any { it is JsonObject } == true
    return hasIr || hasCode
}

fun neededProtocolRefs(commands: JsonElement?): Pair<Set<Long>, Set<String>> {
    val ids = LinkedHashSet<Long>()
    val names = LinkedHashSet<String>()
    val arr = commands as? JsonArray ?: return ids to names
    for (el in arr) {
        val cmd = el as? JsonObject ?: continue
        val keycode = (cmd["KeyCode"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
        if (keycode.startsWith("G:")) {
            val name = keycode.substring(2).substringBefore(":")
            if (name.isNotEmpty()) names.add(name)
            val pidPrim = cmd["ProtocolId"] as? JsonPrimitive
            if (pidPrim != null && !pidPrim.isString) {
                val pid = parseIntegerElement(pidPrim)
                if (pid != null && pid > 0) ids.add(pid)
            }
        }
    }
    return ids to names
}

fun selectNeededProtocols(protocolList: List<JsonObject>, commands: JsonElement?): List<JsonObject> {
    val (needIds, needNames) = neededProtocolRefs(commands)
    if (needIds.isEmpty() && needNames.isEmpty()) return emptyList()
    val selected = mutableListOf<JsonObject>()
    val seenIds = HashSet<Long>()
    val seenNames = HashSet<String>()
    for (proto in protocolList) {
        if (!isValidProtocolRecord(proto)) continue
        val pid = parseIntegerElement(proto["Id-"] as JsonPrimitive) ?: continue
        val name = (proto["Name"] as JsonPrimitive).content
        if (pid !in needIds && name !in needNames) continue
        if (pid in seenIds || name in seenNames) continue
        seenIds.add(pid)
        seenNames.add(name)
        selected.add(proto)
    }
    return selected
}

/** Valid IrProtocol records bundled inside a catalog package, deduplicated by Id- and Name. */
fun packageProtocols(pkg: JsonElement?): List<JsonObject> {
    val resources = (pkg as? JsonObject)?.get("resources") as? JsonObject ?: return emptyList()
    val raw = resources["protocols"] as? JsonArray ?: return emptyList()
    val valid = mutableListOf<JsonObject>()
    val seenIds = HashSet<Long>()
    val seenNames = HashSet<String>()
    for (el in raw) {
        val proto = el as? JsonObject ?: continue
        if (!isValidProtocolRecord(proto)) continue
        val pid = parseIntegerElement(proto["Id-"] as JsonPrimitive) ?: continue
        val name = (proto["Name"] as JsonPrimitive).content
        if (pid in seenIds || name in seenNames) continue
        seenIds.add(pid)
        seenNames.add(name)
        valid.add(proto)
    }
    return valid
}

fun catalogRows(pkg: JsonElement?, hubProtocolNames: List<String>): CatalogRowsResult {
    val resources = (pkg as? JsonObject)?.get("resources") as? JsonObject
    val commands = (resources?.get("global_language_commands") as? JsonArray) ?: JsonArray(emptyList())
    val have = hubProtocolNames.toSet()
    val bundledByName = LinkedHashMap<String, JsonObject>()
    for (proto in packageProtocols(pkg)) {
        val name = (proto["Name"] as JsonPrimitive).content
        bundledByName[name] = proto
    }
    val rows = mutableListOf<CatalogCommandRow>()
    val skipped = mutableListOf<CatalogSkipped>()
    val used = sortedSetOf<String>()
    val missing = sortedSetOf<String>()
    val toAddByName = LinkedHashMap<String, JsonObject>()
    for (commandEl in commands) {
        val command = commandEl as? JsonObject
        val name = ((command?.get("Name") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "").trim()
        if (name.isEmpty()) {
            skipped.add(CatalogSkipped("(unnamed)", "no command name"))
            continue
        }
        val keycode = (command?.get("KeyCode") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        val raw = (command?.get("Raw") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        if (keycode.startsWith("G:")) {
            val protocol = keycode.substring(2).substringBefore(":")
            if (protocol.isEmpty()) {
                skipped.add(CatalogSkipped(name, "KeyCode names no protocol"))
                continue
            }
            if (protocol !in have) {
                val bundled = bundledByName[protocol]
                if (bundled == null) {
                    missing.add(protocol)
                    skipped.add(CatalogSkipped(name, "protocol “${protocol}” is not on this hub"))
                    continue
                }
                toAddByName[protocol] = bundled
            }
            used.add(protocol)
            rows.add(CatalogCommandRow(name, keycode, "", protocol))
        } else if (raw.isNotEmpty()) {
            rows.add(CatalogCommandRow(name, "", raw, ""))
        } else if (keycode.isNotEmpty()) {
            skipped.add(CatalogSkipped(name, "KeyCode is not in Harmony G: form"))
        } else {
            skipped.add(CatalogSkipped(name, "no KeyCode or Raw code"))
        }
    }
    return CatalogRowsResult(
        rows = rows,
        skipped = skipped,
        protocolsUsed = used.sorted(),
        missingProtocols = missing.sorted(),
        protocolsToAdd = toAddByName.values.toList(),
    )
}

fun hubProtocolNames(protocolList: JsonElement?): List<String> {
    val protocols = (protocolList as? JsonObject)?.get("Protocols") as? JsonArray ?: return emptyList()
    return protocols.mapNotNull { el ->
        val prim = (el as? JsonObject)?.get("Name") as? JsonPrimitive ?: return@mapNotNull null
        val s = if (prim.isString) prim.content else prim.content
        s.takeIf { it.isNotEmpty() }
    }
}

/**
 * Protocol names the hub can accept for catalog KeyCodes, given a parsed
 * `/export/protocols` ProtocolList export: every name already in ProtocolList
 * plus the hub's built-in protocols. Returns null if [protocolList] is not a
 * valid ProtocolList object.
 */
fun supportedHubProtocolNames(protocolList: JsonElement?): List<String>? {
    val obj = protocolList as? JsonObject ?: return null
    if (obj["Protocols"] !is JsonArray) return null
    val merged = hubProtocolNames(obj).toMutableList()
    val seen = merged.toMutableSet()
    for (name in BUILTIN_HUB_PROTOCOLS) {
        if (seen.add(name)) merged.add(name)
    }
    return merged
}

/** Human explanation and workaround when a catalog package needs missing IR protocols. */
fun missingProtocolsHint(missingProtocols: List<String>): String {
    val list = missingProtocols.filter { it.isNotEmpty() }
    if (list.isEmpty()) return ""
    return "This hub does not have the IR timing definition for ${list.joinToString(", ")}, " +
        "so it cannot play those KeyCodes. Learn the buttons from your original remote, " +
        "or import the device from IRDB or a Flipper .ir file in Find codes."
}

fun describeCatalogRows(result: CatalogRowsResult): String {
    val bits = mutableListOf("${result.rows.size} importable")
    if (result.protocolsUsed.isNotEmpty()) bits.add("protocols: ${result.protocolsUsed.joinToString(", ")}")
    if (result.protocolsToAdd.isNotEmpty()) {
        val names = result.protocolsToAdd.mapNotNull {
            (it["Name"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content
        }.sorted()
        if (names.isNotEmpty()) bits.add("adds protocols: ${names.joinToString(", ")}")
    }
    if (result.skipped.isNotEmpty()) bits.add("${result.skipped.size} skipped")
    if (result.missingProtocols.isNotEmpty()) bits.add("missing on hub: ${result.missingProtocols.joinToString(", ")}")
    return bits.joinToString(" · ")
}
