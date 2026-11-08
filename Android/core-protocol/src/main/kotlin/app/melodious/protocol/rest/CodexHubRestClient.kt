package app.melodious.protocol.rest

import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.ir.IrProtocolTools
import app.melodious.protocol.model.BtAdapterStatus
import app.melodious.protocol.model.BtTextHelperStatus
import app.melodious.protocol.model.HaState
import app.melodious.protocol.model.HaStateEnvelope
import app.melodious.protocol.model.HubConfigSnapshot
import app.melodious.protocol.model.HubEndpoint
import app.melodious.protocol.model.IrCaptureAnalysis
import app.melodious.protocol.model.SavedBtDevice
import app.melodious.protocol.model.SavedBtScript
import app.melodious.protocol.catalog.CatalogCommandRow
import app.melodious.protocol.catalog.hubProtocolNames
import app.melodious.protocol.model.SystemStatusSnapshot
import app.melodious.protocol.update.HubSoftware
import app.melodious.protocol.update.ReleaseVersion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit

/** `GET /api/ha-state`: [changed] is false when nothing moved since the version asked about. */
data class HaStatePoll(
    val changed: Boolean,
    val envelope: HaStateEnvelope,
)

/** One `/api/state` poll; activity fields are only filled when the digest changed. */
data class HubStatePoll(
    val changed: Boolean,
    val version: String?,
    val activityId: String?,
    val activityStatus: Int?,
    val sleepTimer: app.melodious.protocol.hbus.SleepTimerState? = null,
)

class HubApiException(message: String, val statusCode: Int = 0) : IOException(message)

/**
 * Full Kotlin REST client for `codex_webui` (`http://<hub-ip>:8080`) and `tools/webui-sim` (`:8787`).
 * Mirrors every endpoint in `docs/API.md` and `tools/webui-sim/public/js/api.js`.
 */
class CodexHubRestClient(
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
) {
    private val jsonParser = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /* Writes go through the hub's offline writer, which says nothing until it
       has saved, reloaded the engine and published. That takes 25-50 s with an
       activity running, and codex_webui waits up to 120 s, so allow longer. */
    private val writerClient: OkHttpClient = httpClient.newBuilder()
        .readTimeout(150, TimeUnit.SECONDS)
        .build()

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val ACTIVITY_ID_REGEX = Regex(""""(?:current)?activityId"\s*:\s*"?(-?\d+)"?""", RegexOption.IGNORE_CASE)
        private val RESULT_ID_REGEX = Regex(""""result"\s*:\s*"?(-?\d+)"?""", RegexOption.IGNORE_CASE)
        private val ACTIVITY_STATUS_REGEX = Regex(""""activityStatus"\s*:\s*"?(\d+)""", RegexOption.IGNORE_CASE)
        private val STATE_VERSION_REGEX = Regex(""""stateVersion"\s*:\s*"?(\d+)""", RegexOption.IGNORE_CASE)

        fun buildBasicAuthHeader(username: String, password: String): String {
            val raw = "$username:$password"
            val encoded = Base64.getEncoder().encodeToString(raw.toByteArray(Charsets.ISO_8859_1))
            return "Basic $encoded"
        }

        /**
         * Robust current-activity extractor ported from `tools/webui-sim/public/js/state.js`.
         */
        fun extractCurrentActivityId(payloadText: String): String {
            // codex_webui wraps the HBus reply as an escaped JSON string ("reply":"{\"data\":{\"result\":...}}"),
            // so match against the unescaped text or the quoted keys never line up.
            val text = payloadText.replace("\\", "")
            val match = ACTIVITY_ID_REGEX.find(text) ?: RESULT_ID_REGEX.find(text)
            if (match != null) return match.groupValues[1]
            val trimmed = payloadText.trim().trim('"')
            if (trimmed.matches(Regex("^-?\\d+$"))) return trimmed
            return ""
        }

        fun extractSleepTimer(payloadText: String): app.melodious.protocol.hbus.SleepTimerState? {
            val text = payloadText.replace("\\", "")
            fun num(key: String) = Regex(""""$key"\s*:\s*"?(-?[\d.]+)""").find(text)?.groupValues?.get(1)
            return app.melodious.protocol.hbus.SleepTimerState.fromDigest(
                timerId = num("sleepTimerId")?.toDoubleOrNull()?.toInt(),
                endEpochSeconds = num("sleepTimerValue")?.toDoubleOrNull()?.toLong(),
                hubEpochSeconds = num("time")?.toDoubleOrNull()?.toLong(),
            )
        }

        /** statedigest `activityStatus`: 0 off, 1 starting, 2 running, 3 turning off. */
        fun extractActivityStatus(payloadText: String): Int? =
            ACTIVITY_STATUS_REGEX.find(payloadText.replace("\\", ""))?.groupValues?.get(1)?.toIntOrNull()

        fun extractStateVersion(payloadText: String): String? {
            val unescaped = payloadText.replace("\\", "")
            return STATE_VERSION_REGEX.find(unescaped)?.groupValues?.get(1)
        }
    }

    /**
     * `GET /api/activity-config`: Loads native ActivityList, MapList, FunctionList, DeviceList, and revision.
     */
    suspend fun getActivityConfig(endpoint: HubEndpoint): HubConfigSnapshot = withContext(Dispatchers.IO) {
        val root = getJson(endpoint, "/api/activity-config")
        ActivityGraphBuilder.parseConfigSnapshot(root)
    }

    /**
     * `GET /api/activity-state`: Returns the currently running activity ID (`"-1"` when everything is off).
     */
    suspend fun getActivityState(endpoint: HubEndpoint): String = withContext(Dispatchers.IO) {
        val raw = getRawText(endpoint, "/api/activity-state")
        // An unreadable reply must not be reported as "everything off".
        extractCurrentActivityId(raw).ifEmpty { throw HubApiException("Couldn't read the current activity") }
    }

    /**
     * `GET /api/state?version=<lastVersion>`: Cheap liveness check (`304` with `changed: false` when unchanged).
     */
    suspend fun pollStateDigest(endpoint: HubEndpoint, lastVersion: String?): HubStatePoll =
        withContext(Dispatchers.IO) {
            val query = if (lastVersion.isNullOrBlank()) "" else "?version=$lastVersion"
            val obj = getJson(endpoint, "/api/state$query")
            val changed = obj["changed"]?.jsonPrimitive?.booleanOrNull ?: false
            val reply = obj["reply"]?.toString().orEmpty()
            HubStatePoll(
                changed = changed,
                version = extractStateVersion(reply) ?: lastVersion,
                activityId = if (changed) extractCurrentActivityId(reply).ifEmpty { null } else null,
                activityStatus = if (changed) extractActivityStatus(reply) else null,
                sleepTimer = if (changed) extractSleepTimer(reply) else null,
            )
        }

    /**
     * `GET /api/ha-state?since=<version>`: live Home Assistant device state. The hub always sends the
     * states; `changed` is false when [since] is current and the state isn't stale.
     */
    suspend fun getHaState(endpoint: HubEndpoint, since: Long?): HaStatePoll = withContext(Dispatchers.IO) {
        val query = if (since != null && since > 0) "?since=$since" else ""
        val obj = getJson(endpoint, "/api/ha-state$query")
        HaStatePoll(
            changed = obj["changed"]?.jsonPrimitive?.booleanOrNull ?: true,
            envelope = HaState.parseEnvelope(obj) ?: HaStateEnvelope(0, true, emptyList()),
        )
    }

    /**
     * `POST /api/activity-run`: Starts an activity, or powers off when `activityId == "-1"`.
     */
    suspend fun runActivity(endpoint: HubEndpoint, activityId: String): JsonObject =
        withContext(Dispatchers.IO) {
            postFormJson(
                endpoint = endpoint,
                path = "/api/activity-run",
                fields = mapOf("activityId" to activityId),
            )
        }

    suspend fun powerOff(endpoint: HubEndpoint): JsonObject = runActivity(endpoint, "-1")

    /**
     * `POST /api/activity-save`: Compensated, Hub-local transaction for `ActivityList.json`,
     * `MapList.json`, and `FunctionList.json` with optimistic concurrency (`baseRevision`).
     */
    suspend fun saveActivityGraph(
        endpoint: HubEndpoint,
        baseRevision: String,
        builtGraph: ActivityGraphBuilder.BuiltActivityGraph,
        syncRemote: Boolean = true,
    ): JsonObject = withContext(Dispatchers.IO) {
        val bodyObj = JsonObject(
            mapOf(
                "baseRevision" to JsonPrimitive(baseRevision),
                "syncRemote" to JsonPrimitive(syncRemote),
                "activityList" to builtGraph.activityList,
                "mapList" to builtGraph.mapList,
                "functionList" to builtGraph.functionList,
            )
        )
        postJson(endpoint, "/api/activity-save", bodyObj, writerClient)
    }

    /**
     * `POST /api/device-settings`: power and timing for one device. The hub validates against the
     * device's own commands, saves DeviceList and reloads the engine, restoring the old file on failure.
     */
    suspend fun saveDeviceSettings(endpoint: HubEndpoint, deviceId: String, settings: app.melodious.protocol.model.DeviceSettings): JsonObject =
        withContext(Dispatchers.IO) {
            postJson(endpoint, "/api/device-settings", app.melodious.protocol.model.DeviceSettingsModel.requestBody(deviceId, settings), writerClient)
        }

    /**
     * `POST /api/device-screen`: makes, rebuilds or removes one device's Harmony Touch screen. The
     * hub builds it from the device's commands, saves MapList and publishes, so the Touch pulls it.
     */
    suspend fun saveDeviceScreen(endpoint: HubEndpoint, deviceId: String, remove: Boolean): JsonObject =
        withContext(Dispatchers.IO) {
            postJson(endpoint, "/api/device-screen", app.melodious.protocol.model.DeviceTouchScreens.requestBody(deviceId, remove), writerClient)
        }

    /**
     * `POST /api/ir-send`: Dispatches a single IR or Bluetooth HID command through the hub.
     */
    suspend fun irSend(
        endpoint: HubEndpoint,
        deviceId: String,
        command: String,
        functionId: Int? = null,
        activityId: String? = null,
    ): JsonObject = withContext(Dispatchers.IO) {
        val fields = linkedMapOf(
            "deviceId" to deviceId,
            "command" to command,
        )
        if (functionId != null && functionId > 0) fields["functionId"] = functionId.toString()
        if (!activityId.isNullOrBlank()) fields["activityId"] = activityId
        postFormJson(endpoint, "/api/ir-send", fields)
    }

    /**
     * `POST /api/ir-batch-send`: Fires a cancellable batch of commands for hardware discovery.
     */
    suspend fun irBatchSend(
        endpoint: HubEndpoint,
        deviceId: String,
        commands: List<String>,
        delayMs: Int = 120,
        dryRun: Boolean = false,
        runId: String = IrProtocolTools.makeRunId(),
    ): JsonObject = withContext(Dispatchers.IO) {
        postFormJson(
            endpoint = endpoint,
            path = "/api/ir-batch-send",
            fields = mapOf(
                "deviceId" to deviceId,
                "commands" to commands.joinToString("\n"),
                "delayMs" to IrProtocolTools.clampDelay(delayMs).toString(),
                "dryRun" to if (dryRun) "1" else "0",
                "runId" to runId,
            )
        )
    }

    suspend fun irCancelBatch(endpoint: HubEndpoint, runId: String): JsonObject =
        withContext(Dispatchers.IO) {
            postFormJson(endpoint, "/api/ir-cancel", mapOf("runId" to runId))
        }

    /**
     * `POST /api/capture`: Captures a raw/NEC/keycode IR signal from an original physical remote.
     */
    suspend fun captureIrSignal(endpoint: HubEndpoint, timeoutSeconds: Int = 8): IrCaptureAnalysis =
        withContext(Dispatchers.IO) {
            val res = postFormJson(
                endpoint = endpoint,
                path = "/api/capture",
                fields = mapOf("timeout" to timeoutSeconds.coerceIn(3, 15).toString()),
            )
            IrProtocolTools.analyzeCaptureJson(res)
        }

    /**
     * `POST /api/ir-test-learned`: Tests a captured or pasted IR signal before saving.
     */
    suspend fun testLearnedIr(
        endpoint: HubEndpoint,
        deviceId: String,
        name: String,
        mode: String,
        raw: String = "",
        keycode: String = "",
        nec: String = "",
        protocol: String = "2",
    ): JsonObject = withContext(Dispatchers.IO) {
        postFormJson(
            endpoint = endpoint,
            path = "/api/ir-test-learned",
            fields = mapOf(
                "deviceId" to deviceId,
                "name" to name,
                "mode" to mode,
                "raw" to raw,
                "keycode" to keycode,
                "nec" to nec,
                "protocol" to protocol,
            )
        )
    }

    /**
     * `POST /ir/command`: Saves a learned or manual IR command onto a device.
     */
    suspend fun saveIrCommand(
        endpoint: HubEndpoint,
        deviceId: String,
        name: String,
        mode: String,
        raw: String = "",
        keycode: String = "",
        nec: String = "",
        protocol: String = "2",
    ) = withContext(Dispatchers.IO) {
        postFormRaw(
            endpoint = endpoint,
            path = "/ir/command",
            fields = mapOf(
                "deviceId" to deviceId,
                "name" to name,
                "mode" to mode,
                "raw" to raw,
                "keycode" to keycode,
                "nec" to nec,
                "protocol" to protocol,
            )
        )
    }

    /**
     * `POST /api/irdb-import`: Bulk-imports IRDB/Pronto/raw command lines onto a device.
     */
    suspend fun importIrdbCommands(
        endpoint: HubEndpoint,
        deviceId: String,
        payloadLines: String,
    ): JsonObject = withContext(Dispatchers.IO) {
        postFormJson(
            endpoint = endpoint,
            path = "/api/irdb-import",
            fields = mapOf(
                "deviceId" to deviceId,
                "payload" to payloadLines,
            )
        )
    }

    /**
     * `POST /api/bt-call`: Invokes Bluetooth adapter, SSP pairing, connect, or HID report actions.
     */
    suspend fun btCall(
        endpoint: HubEndpoint,
        action: String,
        type: String = "btkeyboard",
        address: String = "",
        name: String = "Melodious Keyboard",
        code: String = "",
        gapMs: Int = 35,
    ): BtAdapterStatus = withContext(Dispatchers.IO) {
        val fields = linkedMapOf(
            "action" to action,
            "type" to type,
        )
        if (address.isNotBlank()) fields["address"] = address.trim().uppercase()
        if (name.isNotBlank()) fields["name"] = name.trim()
        if (code.isNotBlank()) fields["code"] = code
        fields["gapMs"] = gapMs.coerceIn(15, 5000).toString()

        val json = postFormJson(endpoint, "/api/bt-call", fields)
        BtAdapterStatus(
            action = json["action"]?.jsonPrimitive?.content.orEmpty(),
            connected = json["connected"]?.jsonPrimitive?.booleanOrNull == true,
            detectedAddress = json["detectedAddress"]?.jsonPrimitive?.content.orEmpty(),
            rawOutput = (json["responseRaw"] ?: json["reply"])?.jsonPrimitive?.content.orEmpty(),
            error = json["error"]?.jsonPrimitive?.content.orEmpty(),
        )
    }

    /**
     * `GET /api/bt-text-status`: Checks the `codex_bthid_keyboard` FIFO daemon status.
     */
    suspend fun getBtTextStatus(endpoint: HubEndpoint): BtTextHelperStatus =
        withContext(Dispatchers.IO) {
            val json = getJson(endpoint, "/api/bt-text-status")
            val runtime = json["runtime"]?.jsonPrimitive?.booleanOrNull == true
            val state = json["state"]?.jsonPrimitive?.content ?: "unknown"
            val live = runtime && state == "listening"
            BtTextHelperStatus(
                runtime = runtime,
                state = state,
                target = json["target"]?.jsonPrimitive?.content.orEmpty(),
                sent = json["sent"]?.jsonPrimitive?.intOrNull ?: 0,
                skipped = json["skipped"]?.jsonPrimitive?.intOrNull ?: 0,
                error = (json["error"] ?: json["detail"])?.jsonPrimitive?.content.orEmpty(),
                live = live,
            )
        }

    /**
     * `POST /api/bt-text`: Streams exact ASCII text from Android's IME / voice dictation to the paired TV/PC.
     */
    suspend fun sendBtText(endpoint: HubEndpoint, text: String): JsonObject =
        withContext(Dispatchers.IO) {
            postFormJson(endpoint, "/api/bt-text", mapOf("text" to text))
        }

    /**
     * `GET /export/bluetooth`: Loads saved Bluetooth inventory & keystroke macro scripts.
     */
    suspend fun getSavedBtDevices(endpoint: HubEndpoint): List<SavedBtDevice> =
        withContext(Dispatchers.IO) {
            val text = runCatching { getRawText(endpoint, "/export/bluetooth") }.getOrDefault("{}")
            val root = runCatching { jsonParser.parseToJsonElement(text).jsonObject }.getOrNull()
                ?: return@withContext emptyList()
            val devices = (root["devices"] as? JsonArray) ?: return@withContext emptyList()
            devices.mapNotNull { el ->
                val d = el as? JsonObject ?: return@mapNotNull null
                val id = d["id"]?.jsonPrimitive?.content.orEmpty()
                val name = d["name"]?.jsonPrimitive?.content.orEmpty()
                if (id.isEmpty() || name.isEmpty()) return@mapNotNull null
                val scripts = ((d["commands"] as? JsonArray) ?: emptyList()).mapNotNull { cEl ->
                    val c = cEl as? JsonObject ?: return@mapNotNull null
                    val cName = c["name"]?.jsonPrimitive?.content.orEmpty()
                    val cScript = c["script"]?.jsonPrimitive?.content.orEmpty()
                    if (cName.isEmpty() || cScript.isEmpty()) return@mapNotNull null
                    SavedBtScript(
                        name = cName,
                        delayMs = (c["delayMs"]?.jsonPrimitive?.intOrNull ?: 35).coerceIn(15, 5000),
                        script = cScript,
                    )
                }
                SavedBtDevice(
                    id = id,
                    name = name,
                    type = d["type"]?.jsonPrimitive?.content ?: "btkeyboard",
                    bdaddr = d["bdaddr"]?.jsonPrimitive?.content.orEmpty(),
                    scripts = scripts,
                )
            }
        }

    /**
     * `GET /api/system-status` + `/export/cloud` + `/export/timezone`: Loads Hub health & security posture.
     */
    suspend fun getSystemStatus(endpoint: HubEndpoint): SystemStatusSnapshot =
        withContext(Dispatchers.IO) {
            val sys = getJson(endpoint, "/api/system-status")
            val cloudText = runCatching { getRawText(endpoint, "/export/cloud").trim() }.getOrDefault("1")
            val tzText = runCatching { getRawText(endpoint, "/export/timezone").trim() }.getOrDefault("UTC")
            val tzZone = tzText.lineSequence().firstOrNull()?.trim().orEmpty().ifEmpty { "UTC" }
            SystemStatusSnapshot(
                ok = sys["ok"]?.jsonPrimitive?.booleanOrNull ?: true,
                firmware = sys["firmware"]?.jsonPrimitive?.content.orEmpty(),
                uptime = sys["uptime"]?.jsonPrimitive?.content.orEmpty(),
                memTotal = sys["memTotal"]?.jsonPrimitive?.content.orEmpty(),
                memory = sys["memory"]?.jsonPrimitive?.content.orEmpty(),
                uname = sys["uname"]?.jsonPrimitive?.content.orEmpty(),
                mounts = sys["mounts"]?.jsonPrimitive?.content.orEmpty(),
                processes = sys["processes"]?.jsonPrimitive?.content.orEmpty(),
                logs = sys["logs"]?.jsonPrimitive?.content.orEmpty(),
                authMode = sys["authMode"]?.jsonPrimitive?.content ?: "open on local network",
                cloudBlocked = cloudText != "0",
                timezone = tzZone,
            )
        }

    /**
     * `GET /api/version`: the Melodious release the hub runs. Hubs before 1.3.0 have no such
     * route and answer 404, reported as [HubSoftware.Legacy]; null when the hub can't be asked.
     */
    suspend fun getHubSoftware(endpoint: HubEndpoint): HubSoftware? =
        withContext(Dispatchers.IO) {
            try {
                getJson(endpoint, "/api/version")["version"]?.jsonPrimitive?.contentOrNull
                    ?.takeIf { ReleaseVersion.parse(it) != null }
                    ?.let { HubSoftware.Known(it) }
            } catch (e: HubApiException) {
                if (e.statusCode == 404) HubSoftware.Legacy else null
            } catch (e: IOException) {
                null
            }
        }

    /**
     * `POST /api/led`: Flashes or changes the hub's physical front status LED.
     */
    suspend fun setHubLed(endpoint: HubEndpoint, action: String = "fire_command"): JsonObject =
        withContext(Dispatchers.IO) {
            postFormJson(endpoint, "/api/led", mapOf("action" to action))
        }

    /**
     * `GET /export/bundle`: Downloads the complete `harmony-owner-bundle-v2` JSON backup.
     */
    suspend fun downloadOwnerBundle(endpoint: HubEndpoint): String =
        withContext(Dispatchers.IO) {
            getRawText(endpoint, "/export/bundle")
        }

    /** `GET /export/protocols` → protocol names the hub has. Throws on an unreadable reply. */
    suspend fun getHubProtocolNames(endpoint: HubEndpoint): List<String> = withContext(Dispatchers.IO) {
        val raw = getRawText(endpoint, "/export/protocols")
        val parsed = runCatching { jsonParser.parseToJsonElement(raw) }
            .getOrElse { throw HubApiException("couldn't be read") }
        hubProtocolNames(parsed)
    }

    /** `POST /api/catalog-import` with hub rows from a catalog package. */
    suspend fun importCatalogCommands(
        endpoint: HubEndpoint,
        deviceId: String,
        rows: List<CatalogCommandRow>,
    ): JsonObject = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("deviceId", deviceId)
            put("commands", buildJsonArray {
                for (row in rows) {
                    add(buildJsonObject {
                        put("name", row.name)
                        put("keycode", row.keycode)
                        put("raw", row.raw)
                        put("protocol", row.protocol)
                    })
                }
            })
        }
        try {
            postJson(endpoint, "/api/catalog-import", body)
        } catch (e: HubApiException) {
            if (e.statusCode == 404) {
                throw HubApiException(
                    "Your hub's Melodious software is older than this app; update the hub",
                    404,
                )
            }
            throw e
        }
    }

    private fun getRawText(endpoint: HubEndpoint, path: String): String {
        val request = Request.Builder()
            .url("${endpoint.baseUrl}$path")
            .header("Cache-Control", "no-store")
            .apply {
                endpoint.basicAuthHeader?.let { header("Authorization", it) }
            }
            .get()
            .build()

        httpClient.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw HubApiException(extractErrorMessage(raw, response.code), response.code)
            }
            return raw
        }
    }

    private fun getJson(endpoint: HubEndpoint, path: String): JsonObject {
        val raw = getRawText(endpoint, path)
        val parsed = runCatching { jsonParser.parseToJsonElement(raw).jsonObject }
            .getOrElse { throw HubApiException("Invalid JSON from $path: ${raw.take(80)}") }
        if (parsed["ok"]?.jsonPrimitive?.booleanOrNull == false) {
            val msg = (parsed["error"] ?: parsed["message"])?.jsonPrimitive?.content ?: "Request failed"
            throw HubApiException(msg, 400)
        }
        return parsed
    }

    private fun postFormRaw(
        endpoint: HubEndpoint,
        path: String,
        fields: Map<String, String>,
    ): String {
        val formBody = FormBody.Builder().apply {
            fields.forEach { (k, v) -> add(k, v) }
        }.build()
        val request = Request.Builder()
            .url("${endpoint.baseUrl}$path")
            .header("Cache-Control", "no-store")
            .apply {
                endpoint.basicAuthHeader?.let { header("Authorization", it) }
            }
            .post(formBody)
            .build()

        httpClient.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw HubApiException(extractErrorMessage(raw, response.code), response.code)
            }
            return raw
        }
    }

    private fun postFormJson(
        endpoint: HubEndpoint,
        path: String,
        fields: Map<String, String>,
    ): JsonObject {
        val raw = postFormRaw(endpoint, path, fields)
        if (raw.isBlank()) return JsonObject(mapOf("ok" to JsonPrimitive(true)))
        val parsed = runCatching { jsonParser.parseToJsonElement(raw).jsonObject }
            .getOrElse { return JsonObject(mapOf("ok" to JsonPrimitive(true), "raw" to JsonPrimitive(raw))) }
        if (parsed["ok"]?.jsonPrimitive?.booleanOrNull == false) {
            val msg = (parsed["error"] ?: parsed["message"])?.jsonPrimitive?.content ?: "Operation failed"
            throw HubApiException(msg, 400)
        }
        return parsed
    }

    private fun postJson(
        endpoint: HubEndpoint,
        path: String,
        body: JsonElement,
        client: OkHttpClient = httpClient,
    ): JsonObject {
        val requestBody = body.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("${endpoint.baseUrl}$path")
            .header("Cache-Control", "no-store")
            .apply {
                endpoint.basicAuthHeader?.let { header("Authorization", it) }
            }
            .post(requestBody)
            .build()

        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val parsed = runCatching { jsonParser.parseToJsonElement(raw).jsonObject }.getOrNull()
            if (!response.isSuccessful || parsed?.get("ok")?.jsonPrimitive?.booleanOrNull == false) {
                val msg = (parsed?.get("error") ?: parsed?.get("message"))?.jsonPrimitive?.content
                    ?: extractErrorMessage(raw, response.code)
                throw HubApiException(msg, response.code)
            }
            return parsed ?: JsonObject(mapOf("ok" to JsonPrimitive(true)))
        }
    }

    private fun extractErrorMessage(raw: String, code: Int): String {
        val jsonErr = runCatching {
            val obj = jsonParser.parseToJsonElement(raw).jsonObject
            (obj["error"] ?: obj["message"])?.jsonPrimitive?.content
        }.getOrNull()
        if (!jsonErr.isNullOrBlank()) return jsonErr
        val msgDiv = Regex("""<div\s+class=['"]msg['"][^>]*>([\s\S]*?)</div>""", RegexOption.IGNORE_CASE)
            .find(raw)?.groupValues?.get(1)
            ?.replace(Regex("<[^>]+>"), " ")
            ?.trim()
        if (!msgDiv.isNullOrBlank()) return msgDiv
        return raw.take(120).ifBlank { "HTTP $code" }
    }
}
