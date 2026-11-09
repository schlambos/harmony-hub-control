package app.melodious.protocol.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Discovered or configured hub endpoint on the LAN.
 */
@Serializable
data class HubEndpoint(
    val name: String,
    val host: String,
    val webUiPort: Int = 8080,
    val hbusPort: Int = 8088,
    val hubId: String = "",
    val firmware: String = "",
    val isSimulated: Boolean = false,
    val basicAuthHeader: String? = null,
) {
    val baseUrl: String get() = "http://$host:$webUiPort"
    val hbusWsUrl: String
        get() = if (hubId.isNotBlank()) {
            "ws://$host:$hbusPort/?domain=svcs.myharmony.com&hubId=$hubId"
        } else {
            "ws://$host:$hbusPort/"
        }
}

/**
 * Domain representation of a hub activity parsed from `/api/activity-config`.
 */
@Serializable
data class HubActivity(
    val id: String,
    val name: String,
    val displayName: String,
    val type: Int = 1,
    val activityOrder: Int = 0,
    val roles: List<HubRole> = emptyList(),
) {
    val typeLabel: String
        get() = ACTIVITY_TYPE_LABELS[type] ?: "Activity"

    companion object {
        val ACTIVITY_TYPE_LABELS = mapOf(
            1 to "Watch TV",
            2 to "Watch a movie",
            3 to "Play a game",
            4 to "Listen to music",
        )
    }
}

@Serializable
data class HubRole(
    val id: Int = 0,
    val deviceId: String,
    val roleType: String,
    val selectedInput: String? = null,
    val powerOnOrder: Int = 1,
    val powerOffOrder: Int = 1,
    val nextDevicePowerOnDelay: Int? = null,
)

@Serializable
data class HubDevice(
    val id: String,
    val name: String,
    val manufacturer: String = "",
    val model: String = "",
    val type: String = "",
    val transport: Int = 1,
    val btAddress: String = "",
    val isKeyboardAssociated: Boolean = false,
    val commands: List<DeviceCommand> = emptyList(),
    val inputs: List<String> = emptyList(),
    /** Input display name ("HDMI 2") -> command that selects it ("InputHdmi2"); empty when the hub lists no inputs. */
    val inputCommands: Map<String, String> = emptyMap(),
    /** The Home Assistant device key (the `{d}` token), or null for other devices. */
    val haKey: String? = null,
    /** `AutoDetectedDevice.Id`: `melodious-ha-…`, `melodious-androidtv-…` or `melodious-bt-…` for the hub's IP devices. */
    val autoDetectedId: String = "",
) {
    val isBluetoothHid: Boolean get() = transport == 32

    /** A network Android/Google TV the hub drives itself (an IP device, but not Home Assistant's). */
    val isNetworkTv: Boolean get() = autoDetectedId.startsWith("melodious-androidtv-")

    /** A saved Bluetooth keyboard target the hub publishes as an IP device (its keys go out over Bluetooth). */
    val isHubBluetooth: Boolean get() = autoDetectedId.startsWith("melodious-bt-")

    /** Transport 64 or a Home Assistant manufacturer, as the web app decides it. */
    val isHomeAssistant: Boolean
        get() = !isNetworkTv && !isHubBluetooth &&
            (transport == 64 || manufacturer.contains("home assistant", ignoreCase = true))
}

@Serializable
data class DeviceCommand(
    val name: String,
    val functionId: Int = 0,
    val keyCode: String = "",
    val isLearned: Boolean = false,
    val isRaw: Boolean = false,
)

/**
 * Resolved button action for a hard key or soft MenuItem in an Activity or Device view.
 */
@Serializable
data class ResolvedButtonAction(
    val buttonKey: String,
    val buttonLabel: String,
    val pressDeviceId: String,
    val pressDeviceName: String,
    val pressCommand: String,
    val pressFunctionId: Int = 0,
    val holdDeviceId: String? = null,
    val holdDeviceName: String? = null,
    val holdCommand: String? = null,
    val holdFunctionId: Int = 0,
    val doublePressDeviceId: String? = null,
    val doublePressDeviceName: String? = null,
    val doublePressCommand: String? = null,
    val doublePressFunctionId: Int = 0,
) {
    val hasHold: Boolean get() = !holdCommand.isNullOrBlank() && !holdDeviceId.isNullOrBlank()
    val summaryText: String get() = "$pressDeviceName · $pressCommand"
}

/**
 * An on-screen ("soft") button from an activity's touch-screen map (`16417Activity<id>`):
 * the labelled buttons Harmony remotes with screens show, such as Home or Sleep.
 */
data class SoftButton(
    val label: String,
    val deviceId: String,
    val deviceName: String,
    val command: String,
    val functionId: Int = 0,
    val order: Int = 0,
    /** Non-empty when the button runs a sequence; the command fields are then blank. */
    val steps: List<app.melodious.protocol.graph.SequenceStep> = emptyList(),
) {
    /** Single digit keys, which belong on the number pad rather than in the button list. */
    val digit: Int? get() = if (steps.isNotEmpty()) null else command.trim().takeIf { it.length == 1 }?.toIntOrNull()
}

/**
 * Wizard draft state for creating or editing an Activity.
 */
@Serializable
enum class ButtonMappingSource {
    @SerialName("default") DEFAULT,
    @SerialName("user") USER,
    @SerialName("existing") EXISTING,
}

@Serializable
data class WizardButtonMapping(
    val deviceId: String,
    val commandName: String,
    val functionId: Int = 0,
    val holdDeviceId: String? = null,
    val holdCommandName: String? = null,
    val holdFunctionId: Int = 0,
    val doublePressDeviceId: String? = null,
    val doublePressCommandName: String? = null,
    val doublePressFunctionId: Int = 0,
    val source: ButtonMappingSource = ButtonMappingSource.DEFAULT,
    val extra: Boolean = false,
)

@Serializable
data class WizardRoleDraft(
    val roleType: String,
    val deviceId: String,
    val input: String? = null,
    val powerDelay: Int? = null,
)

data class ActivityWizardDraft(
    val editActivityId: String? = null,
    val name: String = "",
    val type: Int = 1,
    val roles: List<WizardRoleDraft> = emptyList(),
    val buttons: Map<String, WizardButtonMapping> = emptyMap(),
    /** Device ids in power-on order; devices missing from the list follow in role order. */
    val powerOnOrder: List<String> = emptyList(),
    /** Device ids in power-off order; empty means "same as power-on". */
    val powerOffOrder: List<String> = emptyList(),
    /** Extra steps when the activity starts / ends. Null means "leave the hub's list untouched". */
    val enterSteps: List<app.melodious.protocol.graph.SequenceStep>? = emptyList(),
    val leaveSteps: List<app.melodious.protocol.graph.SequenceStep>? = emptyList(),
)

/**
 * Raw JSON resource container returned by `GET /api/activity-config` and mutated
 * in-place during transactional saves so unknown vendor keys survive byte-for-byte.
 */
data class HubConfigSnapshot(
    val revision: String,
    val rawRoot: JsonObject,
    val activityList: JsonObject,
    val mapList: JsonObject,
    val functionList: JsonObject,
    val deviceList: JsonObject,
    val activities: List<HubActivity>,
    val devices: List<HubDevice>,
    /** Live Home Assistant device state from the same response; null on hubs without `ha-state`. */
    val haState: HaStateEnvelope? = null,
)

@Serializable
data class SystemStatusSnapshot(
    val ok: Boolean = true,
    val firmware: String = "",
    val uptime: String = "",
    val memTotal: String = "",
    val memory: String = "",
    val uname: String = "",
    val mounts: String = "",
    val processes: String = "",
    val logs: String = "",
    val authMode: String = "open on local network",
    val cloudBlocked: Boolean = true,
    val timezone: String = "UTC",
) {
    val isAuthEnabled: Boolean
        get() = authMode.contains("sign-in required", ignoreCase = true)
}

@Serializable
data class IrCaptureAnalysis(
    val empty: Boolean,
    val mode: String,
    val keycode: String,
    val nec: String,
    val raw: String,
    val protocolId: Int = 2,
    val analysis: String = "",
)

@Serializable
data class BtAdapterStatus(
    val action: String = "",
    val connected: Boolean = false,
    val detectedAddress: String = "",
    val rawOutput: String = "",
    val error: String = "",
)

@Serializable
data class BtTextHelperStatus(
    val runtime: Boolean = false,
    val state: String = "unknown",
    val target: String = "",
    val sent: Int = 0,
    val skipped: Int = 0,
    val error: String = "",
    val live: Boolean = false,
    val remedy: String = "",
)

@Serializable
data class SavedBtDevice(
    val id: String,
    val name: String,
    val type: String = "btkeyboard",
    val bdaddr: String = "",
    val scripts: List<SavedBtScript> = emptyList(),
)

@Serializable
data class SavedBtScript(
    val name: String,
    val delayMs: Int = 35,
    val script: String,
)
