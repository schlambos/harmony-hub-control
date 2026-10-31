package app.melodious.protocol.graph

import app.melodious.protocol.model.ActivityWizardDraft
import app.melodious.protocol.model.ButtonMappingSource
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.HubActivity
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.HubRole
import app.melodious.protocol.model.HubConfigSnapshot
import app.melodious.protocol.model.RemoteLayout
import app.melodious.protocol.model.ResolvedButtonAction
import app.melodious.protocol.model.SoftButton
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pure Kotlin port of `wizard-model.js` and `activity_graph_repair.mjs`.
 *
 * Enforces all physical universal-remote invariants locally on Android:
 * 1. Disjoint offline ID allocation (`MAP_ID_FLOOR = 52_944_089`, `BUTTON_ID_FLOOR = 1_878_029_713`).
 * 2. Preservation of non-wizard-owned maps (`16420Activity<ID>` Bluetooth HID maps, second surfaces,
 *    RootButtonMap, DeviceButtonMap).
 * 3. Automatic creation/pruning of `16420Activity<ID>` when `KeyboardTextEntryActivityRole` is present.
 * 4. Zero action-less buttons inside any `ActivityButtonMap` (prevents physical remote freeze).
 * 5. Role-based default button derivation (`VolumeActivityRole` -> `ChannelChangingActivityRole` -> Player chain).
 */
object ActivityGraphBuilder {
    const val MAP_ID_FLOOR = 52_944_089
    const val BUTTON_ID_FLOOR = 1_878_029_713
    const val ID_CEILING = 2_147_483_000

    private val IDENTITY_KEYS = setOf("Id", "Id-", "ButtonId", "ButtonMapId", "ButtonMapId-")

    private val HID_DIRECT_COMMANDS = setOf(
        "Back", "DirectionDown", "DirectionLeft", "DirectionRight", "DirectionUp",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "FastForward", "Info", "Menu", "Pause", "Play", "Rewind", "Stop",
        "VolumeDown", "VolumeUp",
    )

    data class RoleTypeSpec(val type: String, val label: String, val hint: String)

    val ROLE_TYPES: List<RoleTypeSpec> = listOf(
        RoleTypeSpec("DisplayActivityRole", "Shows the picture", "TV or projector — usually switches to an HDMI input"),
        RoleTypeSpec("VolumeActivityRole", "Controls the volume", "Receiver, soundbar, or TV speakers"),
        RoleTypeSpec("PlayMovieActivityRole", "Plays movies & shows", "Streamer, Blu-ray player, or media box"),
        RoleTypeSpec("PlayGameActivityRole", "Plays games", "Console or gaming PC"),
        RoleTypeSpec("PlayMediaActivityRole", "Plays music & media", "Music streamer or media player"),
        RoleTypeSpec("ChannelChangingActivityRole", "Changes channels", "Cable box, tuner, or set-top box"),
        RoleTypeSpec("KeyboardTextEntryActivityRole", "Keyboard / typing", "Device you type searches and logins into"),
    )

    class IdAllocator(roots: List<JsonElement>) {
        private var nextMapId = MAP_ID_FLOOR + 1
        private var nextEntityId = BUTTON_ID_FLOOR + 1
        private val seen = HashSet<Int>()

        init {
            roots.forEach(::walk)
        }

        private fun walk(element: JsonElement?) {
            when (element) {
                is JsonArray -> element.forEach(::walk)
                is JsonObject -> {
                    for ((key, child) in element) {
                        if (key in IDENTITY_KEYS) {
                            val n = (child as? JsonPrimitive)?.intOrNull ?: child.toString().trim('"').toIntOrNull()
                            if (n != null && n > 0) {
                                seen.add(n)
                                if (key.startsWith("ButtonMapId")) {
                                    if (n + 1 > nextMapId) nextMapId = n + 1
                                } else {
                                    if (n + 1 > nextEntityId) nextEntityId = n + 1
                                }
                            }
                        } else {
                            walk(child)
                        }
                    }
                }
                else -> Unit
            }
        }

        fun allocateMapId(): Int = take(isMap = true)
        fun allocateId(): Int = take(isMap = false)

        private fun take(isMap: Boolean): Int {
            var cursor = if (isMap) nextMapId else nextEntityId
            while (cursor in seen || cursor >= ID_CEILING) {
                cursor += 1
            }
            seen.add(cursor)
            if (isMap) nextMapId = cursor + 1 else nextEntityId = cursor + 1
            return cursor
        }
    }

    /**
     * Parse raw `/api/activity-config` JSON into a rich `HubConfigSnapshot` while retaining
     * the underlying `JsonObject` trees for lossless round-trip saves.
     */
    fun parseConfigSnapshot(root: JsonObject): HubConfigSnapshot {
        val revision = root["revision"]?.jsonPrimitive?.content.orEmpty()
        val activityList = root["activityList"]?.jsonObject ?: JsonObject(emptyMap())
        val mapList = root["mapList"]?.jsonObject ?: JsonObject(emptyMap())
        val functionList = root["functionList"]?.jsonObject ?: JsonObject(emptyMap())
        val deviceList = root["deviceList"]?.jsonObject ?: JsonObject(emptyMap())

        val activities = parseActivities(activityList)
        val devices = parseDevices(deviceList)

        return HubConfigSnapshot(
            revision = revision,
            rawRoot = root,
            activityList = activityList,
            mapList = mapList,
            functionList = functionList,
            deviceList = deviceList,
            activities = activities,
            devices = devices,
        )
    }

    fun parseActivities(activityList: JsonObject): List<HubActivity> {
        val rawActivities = (activityList["Activities"] as? JsonArray) ?: return emptyList()
        return rawActivities.mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            val id = obj["Id-"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val name = obj["Name"]?.jsonPrimitive?.content
                ?: obj["ActivityDisplayName"]?.jsonPrimitive?.content
                ?: "Activity $id"
            val displayName = obj["ActivityDisplayName"]?.jsonPrimitive?.content ?: name
            val type = obj["Type"]?.jsonPrimitive?.intOrNull ?: 1
            val order = obj["ActivityOrder"]?.jsonPrimitive?.intOrNull ?: 0
            val roles = ((obj["Roles"] as? JsonArray) ?: emptyList()).mapNotNull { roleEl ->
                val rObj = roleEl as? JsonObject ?: return@mapNotNull null
                val devId = rObj["DeviceId-"]?.jsonPrimitive?.content ?: return@mapNotNull null
                val roleType = rObj["__type"]?.jsonPrimitive?.content ?: "DisplayActivityRole"
                val selInputObj = rObj["SelectedInput"] as? JsonObject
                val selectedInput = selInputObj?.get("Name")?.jsonPrimitive?.content
                HubRole(
                    id = rObj["Id-"]?.jsonPrimitive?.intOrNull ?: 0,
                    deviceId = devId,
                    roleType = roleType,
                    selectedInput = selectedInput,
                    powerOnOrder = rObj["PowerOnOrder"]?.jsonPrimitive?.intOrNull ?: 1,
                    powerOffOrder = rObj["PowerOffOrder"]?.jsonPrimitive?.intOrNull ?: 1,
                    nextDevicePowerOnDelay = rObj["NextDevicePowerOnDelay"]?.jsonPrimitive?.intOrNull,
                )
            }
            HubActivity(
                id = id,
                name = name,
                displayName = displayName,
                type = type,
                activityOrder = order,
                roles = roles,
            )
        }.sortedBy { it.activityOrder }
    }

    fun parseDevices(deviceList: JsonObject): List<HubDevice> {
        val rawList = (deviceList["DevicesWithFeatures"] as? JsonArray) ?: return emptyList()
        return rawList.mapNotNull { el ->
            val entry = el as? JsonObject ?: return@mapNotNull null
            val dev = (entry["Device"] as? JsonObject) ?: entry
            val id = dev["Id-"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val name = dev["Name"]?.jsonPrimitive?.content
                ?: dev["FriendlyName"]?.jsonPrimitive?.content
                ?: "Device $id"
            val commands = ((entry["Commands"] as? JsonArray) ?: emptyList()).mapNotNull { cmdEl ->
                val cObj = cmdEl as? JsonObject ?: return@mapNotNull null
                val cName = cObj["Name"]?.jsonPrimitive?.content ?: return@mapNotNull null
                DeviceCommand(
                    name = cName,
                    functionId = cObj["FunctionId-"]?.jsonPrimitive?.intOrNull ?: 0,
                    keyCode = cObj["KeyCode"]?.jsonPrimitive?.content.orEmpty(),
                )
            }
            // Real input names ("HDMI 2") and the command that selects each live in DeviceFeatures.
            // Activities store those names in SelectedInput, so the editor and Fix it must use them too.
            val featureInputs = parseFeatureInputs(entry)
            val inputCommands = featureInputs.associate { it.first to it.second }
            val inputs = featureInputs.map { it.first }.ifEmpty {
                commands
                    .map { it.name }
                    .filter { it.startsWith("Input", ignoreCase = true) }
                    .map { it.removePrefix("Input").removePrefix("input").ifBlank { it } }
                    .distinct()
            }
            HubDevice(
                id = id,
                name = name,
                manufacturer = dev["Manufacturer"]?.jsonPrimitive?.content.orEmpty(),
                model = dev["Model"]?.jsonPrimitive?.content.orEmpty(),
                type = (dev["DeviceTypeDisplayName"] ?: dev["DeviceType"])?.jsonPrimitive?.content.orEmpty(),
                transport = dev["Transport"]?.jsonPrimitive?.intOrNull ?: 1,
                btAddress = dev["BTAddress"]?.jsonPrimitive?.content.orEmpty(),
                isKeyboardAssociated = dev["IsKeyboardAssociated"]?.jsonPrimitive?.booleanOrNull ?: false,
                commands = commands,
                inputs = inputs,
                inputCommands = inputCommands,
            )
        }
    }

    /** `(InputName, IRCommandName)` pairs from `DeviceFeatures[].Inputs[]`, in `InputOrder`. */
    private fun parseFeatureInputs(entry: JsonObject): List<Pair<String, String>> {
        val features = (entry["DeviceFeatures"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        return features.flatMap { feature ->
            (feature["Inputs"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        }.sortedBy { it["InputOrder"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE }
            .mapNotNull { input ->
                val name = input["InputName"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val command = (input["Actions"] as? JsonArray).orEmpty()
                    .mapNotNull { (it as? JsonObject)?.get("IRCommandName")?.jsonPrimitive?.contentOrNull }
                    .firstOrNull().orEmpty()
                name to command
            }
            .distinctBy { it.first }
    }

    /**
     * Resolve all mapped remote buttons for a given Activity from `MapList.json`.
     * P06 #4: draft only from the 16414 map, falling back to 16417 hard keys
     * (mapped DVR→Dvr) only when 16414 is missing. Touch-only and keyboard
     * keys never leak into 16414. Double-press is carried through (P06 #3).
     */
    fun resolveActivityButtons(
        snapshot: HubConfigSnapshot,
        activityId: String,
    ): Map<String, ResolvedButtonAction> {
        val devicesById = snapshot.devices.associateBy { it.id }
        val buttonMaps = (snapshot.mapList["ButtonMaps"] as? JsonArray) ?: return emptyMap()
        val activityMaps = buttonMaps.mapNotNull { it as? JsonObject }.filter {
            it["ActivityId-"]?.jsonPrimitive?.content == activityId &&
                it["__type"]?.jsonPrimitive?.content == "ActivityButtonMap"
        }
        val wizardMap = activityMaps.firstOrNull { isWizardOwnedActivityMap(it, activityId) }
        // Draft source: 16414 when present, else 16417 hard keys mapped back.
        val sourceMaps: List<JsonObject> = if (wizardMap != null) {
            listOf(wizardMap)
        } else {
            activityMaps.filter {
                it["ButtonMapIdentifier"]?.jsonPrimitive?.content == TouchScreenGraph.identifier(activityId)
            }
        }
        fun canonicalKeyFor(map: JsonObject, rawKey: String): String {
            val id = map["ButtonMapIdentifier"]?.jsonPrimitive?.content.orEmpty()
            // Touch spells Dvr as DVR; file under the wizard's Dvr name.
            if (id.startsWith("16417Activity") && rawKey == "DVR") return "Dvr"
            return rawKey
        }
        val out = LinkedHashMap<String, ResolvedButtonAction>()
        for (map in sourceMaps) {
            val buttons = (map["Buttons"] as? JsonArray) ?: continue
            for (btnEl in buttons) {
                val btn = btnEl as? JsonObject ?: continue
                if (btn["__type"]?.jsonPrimitive?.content != "HardRemoteButton") continue
                val rawKey = btn["ButtonKey"]?.jsonPrimitive?.content ?: continue
                // Touch has no number keys; never draft them into 16414.
                if (map !== wizardMap && rawKey !in TOUCH_HARD_KEYS) continue
                val key = canonicalKeyFor(map, rawKey)
                if (key in out) continue
                val pressAction = btn["ButtonAction"] as? JsonObject ?: continue
                val pressDevId = pressAction["DeviceId-"]?.jsonPrimitive?.content ?: continue
                val pressCmd = pressAction["CommandName"]?.jsonPrimitive?.content ?: continue
                val pressFnId = pressAction["FunctionId-"]?.jsonPrimitive?.intOrNull ?: 0

                val holdAction = btn["ButtonLongPressAction"] as? JsonObject
                val holdDevId = holdAction?.get("DeviceId-")?.jsonPrimitive?.content
                val holdCmd = holdAction?.get("CommandName")?.jsonPrimitive?.content
                val holdFnId = holdAction?.get("FunctionId-")?.jsonPrimitive?.intOrNull ?: 0

                val doubleAction = btn["ButtonDoublePressAction"] as? JsonObject
                val doubleDevId = doubleAction?.get("DeviceId-")?.jsonPrimitive?.content
                val doubleCmd = doubleAction?.get("CommandName")?.jsonPrimitive?.content
                val doubleFnId = doubleAction?.get("FunctionId-")?.jsonPrimitive?.intOrNull ?: 0

                out[key] = ResolvedButtonAction(
                    buttonKey = key,
                    buttonLabel = RemoteLayout.LABEL_BY_BUTTON_KEY[key] ?: key,
                    pressDeviceId = pressDevId,
                    pressDeviceName = devicesById[pressDevId]?.name ?: "Device $pressDevId",
                    pressCommand = pressCmd,
                    pressFunctionId = pressFnId,
                    holdDeviceId = holdDevId,
                    holdDeviceName = holdDevId?.let { devicesById[it]?.name ?: "Device $it" },
                    holdCommand = holdCmd,
                    holdFunctionId = holdFnId,
                    doublePressDeviceId = doubleDevId,
                    doublePressDeviceName = doubleDevId?.let { devicesById[it]?.name ?: "Device $it" },
                    doublePressCommand = doubleCmd,
                    doublePressFunctionId = doubleFnId,
                )
            }
        }
        return out
    }

    /**
     * On-screen buttons for an activity, in menu order. Only command buttons are returned; client
     * actions (the screen's own "123" numpad toggle) have no meaning outside a Harmony touch screen.
     */
    fun resolveActivitySoftButtons(snapshot: HubConfigSnapshot, activityId: String): List<SoftButton> {
        val devicesById = snapshot.devices.associateBy { it.id }
        val buttonMaps = (snapshot.mapList["ButtonMaps"] as? JsonArray) ?: return emptyList()
        val touchMaps = buttonMaps.mapNotNull { it as? JsonObject }
            .filter {
                it["ActivityId-"]?.jsonPrimitive?.content == activityId &&
                    it["ButtonMapIdentifier"]?.jsonPrimitive?.contentOrNull?.startsWith("16417") == true
            }
        val sequences = touchMaps.flatMap { (it["Sequences"] as? JsonArray).orEmpty() }
            .mapNotNull { it as? JsonObject }
            .associate { (it["SequenceId"]?.jsonPrimitive?.contentOrNull ?: "") to it }
        return touchMaps
            .flatMap { (it["Buttons"] as? JsonArray).orEmpty() }
            .mapNotNull { el ->
                val btn = el as? JsonObject ?: return@mapNotNull null
                if (btn["__type"]?.jsonPrimitive?.contentOrNull != "SoftRemoteButton") return@mapNotNull null
                val action = btn["ButtonAction"] as? JsonObject ?: return@mapNotNull null
                val order = (btn["MenuItem"] as? JsonObject)?.get("IndexInMenu")?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE
                if (action["__type"]?.jsonPrimitive?.contentOrNull == "ButtonSequenceAction") {
                    val seq = sequences[action["SequenceId"]?.jsonPrimitive?.contentOrNull] ?: return@mapNotNull null
                    val steps = TouchScreenGraph.parseSteps(seq["Actions"]).takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    return@mapNotNull SoftButton(
                        label = btn["TextOnRemote"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                            ?: seq["Name"]?.jsonPrimitive?.contentOrNull ?: "Sequence",
                        deviceId = "", deviceName = "", command = "",
                        order = order,
                        steps = steps,
                    )
                }
                if (action["__type"]?.jsonPrimitive?.contentOrNull != "ButtonCommandAction") return@mapNotNull null
                val deviceId = action["DeviceId-"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val command = action["CommandName"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val label = btn["TextOnRemote"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: command
                SoftButton(
                    label = humanizeLabel(label),
                    deviceId = deviceId,
                    deviceName = devicesById[deviceId]?.name ?: "Device $deviceId",
                    command = command,
                    functionId = action["FunctionId-"]?.jsonPrimitive?.intOrNull ?: 0,
                    order = (btn["MenuItem"] as? JsonObject)?.get("IndexInMenu")?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE,
                )
            }
            .distinctBy { if (it.steps.isEmpty()) it.deviceId to it.command else it.label to it.order.toString() }
            .sortedBy { it.order }
    }

    /** "PreviousTrack" -> "Previous Track"; labels people typed themselves are left alone. */
    fun humanizeLabel(raw: String): String =
        if (raw.contains(' ')) raw else raw.replace(Regex("(?<=[a-z])(?=[A-Z])"), " ")

    /**
     * Same priority chain as `wizard-model.js` `preferredDeviceForButtonKey`.
     */
    fun preferredDeviceForButtonKey(buttonKey: String, roles: List<WizardRoleDraft>): String {
        val identity = buttonKey.lowercase()
        if (identity.isEmpty()) return ""
        fun roleDeviceId(roleTypeSubstring: String): String =
            roles.firstOrNull { it.deviceId.isNotBlank() && it.roleType.contains(roleTypeSubstring) }?.deviceId.orEmpty()

        if (identity in setOf("volumeup", "volumedown", "volumemute", "mute")) {
            return roleDeviceId("VolumeActivityRole")
        }
        if (identity == "channelup" || identity == "channeldown" || identity.matches(Regex("^(number[0-9]|[0-9])$"))) {
            val ch = roleDeviceId("ChannelChangingActivityRole")
            if (ch.isNotEmpty()) return ch
        }
        return sequenceOf(
            "PlayGameActivityRole",
            "PlayMovieActivityRole",
            "PlayMediaActivityRole",
            "ChannelChangingActivityRole",
            "KeyboardTextEntryActivityRole",
            "DisplayActivityRole",
        ).map(::roleDeviceId).firstOrNull { it.isNotEmpty() }.orEmpty()
    }

    /**
     * Pure derivation: every assignable wizard key -> mapping when the preferred
     * role device actually has a matching command.
     */
    fun deriveDefaultButtons(
        roles: List<WizardRoleDraft>,
        devices: List<HubDevice>,
    ): Map<String, WizardButtonMapping> {
        val byId = devices.associateBy { it.id }
        val out = LinkedHashMap<String, WizardButtonMapping>()
        for (button in RemoteLayout.REMOTE_BUTTONS) {
            val buttonKey = button.canonicalButtonKey ?: continue
            val deviceId = preferredDeviceForButtonKey(buttonKey, roles)
            if (deviceId.isEmpty()) continue
            val device = byId[deviceId] ?: continue
            val command = RemoteLayout.matchCommand(device.commands, button.aliases) ?: continue
            if (command.name.isBlank()) continue
            out[buttonKey] = WizardButtonMapping(
                deviceId = deviceId,
                commandName = command.name,
                functionId = command.functionId,
                source = ButtonMappingSource.DEFAULT,
            )
        }
        return out
    }

    /**
     * Hardware-proven one-shot commands (P11): toggles double-fire when held
     * >=300ms, so they need self-long (long == short, EventType 2).
     */
    private val ONE_SHOT_COMMANDS = setOf(
        "powertoggle", "playpause", "mute", "skipforward", "skipback", "run", "activate", "press",
    )

    fun isOneShotCommand(commandName: String?): Boolean {
        if (commandName.isNullOrBlank()) return false
        val key = commandName.lowercase().replace(Regex("[^a-z0-9]"), "")
        return key in ONE_SHOT_COMMANDS
    }

    fun recommendedPressMode(commandName: String?): String =
        if (isOneShotCommand(commandName)) "oneShot" else "standard"

    /**
     * Reconcile `draft.buttons` after role/device changes (P06 #7 / P13):
     * - Keeps non-member "Extra controls" (any device in DeviceList works on
     *   hard keys), flagged `extra=true` for the UI badge.
     * - Drops only mappings whose device vanished from the hub.
     * - Never overwrites `USER` or `EXISTING` mappings.
     * - Fills empty keys from `deriveDefaultButtons` only when `fillDefaults`
     *   is true. The wizard passes false when opening an existing activity,
     *   so unmapped keys stay unmapped until Reset.
     */
    fun reconcileWizardButtons(
        buttons: Map<String, WizardButtonMapping>,
        roles: List<WizardRoleDraft>,
        devices: List<HubDevice>,
        fillDefaults: Boolean = true,
    ): Map<String, WizardButtonMapping> {
        val roleDeviceIds = roles.map { it.deviceId }.filter { it.isNotBlank() }.toSet()
        val deviceIds = devices.map { it.id }.filter { it.isNotBlank() }.toSet()
        val defaults = if (fillDefaults) deriveDefaultButtons(roles, devices) else emptyMap()
        val next = LinkedHashMap<String, WizardButtonMapping>()

        for ((key, mapping) in buttons) {
            if (mapping.commandName.isBlank()) continue
            if (deviceIds.isNotEmpty() && mapping.deviceId !in deviceIds) continue
            if (mapping.source == ButtonMappingSource.USER || mapping.source == ButtonMappingSource.EXISTING) {
                val extra = mapping.deviceId !in roleDeviceIds
                next[key] = mapping.copy(extra = extra)
            }
        }
        for ((key, def) in defaults) {
            if (key !in next) {
                next[key] = def
            }
        }
        return next
    }

    fun wizardMapIdentifier(activityId: String): String = "16414Activity$activityId"
    fun hidMapIdentifier(activityId: String): String = "16420Activity$activityId"

    fun isWizardOwnedActivityMap(map: JsonObject, activityId: String): Boolean =
        map["ButtonMapIdentifier"]?.jsonPrimitive?.content == wizardMapIdentifier(activityId)

    fun isKeyboardHidActivityMap(map: JsonObject): Boolean =
        map["ButtonMapIdentifier"]?.jsonPrimitive?.content?.matches(Regex("^16420Activity-?\\d+$")) == true

    /**
     * The Harmony Touch's hard keys, as Logitech's own 16417Activity maps name them. The Touch has
     * no hard number keys (its number pad is on screen) and spells the 16414 surface's "Dvr" as "DVR".
     */
    private val TOUCH_HARD_KEYS = setOf(
        "Blue", "ChannelDown", "ChannelUp", "DVR", "DirectionDown", "DirectionLeft",
        "DirectionRight", "DirectionUp", "Exit", "FastForward", "Green", "Guide",
        "Info", "Menu", "Pause", "Play", "PrevChannel", "Record", "Red", "Rewind",
        "Select", "Stop", "VolumeDown", "VolumeMute", "VolumeUp", "Yellow",
    )

    /** The Touch's name for a wizard key, or "" when the Touch has no such key. */
    fun touchHardKey(buttonKey: String): String {
        val key = if (buttonKey == "Dvr") "DVR" else buttonKey
        return if (key in TOUCH_HARD_KEYS) key else ""
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun actionShape(action: JsonElement?): List<String?>? =
        (action as? JsonObject)?.let { obj -> listOf("__type", "DeviceId-", "CommandName", "ActivityId-").map { obj.text(it) } }

    private fun sameButton(left: JsonObject?, right: JsonObject?): Boolean {
        if (left == null || right == null) return left == null && right == null
        return listOf("ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction")
            .all { actionShape(left[it]) == actionShape(right[it]) }
    }

    private fun hardButtonsByTouchKey(map: JsonObject?): Map<String, JsonObject> {
        val out = LinkedHashMap<String, JsonObject>()
        for (button in (map?.get("Buttons") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }) {
            if (button.text("__type") != "HardRemoteButton") continue
            val key = touchHardKey(button.text("ButtonKey").orEmpty())
            if (key.isNotEmpty() && key !in out) out[key] = button
        }
        return out
    }

    /**
     * The Touch answers its hard buttons from its own 16417Activity map, never the 16414 one;
     * Logitech's maps carry the same hard buttons on both. Mirrors wizard-model.js
     * mirrorTouchHardButtons: a Touch map with no hard buttons gets every one the wizard map has;
     * one that already has some keeps them and takes only the keys this edit changed, so a
     * Touch-only mapping set up in MyHarmony survives. Buttons that aren't hard buttons are
     * untouched. A hub with a Touch surface but no map for this activity gets one.
     */
    fun mirrorTouchHardButtons(
        maps: List<JsonObject>,
        activityId: Int,
        wizardMap: JsonObject,
        previousWizardMap: JsonObject?,
        alloc: IdAllocator,
        now: String,
    ): List<JsonObject> {
        val identifier = TouchScreenGraph.identifier(activityId.toString())
        val result = maps.toMutableList()
        var index = result.indexOfFirst { it.text("ButtonMapIdentifier") == identifier }
        if (index < 0) {
            val sibling = maps.firstOrNull { it.text("ButtonMapIdentifier")?.startsWith("16417Activity") == true }
                ?: maps.firstOrNull { it.text("ButtonMapIdentifier")?.startsWith("16417") == true }
                ?: return maps
            result.add(
                JsonObject(
                    mapOf(
                        "ButtonMapId-" to JsonPrimitive(alloc.allocateMapId()),
                        "ActivityId-" to JsonPrimitive(activityId),
                        "Buttons" to JsonArray(emptyList()),
                        "ButtonMapSurfaceId-" to (sibling["ButtonMapSurfaceId-"] ?: JsonNull),
                        "__type" to JsonPrimitive("ActivityButtonMap"),
                        "RemoteId-" to (sibling["RemoteId-"] ?: JsonNull),
                        "ButtonMapIdentifier" to JsonPrimitive(identifier),
                        "DateModified" to JsonPrimitive(now),
                        "Sequences" to JsonArray(emptyList()),
                        "SurfaceId-" to (sibling["SurfaceId-"] ?: JsonNull),
                    )
                )
            )
            index = result.size - 1
        }
        val touch = result[index]
        val next = hardButtonsByTouchKey(wizardMap)
        val before = hardButtonsByTouchKey(previousWizardMap)
        val current = hardButtonsByTouchKey(touch)
        val mirrorAll = current.isEmpty()
        val changes = LinkedHashMap<String, JsonObject?>() // null drops the key
        for (key in next.keys + current.keys) {
            val wanted = next[key]
            if (!mirrorAll && sameButton(wanted, before[key])) continue
            if (wanted == null) {
                changes[key] = null
                continue
            }
            if (current[key] != null && sameButton(wanted, current[key])) continue
            changes[key] = JsonObject(
                wanted.toMutableMap().apply {
                    put("ButtonId", current[key]?.get("ButtonId") ?: JsonPrimitive(alloc.allocateId()))
                    put("FunctionGroupType", JsonPrimitive(0))
                    put("ButtonKey", JsonPrimitive(key))
                }
            )
        }
        if (changes.isEmpty()) return result
        // Changed buttons keep their place; new ones go after the rest.
        val buttons = mutableListOf<JsonElement>()
        for (element in (touch["Buttons"] as? JsonArray).orEmpty()) {
            val button = element as? JsonObject
            val key = if (button?.text("__type") == "HardRemoteButton") touchHardKey(button.text("ButtonKey").orEmpty()) else ""
            if (key.isEmpty() || key !in changes) {
                buttons.add(element)
                continue
            }
            changes.remove(key)?.let { buttons.add(it) }
        }
        changes.values.filterNotNull().forEach { buttons.add(it) }
        result[index] = JsonObject(
            touch.toMutableMap().apply {
                put("Buttons", JsonArray(buttons))
                put("DateModified", JsonPrimitive(now))
            }
        )
        return result
    }

    data class BuiltActivityGraph(
        val activityId: String,
        val name: String,
        val activityList: JsonObject,
        val mapList: JsonObject,
        val functionList: JsonObject,
    )

    /**
     * Build the three replacement resources (`activityList`, `mapList`, `functionList`)
     * for a wizard draft, preserving non-wizard-owned maps (`16420Activity<ID>`, second surfaces)
     * and pruning any action-less buttons.
     */
    fun buildActivityGraph(
        snapshot: HubConfigSnapshot,
        draft: ActivityWizardDraft,
    ): BuiltActivityGraph {
        val alloc = IdAllocator(
            listOf(snapshot.activityList, snapshot.mapList, snapshot.functionList, snapshot.deviceList)
        )
        val now = "/Date(${System.currentTimeMillis()}+0000)/"
        val currentActivities = ((snapshot.activityList["Activities"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
            .toMutableList()

        val editId = draft.editActivityId
        val targetActivityId: Int
        val baseActivityObj: JsonObject

        if (!editId.isNullOrBlank()) {
            val idx = currentActivities.indexOfFirst { it["Id-"]?.jsonPrimitive?.content == editId }
            require(idx >= 0) { "The activity being edited ($editId) no longer exists in this config." }
            baseActivityObj = currentActivities[idx]
            targetActivityId = baseActivityObj["Id-"]?.jsonPrimitive?.intOrNull ?: editId.toInt()
        } else {
            targetActivityId = alloc.allocateId()
            baseActivityObj = createBlankActivityJson(targetActivityId, currentActivities.size, now)
            currentActivities.add(baseActivityObj)
        }

        val cleanName = draft.name.trim().ifEmpty { "New Activity" }
        val existingRolesForReuse = (baseActivityObj["Roles"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val rolesJson = composeRolesJson(draft.roles, alloc, draft.powerOnOrder, draft.powerOffOrder, existingRolesForReuse)
        val updatedActivity = JsonObject(
            baseActivityObj.toMutableMap().apply {
                put("Name", JsonPrimitive(cleanName))
                put("ActivityDisplayName", JsonPrimitive(cleanName))
                put("Type", JsonPrimitive(draft.type))
                put("DateModified", JsonPrimitive(now))
                put("Roles", rolesJson)
                draft.enterSteps?.let { put("EnterActions", activityActionsJson(it)) }
                draft.leaveSteps?.let { put("LeaveActions", activityActionsJson(it)) }
            }
        )

        val replaceIdx = currentActivities.indexOfFirst {
            it["Id-"]?.jsonPrimitive?.content == targetActivityId.toString()
        }
        currentActivities[replaceIdx] = updatedActivity

        val existingMaps = ((snapshot.mapList["ButtonMaps"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
        val existingWizardMap = existingMaps.firstOrNull {
            isWizardOwnedActivityMap(it, targetActivityId.toString())
        }
        val wizardMap = composeWizardButtonMap(
            draft = draft,
            activityId = targetActivityId,
            existingMaps = existingMaps,
            alloc = alloc,
            existingWizardMap = existingWizardMap,
            now = now,
        )

        val keyboardDeviceIds = draft.roles
            .filter { it.roleType.contains("KeyboardTextEntryActivityRole") && it.deviceId.isNotBlank() }
            .map { it.deviceId }

        val mergedMaps = mirrorTouchHardButtons(
            maps = mergeActivityButtonMaps(
                buttonMaps = existingMaps,
                activityId = targetActivityId,
                wizardMap = wizardMap,
                keyboardDeviceIds = keyboardDeviceIds,
                snapshot = snapshot,
                alloc = alloc,
                now = now,
            ),
            activityId = targetActivityId,
            wizardMap = wizardMap,
            previousWizardMap = existingWizardMap,
            alloc = alloc,
            now = now,
        )

        val existingFunctions = ((snapshot.functionList["FunctionMaps"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
            .toMutableList()
        val hasFunctionMap = existingFunctions.any {
            it["__type"]?.jsonPrimitive?.content?.contains("ActivityFunctionMap") == true &&
                it["ActivityId-"]?.jsonPrimitive?.content == targetActivityId.toString()
        }
        if (!hasFunctionMap) {
            existingFunctions.add(
                JsonObject(
                    mapOf(
                        "UIModeName" to JsonPrimitive("Functions.UserConfigurator.$targetActivityId"),
                        "__type" to JsonPrimitive("ActivityFunctionMap"),
                        "ActivityId-" to JsonPrimitive(targetActivityId),
                        "FunctionGroups" to JsonArray(emptyList()),
                    )
                )
            )
        }

        return BuiltActivityGraph(
            activityId = targetActivityId.toString(),
            name = cleanName,
            activityList = JsonObject(
                snapshot.activityList.toMutableMap().apply {
                    put("Activities", JsonArray(currentActivities))
                }
            ),
            mapList = JsonObject(
                snapshot.mapList.toMutableMap().apply {
                    put("ButtonMaps", JsonArray(mergedMaps))
                }
            ),
            functionList = JsonObject(
                snapshot.functionList.toMutableMap().apply {
                    put("FunctionMaps", JsonArray(existingFunctions))
                }
            ),
        )
    }

    /**
     * Delete an activity and all of its associated ButtonMaps and ActivityFunctionMaps.
     */
    fun buildDeleteActivityGraph(snapshot: HubConfigSnapshot, activityId: String): BuiltActivityGraph {
        val remainingActivities = ((snapshot.activityList["Activities"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
            .filterNot { it["Id-"]?.jsonPrimitive?.content == activityId }

        val now = "/Date(${System.currentTimeMillis()}+0000)/"
        val remainingMaps = ((snapshot.mapList["ButtonMaps"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
            .filterNot { it["ActivityId-"]?.jsonPrimitive?.content == activityId }
            .map { clearActivityActions(it, activityId, now) }

        val remainingFunctions = ((snapshot.functionList["FunctionMaps"] as? JsonArray) ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
            .filterNot {
                it["__type"]?.jsonPrimitive?.content?.contains("ActivityFunctionMap") == true &&
                    it["ActivityId-"]?.jsonPrimitive?.content == activityId
            }

        return BuiltActivityGraph(
            activityId = activityId,
            name = "",
            activityList = JsonObject(
                snapshot.activityList.toMutableMap().apply {
                    put("Activities", JsonArray(remainingActivities))
                }
            ),
            mapList = JsonObject(
                snapshot.mapList.toMutableMap().apply {
                    put("ButtonMaps", JsonArray(remainingMaps))
                }
            ),
            functionList = JsonObject(
                snapshot.functionList.toMutableMap().apply {
                    put("FunctionMaps", JsonArray(remainingFunctions))
                }
            ),
        )
    }

    private val ACTION_FIELDS = listOf("ButtonAction", "ButtonLongPressAction", "ButtonDoublePressAction")

    /**
     * The hub refuses a MapList that still starts a deleted activity anywhere (a Smart Control
     * activity button, say), so those actions become null. A button left with no action goes,
     * except in a root map: an action-less button in an activity map stops the paired remote,
     * while Logitech's root maps keep empty ones. Same rule as `deleteActivityResources` in
     * `wizard-model.js`.
     */
    private fun clearActivityActions(map: JsonObject, activityId: String, now: String): JsonObject {
        val buttons = map["Buttons"] as? JsonArray ?: return map
        val isRoot = map["__type"]?.jsonPrimitive?.contentOrNull?.contains("RootButtonMap") == true
        var changed = false
        val kept = buttons.mapNotNull { element ->
            val button = element as? JsonObject ?: return@mapNotNull element
            val cleared = ACTION_FIELDS.filter { field ->
                (button[field] as? JsonObject)?.get("ActivityId-")?.jsonPrimitive?.contentOrNull == activityId
            }
            if (cleared.isEmpty()) return@mapNotNull element
            changed = true
            val updated = JsonObject(button.toMutableMap().apply { cleared.forEach { put(it, JsonNull) } })
            if (isRoot || ACTION_FIELDS.any { updated[it] is JsonObject }) updated else null
        }
        if (!changed) return map
        return JsonObject(
            map.toMutableMap().apply {
                put("Buttons", JsonArray(kept))
                if (containsKey("DateModified")) put("DateModified", JsonPrimitive(now))
            }
        )
    }

    /**
     * Power-on/off order per device. Orders are table indexes in the stock loader
     * (`userconfigreader.lua:216,270`), so every device gets a distinct value or actions vanish.
     */
    fun devicePowerOrders(roles: List<WizardRoleDraft>, preferred: List<String>): Map<String, Int> {
        val roleDevices = roles.map { it.deviceId }.filter { it.isNotBlank() }.distinct()
        val ordered = preferred.filter { it in roleDevices } + roleDevices.filterNot { it in preferred }
        return ordered.withIndex().associate { (i, id) -> id to i + 1 }
    }

    /** Start/end steps in hub form: `ActionOrder` must be unique, so it is the list position. */
    fun activityActionsJson(steps: List<SequenceStep>): JsonArray = JsonArray(steps.mapIndexed { i, step ->
        when (step) {
            is SequenceStep.Command -> JsonObject(
                mapOf(
                    "__type" to JsonPrimitive("CommandActivityAction"),
                    "ActionOrder" to JsonPrimitive(i),
                    "DeviceId-" to JsonPrimitive(step.deviceId.toLongOrNull() ?: 0),
                    "CommandName" to JsonPrimitive(step.command),
                )
            )
            is SequenceStep.Delay -> JsonObject(
                mapOf(
                    "__type" to JsonPrimitive("DelayActivityAction"),
                    "ActionOrder" to JsonPrimitive(i),
                    "Duration" to JsonPrimitive(step.seconds),
                )
            )
        }
    })

    /**
     * Reads EnterActions/LeaveActions back. Returns null when the list holds anything the editor
     * can't represent (channel or home-control actions), so the caller keeps it untouched.
     */
    fun parseActivityActions(actions: JsonElement?): List<SequenceStep>? {
        val items = (actions as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .sortedBy { it["ActionOrder"]?.jsonPrimitive?.intOrNull ?: 0 }
        val steps = items.map { action ->
            val type = action["__type"]?.jsonPrimitive?.contentOrNull.orEmpty()
            when {
                type.contains("CommandActivityAction") -> {
                    val deviceId = action["DeviceId-"]?.jsonPrimitive?.contentOrNull ?: return null
                    val command = action["CommandName"]?.jsonPrimitive?.contentOrNull ?: return null
                    SequenceStep.Command(deviceId, command)
                }
                type.contains("DelayActivityAction") ->
                    SequenceStep.Delay(action["Duration"]?.jsonPrimitive?.doubleOrNull ?: return null)
                else -> return null
            }
        }
        return steps
    }

    private fun composeRolesJson(
        roles: List<WizardRoleDraft>,
        alloc: IdAllocator,
        powerOnOrder: List<String> = emptyList(),
        powerOffOrder: List<String> = emptyList(),
        existingRoles: List<JsonObject> = emptyList(),
    ): JsonArray {
        val onOrders = devicePowerOrders(roles, powerOnOrder)
        val offOrders = devicePowerOrders(roles, powerOffOrder.ifEmpty { powerOnOrder })
        // P06 #8: reuse role and SelectedInput IDs by (device, type, input).
        val byKey = existingRoles.groupBy {
            "${it["DeviceId-"]?.jsonPrimitive?.content}|${it["__type"]?.jsonPrimitive?.content}"
        }
        val used = mutableSetOf<JsonObject>()
        val items = roles.map { role ->
            val order = onOrders[role.deviceId] ?: 1
            val key = "${role.deviceId}|${role.roleType}"
            val candidates = (byKey[key] ?: emptyList()).filter { it !in used }
            val reuse = candidates.firstOrNull {
                (it["SelectedInput"] as? JsonObject)?.get("Name")?.jsonPrimitive?.contentOrNull == role.input
            } ?: candidates.firstOrNull()
            if (reuse != null) used.add(reuse)
            val inputId = if (!role.input.isNullOrBlank()) {
                val reusedInputId = (reuse?.get("SelectedInput") as? JsonObject)?.get("Id-")?.jsonPrimitive?.intOrNull
                val reusedName = (reuse?.get("SelectedInput") as? JsonObject)?.get("Name")?.jsonPrimitive?.contentOrNull
                if (reusedInputId != null && reusedName == role.input) reusedInputId else alloc.allocateId()
            } else null
            val selectedInput = if (!role.input.isNullOrBlank()) {
                JsonObject(
                    mapOf(
                        "ChannelNumber" to JsonNull,
                        "Id-" to JsonPrimitive(inputId ?: alloc.allocateId()),
                        "Name" to JsonPrimitive(role.input),
                    )
                )
            } else {
                JsonNull
            }
            JsonObject(
                mapOf(
                    "DeviceId-" to JsonPrimitive(role.deviceId.toInt()),
                    "SelectedInput" to selectedInput,
                    "PowerOffOrder" to JsonPrimitive(offOrders[role.deviceId] ?: order),
                    "__type" to JsonPrimitive(role.roleType),
                    "PowerOnOrder" to JsonPrimitive(order),
                    "NextDevicePowerOnDelay" to (role.powerDelay?.let { JsonPrimitive(it) } ?: JsonNull),
                    "Id-" to JsonPrimitive(reuse?.get("Id-")?.jsonPrimitive?.intOrNull ?: alloc.allocateId()),
                )
            )
        }
        return JsonArray(items)
    }

    private fun commandActionJson(
        deviceId: Int,
        commandName: String,
        functionId: Int,
        eventType: Int,
    ): JsonObject = JsonObject(
        mapOf(
            "DeviceId-" to JsonPrimitive(deviceId),
            "__type" to JsonPrimitive("ButtonCommandAction"),
            "FunctionId-" to JsonPrimitive(functionId),
            "Order" to JsonPrimitive(0),
            "CommandName" to JsonPrimitive(commandName),
            "EventType" to JsonPrimitive(eventType),
            "Id" to JsonPrimitive(0),
        )
    )

    private fun composeWizardButtonMap(
        draft: ActivityWizardDraft,
        activityId: Int,
        existingMaps: List<JsonObject>,
        alloc: IdAllocator,
        existingWizardMap: JsonObject?,
        now: String,
    ): JsonObject {
        // P06 #8: reuse ButtonIds by ButtonKey so an unchanged save keeps identities.
        val existingByKey = (existingWizardMap?.get("Buttons") as? JsonArray).orEmpty()
            .mapNotNull { it as? JsonObject }
            .associateBy { it["ButtonKey"]?.jsonPrimitive?.content.orEmpty() }
        // Strict rule: never emit action-less buttons into an ActivityButtonMap!
        val buttons = draft.buttons.entries.mapNotNull { (buttonKey, mapping) ->
            if (mapping.commandName.isBlank() || mapping.deviceId.isBlank()) return@mapNotNull null
            val pressAction = commandActionJson(
                deviceId = mapping.deviceId.toInt(),
                commandName = mapping.commandName,
                functionId = mapping.functionId,
                eventType = 1,
            )
            val holdAction = if (!mapping.holdCommandName.isNullOrBlank() && !mapping.holdDeviceId.isNullOrBlank()) {
                commandActionJson(
                    deviceId = mapping.holdDeviceId.toInt(),
                    commandName = mapping.holdCommandName,
                    functionId = mapping.holdFunctionId,
                    eventType = 2,
                )
            } else {
                JsonNull
            }
            // P06 #3: preserve double-press (Touch and hub both honor it).
            val doubleAction = if (!mapping.doublePressCommandName.isNullOrBlank() && !mapping.doublePressDeviceId.isNullOrBlank()) {
                commandActionJson(
                    deviceId = mapping.doublePressDeviceId.toInt(),
                    commandName = mapping.doublePressCommandName,
                    functionId = mapping.doublePressFunctionId,
                    eventType = 3,
                )
            } else {
                (existingByKey[buttonKey]?.get("ButtonDoublePressAction") as? JsonObject)?.let { it } ?: JsonNull
            }
            JsonObject(
                mapOf(
                    "ButtonId" to JsonPrimitive(existingByKey[buttonKey]?.get("ButtonId")?.jsonPrimitive?.intOrNull ?: alloc.allocateId()),
                    "__type" to JsonPrimitive("HardRemoteButton"),
                    "ButtonAction" to pressAction,
                    "ButtonDoublePressAction" to doubleAction,
                    "FunctionGroupType" to JsonPrimitive(if (buttonKey.matches(Regex("^Number\\d$"))) 2 else 0),
                    "ButtonState" to JsonPrimitive(1),
                    "ButtonKey" to JsonPrimitive(buttonKey),
                    "ButtonLongPressAction" to holdAction,
                )
            )
        }

        val surfaceSource = existingMaps.firstOrNull {
            it["__type"]?.jsonPrimitive?.content == "ActivityButtonMap" &&
                it["ButtonMapIdentifier"]?.jsonPrimitive?.content?.startsWith("16414Activity") == true
        } ?: existingMaps.firstOrNull {
            it["__type"]?.jsonPrimitive?.content == "ActivityButtonMap"
        }

        val baseMap = existingWizardMap?.toMutableMap() ?: mutableMapOf()
        val existingMapId = baseMap["ButtonMapId-"]?.jsonPrimitive?.intOrNull ?: 0
        if (existingMapId <= 0) {
            baseMap["ButtonMapId-"] = JsonPrimitive(alloc.allocateMapId())
        }
        for (surfKey in listOf("ButtonMapSurfaceId-", "RemoteId-", "SurfaceId-")) {
            if (baseMap[surfKey] == null || baseMap[surfKey] is JsonNull) {
                baseMap[surfKey] = surfaceSource?.get(surfKey) ?: JsonNull
            }
        }
        baseMap["ActivityId-"] = JsonPrimitive(activityId)
        baseMap["Buttons"] = JsonArray(buttons)
        baseMap["__type"] = JsonPrimitive("ActivityButtonMap")
        baseMap["ButtonMapIdentifier"] = JsonPrimitive(wizardMapIdentifier(activityId.toString()))
        baseMap["DateModified"] = JsonPrimitive(now)
        if (baseMap["Sequences"] !is JsonArray) {
            baseMap["Sequences"] = JsonArray(emptyList())
        }
        return JsonObject(baseMap)
    }

    private fun composeKeyboardHidMap(
        activityId: Int,
        deviceId: String,
        snapshot: HubConfigSnapshot,
        sourceMap: JsonObject,
        alloc: IdAllocator,
        now: String,
    ): JsonObject? {
        val device = snapshot.devices.firstOrNull { it.id == deviceId } ?: return null
        val deviceIdInt = device.id.toIntOrNull() ?: return null
        val seen = HashSet<String>()
        val buttons = mutableListOf<JsonObject>()

        for (cmd in device.commands) {
            val key = when {
                cmd.name.matches(Regex("^[0-9]$")) -> "Number${cmd.name}"
                cmd.name == "Mute" -> "VolumeMute"
                cmd.name == "Select" -> "Enter"
                cmd.name in HID_DIRECT_COMMANDS -> cmd.name
                else -> ""
            }
            if (key.isEmpty() || !seen.add(key.lowercase())) continue
            buttons.add(
                JsonObject(
                    mapOf(
                        "ButtonId" to JsonPrimitive(alloc.allocateId()),
                        "__type" to JsonPrimitive("HardRemoteButton"),
                        "ButtonAction" to commandActionJson(deviceIdInt, cmd.name, cmd.functionId, 1),
                        "ButtonDoublePressAction" to JsonNull,
                        "FunctionGroupType" to JsonPrimitive(if (key.matches(Regex("^Number[0-9]$"))) 2 else 0),
                        "ButtonState" to JsonPrimitive(1),
                        "ButtonKey" to JsonPrimitive(key),
                        "ButtonLongPressAction" to JsonNull,
                    )
                )
            )
        }

        return JsonObject(
            mapOf(
                "ButtonMapId-" to JsonPrimitive(alloc.allocateMapId()),
                "ActivityId-" to JsonPrimitive(activityId),
                "Buttons" to JsonArray(buttons),
                "ButtonMapSurfaceId-" to (sourceMap["ButtonMapSurfaceId-"] ?: JsonNull),
                "RemoteId-" to (sourceMap["RemoteId-"] ?: JsonNull),
                "__type" to JsonPrimitive("ActivityButtonMap"),
                "ButtonMapIdentifier" to JsonPrimitive(hidMapIdentifier(activityId.toString())),
                "DateModified" to JsonPrimitive(now),
                "Sequences" to JsonArray(emptyList()),
                "SurfaceId-" to (sourceMap["SurfaceId-"] ?: JsonNull),
            )
        )
    }

    private fun mergeActivityButtonMaps(
        buttonMaps: List<JsonObject>,
        activityId: Int,
        wizardMap: JsonObject,
        keyboardDeviceIds: List<String>,
        snapshot: HubConfigSnapshot,
        alloc: IdAllocator,
        now: String,
    ): List<JsonObject> {
        val actIdStr = activityId.toString()
        val needsHid = keyboardDeviceIds.isNotEmpty()
        var wizardPlaced = false
        var hidPlaced = false
        val result = mutableListOf<JsonObject>()

        for (map in buttonMaps) {
            if (map["ActivityId-"]?.jsonPrimitive?.content != actIdStr) {
                result.add(map)
                continue
            }
            if (isWizardOwnedActivityMap(map, actIdStr)) {
                if (!wizardPlaced) {
                    result.add(wizardMap)
                    wizardPlaced = true
                }
                continue
            }
            if (isKeyboardHidActivityMap(map)) {
                if (needsHid && !hidPlaced) {
                    result.add(map)
                    hidPlaced = true
                }
                continue
            }
            // Preserve second-surface / non-wizard activity maps byte-for-byte
            result.add(map)
        }

        if (!wizardPlaced) {
            result.add(wizardMap)
        }

        if (needsHid && !hidPlaced) {
            val createdHid = composeKeyboardHidMap(
                activityId = activityId,
                deviceId = keyboardDeviceIds.first(),
                snapshot = snapshot,
                sourceMap = wizardMap,
                alloc = alloc,
                now = now,
            )
            if (createdHid != null) {
                result.add(createdHid)
            }
        }

        return result
    }

    private fun createBlankActivityJson(id: Int, order: Int, now: String): JsonObject = JsonObject(
        mapOf(
            "AccountId-" to JsonPrimitive(0),
            "Alternatives" to JsonArray(emptyList()),
            "BaseImageUri" to JsonNull,
            "DefaultChannel" to JsonNull,
            "DefaultStation" to JsonNull,
            "DefaultStationName" to JsonNull,
            "EnterActions" to JsonArray(emptyList()),
            "Icon" to JsonNull,
            "ImageKey" to JsonNull,
            "IsDefault" to JsonPrimitive(false),
            "IsMultiZone" to JsonPrimitive(false),
            "IsTuningDefault" to JsonPrimitive(false),
            "LeaveActions" to JsonArray(emptyList()),
            "StartScreen" to JsonNull,
            "State" to JsonPrimitive(0),
            "SuggestedDisplay" to JsonNull,
            "Zones" to JsonArray(emptyList()),
            "Id-" to JsonPrimitive(id),
            "Name" to JsonPrimitive("New Activity"),
            "ActivityDisplayName" to JsonPrimitive("New Activity"),
            "ActivityOrder" to JsonPrimitive(order),
            "ActivityGroup" to JsonPrimitive(1),
            "Type" to JsonPrimitive(1),
            "DateCreated" to JsonPrimitive(now),
            "DateModified" to JsonPrimitive(now),
            "Roles" to JsonArray(emptyList()),
        )
    )
}
