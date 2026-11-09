package app.melodious.protocol.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** Where a device's Touch screen (`16417Device<id>`) comes from; see [DeviceTouchScreens.state]. */
enum class DeviceTouchScreen {
    /** The hub has a Touch and the device has no screen yet. */
    NONE,
    /** Made on this hub, so it can be rebuilt or removed. */
    MADE,
    /** Logitech's own, never touched. */
    LOGITECH,
    /** A Home Assistant device: its screen follows the device set. */
    MANAGED,
    /** The hub has no Touch screens to copy. */
    NO_TOUCH,
}

/**
 * Device screens on the Harmony Touch. The hub builds them from a device's commands
 * (`POST /api/device-screen`); same rules as the web UI's touchScreenState in ir-model.js.
 */
object DeviceTouchScreens {
    /** Logitech issued every map ID at or below this (codexactivity.lua). */
    private const val MAP_ID_FLOOR = 52944089L

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.present(key: String): Boolean = this[key] != null && this[key] !is JsonNull

    fun state(snapshot: HubConfigSnapshot, deviceId: String): DeviceTouchScreen {
        val maps = (snapshot.mapList["ButtonMaps"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val screen = maps.firstOrNull { it.text("ButtonMapIdentifier") == "16417Device$deviceId" }
        if (screen != null && ((screen["ButtonMapId-"] as? JsonPrimitive)?.longOrNull ?: 0L) <= MAP_ID_FLOOR) {
            return DeviceTouchScreen.LOGITECH
        }
        val device = DeviceSettingsModel.deviceEntry(snapshot, deviceId)?.get("Device") as? JsonObject
        val detected = (device?.get("AutoDetectedDevice") as? JsonObject)?.text("Id")
        // Home Assistant and hub Bluetooth keyboard devices: their writer
        // builds the screen with the device.
        if (detected?.startsWith("melodious-ha-") == true ||
            detected?.startsWith("melodious-bt-") == true) return DeviceTouchScreen.MANAGED
        if (screen != null) return DeviceTouchScreen.MADE
        val hasTouch = maps.any {
            it.text("ButtonMapIdentifier")?.startsWith("16417") == true && it.present("SurfaceId-") && it.present("RemoteId-")
        }
        return if (hasTouch) DeviceTouchScreen.NONE else DeviceTouchScreen.NO_TOUCH
    }

    /** Body for `POST /api/device-screen`. */
    fun requestBody(deviceId: String, remove: Boolean): JsonObject = JsonObject(
        mapOf("deviceId" to JsonPrimitive(deviceId), "remove" to JsonPrimitive(remove))
    )
}
