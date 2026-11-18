package app.melodious.protocol.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * One device's power and timing settings (parity P1). A Kotlin port of the web UI's
 * `device-settings-model.js`, which mirrors codexactivity's `CommitDeviceSettings`, so the app
 * refuses exactly what the hub would. The hub still re-checks everything on save.
 */
enum class PowerType(val wire: String, val label: String) {
    DISCRETE("discrete", "Separate On and Off commands"),
    TOGGLE("toggle", "One power button (toggle)"),
    NONE("none", "No power control (always on, or switched by hand)"),
}

data class DeviceSettings(
    val hasPowerFeature: Boolean,
    val interKeyDelayMs: Int,
    val interDeviceDelayMs: Int,
    val repeats: Int,
    val powerType: PowerType,
    val powerOn: String,
    val powerOff: String,
    val powerToggle: String,
    val powerOnDelayMs: Int,
    val alwaysOn: Boolean,
    val onBetweenActivities: Boolean,
)

object DeviceSettingsModel {
    val INTER_KEY_DELAY_MS = 0..5000
    val INTER_DEVICE_DELAY_MS = 0..10000
    val REPEATS = 0..10
    val POWER_ON_DELAY_MS = 0..60000

    /** PowerFeature.PowerTypeId: 0 (not specified) and 3 (manual) both mean "no power commands". */
    private fun typeById(id: Int?): PowerType = when (id) {
        1 -> PowerType.DISCRETE
        2 -> PowerType.TOGGLE
        else -> PowerType.NONE
    }

    fun deviceEntry(snapshot: HubConfigSnapshot, deviceId: String): JsonObject? =
        (snapshot.deviceList["DevicesWithFeatures"] as? JsonArray).orEmpty()
            .mapNotNull { it as? JsonObject }
            .firstOrNull { ((it["Device"] as? JsonObject)?.get("Id-") as? JsonPrimitive)?.contentOrNull == deviceId }

    fun commandNames(entry: JsonObject): List<String> =
        (entry["Commands"] as? JsonArray).orEmpty()
            .mapNotNull { ((it as? JsonObject)?.get("Name") as? JsonPrimitive)?.contentOrNull }
            .filter { it.isNotBlank() }

    data class PowerSuggestion(val on: String, val off: String, val toggle: String)

    /** Best guesses for a device without a power feature, by command name. */
    fun suggestPowerCommands(names: List<String>): PowerSuggestion {
        fun key(name: String) = name.lowercase().replace(Regex("[\\s_-]+"), "")
        fun pick(candidates: List<String>) = candidates.firstNotNullOfOrNull { c -> names.firstOrNull { key(it) == c } }.orEmpty()
        return PowerSuggestion(
            on = pick(listOf("poweron", "discreteon", "on")),
            off = pick(listOf("poweroff", "discreteoff", "off")),
            toggle = pick(listOf("powertoggle", "power", "poweronoff", "onoff", "standby")),
        )
    }

    private fun powerFeature(entry: JsonObject): JsonObject? =
        (entry["DeviceFeatures"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .firstOrNull { (it["__type"] as? JsonPrimitive)?.contentOrNull.orEmpty().contains("PowerFeature") }

    private fun firstCommand(actions: Any?): String =
        (actions as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.get("IRCommandName") as? JsonPrimitive }
            .firstNotNullOfOrNull { it.contentOrNull?.takeIf(String::isNotBlank) }.orEmpty()

    private fun wholeNumber(value: Any?, fallback: Int): Int {
        val n = (value as? JsonPrimitive)?.doubleOrNull ?: return fallback
        return if (n >= 0 && n == Math.floor(n)) n.toInt() else fallback
    }

    fun read(entry: JsonObject): DeviceSettings {
        val device = entry["Device"] as? JsonObject ?: JsonObject(emptyMap())
        val feature = powerFeature(entry)
        val suggested = suggestPowerCommands(commandNames(entry))
        val type = when {
            feature != null -> typeById((feature["PowerTypeId"] as? JsonPrimitive)?.doubleOrNull?.toInt())
            suggested.on.isNotEmpty() && suggested.off.isNotEmpty() -> PowerType.DISCRETE
            suggested.toggle.isNotEmpty() -> PowerType.TOGGLE
            else -> PowerType.NONE
        }
        val isDisplay = Regex("television|projector", RegexOption.IGNORE_CASE)
            .containsMatchIn((device["DeviceTypeDisplayName"] as? JsonPrimitive)?.contentOrNull.orEmpty())
        return DeviceSettings(
            hasPowerFeature = feature != null,
            interKeyDelayMs = wholeNumber(device["InterKeyDelay"], 100),
            interDeviceDelayMs = wholeNumber(device["InterDeviceDelay"], 500),
            // The engine repeats 3 times when PressMinRepeats is missing.
            repeats = wholeNumber(device["PressMinRepeats"], 3),
            powerType = type,
            powerOn = firstCommand(feature?.get("PowerOnActions")).ifEmpty { suggested.on },
            powerOff = firstCommand(feature?.get("PowerOffActions")).ifEmpty { suggested.off },
            powerToggle = firstCommand(feature?.get("PowerToggleActions")).ifEmpty { suggested.toggle },
            powerOnDelayMs = wholeNumber(feature?.get("PowerOnDelay"), if (isDisplay) 10000 else 2000),
            alwaysOn = (feature?.get("IsPowerAlwaysOn") as? JsonPrimitive)?.booleanOrNull == true,
            onBetweenActivities = (feature?.get("IsPoweredOnBetweenActivities") as? JsonPrimitive)?.booleanOrNull == true,
        )
    }

    /** Human-readable problems; empty when the hub will accept the settings. */
    fun validate(settings: DeviceSettings, names: List<String>, wakeOnly: Boolean = false): List<String> {
        val errors = mutableListOf<String>()
        val has = names.map { it.lowercase() }.toSet()
        fun range(label: String, value: Int, limits: IntRange) {
            if (value !in limits) errors += "$label must be from ${limits.first} to ${limits.last}."
        }
        range("Delay between commands (ms)", settings.interKeyDelayMs, INTER_KEY_DELAY_MS)
        range("Delay between devices (ms)", settings.interDeviceDelayMs, INTER_DEVICE_DELAY_MS)
        range("Repeats", settings.repeats, REPEATS)
        if (settings.powerOnDelayMs !in POWER_ON_DELAY_MS) errors += "Power-on delay must be from 0 to 60 seconds."
        when (settings.powerType) {
            PowerType.DISCRETE -> {
                val hasOn = settings.powerOn.lowercase() in has
                val offBlank = settings.powerOff.isBlank()
                val hasOff = settings.powerOff.lowercase() in has
                when {
                    !hasOn || (!hasOff && !(wakeOnly && offBlank)) ->
                        errors += "Choose an On and an Off command that the device has."
                    !offBlank && settings.powerOn.equals(settings.powerOff, ignoreCase = true) ->
                        errors += "On and Off are the same command; choose one power button instead."
                }
            }
            PowerType.TOGGLE -> if (settings.powerToggle.lowercase() !in has) errors += "Choose the device's power command."
            PowerType.NONE -> Unit
        }
        return errors
    }

    /** Body for `POST /api/device-settings`. deviceId leads: the hub finds it by the first "deviceId" key. */
    fun requestBody(deviceId: String, s: DeviceSettings): JsonObject = JsonObject(
        linkedMapOf(
            "deviceId" to JsonPrimitive(deviceId),
            "settings" to JsonObject(
                mapOf(
                    "interKeyDelayMs" to JsonPrimitive(s.interKeyDelayMs),
                    "interDeviceDelayMs" to JsonPrimitive(s.interDeviceDelayMs),
                    "repeats" to JsonPrimitive(s.repeats),
                    "power" to JsonObject(
                        mapOf(
                            "type" to JsonPrimitive(s.powerType.wire),
                            "on" to if (s.powerType == PowerType.DISCRETE) JsonPrimitive(s.powerOn) else JsonNull,
                            "off" to if (s.powerType == PowerType.DISCRETE && s.powerOff.isNotBlank()) JsonPrimitive(s.powerOff) else JsonNull,
                            "toggle" to if (s.powerType == PowerType.TOGGLE) JsonPrimitive(s.powerToggle) else JsonNull,
                            "delayMs" to JsonPrimitive(s.powerOnDelayMs),
                            "alwaysOn" to JsonPrimitive(s.alwaysOn),
                            "onBetweenActivities" to JsonPrimitive(s.onBetweenActivities),
                        )
                    ),
                )
            ),
        )
    )
}
