package app.melodious.protocol.model

/**
 * "Fix it" — re-send just the power or input command for one device in a running activity,
 * the way the physical remote's Help button does when the TV didn't turn on or the amp is on the
 * wrong input.
 */
data class FixItDevice(
    val device: HubDevice,
    val roleLabels: List<String>,
    /** Discrete PowerOn if the device has one; safe to re-send because it never turns a device off. */
    val powerOn: DeviceCommand?,
    /** PowerToggle fallback; re-sending flips the state, so the UI must say so. */
    val powerToggle: DeviceCommand?,
    val inputName: String?,
    val inputCommand: DeviceCommand?,
    /** Live Home Assistant state for an HA device; null for other devices or without state. */
    val haInfo: HaDeviceInfo? = null,
    /** "Living Room TV is already on · on HDMI 1", "… is off" or "State unknown". */
    val haHint: String? = null,
) {
    val hasAnyFix: Boolean get() = powerOn != null || powerToggle != null || inputCommand != null
}

object FixIt {
    private val POWER_ON_KEYS = setOf("poweron", "on")
    private val POWER_TOGGLE_KEYS = setOf("powertoggle", "power")

    /**
     * [powerOverrides] carries each device's configured power commands (its PowerFeature), which beat
     * name guessing: some devices power on with "Home" and off with "Sleep".
     */
    fun devicesFor(
        activity: HubActivity,
        devices: List<HubDevice>,
        roleLabel: (String) -> String,
        powerOverrides: Map<String, DeviceSettings> = emptyMap(),
        haState: HaStateEnvelope? = null,
    ): List<FixItDevice> {
        val byId = devices.associateBy { it.id }
        return activity.roles
            .sortedBy { it.powerOnOrder }
            .groupBy { it.deviceId }
            .mapNotNull { (deviceId, roles) ->
                val device = byId[deviceId] ?: return@mapNotNull null
                val inputName = roles.firstNotNullOfOrNull { it.selectedInput?.takeIf(String::isNotBlank) }
                val configured = powerOverrides[device.id]?.takeIf { it.hasPowerFeature }
                fun named(name: String) = device.commands.firstOrNull { it.name.equals(name, ignoreCase = true) }
                val haInfo = haState?.let { HaState.describe(device, it) }
                FixItDevice(
                    device = device,
                    roleLabels = roles.map { roleLabel(it.roleType) }.distinct(),
                    powerOn = when (configured?.powerType) {
                        PowerType.DISCRETE -> named(configured.powerOn)
                        PowerType.TOGGLE, PowerType.NONE -> null
                        null -> device.commands.firstOrNull { RemoteLayout.commandKey(it.name) in POWER_ON_KEYS }
                    },
                    powerToggle = when (configured?.powerType) {
                        PowerType.TOGGLE -> named(configured.powerToggle)
                        PowerType.DISCRETE, PowerType.NONE -> null
                        null -> device.commands.firstOrNull { RemoteLayout.commandKey(it.name) in POWER_TOGGLE_KEYS }
                    },
                    inputName = inputName,
                    inputCommand = inputName?.let { inputCommandFor(device, it) },
                    haInfo = haInfo,
                    haHint = HaState.fixItHint(device, haInfo),
                )
            }
    }

    /**
     * The hub's own mapping wins ("HDMI 2" -> "InputHdmi2"); otherwise fall back to the naming
     * convention every Harmony device database entry follows: "Input" + the input name, ignoring
     * spaces and case.
     */
    fun inputCommandFor(device: HubDevice, inputName: String): DeviceCommand? {
        device.inputCommands[inputName]?.let { mapped ->
            device.commands.firstOrNull { it.name == mapped }?.let { return it }
        }
        val wanted = RemoteLayout.commandKey(inputName)
        if (wanted.isEmpty()) return null
        return device.commands.firstOrNull { RemoteLayout.commandKey(it.name) == "input$wanted" }
            ?: device.commands.firstOrNull { RemoteLayout.commandKey(it.name) == wanted }
    }
}
