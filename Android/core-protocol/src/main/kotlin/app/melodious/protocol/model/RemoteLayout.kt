package app.melodious.protocol.model

/**
 * Virtual remote geometry + alias matching, ported directly from `codex_webui.c`
 * and `tools/webui-sim/public/js/remote-layout.js`.
 *
 * Positions are percentages of the remote body (aspect-ratio 591 / 1280):
 * `{ x, y, w, h }` map to left/top/width/height on the remote image canvas.
 * Order matches the C array so overlapping D-pad keys stack identically
 * (`OK` is drawn last and wins the center).
 */
data class RemoteHotspot(
    val label: String,
    val aliases: String,
    val xPercent: Float,
    val yPercent: Float,
    val widthPercent: Float,
    val heightPercent: Float,
    val canonicalButtonKey: String? = RemoteLayout.BUTTON_KEY_BY_LABEL[label],
) {
    val isPowerKey: Boolean get() = label == "Power off"
    val colorTint: RemoteKeyTint? get() = RemoteLayout.KEY_TINTS[label]
}

enum class RemoteKeyTint {
    RED, GREEN, YELLOW, BLUE
}

sealed interface SkinPowerAction {
    data object ActivityPowerOff : SkinPowerAction
    data class DevicePower(
        val deviceId: String,
        val command: String,
        val functionId: Int,
    ) : SkinPowerAction
    data class Inert(val reason: InertReason) : SkinPowerAction

    enum class InertReason {
        NOTHING_RUNNING,
        NO_POWER_COMMAND,
        NO_DEVICE,
    }
}

object RemoteLayout {
    const val SKIN_ASPECT_WIDTH = 591f
    const val SKIN_ASPECT_HEIGHT = 1280f
    const val SKIN_ASPECT_RATIO = SKIN_ASPECT_WIDTH / SKIN_ASPECT_HEIGHT

    const val POWER_ALIASES =
        "poweroff|power off|standby|shutdown|off|powertoggle|power toggle|power"

    val KEY_TINTS: Map<String, RemoteKeyTint> = mapOf(
        "Red" to RemoteKeyTint.RED,
        "Green" to RemoteKeyTint.GREEN,
        "Yellow" to RemoteKeyTint.YELLOW,
        "Blue" to RemoteKeyTint.BLUE,
    )

    /**
     * Canonical firmware `ButtonKey` names (as they appear in genuine `MapList.json`
     * entries) for every hard key the setup wizard lets users map.
     */
    val BUTTON_KEY_BY_LABEL: Map<String, String> = linkedMapOf(
        "Rewind" to "Rewind",
        "Play" to "Play",
        "Forward" to "FastForward",
        "Record" to "Record",
        "Pause" to "Pause",
        "Stop" to "Stop",
        "Red" to "Red",
        "Green" to "Green",
        "Yellow" to "Yellow",
        "Blue" to "Blue",
        "DVR" to "Dvr",
        "Guide" to "Guide",
        "Info" to "Info",
        "Exit" to "Exit",
        "Menu" to "Menu",
        "Up" to "DirectionUp",
        "Left" to "DirectionLeft",
        "Right" to "DirectionRight",
        "Down" to "DirectionDown",
        "OK" to "Select",
        "Volume up" to "VolumeUp",
        "Volume down" to "VolumeDown",
        "Mute" to "VolumeMute",
        // The physical remote's Back/Return key is stored as PrevChannel in real MapList.json files.
        "Back" to "PrevChannel",
        "Channel up" to "ChannelUp",
        "Channel down" to "ChannelDown",
        "1" to "Number1",
        "2" to "Number2",
        "3" to "Number3",
        "4" to "Number4",
        "5" to "Number5",
        "6" to "Number6",
        "7" to "Number7",
        "8" to "Number8",
        "9" to "Number9",
        "0" to "Number0",
    )

    val LABEL_BY_BUTTON_KEY: Map<String, String> =
        BUTTON_KEY_BY_LABEL.entries.associate { (k, v) -> v to k }

    val REMOTE_BUTTONS: List<RemoteHotspot> = listOf(
        RemoteHotspot("Power off", POWER_ALIASES, 13.55f, 0.45f, 18.60f, 3.35f),
        RemoteHotspot("Music", "music|audio", 8.80f, 6.85f, 26.75f, 5.10f),
        RemoteHotspot("TV", "tv|television|watchtv|display", 35.50f, 6.85f, 27.10f, 5.10f),
        RemoteHotspot("Movie", "movie|video|media", 62.60f, 6.85f, 27.10f, 5.10f),
        RemoteHotspot("Rewind", "rewind|rev|skipback|previous track", 8.80f, 14.90f, 27.95f, 5.25f),
        RemoteHotspot("Play", "play", 41.45f, 15.00f, 16.25f, 5.40f),
        RemoteHotspot("Forward", "fastforward|forward|ffwd|next track|skipforward", 62.45f, 14.85f, 27.95f, 5.30f),
        RemoteHotspot("Record", "record|rec", 8.95f, 21.80f, 27.90f, 5.35f),
        RemoteHotspot("Pause", "pause", 41.45f, 21.80f, 16.25f, 5.35f),
        RemoteHotspot("Stop", "stop", 62.45f, 21.80f, 27.95f, 5.35f),
        RemoteHotspot("Red", "red", 9.30f, 30.00f, 18.60f, 3.75f),
        RemoteHotspot("Green", "green", 30.10f, 30.00f, 18.95f, 3.75f),
        RemoteHotspot("Yellow", "yellow", 51.80f, 30.00f, 18.15f, 3.75f),
        RemoteHotspot("Blue", "blue", 73.25f, 30.00f, 17.45f, 3.75f),
        RemoteHotspot("DVR", "dvr|recordings", 9.00f, 36.95f, 27.40f, 5.05f),
        RemoteHotspot("Guide", "guide|epg", 36.40f, 36.95f, 26.40f, 5.05f),
        RemoteHotspot("Info", "info|information|displayinfo|settings|setting|setup|option|options", 62.80f, 36.95f, 26.75f, 5.05f),
        RemoteHotspot("Exit", "exit|clear|cancel", 9.10f, 45.45f, 36.05f, 4.95f),
        RemoteHotspot("Menu", "menu", 53.95f, 45.45f, 35.70f, 4.95f),
        RemoteHotspot("Up", "up|directionup|arrowup|cursorup", 36.40f, 49.85f, 27.60f, 6.30f),
        RemoteHotspot("Left", "left|directionleft|arrowleft|cursorleft", 28.80f, 54.70f, 14.90f, 12.10f),
        RemoteHotspot("Right", "right|directionright|arrowright|cursorright", 56.30f, 54.70f, 14.90f, 12.10f),
        RemoteHotspot("Down", "down|directiondown|arrowdown|cursordown", 36.40f, 64.55f, 27.60f, 6.20f),
        RemoteHotspot("OK", "ok|select|enter", 40.10f, 56.10f, 19.80f, 9.10f),
        RemoteHotspot("Volume up", "volumeup|volup|vol up|vol_up|volume up", 9.30f, 52.20f, 19.30f, 8.85f),
        RemoteHotspot("Volume down", "volumedown|voldown|voldn|vol down|vol_down|vol_dn|volume down", 9.30f, 61.05f, 19.30f, 9.05f),
        RemoteHotspot("Channel up", "channelup|chup|chnext|ch_next|ch up|channel next|channelnext|pageup|pgup", 70.20f, 52.20f, 19.15f, 8.85f),
        RemoteHotspot("Channel down", "channeldown|chdown|chdn|chprev|ch_prev|ch down|ch_dn|channel prev|channel previous|channel down|channelprev|channeldn|pagedown|pgdown", 70.20f, 61.05f, 19.15f, 9.05f),
        RemoteHotspot("Mute", "mute", 9.30f, 71.70f, 36.20f, 5.30f),
        RemoteHotspot("Back", "back|return|previous", 54.15f, 71.70f, 35.55f, 5.30f),
        RemoteHotspot("1", "1|digit1|number1|num1", 9.30f, 80.45f, 27.10f, 3.45f),
        RemoteHotspot("2", "2|digit2|number2|num2", 36.40f, 80.45f, 26.25f, 3.45f),
        RemoteHotspot("3", "3|digit3|number3|num3", 62.60f, 80.45f, 27.05f, 3.45f),
        RemoteHotspot("4", "4|digit4|number4|num4", 9.30f, 85.55f, 27.10f, 3.40f),
        RemoteHotspot("5", "5|digit5|number5|num5", 36.40f, 85.55f, 26.25f, 3.40f),
        RemoteHotspot("6", "6|digit6|number6|num6", 62.60f, 85.55f, 27.05f, 3.40f),
        RemoteHotspot("7", "7|digit7|number7|num7", 9.30f, 90.60f, 27.10f, 3.35f),
        RemoteHotspot("8", "8|digit8|number8|num8", 36.40f, 90.60f, 26.25f, 3.35f),
        RemoteHotspot("9", "9|digit9|number9|num9", 62.60f, 90.60f, 27.05f, 3.35f),
        RemoteHotspot("Dash", "dash|hyphen|separator|dot|period|minus", 9.30f, 95.70f, 27.10f, 3.35f),
        RemoteHotspot("0", "0|digit0|number0|num0", 36.40f, 95.70f, 26.25f, 3.35f),
        RemoteHotspot("Enter", "enter|e", 62.60f, 95.70f, 27.05f, 3.35f),
    )

    private val NON_ALPHANUMERIC = Regex("[^a-z0-9]")

    /** `ir_command_key`: lowercase, keep alphanumerics only. */
    fun commandKey(name: String?): String =
        (name ?: "").lowercase().replace(NON_ALPHANUMERIC, "")

    /**
     * `ir_alias_match`: exact key match, or the alias (when longer than 4 chars)
     * appears as a substring of the command key — same as the C `strstr` check.
     */
    fun aliasMatch(cmdKey: String, aliases: String): Boolean {
        if (cmdKey.isEmpty()) return false
        for (raw in aliases.split("|")) {
            val key = commandKey(raw)
            if (key.isEmpty()) continue
            if (key == cmdKey) return true
            if (key.length > 4 && cmdKey.contains(key)) return true
        }
        return false
    }

    /** `ir_find_remote_command`: first device command whose name matches any alias. */
    fun matchCommand(commands: List<DeviceCommand>, aliases: String): DeviceCommand? =
        commands.firstOrNull { aliasMatch(commandKey(it.name), aliases) }

    /**
     * Resolve what the skin Power key should do (`control-power.js`).
     */
    fun resolveSkinPowerAction(
        isActivitiesMode: Boolean,
        currentActivityId: String,
        selectedDeviceId: String?,
        deviceCommands: List<DeviceCommand>,
    ): SkinPowerAction {
        if (isActivitiesMode) {
            val id = currentActivityId.trim()
            return if (id.isNotEmpty() && id != "-1") {
                SkinPowerAction.ActivityPowerOff
            } else {
                SkinPowerAction.Inert(SkinPowerAction.InertReason.NOTHING_RUNNING)
            }
        }
        val devId = selectedDeviceId?.trim().orEmpty()
        if (devId.isEmpty()) {
            return SkinPowerAction.Inert(SkinPowerAction.InertReason.NO_DEVICE)
        }
        val cmd = matchCommand(deviceCommands, POWER_ALIASES)
            ?: return SkinPowerAction.Inert(SkinPowerAction.InertReason.NO_POWER_COMMAND)
        return SkinPowerAction.DevicePower(
            deviceId = devId,
            command = cmd.name,
            functionId = cmd.functionId,
        )
    }

    fun isEverythingOff(currentActivityId: String?): Boolean {
        val id = currentActivityId?.trim().orEmpty()
        return id.isEmpty() || id == "-1"
    }

    fun offStateSendNote(
        baseNote: String = "sent",
        currentActivityId: String?,
        selectedActivityName: String?,
    ): String {
        if (!isEverythingOff(currentActivityId)) return baseNote
        val name = selectedActivityName?.trim().orEmpty()
        return if (name.isNotEmpty()) {
            "$baseNote · nothing is running — start $name?"
        } else {
            "$baseNote · nothing is running — start an activity first"
        }
    }

    fun skinPowerLabel(action: SkinPowerAction): String = when (action) {
        is SkinPowerAction.ActivityPowerOff -> "Power off — end the running activity"
        is SkinPowerAction.DevicePower -> "Power — ${action.command}"
        is SkinPowerAction.Inert -> when (action.reason) {
            SkinPowerAction.InertReason.NOTHING_RUNNING -> "Power off — nothing is running"
            SkinPowerAction.InertReason.NO_POWER_COMMAND -> "Power — no power command on this device"
            SkinPowerAction.InertReason.NO_DEVICE -> "Power — not available"
        }
    }
}
