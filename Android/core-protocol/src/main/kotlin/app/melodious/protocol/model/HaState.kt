package app.melodious.protocol.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Live Home Assistant device state, as the hub keeps it (`haState` in `/api/activity-config`,
 * `GET /api/ha-state`). Home Assistant pushes it; the hub holds it in RAM only and marks it
 * stale 90 s after the last push. [states] keeps each snapshot's JSON so fields this app
 * doesn't know survive.
 */
data class HaStateEnvelope(
    val version: Long,
    val stale: Boolean,
    val states: List<JsonObject>,
)

/** One chip in a device's state strip. */
data class HaChip(val kind: Kind, val label: String) {
    enum class Kind { UNKNOWN, ON, OFF, SOURCE, APP, PLAYING, SOUND, MUTED, VOLUME }
}

data class HaTheaterPort(
    val id: String,
    val label: String,
    val connected: Boolean?,
    val signal: Boolean?,
    val cecName: String?,
    val cecType: Int?,
)

data class HaTheaterSound(
    val output: String?,
    val label: String?,
    val port: String?,
    /** TV-reported level on its own 0–100 scale, not a percentage of the HA volume. */
    val volume: Double?,
    val muted: Boolean?,
    val text: String,
)

/** What an LG TV reports about its HDMI ports and sound output while it's on. */
data class HaTheater(
    val activeInput: HaTheaterPort?,
    val ports: List<HaTheaterPort>,
    val sound: HaTheaterSound?,
    val portsText: String,
)

data class HaTheaterLink(val port: String, val live: Boolean = false, val connected: Boolean? = null, val signal: Boolean? = null)

/**
 * One device's state, ready to show. Never says "off" unless Home Assistant does: missing,
 * stale or unavailable state is [known] = false with a "State unknown" badge.
 */
data class HaDeviceInfo(
    val key: String?,
    val known: Boolean,
    val stale: Boolean,
    /** "on", "off" or "unknown". */
    val power: String,
    val source: String? = null,
    val activity: String? = null,
    /** 0–100. */
    val volume: Int? = null,
    val muted: Boolean? = null,
    /** "playing", "paused" or "idle". */
    val playing: String? = null,
    val badge: String,
    val chips: List<HaChip>,
    val theater: HaTheater? = null,
    /** "HDMI 1" when the LG reports which port is live. */
    val activeInputId: String? = null,
    val theaterLink: HaTheaterLink? = null,
) {
    val summary: String get() = chips.joinToString(" · ") { it.label }
}

/** Port of `tools/webui-sim/public/js/views/remote-model.js` (describeHaDeviceState and friends). */
object HaState {
    private val UNKNOWN_CHIPS = listOf(HaChip(HaChip.Kind.UNKNOWN, "State unknown"))

    fun parseEnvelope(obj: JsonObject?): HaStateEnvelope? {
        obj ?: return null
        return HaStateEnvelope(
            version = obj["version"].long() ?: 0L,
            stale = obj["stale"].bool() ?: false,
            states = (obj["states"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject },
        )
    }

    /** "HDMI_1" -> "HDMI 1" (the stable hub input name). */
    fun theaterPortLabel(portId: String?): String = portId.orEmpty().replaceFirst("_", " ")

    fun describe(device: HubDevice?, envelope: HaStateEnvelope?): HaDeviceInfo? {
        if (device == null || !device.isHomeAssistant) return null
        val key = device.haKey
        val snap = key?.let { k -> envelope?.states?.firstOrNull { it["key"].text() == k } }
        val stale = envelope == null || envelope.stale || snap == null || snap["available"].bool() == false
        val rawPower = if (!stale) snap!!["power"].text()?.lowercase() ?: "unknown" else "unknown"
        val power = if (rawPower == "on" || rawPower == "off") rawPower else "unknown"
        val known = !stale && power != "unknown"
        val source = if (!stale) snap!!["source"].text()?.trim()?.takeIf { it.isNotEmpty() } else null
        val activity = if (!stale) snap!!["activity"].text()?.trim()?.takeIf { it.isNotEmpty() } else null
        val volume = if (!stale) snap!!["volume"].number()?.let { Math.round(it * 100).toInt().coerceIn(0, 100) } else null
        val muted = if (!stale) snap!!["muted"].bool() else null
        val playing = if (!stale) snap!!["playing"].text()?.lowercase()?.takeIf { it in setOf("playing", "paused", "idle") } else null
        val theater = parseTheater(snap, stale)

        val chips = if (!known) UNKNOWN_CHIPS else buildList {
            add(if (power == "on") HaChip(HaChip.Kind.ON, "On") else HaChip(HaChip.Kind.OFF, "Off"))
            source?.let { add(HaChip(HaChip.Kind.SOURCE, it)) }
            if (activity != null && !activity.equals(source.orEmpty(), ignoreCase = true)) add(HaChip(HaChip.Kind.APP, activity))
            if (playing == "playing" || playing == "paused") {
                add(HaChip(HaChip.Kind.PLAYING, if (playing == "playing") "Playing" else "Paused"))
            }
            when {
                theater?.sound != null -> add(HaChip(HaChip.Kind.SOUND, theater.sound.text))
                muted == true -> add(HaChip(HaChip.Kind.MUTED, if (volume != null) "Muted ($volume%)" else "Muted"))
                volume != null -> add(HaChip(HaChip.Kind.VOLUME, "Vol $volume%"))
            }
        }
        return HaDeviceInfo(
            key = key,
            known = known,
            stale = stale,
            power = power,
            source = source,
            activity = activity,
            volume = volume,
            muted = muted,
            playing = playing,
            badge = if (!known) "State unknown" else if (power == "on") "On" else "Off",
            chips = chips,
            theater = theater,
            activeInputId = theater?.activeInput?.let { theaterPortLabel(it.id) },
        )
    }

    /**
     * Display-only link from a hub device (often IR) to one LG HDMI port, from the integration's
     * theater links. Connection, video signal and ARC are observations; the linked device's power
     * is never inferred. Null when the device has no link.
     */
    fun describeTheaterLink(device: HubDevice?, envelope: HaStateEnvelope?): HaDeviceInfo? {
        if (device == null || envelope == null) return null
        var snap: JsonObject? = null
        var linkPort: String? = null
        for (state in envelope.states) {
            val links = (state["theater_links"] as? JsonArray) ?: continue
            val found = links.mapNotNull { it as? JsonObject }
                .firstOrNull { it["device_id"].raw() == device.id && it["port"].text() != null }
            if (found != null) {
                snap = state
                linkPort = found["port"].text()
                break
            }
        }
        if (snap == null || linkPort == null) return null
        val stale = envelope.stale || snap["available"].bool() == false
        val key = snap["key"].text()
        val theater = parseTheater(snap, stale)
            ?: return HaDeviceInfo(
                key = key, known = false, stale = true, power = "unknown", badge = "State unknown",
                chips = UNKNOWN_CHIPS, theaterLink = HaTheaterLink(linkPort),
            )
        val port = theater.ports.firstOrNull { it.id == linkPort }
        val live = theater.activeInput?.id == linkPort
        val label = theaterPortLabel(linkPort)
        val chips = buildList {
            when {
                live -> add(HaChip(HaChip.Kind.ON, "$label · live on the TV"))
                port?.connected == true -> add(HaChip(HaChip.Kind.SOURCE, "$label · connected to the TV"))
                port?.connected == false -> add(HaChip(HaChip.Kind.UNKNOWN, "$label · not connected"))
                else -> add(HaChip(HaChip.Kind.UNKNOWN, label))
            }
            if (port?.signal == true && theater.sound?.port != linkPort) add(HaChip(HaChip.Kind.PLAYING, "Signal present"))
            if (theater.sound?.port == linkPort) {
                add(HaChip(HaChip.Kind.SOUND, theater.sound.text.removePrefix("Sound: ").let { "On ARC · $it" }))
            }
        }
        return HaDeviceInfo(
            key = key, known = true, stale = false, power = "unknown", badge = "Linked", chips = chips,
            theater = theater,
            activeInputId = theater.activeInput?.let { theaterPortLabel(it.id) },
            theaterLink = HaTheaterLink(linkPort, live, port?.connected, port?.signal),
        )
    }

    /**
     * What a state strip shows for one device: its own state, a theater link, or both (an HA
     * device that is also linked to an LG port). Null when there's nothing to show.
     */
    fun stripFor(device: HubDevice?, envelope: HaStateEnvelope?): HaDeviceInfo? {
        val own = describe(device, envelope)
        val link = describeTheaterLink(device, envelope)
        if (own != null && link?.known == true) {
            val seen = own.chips.map { it.label }.toSet()
            return own.copy(chips = own.chips + link.chips.filter { it.label !in seen }, theaterLink = link.theaterLink)
        }
        return own ?: link
    }

    /**
     * True when a command would change nothing given fresh state: PowerOn while on, PowerOff while
     * off, Play while playing, Pause while paused, or the input the device is already on. Never
     * true when the state is unknown.
     */
    fun isCommandRedundant(commandName: String, info: HaDeviceInfo?): Boolean {
        if (info == null || !info.known) return false
        val key = RemoteLayout.commandKey(commandName)
        if (key.isEmpty()) return false
        if (info.power == "on" && (key == "poweron" || key == "on")) return true
        if (info.power == "off" && (key == "poweroff" || key == "off")) return true
        if (info.playing == "playing" && key == "play") return true
        if (info.playing == "paused" && key == "pause") return true
        info.activeInputId?.let { active ->
            val activeKey = RemoteLayout.commandKey(active)
            if (activeKey.isNotEmpty() && key == "input$activeKey") return true
        }
        info.source?.let { source ->
            val srcKey = RemoteLayout.commandKey(source)
            if (srcKey.isNotEmpty() &&
                (key == "input$srcKey" || (commandName.lowercase().startsWith("input ") && key == srcKey))
            ) return true
        }
        return false
    }

    /** The Fix it hint for one device: "Living Room TV is already on · on HDMI 1", "… is off", or "State unknown". */
    fun fixItHint(device: HubDevice, info: HaDeviceInfo?): String? {
        info ?: return null
        return when {
            !info.known -> "State unknown"
            info.power == "on" -> buildList {
                add("${device.name} is already on")
                when {
                    info.source != null -> add("on ${info.source}")
                    info.activity != null -> add("in ${info.activity}")
                }
            }.joinToString(" · ")
            else -> "${device.name} is off"
        }
    }

    private fun parseTheater(snap: JsonObject?, stale: Boolean): HaTheater? {
        if (stale || snap == null) return null
        val raw = snap["theater"] as? JsonObject ?: return null
        val ports = (raw["ports"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { port ->
            val id = port["id"].text() ?: return@mapNotNull null
            HaTheaterPort(
                id = id,
                label = port["label"].text()?.trim()?.takeIf { it.isNotEmpty() } ?: theaterPortLabel(id),
                connected = port["connected"].bool(),
                signal = port["signal"].bool(),
                cecName = port["cec_name"].text()?.trim()?.takeIf { it.isNotEmpty() },
                cecType = port["cec_type"].number()?.toInt(),
            )
        }
        val active = (raw["active_input"] as? JsonObject)?.let { a ->
            val id = a["id"].text() ?: return@let null
            HaTheaterPort(id, a["label"].text()?.trim()?.takeIf { it.isNotEmpty() } ?: theaterPortLabel(id), null, null, null, null)
        }
        val sound = (raw["sound"] as? JsonObject)?.let { s ->
            val output = s["output"].text()?.trim()?.takeIf { it.isNotEmpty() }
            val label = s["label"].text()?.trim()?.takeIf { it.isNotEmpty() }
            val volume = s["volume"].number()
            val muted = s["muted"].bool()
            val dest = if (output == "external_arc") (if (label != null) "$label (ARC)" else "ARC") else (label ?: output)
            dest ?: return@let null
            val bits = buildList {
                add("Sound: $dest")
                volume?.let { add("Vol ${formatNumber(it)}") }
                if (muted == true) add("Muted")
            }
            HaTheaterSound(output, label, s["port"].text(), volume, muted, bits.joinToString(" · "))
        }
        val portsText = ports.joinToString(" · ") { port ->
            val live = active != null && port.id == active.id
            val state = when {
                live -> "live"
                port.connected == true -> "connected"
                port.connected == false -> "not connected"
                else -> "unknown"
            }
            val sig = if (port.signal == true && !live) ", signal" else ""
            "${theaterPortLabel(port.id)} ${port.label} ($state$sig)"
        }
        return HaTheater(active, ports, sound, portsText)
    }

    /** 14.0 -> "14", 14.5 -> "14.5", like JavaScript's number formatting. */
    private fun formatNumber(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

    private fun JsonElement?.raw(): String? = (this as? JsonPrimitive)?.contentOrNull
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    private fun JsonElement?.number(): Double? =
        (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
    private fun JsonElement?.long(): Long? =
        (this as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() ?: it.contentOrNull?.toLongOrNull() }
}
