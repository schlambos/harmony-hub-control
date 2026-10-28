package app.melodious.system

import android.content.Context
import android.content.SharedPreferences
import app.melodious.protocol.model.HubEndpoint
import app.melodious.protocol.update.LatestRelease
import kotlinx.serialization.json.Json

/**
 * Single source of truth for the hub the user last connected to plus phone-side preferences.
 * Shared by the app UI and the Quick Settings tile so both talk to the same host, port and auth.
 */
class HubPrefs(context: Context) : app.melodious.ssh.HostKeyStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("melodious_prefs", Context.MODE_PRIVATE)

    fun savedEndpoint(): HubEndpoint? {
        val host = prefs.getString(KEY_HOST, null)?.takeIf { it.isNotBlank() } ?: return null
        val port = prefs.getInt(KEY_PORT, 8080)
        return HubEndpoint(
            name = "Hub",
            host = host,
            webUiPort = port,
            hubId = prefs.getString(KEY_HUB_ID, "").orEmpty(),
            isSimulated = port == 8787,
            basicAuthHeader = prefs.getString(KEY_AUTH, null)?.takeIf { it.isNotBlank() },
        )
    }

    fun saveEndpoint(endpoint: HubEndpoint) {
        prefs.edit()
            .putString(KEY_HOST, endpoint.host)
            .putInt(KEY_PORT, endpoint.webUiPort)
            .putString(KEY_HUB_ID, endpoint.hubId)
            .putString(KEY_AUTH, endpoint.basicAuthHeader)
            .apply()
    }

    /** OAuth client_id override for the Logitech catalog; empty means the built-in public one. */
    var logitechClientId: String
        get() = prefs.getString(KEY_CLIENT_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CLIENT_ID, value).apply()

    var volumeKeysEnabled: Boolean
        get() = prefs.getBoolean(KEY_VOLUME_KEYS, true)
        set(value) = prefs.edit().putBoolean(KEY_VOLUME_KEYS, value).apply()

    var hapticsEnabled: Boolean
        get() = prefs.getBoolean(KEY_HAPTICS, true)
        set(value) = prefs.edit().putBoolean(KEY_HAPTICS, value).apply()

    var remoteMode: String
        get() = prefs.getString(KEY_REMOTE_MODE, "BUTTONS") ?: "BUTTONS"
        set(value) = prefs.edit().putString(KEY_REMOTE_MODE, value).apply()

    var notificationRemoteEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIF_REMOTE, true)
        set(value) = prefs.edit().putBoolean(KEY_NOTIF_REMOTE, value).apply()

    /** The user answered (or dismissed) the "control from your lock screen" prompt. */
    var notificationPromptHandled: Boolean
        get() = prefs.getBoolean(KEY_NOTIF_PROMPT, false)
        set(value) = prefs.edit().putBoolean(KEY_NOTIF_PROMPT, value).apply()

    /**
     * Activities + running state cached for the home-screen widget, which renders without the app
     * running. Names never contain newlines (hub UI forbids them), so a line-based format is enough.
     */
    var cachedActivities: List<Pair<String, String>>
        get() = prefs.getString(KEY_ACTIVITIES, "").orEmpty().lineSequence()
            .mapNotNull { line -> line.split('\t', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }
            .toList()
        set(value) = prefs.edit()
            .putString(KEY_ACTIVITIES, value.joinToString("\n") { (id, name) -> "$id\t${name.replace('\n', ' ')}" })
            .apply()

    var cachedCurrentActivityId: String
        get() = prefs.getString(KEY_CURRENT, "-1") ?: "-1"
        set(value) = prefs.edit().putString(KEY_CURRENT, value).apply()

    /** Activity the widget asked the hub to start and is still waiting on ("-1" = turning off). */
    var widgetPendingActivityId: String?
        get() = prefs.getString(KEY_WIDGET_PENDING, null)
        set(value) = prefs.edit().putString(KEY_WIDGET_PENDING, value).apply()

    /** Null until the user answers "Check for updates?"; then their choice. */
    var updateChecks: Boolean?
        get() = if (prefs.contains(KEY_UPDATE_CHECKS)) prefs.getBoolean(KEY_UPDATE_CHECKS, false) else null
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_UPDATE_CHECKS) else putBoolean(KEY_UPDATE_CHECKS, value)
        }.apply()

    var updateLastChecked: Long
        get() = prefs.getLong(KEY_UPDATE_LAST, 0L)
        set(value) = prefs.edit().putLong(KEY_UPDATE_LAST, value).apply()

    /** ETag of the last release list; a 304 reuses the picks below. */
    var updateEtag: String
        get() = prefs.getString(KEY_UPDATE_ETAG, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_UPDATE_ETAG, value).apply()

    var updateLatestApp: LatestRelease?
        get() = readRelease(KEY_UPDATE_APP)
        set(value) = writeRelease(KEY_UPDATE_APP, value)

    var updateLatestHub: LatestRelease?
        get() = readRelease(KEY_UPDATE_HUB)
        set(value) = writeRelease(KEY_UPDATE_HUB, value)

    /** App version the user already said "Later" to; scheduled checks stay quiet about it. */
    var updateDismissed: String
        get() = prefs.getString(KEY_UPDATE_DISMISSED, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_UPDATE_DISMISSED, value).apply()

    var updateDismissedHub: String
        get() = prefs.getString(KEY_UPDATE_DISMISSED_HUB, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_UPDATE_DISMISSED_HUB, value).apply()

    /**
     * Debug builds only: a release-list base URL to use instead of GitHub (set with adb for the
     * emulator self-update test). Release builds never read it.
     */
    val updateTestBase: String
        get() = prefs.getString(KEY_UPDATE_TEST_BASE, "").orEmpty()

    /** Debug builds only: the hub's SSH port for the emulator hub-update test. Release builds use 22. */
    val updateTestSshPort: Int
        get() = prefs.getInt(KEY_UPDATE_TEST_SSH_PORT, 0)

    /** Each hub's SSH host key fingerprint, pinned on first use (as `ssh` accept-new does). */
    override fun get(host: String): String? = prefs.getString(KEY_SSH_HOST_PREFIX + host, null)

    override fun put(host: String, fingerprint: String) {
        prefs.edit().putString(KEY_SSH_HOST_PREFIX + host, fingerprint).apply()
    }

    private fun readRelease(key: String): LatestRelease? =
        prefs.getString(key, null)?.let { runCatching { Json.decodeFromString(LatestRelease.serializer(), it) }.getOrNull() }

    private fun writeRelease(key: String, value: LatestRelease?) = prefs.edit().apply {
        if (value == null) remove(key) else putString(key, Json.encodeToString(LatestRelease.serializer(), value))
    }.apply()

    private companion object {
        const val KEY_HOST = "saved_hub_host"
        const val KEY_PORT = "saved_hub_port"
        const val KEY_HUB_ID = "saved_hub_id"
        const val KEY_AUTH = "saved_hub_auth"
        const val KEY_CLIENT_ID = "logitech_client_id"
        const val KEY_VOLUME_KEYS = "volume_keys_enabled"
        const val KEY_HAPTICS = "haptics_enabled"
        const val KEY_REMOTE_MODE = "remote_mode"
        const val KEY_NOTIF_REMOTE = "notification_remote_enabled"
        const val KEY_NOTIF_PROMPT = "notification_prompt_handled"
        const val KEY_ACTIVITIES = "cached_activities"
        const val KEY_CURRENT = "cached_current_activity"
        const val KEY_WIDGET_PENDING = "widget_pending_activity"
        const val KEY_UPDATE_CHECKS = "update_checks"
        const val KEY_UPDATE_LAST = "update_last_checked"
        const val KEY_UPDATE_ETAG = "update_etag"
        const val KEY_UPDATE_APP = "update_latest_app"
        const val KEY_UPDATE_HUB = "update_latest_hub"
        const val KEY_UPDATE_DISMISSED = "update_dismissed"
        const val KEY_UPDATE_DISMISSED_HUB = "update_dismissed_hub"
        const val KEY_UPDATE_TEST_BASE = "update_test_base"
        const val KEY_UPDATE_TEST_SSH_PORT = "update_test_ssh_port"
        const val KEY_SSH_HOST_PREFIX = "ssh_host_key_"
    }
}
