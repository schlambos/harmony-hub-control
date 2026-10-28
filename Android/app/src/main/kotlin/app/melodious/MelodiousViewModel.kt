package app.melodious

import android.app.Application
import android.content.Context
import android.net.wifi.WifiManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.melodious.protocol.catalog.CatalogError
import app.melodious.protocol.catalog.CatalogService
import app.melodious.protocol.catalog.OkHttpCatalogHttp
import app.melodious.protocol.catalog.effectiveClientId
import app.melodious.protocol.catalog.normalizeClientId
import app.melodious.system.AuthTabSignIn
import app.melodious.system.HubPrefs
import app.melodious.system.LogitechTokenStore
import app.melodious.system.RemoteNotification
import app.melodious.system.WidgetRenderer
import app.melodious.protocol.model.DeviceCommand
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import app.melodious.protocol.discovery.HubDiscovery
import app.melodious.protocol.graph.ActivityGraphBuilder
import app.melodious.protocol.hbus.HBusWebSocketClient
import app.melodious.protocol.ir.IrProtocolTools
import app.melodious.protocol.model.ActivityWizardDraft
import app.melodious.protocol.model.BtAdapterStatus
import app.melodious.protocol.model.BtTextHelperStatus
import app.melodious.protocol.model.ButtonMappingSource
import app.melodious.protocol.model.HubActivity
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.HubConfigSnapshot
import app.melodious.protocol.model.HubEndpoint
import app.melodious.protocol.model.IrCaptureAnalysis
import app.melodious.protocol.model.RemoteLayout
import app.melodious.protocol.model.ResolvedButtonAction
import app.melodious.protocol.model.SoftButton
import app.melodious.protocol.model.DeviceSettings
import app.melodious.protocol.model.DeviceSettingsModel
import app.melodious.protocol.model.DeviceTouchScreen
import app.melodious.protocol.model.DeviceTouchScreens
import app.melodious.protocol.hbus.SleepTimerState
import app.melodious.protocol.graph.SequenceStep
import app.melodious.protocol.graph.SoftButtonDraft
import app.melodious.protocol.graph.TouchScreenDraft
import app.melodious.protocol.graph.TouchScreenGraph
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import app.melodious.protocol.model.SavedBtDevice
import app.melodious.protocol.model.SystemStatusSnapshot
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft
import app.melodious.protocol.rest.CodexHubRestClient
import app.melodious.protocol.update.GitHubReleaseClient
import app.melodious.protocol.update.GitHubReleases
import app.melodious.protocol.update.HubSoftware
import app.melodious.protocol.update.LatestRelease
import app.melodious.protocol.update.ReleaseDownloader
import app.melodious.protocol.update.ReleaseFetch
import app.melodious.system.AppUpdater
import app.melodious.system.HubKeyStore
import app.melodious.ssh.HubSshUpdater
import app.melodious.protocol.update.ReleaseVersion
import app.melodious.ssh.HubSshProvisioner
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

enum class HubConnection { SEARCHING, CONNECTING, CONNECTED, UNREACHABLE, NOT_FOUND }

enum class RemoteMode { BUTTONS, TOUCHPAD, KEYBOARD }

/** What a remote surface is currently driving: a whole activity, or one device directly. */
sealed interface RemoteTarget {
    data class Activity(val id: String) : RemoteTarget
    data class Device(val id: String) : RemoteTarget
}

enum class SendStatus { PENDING, OK, FAILED }

data class SendLogEntry(
    val id: Long,
    val timestamp: String,
    val targetName: String,
    val commandName: String,
    val status: SendStatus,
    val error: String? = null,
)

data class UiMessage(val id: Long, val text: String, val isError: Boolean)

enum class AppUpdateStage { DOWNLOADING, CHECKING, INSTALLING }

/** The in-app update while it runs; [total] is -1 when GitHub didn't say. */
data class AppUpdateProgress(val stage: AppUpdateStage, val done: Long = 0, val total: Long = -1)

/** "A newer version is out" dialog: for this app, or for the hub when the app is current. */
data class UpdatePrompt(val title: String, val text: String, val url: String, val version: String, val forHub: Boolean)

/** State of the Import sheet's Logitech catalog tab, kept in the ViewModel. */
data class CatalogTabState(
    val deviceId: String = "",
    val matches: List<app.melodious.protocol.catalog.CatalogSearchMatch> = emptyList(),
    val preview: app.melodious.protocol.catalog.CatalogRowsResult? = null,
    val previewSummary: String = "",
    /** True when the hub's protocol list couldn't be read, so no KeyCode was checked. */
    val previewProtocolsUnreadable: Boolean = false,
    val status: String = "",
    val statusError: Boolean = false,
    val modelCheck: String = "",
    /** "brand\0model" the [modelCheck] text belongs to; stale results are dropped. */
    val modelCheckKey: String = "",
)

data class MelodiousUiState(
    val connection: HubConnection = HubConnection.SEARCHING,
    val connectionError: String? = null,
    val discoveredHubs: List<HubEndpoint> = emptyList(),
    val isScanningHubs: Boolean = false,
    val activeEndpoint: HubEndpoint? = null,
    val hbusConnected: Boolean = false,

    val configSnapshot: HubConfigSnapshot? = null,
    val currentActivityId: String = "-1",
    /** Activity the user asked to start (or "-1" for power off) while the hub is still switching. */
    val pendingActivityId: String? = null,
    /** Hub statedigest activityStatus (0 off, 1 starting, 2 running, 3 turning off); null when unknown. */
    val activityStatus: Int? = null,
    /** Phone wall-clock time the hub's sleep timer will turn everything off; null when no timer. */
    val sleepTimerEndsAtMillis: Long? = null,

    val message: UiMessage? = null,
    val sendLog: List<SendLogEntry> = emptyList(),

    val remoteMode: RemoteMode = RemoteMode.BUTTONS,
    val volumeKeysEnabled: Boolean = true,
    val hapticsEnabled: Boolean = true,
    val notificationRemoteEnabled: Boolean = true,
    val notificationPermissionGranted: Boolean = true,
    val notificationPromptHandled: Boolean = false,

    // Activity editor
    val wizardOpen: Boolean = false,
    val wizardStep: Int = 0,
    val wizardDraft: ActivityWizardDraft = ActivityWizardDraft(),
    val wizardSaving: Boolean = false,

    // On-screen button editor: the draft is null while the editor is closed.
    val touchDraft: TouchScreenDraft? = null,
    val touchDraftDirty: Boolean = false,
    val touchSaving: Boolean = false,
    val deviceSettingsSaving: Boolean = false,
    val deviceScreenSaving: Boolean = false,

    // IR tools
    val irCapturing: Boolean = false,
    val lastIrCapture: IrCaptureAnalysis? = null,
    val irBusy: Boolean = false,
    val activeBatchRunId: String? = null,
    val batchSweepStatus: String? = null,

    // Logitech catalog account (tokens stay encrypted on the phone)
    val catalogSignedIn: Boolean = false,
    val catalogBusy: Boolean = false,
    val logitechClientId: String = "",
    /** In-tab catalog state: null while the Import sheet is closed. */
    val catalogTab: CatalogTabState? = null,

    // Bluetooth & admin
    val btAdapterStatus: BtAdapterStatus = BtAdapterStatus(),
    val btTextHelperStatus: BtTextHelperStatus = BtTextHelperStatus(),
    val savedBtDevices: List<SavedBtDevice> = emptyList(),
    val systemStatus: SystemStatusSnapshot = SystemStatusSnapshot(),
    val sshConsoleOutput: String = "",
    val sshBusy: Boolean = false,

    // Update notices (nothing is downloaded or installed)
    val appVersion: String = "",
    /** Null until the user answers "Check for updates?". */
    val updateChecks: Boolean? = null,
    val updateChecking: Boolean = false,
    val updateLastChecked: Long = 0L,
    /** Newer than this app, or null. */
    val latestApp: LatestRelease? = null,
    val latestHub: LatestRelease? = null,
    val hubSoftware: HubSoftware? = null,
    val updatePrompt: UpdatePrompt? = null,
    val appUpdateProgress: AppUpdateProgress? = null,
    /** Android needs "Install unknown apps" allowed for Melodious before the update can install. */
    val installPermissionNeeded: Boolean = false,

    // Hub update over SSH (the installer's way, with the owner's hub key)
    /** Progress text while the hub is being updated; null otherwise. */
    val hubUpdateStep: String? = null,
    val hubKeyNeeded: Boolean = false,
    val hubKeySaved: Boolean = false,
    val hubUpdateConfirm: LatestRelease? = null,
    val hubUpdateOutcome: String? = null,
    val hubUpdateOk: Boolean = false,
) {
    val hubUpdateNote: String get() = GitHubReleases.hubNote(hubSoftware, latestHub)

    val isConnected: Boolean get() = connection == HubConnection.CONNECTED && configSnapshot != null

    val activities: List<HubActivity>
        get() = configSnapshot?.activities.orEmpty().sortedBy { it.activityOrder }

    val devices: List<HubDevice>
        get() = configSnapshot?.devices.orEmpty()

    val runningActivity: HubActivity?
        get() = activities.firstOrNull { it.id == currentActivityId }

    val isEverythingOff: Boolean
        get() = RemoteLayout.isEverythingOff(currentActivityId)

    fun device(id: String?): HubDevice? = devices.firstOrNull { it.id == id }

    fun activity(id: String?): HubActivity? = activities.firstOrNull { it.id == id }

    /** Distinct device names taking part in an activity, in role power-on order. */
    fun deviceNamesFor(activity: HubActivity): List<String> =
        activity.roles.sortedBy { it.powerOnOrder }
            .mapNotNull { role -> device(role.deviceId)?.name }
            .distinct()

    /** A device's power and timing settings as the hub stores them; null if the device is gone. */
    fun deviceSettings(deviceId: String): DeviceSettings? =
        configSnapshot?.let { DeviceSettingsModel.deviceEntry(it, deviceId) }?.let(DeviceSettingsModel::read)

    /** Where the device's Harmony Touch screen comes from, and so what the app may do with it. */
    fun deviceTouchScreen(deviceId: String): DeviceTouchScreen =
        configSnapshot?.let { DeviceTouchScreens.state(it, deviceId) } ?: DeviceTouchScreen.NO_TOUCH

    fun deviceCommandNames(deviceId: String): List<String> =
        configSnapshot?.let { DeviceSettingsModel.deviceEntry(it, deviceId) }?.let(DeviceSettingsModel::commandNames).orEmpty()

    /** On-screen buttons for an activity (number keys excluded; they feed the number pad). */
    fun softButtons(activityId: String): List<SoftButton> =
        configSnapshot?.let { ActivityGraphBuilder.resolveActivitySoftButtons(it, activityId) }.orEmpty()

    /** Every mapped key for a target, keyed by canonical firmware ButtonKey. */
    fun keyMap(target: RemoteTarget?): Map<String, ResolvedButtonAction> {
        val snapshot = configSnapshot ?: return emptyMap()
        return when (target) {
            null -> emptyMap()
            is RemoteTarget.Activity -> {
                val hard = ActivityGraphBuilder.resolveActivityButtons(snapshot, target.id)
                // Many activities only have digits as on-screen buttons; let them drive the number pad.
                val digits = softButtons(target.id).mapNotNull { b -> b.digit?.let { "Number$it" to b } }
                    .filter { (key, _) -> key !in hard }
                    .associate { (key, b) ->
                        key to ResolvedButtonAction(
                            buttonKey = key,
                            buttonLabel = b.label,
                            pressDeviceId = b.deviceId,
                            pressDeviceName = b.deviceName,
                            pressCommand = b.command,
                            pressFunctionId = b.functionId,
                        )
                    }
                hard + digits
            }
            is RemoteTarget.Device -> {
                val device = device(target.id) ?: return emptyMap()
                val out = LinkedHashMap<String, ResolvedButtonAction>()
                for (hotspot in RemoteLayout.REMOTE_BUTTONS) {
                    if (hotspot.isPowerKey) continue
                    val key = hotspot.canonicalButtonKey ?: hotspot.label
                    val matched = RemoteLayout.matchCommand(device.commands, hotspot.aliases) ?: continue
                    out[key] = ResolvedButtonAction(
                        buttonKey = key,
                        buttonLabel = hotspot.label,
                        pressDeviceId = device.id,
                        pressDeviceName = device.name,
                        pressCommand = matched.name,
                        pressFunctionId = matched.functionId,
                    )
                }
                out
            }
        }
    }
}

/** Largest catalog package the file picker reads (the Sony package is ~30 KB). */
private const val MAX_CATALOG_FILE_BYTES = 4 * 1024 * 1024

class MelodiousViewModel(application: Application) : AndroidViewModel(application) {
    private val prefs = HubPrefs(application)
    private val restClient = CodexHubRestClient()
    private val discovery = HubDiscovery()
    private val hbusClient = HBusWebSocketClient(viewModelScope)
    private val sshProvisioner = HubSshProvisioner()
    /* Debug builds may point update checks at a test server (HubPrefs.updateTestBase) and the hub
       update at another SSH port; release builds only ever talk to GitHub and port 22. */
    private val debuggable = (application.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    private val updateTestBase: String = prefs.updateTestBase.takeIf { it.isNotBlank() && debuggable }.orEmpty()
    private val hubSshPort: Int = prefs.updateTestSshPort.takeIf { it > 0 && debuggable } ?: 22
    private val hubKeyStore = HubKeyStore(application)
    private val releaseClient = if (updateTestBase.isEmpty()) GitHubReleaseClient()
    else GitHubReleaseClient(releasesUrl = "$updateTestBase/releases")
    private val allowUpdateUrl: (String) -> Boolean =
        { url -> GitHubReleases.isGitHubUrl(url) || (updateTestBase.isNotEmpty() && url.startsWith("$updateTestBase/")) }
    private val releaseDownloader = ReleaseDownloader(isAllowed = allowUpdateUrl)
    private var appUpdateJob: Job? = null
    private val hubUpdater = HubSshUpdater(downloader = releaseDownloader, hostKeys = prefs)
    private val appVersion: String = runCatching {
        application.packageManager.getPackageInfo(application.packageName, 0).versionName
    }.getOrNull() ?: "0.0.0"
    private val catalogService = CatalogService(
        http = OkHttpCatalogHttp(),
        tokenStore = LogitechTokenStore(application),
        signInLauncher = AuthTabSignIn,
        clientIdProvider = { effectiveClientId(prefs.logitechClientId) },
    )

    private val _uiState = MutableStateFlow(
        MelodiousUiState(
            remoteMode = savedRemoteMode(prefs),
            volumeKeysEnabled = prefs.volumeKeysEnabled,
            hapticsEnabled = prefs.hapticsEnabled,
            notificationRemoteEnabled = prefs.notificationRemoteEnabled,
            notificationPermissionGranted = RemoteNotification.hasPermission(application),
            notificationPromptHandled = prefs.notificationPromptHandled,
            catalogSignedIn = catalogService.status().signedIn,
            logitechClientId = prefs.logitechClientId,
            appVersion = appVersion,
            updateChecks = prefs.updateChecks,
            updateLastChecked = prefs.updateLastChecked,
            latestApp = newerThanThisApp(prefs.updateLatestApp),
            latestHub = prefs.updateLatestHub,
            hubKeySaved = hubKeyStore.load() != null,
        )
    )
    val uiState: StateFlow<MelodiousUiState> = _uiState.asStateFlow()

    /** The remote surface currently on screen; physical volume keys drive this first. */
    @Volatile
    var visibleRemoteTarget: RemoteTarget? = null

    private val ids = AtomicLong(1)
    private var statePollJob: Job? = null
    private var lastStateVersion: String? = null
    private var repeatJob: Job? = null
    private var hbusHold: ResolvedButtonAction? = null
    private var inForeground = true
    private var hbusReconnectJob: Job? = null
    private var hbusBackoffMs = HBUS_MIN_BACKOFF_MS

    init {
        viewModelScope.launch {
            hbusClient.connectionState.collect { conn ->
                _uiState.update { it.copy(hbusConnected = conn is HBusWebSocketClient.ConnectionState.Connected) }
                when (conn) {
                    is HBusWebSocketClient.ConnectionState.Connected -> hbusBackoffMs = HBUS_MIN_BACKOFF_MS
                    is HBusWebSocketClient.ConnectionState.Error -> scheduleHbusReconnect()
                    else -> Unit
                }
            }
        }
        viewModelScope.launch {
            hbusClient.stateEvents.collect { digest -> applyHubState(digest.activityId, digest.activityStatus, digest.sleepTimer) }
        }
        // Keep the home-screen widget's cached activities and running state in step with the hub.
        viewModelScope.launch {
            _uiState
                .map { s -> Triple(s.isConnected, s.activities.map { it.id to it.name }, s.currentActivityId) }
                .distinctUntilChanged()
                .collect { (connected, activities, current) ->
                    if (!connected) return@collect
                    prefs.cachedActivities = activities
                    prefs.cachedCurrentActivityId = current
                    prefs.widgetPendingActivityId = null
                    WidgetRenderer.updateAll(getApplication())
                }
        }
        viewModelScope.launch {
            AppUpdater.events.collect { event ->
                _uiState.update { it.copy(appUpdateProgress = null) }
                when (event) {
                    AppUpdater.Event.Installed -> showMessage("Melodious is up to date.")
                    is AppUpdater.Event.Failed -> showMessage(event.message, isError = true)
                }
            }
        }
        start()
        checkForUpdatesIfDue()
    }

    // ========================================================================
    // Connection lifecycle
    // ========================================================================

    /** Fast path: reconnect to the saved hub; fall back to a LAN scan only if that fails. */
    private fun start() {
        val saved = prefs.savedEndpoint()
        if (saved != null) {
            viewModelScope.launch {
                if (!tryConnect(saved)) scanForHubs()
            }
        } else {
            scanForHubs()
        }
    }

    fun retryConnection() = start()

    fun scanForHubs() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isScanningHubs = true,
                    connection = if (it.isConnected) it.connection else HubConnection.SEARCHING,
                )
            }
            val wifiManager = getApplication<Application>().applicationContext
                .getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val multicastLock = wifiManager?.createMulticastLock("melodious_ssdp_lock")?.apply {
                setReferenceCounted(false)
                runCatching { acquire() }
            }
            val found = try {
                val saved = prefs.savedEndpoint()
                discovery.discoverHubs(extraHosts = listOfNotNull(saved?.host))
                    // The Android emulator dev probes are not real hubs.
                    .filterNot { it.isSimulated && it.host == "10.0.2.2" }
            } catch (e: Exception) {
                emptyList()
            } finally {
                runCatching { if (multicastLock?.isHeld == true) multicastLock.release() }
            }
            _uiState.update { it.copy(discoveredHubs = found, isScanningHubs = false) }

            if (_uiState.value.isConnected) return@launch
            val saved = prefs.savedEndpoint()
            val preferred = found.firstOrNull { it.host == saved?.host }?.withSavedSettings(saved)
                ?: found.singleOrNull()
            if (preferred != null) {
                tryConnect(preferred)
            } else {
                _uiState.update { it.copy(connection = HubConnection.NOT_FOUND) }
            }
        }
    }

    private fun HubEndpoint.withSavedSettings(saved: HubEndpoint?): HubEndpoint =
        if (saved == null) this else copy(
            webUiPort = saved.webUiPort,
            hubId = saved.hubId.ifBlank { hubId },
            basicAuthHeader = saved.basicAuthHeader,
        )

    fun connectManualHub(host: String, port: Int = 8080, username: String = "", password: String = "") {
        val cleanHost = host.trim()
        if (cleanHost.isEmpty()) return
        val endpoint = HubEndpoint(
            name = "Hub",
            host = cleanHost,
            webUiPort = port,
            isSimulated = port == 8787,
            basicAuthHeader = username.takeIf { it.isNotBlank() }
                ?.let { CodexHubRestClient.buildBasicAuthHeader(it.trim(), password) },
        )
        viewModelScope.launch { tryConnect(endpoint) }
    }

    fun connectToHub(endpoint: HubEndpoint) {
        viewModelScope.launch { tryConnect(endpoint.withSavedSettings(prefs.savedEndpoint()?.takeIf { it.host == endpoint.host })) }
    }

    private suspend fun tryConnect(endpoint: HubEndpoint): Boolean {
        _uiState.update {
            it.copy(
                connection = HubConnection.CONNECTING,
                connectionError = null,
                activeEndpoint = endpoint,
            )
        }
        return try {
            val config = restClient.getActivityConfig(endpoint)
            val endpoint = if (endpoint.hubId.isNotBlank() || endpoint.isSimulated) endpoint
            else endpoint.copy(hubId = hbusClient.fetchHubId(endpoint).orEmpty())
            val currentActId = runCatching { restClient.getActivityState(endpoint) }.getOrDefault("-1")
            prefs.saveEndpoint(endpoint)
            _uiState.update {
                it.copy(
                    connection = HubConnection.CONNECTED,
                    activeEndpoint = endpoint,
                    configSnapshot = config,
                    currentActivityId = currentActId,
                    activityStatus = null,
                    pendingActivityId = null,
                )
            }
            hbusClient.connect(endpoint)
            startStatePolling(endpoint)
            refreshHubDetails()
            refreshHubSoftware(endpoint)
            true
        } catch (e: Exception) {
            _uiState.update {
                it.copy(
                    connection = HubConnection.UNREACHABLE,
                    connectionError = friendlyError(e),
                )
            }
            false
        }
    }

    /** Pull system + Bluetooth status in the background; failures here never block control. */
    fun refreshHubDetails() {
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            val sys = runCatching { restClient.getSystemStatus(endpoint) }.getOrNull()
            val btText = runCatching { restClient.getBtTextStatus(endpoint) }.getOrNull()
            val btDevs = runCatching { restClient.getSavedBtDevices(endpoint) }.getOrNull()
            _uiState.update {
                it.copy(
                    systemStatus = sys ?: it.systemStatus,
                    btTextHelperStatus = btText ?: it.btTextHelperStatus,
                    savedBtDevices = btDevs ?: it.savedBtDevices,
                )
            }
        }
    }

    private suspend fun reloadConfig(endpoint: HubEndpoint) {
        val reloaded = restClient.getActivityConfig(endpoint)
        _uiState.update { it.copy(configSnapshot = reloaded) }
    }

    private fun startStatePolling(endpoint: HubEndpoint) {
        statePollJob?.cancel()
        lastStateVersion = null
        statePollJob = viewModelScope.launch {
            while (isActive) {
                // Poll faster while a start/stop is in flight so the busy screen clears promptly.
                delay(if (_uiState.value.pendingActivityId != null) 1500 else 4000)
                runCatching {
                    val poll = restClient.pollStateDigest(endpoint, lastStateVersion)
                    lastStateVersion = poll.version
                    if (poll.changed) {
                        val actId = poll.activityId ?: restClient.getActivityState(endpoint)
                        applyHubState(actId, poll.activityStatus, poll.sleepTimer)
                    }
                }
            }
        }
    }

    /** Live updates dropped (hub reboot, Wi-Fi blip): retry with backoff while the app is in use. */
    private fun scheduleHbusReconnect() {
        if (hbusReconnectJob?.isActive == true) return
        hbusReconnectJob = viewModelScope.launch {
            delay(hbusBackoffMs)
            hbusBackoffMs = (hbusBackoffMs * 2).coerceAtMost(HBUS_MAX_BACKOFF_MS)
            val state = _uiState.value
            val endpoint = state.activeEndpoint
            if (inForeground && state.isConnected && endpoint != null && !state.hbusConnected) {
                hbusClient.connect(endpoint)
            }
        }
    }

    /** Stop background traffic while the app is not visible; resync instantly when it returns. */
    fun onAppBackground() {
        inForeground = false
        hbusReconnectJob?.cancel()
        stopHold()
        postNotificationRemote()
        statePollJob?.cancel()
        statePollJob = null
        hbusClient.disconnect()
    }

    fun onAppForeground() {
        RemoteNotification.cancel(getApplication())
        _uiState.update { it.copy(notificationPermissionGranted = RemoteNotification.hasPermission(getApplication())) }
        if (inForeground) return
        inForeground = true
        checkForUpdatesIfDue()
        // Back from Android's "Install unknown apps" page: carry on if the user allowed it.
        if (_uiState.value.installPermissionNeeded && AppUpdater.canInstall(getApplication())) installAppUpdate()
        val state = _uiState.value
        val endpoint = state.activeEndpoint
        if (endpoint == null || !state.isConnected) {
            start()
            return
        }
        viewModelScope.launch {
            runCatching { restClient.getActivityState(endpoint) }
                .onSuccess { actId -> applyHubState(actId, status = null) }
                .onFailure {
                    _uiState.update { s ->
                        s.copy(connection = HubConnection.UNREACHABLE, connectionError = friendlyError(it))
                    }
                    return@launch
                }
            hbusClient.connect(endpoint)
            startStatePolling(endpoint)
        }
    }

    // ========================================================================
    // Preferences
    // ========================================================================

    /** Keyboard is a quick detour, never the default: only Buttons/Touchpad are remembered. */
    fun setRemoteMode(mode: RemoteMode) {
        if (mode != RemoteMode.KEYBOARD) prefs.remoteMode = mode.name
        _uiState.update { it.copy(remoteMode = mode) }
    }

    fun refreshKeyboardStatus() {
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            runCatching { restClient.getBtTextStatus(endpoint) }
                .onSuccess { status -> _uiState.update { it.copy(btTextHelperStatus = status) } }
        }
    }

    /**
     * Single entry point for "what is the hub doing". A pending start/stop is only cleared once the
     * hub confirms it finished; the hub answers the run request before it has actually switched, and
     * its intermediate digests still report the old activity.
     */
    private fun applyHubState(activityId: String, status: Int?, sleepTimer: SleepTimerState? = null) {
        _uiState.update { s ->
            val pending = s.pendingActivityId
            val finished = status == null || status == STATUS_RUNNING || status == STATUS_OFF
            val confirmed = pending != null && activityId == pending && finished
            val switchedActivity = activityId != s.currentActivityId && activityId != "-1"
            s.copy(
                currentActivityId = activityId,
                activityStatus = status,
                pendingActivityId = if (confirmed) null else pending,
                remoteMode = if (switchedActivity && s.remoteMode == RemoteMode.KEYBOARD) savedRemoteMode(prefs) else s.remoteMode,
                sleepTimerEndsAtMillis = when {
                    activityId == "-1" -> null
                    sleepTimer == null -> s.sleepTimerEndsAtMillis
                    sleepTimer.isRunning -> System.currentTimeMillis() + sleepTimer.secondsRemaining * 1000
                    else -> null
                },
            )
        }
    }

    fun setVolumeKeysEnabled(enabled: Boolean) {
        prefs.volumeKeysEnabled = enabled
        _uiState.update { it.copy(volumeKeysEnabled = enabled) }
    }

    fun setHapticsEnabled(enabled: Boolean) {
        prefs.hapticsEnabled = enabled
        _uiState.update { it.copy(hapticsEnabled = enabled) }
    }

    // ========================================================================
    // Logitech catalog account
    // ========================================================================

    fun catalogSignIn() {
        if (_uiState.value.catalogBusy) return
        _uiState.update { it.copy(catalogBusy = true) }
        viewModelScope.launch {
            runCatching { catalogService.signIn() }
                .onSuccess { status ->
                    _uiState.update { it.copy(catalogBusy = false, catalogSignedIn = status.signedIn) }
                    if (status.signedIn) showMessage("Signed in to Logitech.")
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(catalogBusy = false, catalogSignedIn = catalogService.status().signedIn)
                    }
                    showMessage(err.message ?: "Sign-in failed.", isError = true)
                }
        }
    }

    fun catalogSignOut() {
        if (_uiState.value.catalogBusy) return
        _uiState.update { it.copy(catalogBusy = true) }
        viewModelScope.launch {
            runCatching { catalogService.signOut() }
                .onSuccess {
                    _uiState.update { it.copy(catalogBusy = false, catalogSignedIn = false) }
                    showMessage("Signed out of Logitech.")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(catalogBusy = false) }
                    showMessage(err.message ?: "Sign-out failed.", isError = true)
                }
        }
    }

    // ========================================================================
    // Logitech catalog tab (Import sheet)
    // ========================================================================

    private var modelCheckInFlight = false

    fun openCatalogTab(deviceId: String) {
        if (_uiState.value.catalogTab?.deviceId == deviceId) return
        _uiState.update { it.copy(catalogTab = CatalogTabState(deviceId = deviceId)) }
    }

    fun closeCatalogTab() {
        _uiState.update { it.copy(catalogTab = null) }
    }

    /**
     * The debounced model check: at most one request in flight, and a result
     * is dropped when the fields have changed since it was sent. The tab
     * composable debounces (600 ms) and never calls this for pre-filled or
     * blank values. Anonymous: it never signs in.
     */
    fun checkCatalogModel(manufacturer: String, model: String) {
        if (modelCheckInFlight) return
        modelCheckInFlight = true
        val m = manufacturer.trim()
        val n = model.trim()
        viewModelScope.launch {
            try {
                val res = catalogService.checkModel(m, n)
                val tab = _uiState.value.catalogTab ?: return@launch
                // Only publish when the tab is still open; the composable
                // re-checks the displayed fields before showing it.
                _uiState.update {
                    it.copy(
                        catalogTab = tab.copy(
                            modelCheck = if (res.found) "Logitech knows this as ${res.model.ifBlank { n }}"
                            else "Not found under that name",
                            modelCheckKey = "$m\u0000$n",
                        )
                    )
                }
            } catch (_: Exception) {
                _uiState.update { s ->
                    s.catalogTab?.let { t -> s.copy(catalogTab = t.copy(modelCheck = "", modelCheckKey = "")) } ?: s
                }
            } finally {
                modelCheckInFlight = false
            }
        }
    }

    fun catalogSearch(brand: String, model: String) {
        val m = brand.trim()
        val n = model.trim()
        if (m.isEmpty() || n.isEmpty()) {
            updateCatalogTab { it.copy(status = "Enter both the brand and the model (part of the model is enough).", statusError = true) }
            return
        }
        if (_uiState.value.catalogBusy) return
        _uiState.update { s ->
            s.copy(
                catalogBusy = true,
                catalogTab = (s.catalogTab ?: CatalogTabState()).copy(matches = emptyList(), preview = null, previewSummary = "", status = "Searching Logitech's catalog…", statusError = false),
            )
        }
        viewModelScope.launch {
            runCatching { catalogService.search(m, n) }
                .onSuccess { matches ->
                    _uiState.update { s ->
                        s.copy(
                            catalogBusy = false,
                            catalogSignedIn = true,
                            catalogTab = (s.catalogTab ?: CatalogTabState()).copy(
                                matches = matches,
                                status = "Found ${matches.size} catalog match${if (matches.size == 1) "" else "es"}. Pick one to download its commands.",
                                statusError = false,
                            ),
                        )
                    }
                }
                .onFailure { err -> catalogTabError(err, "Catalog search failed.") }
        }
    }

    fun catalogDownload(match: app.melodious.protocol.catalog.CatalogSearchMatch) {
        if (_uiState.value.catalogBusy) return
        _uiState.update { s ->
            s.copy(
                catalogBusy = true,
                catalogTab = (s.catalogTab ?: CatalogTabState()).copy(
                    preview = null, previewSummary = "",
                    status = "Downloading ${match.displayText} from Logitech…", statusError = false,
                ),
            )
        }
        viewModelScope.launch {
            runCatching { catalogService.download(match.id, match.manufacturer, match.model) }
                .onSuccess { pkg ->
                    _uiState.update { it.copy(catalogSignedIn = true) }
                    previewCatalogPackage(pkg, "Logitech catalog")
                }
                .onFailure { err -> catalogTabError(err, "Catalog download failed.") }
        }
    }

    /** The picker could not read the chosen file (or it was over 4 MB). */
    fun openCatalogFileUnreadable(name: String) {
        updateCatalogTab { it.copy(status = "$name is not a catalog package (not JSON)", statusError = true) }
    }

    /** Parse and preview a harmony-catalog-*.json file's contents (at most 4 MB). */
    fun openCatalogFile(name: String, text: String) {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_CATALOG_FILE_BYTES) {
            updateCatalogTab { it.copy(status = "$name is not a catalog package (not JSON)", statusError = true) }
            return
        }
        val pkg = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(text) }.getOrNull()
        if (pkg == null) {
            updateCatalogTab { it.copy(status = "$name is not a catalog package (not JSON)", statusError = true) }
            return
        }
        if (!app.melodious.protocol.catalog.isCatalogPackage(pkg)) {
            updateCatalogTab {
                it.copy(status = "$name is not a Logitech catalog package from tools/catalog/harmony_catalog.py.", statusError = true)
            }
            return
        }
        previewCatalogPackage(pkg, name)
    }

    private fun previewCatalogPackage(pkg: kotlinx.serialization.json.JsonElement, label: String) {
        val endpoint = _uiState.value.activeEndpoint
        viewModelScope.launch {
            if (endpoint == null) {
                finishCatalogPreview(emptyList(), pkg, label, protocolsUnreadable = true)
                return@launch
            }
            runCatching { restClient.getHubProtocolNames(endpoint) }
                .onSuccess { names -> finishCatalogPreview(names, pkg, label, protocolsUnreadable = false) }
                .onFailure { finishCatalogPreview(emptyList(), pkg, label, protocolsUnreadable = true) }
        }
    }

    private fun finishCatalogPreview(
        protocols: List<String>,
        pkg: kotlinx.serialization.json.JsonElement,
        label: String,
        protocolsUnreadable: Boolean,
    ) {
        val converted = app.melodious.protocol.catalog.catalogRows(pkg, protocols)
        val summary = app.melodious.protocol.catalog.describeCatalogRows(converted)
        _uiState.update { s ->
            s.copy(
                catalogBusy = false,
                catalogTab = (s.catalogTab ?: CatalogTabState()).copy(
                    preview = converted,
                    previewSummary = summary,
                    previewProtocolsUnreadable = protocolsUnreadable,
                    status = if (protocolsUnreadable) {
                        "Loaded $label, but the hub's protocol list couldn't be read, so no KeyCode can be checked yet."
                    } else {
                        "Loaded $label: $summary."
                    },
                    statusError = false,
                ),
            )
        }
    }

    /** Imports the preview rows to the tab's device; returns through the snackbar on success. */
    fun catalogImport(device: HubDevice, onDone: () -> Unit) {
        val tab = _uiState.value.catalogTab ?: return
        val rows = tab.preview?.rows.orEmpty()
        if (rows.isEmpty()) {
            updateCatalogTab { it.copy(status = "Nothing to import yet: open a catalog package with importable commands first.", statusError = true) }
            return
        }
        val endpoint = _uiState.value.activeEndpoint ?: return
        if (_uiState.value.catalogBusy) return
        _uiState.update { s ->
            s.copy(catalogBusy = true, catalogTab = (s.catalogTab ?: CatalogTabState()).copy(status = "Importing… the hub backs up its device list first.", statusError = false))
        }
        viewModelScope.launch {
            runCatching {
                val reply = restClient.importCatalogCommands(endpoint, device.id, rows)
                runCatching { reloadConfig(endpoint) }
                reply
            }.onSuccess { reply ->
                _uiState.update { it.copy(catalogBusy = false) }
                onDone()
                val msg = reply["message"]?.jsonPrimitive?.content.orEmpty()
                showMessage("Imported to ${device.name}. $msg".trim())
            }.onFailure { err ->
                _uiState.update { it.copy(catalogBusy = false) }
                val msg = if (err is app.melodious.protocol.rest.HubApiException && err.statusCode == 404) {
                    "Your hub's Melodious software is older than this app; update the hub"
                } else {
                    err.message ?: "Import failed."
                }
                updateCatalogTab { it.copy(status = msg, statusError = true) }
            }
        }
    }

    private fun catalogTabError(err: Throwable, fallback: String) {
        _uiState.update { s ->
            s.copy(
                catalogBusy = false,
                catalogSignedIn = if (err.message?.contains("sign in", ignoreCase = true) == true) false else s.catalogSignedIn,
                catalogTab = (s.catalogTab ?: CatalogTabState()).copy(status = err.message ?: fallback, statusError = true),
            )
        }
    }

    private inline fun updateCatalogTab(crossinline f: (CatalogTabState) -> CatalogTabState) {
        _uiState.update { s -> s.catalogTab?.let { s.copy(catalogTab = f(it)) } ?: s }
    }

    /** Returns false (and shows why) when the client_id is not usable. */
    fun saveLogitechClientId(value: String): Boolean {
        val clean = try {
            normalizeClientId(value)
        } catch (e: CatalogError) {
            showMessage(e.message ?: "Invalid client_id", isError = true)
            return false
        }
        prefs.logitechClientId = clean
        _uiState.update { it.copy(logitechClientId = clean) }
        showMessage(
            if (clean.isEmpty()) "Reset to built-in OAuth client_id."
            else "Saved custom OAuth client_id."
        )
        return true
    }

    fun setNotificationRemoteEnabled(enabled: Boolean) {
        prefs.notificationRemoteEnabled = enabled
        _uiState.update { it.copy(notificationRemoteEnabled = enabled) }
    }

    fun dismissNotificationPrompt() {
        prefs.notificationPromptHandled = true
        _uiState.update { it.copy(notificationPromptHandled = true) }
    }

    fun onNotificationPermissionResult(granted: Boolean) {
        prefs.notificationPromptHandled = true
        if (granted) prefs.notificationRemoteEnabled = true
        _uiState.update {
            it.copy(
                notificationPromptHandled = true,
                notificationPermissionGranted = granted,
                notificationRemoteEnabled = if (granted) true else it.notificationRemoteEnabled,
            )
        }
        if (granted) showMessage("Lock-screen controls will appear when you leave the app")
    }

    /** Lock-screen / shade controls for whatever is running, shown only while the app is not in front. */
    private fun postNotificationRemote() {
        val state = _uiState.value
        val activity = state.runningActivity ?: return
        if (!state.isConnected) return
        RemoteNotification.post(
            context = getApplication(),
            activity = activity,
            subtitle = state.deviceNamesFor(activity).joinToString(" · "),
            keys = state.keyMap(RemoteTarget.Activity(activity.id)),
        )
    }

    // ========================================================================
    // Update notices: GitHub's release list, once a day after the user says yes
    // ========================================================================

    private fun newerThanThisApp(release: LatestRelease?): LatestRelease? {
        val latest = ReleaseVersion.parse(release?.version) ?: return null
        val mine = ReleaseVersion.parse(appVersion) ?: return null
        return release.takeIf { latest > mine }
    }

    fun setUpdateChecks(enabled: Boolean) {
        prefs.updateChecks = enabled
        _uiState.update { it.copy(updateChecks = enabled) }
        if (enabled) checkForUpdatesIfDue()
    }

    private fun checkForUpdatesIfDue() {
        if (prefs.updateChecks != true) return
        if (System.currentTimeMillis() - prefs.updateLastChecked < GitHubReleases.CHECK_INTERVAL_MS) return
        checkForUpdates(manual = false)
    }

    /** Scheduled checks speak only about versions not yet dismissed; a manual check always answers. */
    fun checkForUpdates(manual: Boolean = true) {
        if (_uiState.value.updateChecking) return
        _uiState.update { it.copy(updateChecking = true) }
        viewModelScope.launch {
            val etag = prefs.updateEtag.takeIf { prefs.updateLastChecked > 0 }
            val result = releaseClient.fetch(etag, "Melodious/$appVersion (Android)")
            when (result) {
                is ReleaseFetch.Fresh -> {
                    prefs.updateLatestApp = GitHubReleases.latestAndroid(result.releases, allowUpdateUrl)
                    prefs.updateLatestHub = GitHubReleases.latestHub(result.releases, allowUpdateUrl)
                    prefs.updateEtag = result.etag
                    prefs.updateLastChecked = System.currentTimeMillis()
                }
                ReleaseFetch.NotModified -> prefs.updateLastChecked = System.currentTimeMillis()
                is ReleaseFetch.RateLimited ->
                    if (manual) showMessage("GitHub is limiting requests from this network. Try again later.", isError = true)
                is ReleaseFetch.Failed -> if (manual) showMessage(result.message, isError = true)
            }
            _uiState.value.activeEndpoint?.let { refreshHubSoftware(it).join() }
            val latestApp = newerThanThisApp(prefs.updateLatestApp)
            val latestHub = prefs.updateLatestHub
            _uiState.update {
                it.copy(
                    updateChecking = false,
                    updateLastChecked = prefs.updateLastChecked,
                    latestApp = latestApp,
                    latestHub = latestHub,
                )
            }
            val state = _uiState.value
            val prompt = when {
                latestApp != null && (manual || latestApp.version != prefs.updateDismissed) -> UpdatePrompt(
                    title = "Melodious ${latestApp.version} is available",
                    text = "You have $appVersion. Install downloads it from GitHub, checks it, and updates this app; your settings stay." +
                        state.hubUpdateNote.takeIf { it.isNotEmpty() }?.let { "\n\n$it" }.orEmpty(),
                    url = latestApp.url,
                    version = latestApp.version,
                    forHub = false,
                )
                latestHub != null && state.hubUpdateNote.isNotEmpty() &&
                    (manual || latestHub.version != prefs.updateDismissedHub) -> UpdatePrompt(
                    title = "Hub software ${latestHub.version} is available",
                    text = state.hubUpdateNote,
                    url = latestHub.url,
                    version = latestHub.version,
                    forHub = true,
                )
                else -> null
            }
            _uiState.update { it.copy(updatePrompt = prompt) }
            if (manual && prompt == null && (result is ReleaseFetch.Fresh || result == ReleaseFetch.NotModified)) {
                showMessage("Melodious is up to date.")
            }
        }
    }

    /** "Later" (or opening the release page): scheduled checks stop mentioning this version. */
    fun dismissUpdatePrompt() {
        val prompt = _uiState.value.updatePrompt ?: return
        if (prompt.forHub) prefs.updateDismissedHub = prompt.version else prefs.updateDismissed = prompt.version
        _uiState.update { it.copy(updatePrompt = null) }
    }

    /**
     * Download the newer APK from the GitHub release, check it against the release's SHA256SUMS and
     * this app's signing key, then let Android install it over this app.
     */
    fun installAppUpdate() {
        val release = _uiState.value.latestApp ?: return
        if (appUpdateJob?.isActive == true) return
        val app = getApplication<Application>()
        if (!AppUpdater.canInstall(app)) {
            _uiState.update { it.copy(updatePrompt = null, installPermissionNeeded = true) }
            return
        }
        _uiState.update {
            it.copy(updatePrompt = null, installPermissionNeeded = false, appUpdateProgress = AppUpdateProgress(AppUpdateStage.DOWNLOADING))
        }
        appUpdateJob = viewModelScope.launch {
            try {
                val dir = java.io.File(app.cacheDir, "updates").apply { deleteRecursively() }
                var lastPercent = -1L
                val apk = releaseDownloader.fetchVerified(release, "melodious-${release.version}.apk", dir) { done, total ->
                    val percent = if (total > 0) done * 100 / total else -1
                    if (percent != lastPercent) {
                        lastPercent = percent
                        _uiState.update { it.copy(appUpdateProgress = AppUpdateProgress(AppUpdateStage.DOWNLOADING, done, total)) }
                    }
                }
                _uiState.update { it.copy(appUpdateProgress = AppUpdateProgress(AppUpdateStage.CHECKING)) }
                AppUpdater.check(app, apk)?.let { reason -> throw IllegalStateException(reason) }
                _uiState.update { it.copy(appUpdateProgress = AppUpdateProgress(AppUpdateStage.INSTALLING)) }
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { AppUpdater.install(app, apk) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                _uiState.update { it.copy(appUpdateProgress = null) }
                throw e
            } catch (e: Exception) {
                _uiState.update { it.copy(appUpdateProgress = null) }
                showMessage(e.message ?: "The update didn't install.", isError = true)
            }
        }
    }

    fun cancelAppUpdate() {
        if (_uiState.value.appUpdateProgress?.stage != AppUpdateStage.DOWNLOADING) return
        appUpdateJob?.cancel()
        _uiState.update { it.copy(appUpdateProgress = null) }
    }

    fun dismissInstallPermission() {
        _uiState.update { it.copy(installPermissionNeeded = false) }
    }

    /** "Update hub": ask for the SSH key once, then confirm. */
    fun startHubUpdate() {
        val state = _uiState.value
        val release = state.latestHub ?: return
        if (state.hubUpdateStep != null || state.activeEndpoint == null) return
        _uiState.update {
            if (hubKeyStore.load() == null) it.copy(updatePrompt = null, hubKeyNeeded = true)
            else it.copy(updatePrompt = null, hubUpdateConfirm = release)
        }
    }

    /** The installer's private key (harmony_owner_…), pasted or read from a file; kept encrypted. */
    fun saveHubKey(privateKeyPem: String): Boolean {
        val pem = privateKeyPem.trim()
        if (!pem.startsWith("-----BEGIN") || !pem.contains("PRIVATE KEY")) {
            showMessage("That isn't a private key. Use the harmony_owner_… file, not the .pub one.", isError = true)
            return false
        }
        if (!hubKeyStore.save("$pem\n")) {
            showMessage("This phone couldn't store the key securely, so it wasn't saved.", isError = true)
            return false
        }
        _uiState.update { it.copy(hubKeyNeeded = false, hubKeySaved = true, hubUpdateConfirm = it.latestHub) }
        return true
    }

    fun forgetHubKey() {
        hubKeyStore.clear()
        _uiState.update { it.copy(hubKeySaved = false) }
    }

    fun cancelHubUpdate() {
        _uiState.update { it.copy(hubKeyNeeded = false, hubUpdateConfirm = null) }
    }

    fun confirmHubUpdate() {
        val release = _uiState.value.hubUpdateConfirm ?: return
        val endpoint = _uiState.value.activeEndpoint ?: return
        val key = hubKeyStore.load() ?: run {
            _uiState.update { it.copy(hubUpdateConfirm = null, hubKeyNeeded = true) }
            return
        }
        _uiState.update { it.copy(hubUpdateConfirm = null, hubUpdateStep = "Starting…") }
        viewModelScope.launch {
            val app = getApplication<Application>()
            val (ok, text) = try {
                val result = hubUpdater.update(
                    release = release,
                    host = endpoint.host,
                    privateKeyPem = key,
                    workDir = java.io.File(app.cacheDir, "hub-update").apply { deleteRecursively(); mkdirs() },
                    sshPort = hubSshPort,
                    onStep = { step -> _uiState.update { it.copy(hubUpdateStep = step) } },
                    versionProbe = { restClient.getHubSoftware(endpoint) },
                )
                result.ok to result.message
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                false to (e.message ?: "The hub wasn't updated.")
            }
            _uiState.update { it.copy(hubUpdateStep = null, hubUpdateOutcome = text, hubUpdateOk = ok) }
            refreshHubSoftware(endpoint)
        }
    }

    fun dismissHubUpdateOutcome() {
        _uiState.update { it.copy(hubUpdateOutcome = null) }
    }

    private fun refreshHubSoftware(endpoint: HubEndpoint) = viewModelScope.launch {
        val software = restClient.getHubSoftware(endpoint) ?: return@launch
        _uiState.update { it.copy(hubSoftware = software) }
    }

    fun consumeMessage(id: Long) {
        _uiState.update { if (it.message?.id == id) it.copy(message = null) else it }
    }

    fun showHint(text: String) = showMessage(text)

    private fun showMessage(text: String, isError: Boolean = false) {
        _uiState.update { it.copy(message = UiMessage(ids.incrementAndGet(), text, isError)) }
    }

    // ========================================================================
    // Remote keys
    // ========================================================================

    fun pressKey(target: RemoteTarget, buttonKey: String, longPress: Boolean = false) {
        val resolved = _uiState.value.keyMap(target)[buttonKey] ?: return
        val activityId = (target as? RemoteTarget.Activity)?.id
        if (longPress && resolved.hasHold) {
            dispatchCommand(
                deviceId = resolved.holdDeviceId!!,
                deviceName = resolved.holdDeviceName ?: resolved.pressDeviceName,
                commandName = resolved.holdCommand!!,
                functionId = resolved.holdFunctionId,
                activityId = activityId,
            )
        } else {
            dispatchCommand(
                deviceId = resolved.pressDeviceId,
                deviceName = resolved.pressDeviceName,
                commandName = resolved.pressCommand,
                functionId = resolved.pressFunctionId,
                activityId = activityId,
            )
        }
    }

    /**
     * Finger is still down on a repeatable key (volume, channel, D-pad). Uses the hub's native
     * HBus press-and-hold when the socket is up; otherwise repeats single sends.
     */
    fun startHold(target: RemoteTarget, buttonKey: String) {
        stopHold()
        val resolved = _uiState.value.keyMap(target)[buttonKey] ?: return
        if (_uiState.value.hbusConnected) {
            hbusHold = resolved
            hbusClient.startButtonHold(resolved.pressDeviceId, resolved.pressCommand)
        } else {
            repeatJob = viewModelScope.launch {
                while (isActive) {
                    delay(REPEAT_INTERVAL_MS)
                    pressKey(target, buttonKey)
                }
            }
        }
    }

    fun stopHold() {
        repeatJob?.cancel()
        repeatJob = null
        hbusHold?.let { hbusClient.stopButtonHold(it.pressDeviceId, it.pressCommand) }
        hbusHold = null
    }

    fun powerOffDevice(deviceId: String) {
        val device = _uiState.value.device(deviceId) ?: return
        val cmd = RemoteLayout.matchCommand(device.commands, RemoteLayout.POWER_ALIASES)
        if (cmd == null) {
            showMessage("${device.name} has no power command")
            return
        }
        dispatchCommand(device.id, device.name, cmd.name, cmd.functionId, activityId = null)
    }

    fun setSleepTimer(minutes: Int) = sleepTimerCommand(minutes * 60)

    fun cancelSleepTimer() = sleepTimerCommand(-1)

    /** The hub owns the timer (it keeps running with the app closed); the app only sets and shows it. */
    private fun sleepTimerCommand(seconds: Int) {
        if (!_uiState.value.hbusConnected) {
            showMessage("The sleep timer needs live updates, which are reconnecting. Try again in a moment.", isError = true)
            scheduleHbusReconnect()
            return
        }
        viewModelScope.launch {
            val reply = hbusClient.request(
                "harmony.engine?setsleeptimer",
                JsonObject(mapOf("interval" to JsonPrimitive(seconds))),
            )
            val error = ((reply?.get("data") as? JsonObject)?.get("error") as? JsonObject)?.get("msg")?.jsonPrimitive?.content
            when {
                reply == null -> showMessage("Your hub didn't answer. Try again.", isError = true)
                error != null -> showMessage(error.replaceFirstChar { it.uppercase() }, isError = true)
                seconds < 0 -> {
                    _uiState.update { it.copy(sleepTimerEndsAtMillis = null) }
                    showMessage("Sleep timer off")
                }
                else -> {
                    _uiState.update { it.copy(sleepTimerEndsAtMillis = System.currentTimeMillis() + seconds * 1000L) }
                    showMessage("Everything turns off in ${seconds / 60} min")
                }
            }
        }
    }

    /**
     * The hub's own Help: re-sends discrete power and input for every device in the activity,
     * using the hub's tracked device states, so toggle-only devices are handled correctly.
     */
    fun runHubHelp(activityId: String) {
        if (!_uiState.value.hbusConnected) {
            showMessage("Help needs live updates, which are reconnecting. Try again in a moment.", isError = true)
            scheduleHbusReconnect()
            return
        }
        showMessage("Resending power and inputs to every device…")
        viewModelScope.launch {
            val reply = hbusClient.request(
                "harmony.engine?helpdiscretes",
                JsonObject(mapOf("activityId" to JsonPrimitive(activityId))),
                timeoutMs = 30_000,
            )
            val code = reply?.get("code")?.jsonPrimitive?.content
            if (reply != null && code != null && code != "200") {
                showMessage("Help didn't run — ${reply["msg"]?.jsonPrimitive?.content ?: "hub error $code"}", isError = true)
            }
        }
    }

    /** Returns through [onSaved] only after the hub saved DeviceList and reloaded its engine. */
    fun saveDeviceSettings(deviceId: String, settings: DeviceSettings, onSaved: () -> Unit) {
        val state = _uiState.value
        val endpoint = state.activeEndpoint ?: return
        if (state.deviceSettingsSaving) return
        val problems = DeviceSettingsModel.validate(settings, state.deviceCommandNames(deviceId))
        if (problems.isNotEmpty()) {
            showMessage(problems.first(), isError = true)
            return
        }
        val name = state.device(deviceId)?.name ?: "the device"
        _uiState.update { it.copy(deviceSettingsSaving = true) }
        viewModelScope.launch {
            runCatching {
                restClient.saveDeviceSettings(endpoint, deviceId, settings)
                reloadConfig(endpoint)
            }.onSuccess {
                _uiState.update { it.copy(deviceSettingsSaving = false) }
                showMessage("Saved settings for $name")
                onSaved()
            }.onFailure { err ->
                _uiState.update { it.copy(deviceSettingsSaving = false) }
                val notSupported = (err as? app.melodious.protocol.rest.HubApiException)?.statusCode == 404
                showMessage(
                    if (notSupported) "Your hub's firmware doesn't support device settings yet. Update the hub and try again."
                    else "Hub didn't save the settings — ${friendlyError(err)}",
                    isError = true,
                )
            }
        }
    }

    /**
     * Makes, rebuilds or removes a device's Harmony Touch screen. The hub builds it from the
     * device's commands; the Touch pulls the change by itself.
     */
    fun saveDeviceScreen(deviceId: String, remove: Boolean) {
        val state = _uiState.value
        val endpoint = state.activeEndpoint ?: return
        if (state.deviceScreenSaving) return
        val name = state.device(deviceId)?.name ?: "the device"
        _uiState.update { it.copy(deviceScreenSaving = true) }
        viewModelScope.launch {
            runCatching {
                val result = restClient.saveDeviceScreen(endpoint, deviceId, remove)
                reloadConfig(endpoint)
                result
            }.onSuccess { result ->
                _uiState.update { it.copy(deviceScreenSaving = false) }
                val changed = (result["changed"] as? JsonPrimitive)?.booleanOrNull ?: true
                val keys = (result["hardKeys"] as? JsonArray)?.size ?: 0
                val onScreen = (result["onScreen"] as? JsonPrimitive)?.intOrNull ?: 0
                showMessage(
                    when {
                        !changed && remove -> "$name has no Touch screen"
                        !changed -> "$name's Touch screen is already up to date"
                        remove -> "Removed $name's Touch screen. The Touch picks this up by itself."
                        else -> "$name's Touch screen: $keys hard key${if (keys == 1) "" else "s"}, " +
                            "$onScreen on-screen button${if (onScreen == 1) "" else "s"}. The Touch picks it up by itself."
                    }
                )
            }.onFailure { err ->
                _uiState.update { it.copy(deviceScreenSaving = false) }
                val notSupported = (err as? app.melodious.protocol.rest.HubApiException)?.statusCode == 404
                showMessage(
                    if (notSupported) "Your hub's firmware doesn't build Touch screens yet. Update the hub and try again."
                    else "Hub didn't save the Touch screen — ${friendlyError(err)}",
                    isError = true,
                )
            }
        }
    }

    fun openTouchEditor(activityId: String) {
        val snapshot = _uiState.value.configSnapshot ?: return
        _uiState.update {
            it.copy(touchDraft = TouchScreenGraph.read(snapshot, activityId), touchDraftDirty = false, touchSaving = false)
        }
    }

    fun updateTouchDraft(draft: TouchScreenDraft) {
        _uiState.update { it.copy(touchDraft = draft, touchDraftDirty = true) }
    }

    fun closeTouchEditor() {
        _uiState.update { it.copy(touchDraft = null, touchDraftDirty = false, touchSaving = false) }
    }

    /** Same transactional path as the activity editor: the hub must accept it before the editor closes. */
    fun saveTouchDraft() {
        val state = _uiState.value
        val snapshot = state.configSnapshot ?: return
        val endpoint = state.activeEndpoint ?: return
        val draft = state.touchDraft ?: return
        if (state.touchSaving) return
        val built = runCatching { TouchScreenGraph.build(snapshot, draft) }.getOrElse {
            showMessage(it.message ?: "Couldn't build the on-screen buttons", isError = true)
            return
        }
        _uiState.update { it.copy(touchSaving = true) }
        viewModelScope.launch {
            runCatching {
                restClient.saveActivityGraph(endpoint, snapshot.revision, built, syncRemote = true)
                reloadConfig(endpoint)
            }.onSuccess {
                _uiState.update { it.copy(touchDraft = null, touchDraftDirty = false, touchSaving = false) }
                showMessage("Saved on-screen buttons for ${built.name.ifBlank { "this activity" }}")
            }.onFailure { err ->
                _uiState.update { it.copy(touchSaving = false) }
                showMessage("Hub didn't save the buttons — ${friendlyError(err)}", isError = true)
            }
        }
    }

    fun pressSoftButton(activityId: String, button: SoftButton) {
        if (button.steps.isNotEmpty()) runSteps(button.steps, activityId)
        else dispatchCommand(button.deviceId, button.deviceName, button.command, button.functionId, activityId = activityId)
    }

    private var sequenceJob: Job? = null

    /** Runs a sequence's steps in order; starting another sequence cancels the one in progress. */
    fun runSteps(steps: List<SequenceStep>, activityId: String? = null) {
        sequenceJob?.cancel()
        sequenceJob = viewModelScope.launch {
            for (step in steps) {
                when (step) {
                    is SequenceStep.Delay -> delay((step.seconds * 1000).toLong().coerceIn(0, 60_000))
                    is SequenceStep.Command -> {
                        val device = _uiState.value.device(step.deviceId)
                        dispatchCommand(step.deviceId, device?.name ?: "Device", step.command, step.functionId, activityId)
                        delay(SEQUENCE_MIN_GAP_MS)
                    }
                }
            }
        }
    }

    /** Fix it: re-send one command and confirm it, since the user can't see IR going out. */
    fun sendFix(deviceId: String, command: DeviceCommand) {
        val device = _uiState.value.device(deviceId) ?: return
        dispatchCommand(device.id, device.name, command.name, command.functionId, activityId = null, successMessage = "Sent ${command.name} to ${device.name}")
    }

    /** Fix it › Resend everything: power-on then input for each device, spaced so slow IR receivers keep up. */
    fun sendFixes(fixes: List<Pair<String, DeviceCommand>>) {
        viewModelScope.launch {
            fixes.forEachIndexed { i, (deviceId, command) ->
                if (i > 0) delay(FIX_GAP_MS)
                val device = _uiState.value.device(deviceId) ?: return@forEachIndexed
                dispatchCommand(device.id, device.name, command.name, command.functionId, activityId = null)
            }
            showMessage("Resent power and inputs")
        }
    }

    fun sendDeviceCommand(deviceId: String, commandName: String) {
        val device = _uiState.value.device(deviceId) ?: return
        val cmd = device.commands.firstOrNull { it.name == commandName }
        dispatchCommand(device.id, device.name, commandName, cmd?.functionId ?: 0, activityId = null)
    }

    /** Phone volume rocker. Returns true when the press was consumed. */
    fun handleHardwareVolumeKey(isVolumeUp: Boolean): Boolean {
        val state = _uiState.value
        if (!state.volumeKeysEnabled || !state.isConnected) return false
        val target = visibleRemoteTarget
            ?: state.runningActivity?.let { RemoteTarget.Activity(it.id) }
            ?: return false
        val key = if (isVolumeUp) "VolumeUp" else "VolumeDown"
        if (key !in state.keyMap(target)) return false
        pressKey(target, key)
        return true
    }

    private fun dispatchCommand(
        deviceId: String,
        deviceName: String,
        commandName: String,
        functionId: Int,
        activityId: String?,
        successMessage: String? = null,
    ) {
        val endpoint = _uiState.value.activeEndpoint
        if (endpoint == null || !_uiState.value.isConnected) {
            showMessage("Not connected to your hub", isError = true)
            return
        }
        val entryId = ids.incrementAndGet()
        val entry = SendLogEntry(
            id = entryId,
            timestamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()),
            targetName = deviceName,
            commandName = commandName,
            status = SendStatus.PENDING,
        )
        _uiState.update { it.copy(sendLog = (listOf(entry) + it.sendLog).take(SEND_LOG_LIMIT)) }

        viewModelScope.launch {
            val result = runCatching {
                restClient.irSend(
                    endpoint = endpoint,
                    deviceId = deviceId,
                    command = commandName,
                    functionId = functionId,
                    activityId = activityId,
                )
            }
            _uiState.update { state ->
                state.copy(sendLog = state.sendLog.map {
                    if (it.id != entryId) it else it.copy(
                        status = if (result.isSuccess) SendStatus.OK else SendStatus.FAILED,
                        error = result.exceptionOrNull()?.let(::friendlyError),
                    )
                })
            }
            if (result.isSuccess && successMessage != null) showMessage(successMessage)
            result.onFailure {
                stopHold()
                showMessage("Couldn't send $commandName to $deviceName — ${friendlyError(it)}", isError = true)
            }
        }
    }

    // ========================================================================
    // Activities
    // ========================================================================

    fun startActivity(activityId: String) {
        val state = _uiState.value
        val endpoint = state.activeEndpoint
        if (endpoint == null || !state.isConnected) {
            showMessage("Not connected to your hub", isError = true)
            return
        }
        val name = state.activity(activityId)?.name
        _uiState.update { it.copy(pendingActivityId = activityId) }
        viewModelScope.launch {
            runCatching { restClient.runActivity(endpoint, activityId) }
                .onSuccess {
                    // Accepted, not finished: wait for the hub's own state to confirm. If it never
                    // does (missed push, slow devices), stop waiting and show whatever the hub says.
                    delay(PENDING_TIMEOUT_MS)
                    if (_uiState.value.pendingActivityId == activityId) {
                        _uiState.update { it.copy(pendingActivityId = null) }
                        runCatching { restClient.getActivityState(endpoint) }.onSuccess { applyHubState(it, status = null) }
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(pendingActivityId = null) }
                    val what = if (activityId == "-1") "turn everything off" else "start ${name ?: "the activity"}"
                    showMessage("Couldn't $what — ${friendlyError(err)}", isError = true)
                }
        }
    }

    fun powerOff() = startActivity("-1")

    fun openNewActivityWizard() {
        val devices = _uiState.value.devices
        val defaultRoles = buildList {
            devices.firstOrNull { it.type.contains("Television", ignoreCase = true) }?.let {
                add(WizardRoleDraft("DisplayActivityRole", it.id, it.inputs.firstOrNull()))
            }
            devices.firstOrNull { it.type.contains("Amplifier", ignoreCase = true) }?.let {
                add(WizardRoleDraft("VolumeActivityRole", it.id, it.inputs.firstOrNull()))
            }
        }
        _uiState.update {
            it.copy(
                wizardOpen = true,
                wizardStep = 0,
                wizardSaving = false,
                wizardDraft = ActivityWizardDraft(
                    editActivityId = null,
                    name = "",
                    type = 1,
                    roles = defaultRoles,
                    buttons = ActivityGraphBuilder.deriveDefaultButtons(defaultRoles, devices),
                ),
            )
        }
    }

    fun openEditActivityWizard(activity: HubActivity, initialStep: Int = 0) {
        val snapshot = _uiState.value.configSnapshot ?: return
        val existing = ActivityGraphBuilder.resolveActivityButtons(snapshot, activity.id)
            .mapValues { (_, r) ->
                WizardButtonMapping(
                    deviceId = r.pressDeviceId,
                    commandName = r.pressCommand,
                    functionId = r.pressFunctionId,
                    holdDeviceId = r.holdDeviceId,
                    holdCommandName = r.holdCommand,
                    holdFunctionId = r.holdFunctionId,
                    doublePressDeviceId = r.doublePressDeviceId,
                    doublePressCommandName = r.doublePressCommand,
                    doublePressFunctionId = r.doublePressFunctionId,
                    source = ButtonMappingSource.EXISTING,
                )
            }
        val roles = activity.roles.map {
            WizardRoleDraft(
                roleType = it.roleType,
                deviceId = it.deviceId,
                input = it.selectedInput,
                powerDelay = it.nextDevicePowerOnDelay,
            )
        }
        // Carry the hub's current orders and start/end steps into the draft, so saving an
        // unrelated change never reorders devices or drops steps.
        val rawActivity = (snapshot.activityList["Activities"] as? kotlinx.serialization.json.JsonArray).orEmpty()
            .mapNotNull { it as? JsonObject }
            .firstOrNull { it["Id-"]?.jsonPrimitive?.content == activity.id }
        _uiState.update {
            it.copy(
                wizardOpen = true,
                wizardStep = initialStep.coerceIn(0, WIZARD_LAST_STEP),
                wizardSaving = false,
                wizardDraft = ActivityWizardDraft(
                    editActivityId = activity.id,
                    name = activity.name,
                    type = activity.type,
                    roles = roles,
                    // P06 #7: existing activities keep unmapped keys unmapped until Reset.
                    buttons = ActivityGraphBuilder.reconcileWizardButtons(existing, roles, snapshot.devices, fillDefaults = false),
                    powerOnOrder = activity.roles.sortedBy { r -> r.powerOnOrder }.map { r -> r.deviceId }.distinct(),
                    powerOffOrder = activity.roles.sortedBy { r -> r.powerOffOrder }.map { r -> r.deviceId }.distinct(),
                    enterSteps = ActivityGraphBuilder.parseActivityActions(rawActivity?.get("EnterActions")),
                    leaveSteps = ActivityGraphBuilder.parseActivityActions(rawActivity?.get("LeaveActions")),
                ),
            )
        }
    }

    fun closeActivityWizard() {
        _uiState.update { it.copy(wizardOpen = false, wizardSaving = false) }
    }

    fun setWizardStep(step: Int) {
        _uiState.update { it.copy(wizardStep = step.coerceIn(0, WIZARD_LAST_STEP)) }
    }

    fun updateWizardNameAndType(name: String, type: Int) {
        _uiState.update { it.copy(wizardDraft = it.wizardDraft.copy(name = name, type = type)) }
    }

    fun updateWizardPowerOrder(onOrder: List<String>, offOrder: List<String>) {
        _uiState.update { it.copy(wizardDraft = it.wizardDraft.copy(powerOnOrder = onOrder, powerOffOrder = offOrder)) }
    }

    /** Wait after a device turns on before the next one (NextDevicePowerOnDelay, ms). */
    fun updateWizardPowerDelay(deviceId: String, delayMs: Int?) {
        _uiState.update { s ->
            s.copy(wizardDraft = s.wizardDraft.copy(roles = s.wizardDraft.roles.map { if (it.deviceId == deviceId) it.copy(powerDelay = delayMs) else it }))
        }
    }

    fun updateWizardSteps(enter: List<SequenceStep>?, leave: List<SequenceStep>?) {
        _uiState.update { it.copy(wizardDraft = it.wizardDraft.copy(enterSteps = enter, leaveSteps = leave)) }
    }

    fun updateWizardRoles(newRoles: List<WizardRoleDraft>) {
        _uiState.update { state ->
            val isNew = state.wizardDraft.editActivityId.isNullOrBlank()
            state.copy(
                wizardDraft = state.wizardDraft.copy(
                    roles = newRoles,
                    buttons = ActivityGraphBuilder.reconcileWizardButtons(
                        buttons = state.wizardDraft.buttons,
                        roles = newRoles,
                        devices = state.devices,
                        fillDefaults = isNew,
                    ),
                )
            )
        }
    }

    fun updateWizardButtonMapping(buttonKey: String, mapping: WizardButtonMapping?) {
        _uiState.update { state ->
            val updated = state.wizardDraft.buttons.toMutableMap()
            if (mapping == null) updated.remove(buttonKey)
            else updated[buttonKey] = mapping.copy(source = ButtonMappingSource.USER)
            state.copy(wizardDraft = state.wizardDraft.copy(buttons = updated))
        }
    }

    fun resetWizardButtonsToDefaults() {
        _uiState.update { state ->
            // Keep EXISTING mappings (P06 #7); refresh defaults for the rest.
            val kept = state.wizardDraft.buttons.filterValues { it.source == ButtonMappingSource.EXISTING }
            state.copy(
                wizardDraft = state.wizardDraft.copy(
                    buttons = ActivityGraphBuilder.reconcileWizardButtons(
                        buttons = kept,
                        roles = state.wizardDraft.roles,
                        devices = state.devices,
                        fillDefaults = true,
                    )
                )
            )
        }
    }

    /** Saves to the hub first; the editor only closes once the hub has accepted the change. */
    fun saveWizardActivity() {
        val state = _uiState.value
        val snapshot = state.configSnapshot ?: return
        val endpoint = state.activeEndpoint ?: return
        if (state.wizardSaving) return
        val built = ActivityGraphBuilder.buildActivityGraph(snapshot, state.wizardDraft)
        _uiState.update { it.copy(wizardSaving = true) }
        viewModelScope.launch {
            runCatching {
                restClient.saveActivityGraph(endpoint, snapshot.revision, built, syncRemote = true)
                reloadConfig(endpoint)
            }.onSuccess {
                _uiState.update { it.copy(wizardOpen = false, wizardSaving = false) }
                showMessage("Saved “${built.name}”")
            }.onFailure { err ->
                _uiState.update { it.copy(wizardSaving = false) }
                showMessage("Hub didn't save the activity — ${friendlyError(err)}", isError = true)
            }
        }
    }

    fun deleteActivity(activityId: String) {
        val state = _uiState.value
        val snapshot = state.configSnapshot ?: return
        val endpoint = state.activeEndpoint ?: return
        if (activityId == state.currentActivityId) {
            showMessage("Turn the activity off before deleting it", isError = true)
            return
        }
        val name = state.activity(activityId)?.name ?: "activity"
        val built = ActivityGraphBuilder.buildDeleteActivityGraph(snapshot, activityId)
        viewModelScope.launch {
            runCatching {
                restClient.saveActivityGraph(endpoint, snapshot.revision, built, syncRemote = true)
                reloadConfig(endpoint)
            }.onSuccess {
                showMessage("Deleted $name")
            }.onFailure { err ->
                showMessage("Couldn't delete $name — ${friendlyError(err)}", isError = true)
            }
        }
    }

    // ========================================================================
    // IR tools
    // ========================================================================

    fun captureIrFromRemote(timeoutSeconds: Int = 8) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        _uiState.update { it.copy(irCapturing = true, lastIrCapture = null) }
        viewModelScope.launch {
            runCatching { restClient.captureIrSignal(endpoint, timeoutSeconds) }
                .onSuccess { analysis ->
                    _uiState.update { it.copy(irCapturing = false, lastIrCapture = analysis) }
                    if (analysis.empty) showMessage("Didn't hear anything. Point the remote at the hub and try again.")
                }
                .onFailure { err ->
                    _uiState.update { it.copy(irCapturing = false) }
                    showMessage("Learning failed — ${friendlyError(err)}", isError = true)
                }
        }
    }

    fun clearIrCapture() {
        _uiState.update { it.copy(lastIrCapture = null) }
    }

    fun testLearnedCommand(deviceId: String, name: String) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        val cap = _uiState.value.lastIrCapture ?: return
        viewModelScope.launch {
            runCatching {
                restClient.testLearnedIr(
                    endpoint, deviceId, name.ifBlank { "Test" }, cap.mode,
                    raw = cap.raw, keycode = cap.keycode, nec = cap.nec, protocol = cap.protocolId.toString(),
                )
            }.onSuccess { showMessage("Test signal sent") }
                .onFailure { showMessage("Test failed — ${friendlyError(it)}", isError = true) }
        }
    }

    fun saveLearnedCommand(deviceId: String, name: String) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        val cap = _uiState.value.lastIrCapture ?: return
        val cleanName = name.trim()
        if (cleanName.isEmpty()) return
        _uiState.update { it.copy(irBusy = true) }
        viewModelScope.launch {
            runCatching {
                restClient.saveIrCommand(
                    endpoint, deviceId, cleanName, cap.mode,
                    raw = cap.raw, keycode = cap.keycode, nec = cap.nec, protocol = cap.protocolId.toString(),
                )
                reloadConfig(endpoint)
            }.onSuccess {
                _uiState.update { it.copy(irBusy = false, lastIrCapture = null) }
                showMessage("Saved “$cleanName”")
            }.onFailure { err ->
                _uiState.update { it.copy(irBusy = false) }
                showMessage("Couldn't save — ${friendlyError(err)}", isError = true)
            }
        }
    }

    /** Returns false (and shows why) when the text has no importable rows. */
    fun importIrPayload(deviceId: String, rawText: String): Boolean {
        val endpoint = _uiState.value.activeEndpoint ?: return false
        var payload = rawText
        var rows = IrProtocolTools.parseIrdbLines(rawText).rows.size
        if (rows == 0) {
            val prontoRaw = IrProtocolTools.prontoToHubRaw(rawText)
            if (prontoRaw.isNotEmpty()) {
                payload = "ProntoImported|raw|$prontoRaw"
                rows = 1
            }
        }
        if (rows == 0) {
            showMessage("No codes found. Paste IRDB CSV, name|mode|code lines, or Pronto hex.", isError = true)
            return false
        }
        _uiState.update { it.copy(irBusy = true) }
        viewModelScope.launch {
            runCatching {
                restClient.importIrdbCommands(endpoint, deviceId, payload)
                reloadConfig(endpoint)
            }.onSuccess {
                _uiState.update { it.copy(irBusy = false) }
                showMessage("Imported $rows command${if (rows == 1) "" else "s"}")
            }.onFailure { err ->
                _uiState.update { it.copy(irBusy = false) }
                showMessage("Import failed — ${friendlyError(err)}", isError = true)
            }
        }
        return true
    }

    fun runBatchSweep(deviceId: String, commands: List<String>, delayMs: Int = 120) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        val runId = IrProtocolTools.makeRunId("android_sweep")
        _uiState.update {
            it.copy(activeBatchRunId = runId, batchSweepStatus = "Sending ${commands.size} commands…")
        }
        viewModelScope.launch {
            runCatching { restClient.irBatchSend(endpoint, deviceId, commands, delayMs, dryRun = false, runId = runId) }
                .onSuccess {
                    _uiState.update {
                        it.copy(activeBatchRunId = null, batchSweepStatus = "Finished sending ${commands.size} commands.")
                    }
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(
                            activeBatchRunId = null,
                            batchSweepStatus = if (it.activeBatchRunId == null) it.batchSweepStatus
                            else "Stopped — ${friendlyError(err)}",
                        )
                    }
                }
        }
    }

    fun cancelBatchSweep() {
        val state = _uiState.value
        val runId = state.activeBatchRunId ?: return
        val endpoint = state.activeEndpoint ?: return
        _uiState.update { it.copy(activeBatchRunId = null, batchSweepStatus = "Cancelled.") }
        viewModelScope.launch { runCatching { restClient.irCancelBatch(endpoint, runId) } }
    }

    // ========================================================================
    // Bluetooth keyboard, hub LED, SSH recovery
    // ========================================================================

    fun sendBluetoothKeyboardText(text: String) {
        if (text.isEmpty()) return
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            runCatching { restClient.sendBtText(endpoint, text) }
                .onFailure { showMessage("Couldn't type text — ${friendlyError(it)}", isError = true) }
        }
    }

    fun sendBluetoothHidKey(keyCode: String) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            runCatching { restClient.btCall(endpoint, action = "report", type = "btkeyboard", code = keyCode) }
                .onFailure { showMessage("Couldn't send key — ${friendlyError(it)}", isError = true) }
        }
    }

    fun triggerBtPairing(profileType: String, displayName: String) {
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            runCatching { restClient.btCall(endpoint, action = "pairing_on", type = profileType, name = displayName) }
                .onSuccess { status ->
                    _uiState.update { it.copy(btAdapterStatus = status) }
                    if (status.error.isNotBlank()) showMessage(status.error, isError = true)
                    else showMessage("Pairing is on. Pick “$displayName” in your TV's Bluetooth settings.")
                }
                .onFailure { showMessage("Couldn't start pairing — ${friendlyError(it)}", isError = true) }
        }
    }

    fun flashLocateHubLed() {
        val endpoint = _uiState.value.activeEndpoint ?: return
        viewModelScope.launch {
            runCatching { restClient.setHubLed(endpoint, "pairing_start") }
                .onSuccess { showMessage("Your hub's light is blinking") }
                .onFailure { showMessage("Couldn't blink the light — ${friendlyError(it)}", isError = true) }
        }
    }

    fun runSshInspectHub(privateKeyPem: String) = runSsh("Inspecting hub…") { host ->
        sshProvisioner.inspectHubOverSsh(host, privateKeyPem)
    }

    fun runSshEmergencyResetAuth(privateKeyPem: String) = runSsh("Clearing sign-in lock…") { host ->
        sshProvisioner.resetWebUiAuthLockout(host, privateKeyPem)
    }

    fun runSshRestartServices(privateKeyPem: String) = runSsh("Restarting hub services…") { host ->
        sshProvisioner.restartBluetoothHelpers(host, privateKeyPem)
    }

    private fun runSsh(progress: String, block: suspend (String) -> Result<String>) {
        val host = (_uiState.value.activeEndpoint ?: prefs.savedEndpoint())?.host ?: run {
            showMessage("Set up a hub first", isError = true)
            return
        }
        if (_uiState.value.sshBusy) return
        _uiState.update { it.copy(sshBusy = true, sshConsoleOutput = progress) }
        viewModelScope.launch {
            val res = block(host)
            _uiState.update {
                it.copy(
                    sshBusy = false,
                    sshConsoleOutput = res.getOrElse { err -> "SSH error: ${err.message}" },
                )
            }
        }
    }

    override fun onCleared() {
        stopHold()
        hbusClient.disconnect()
        super.onCleared()
    }

    companion object {
        const val WIZARD_LAST_STEP = 4
        private const val REPEAT_INTERVAL_MS = 160L
        private const val SEND_LOG_LIMIT = 60
        private const val FIX_GAP_MS = 600L
        /** Gap after each command even without an explicit wait, so back-to-back IR isn't merged. */
        private const val SEQUENCE_MIN_GAP_MS = 250L
        private const val PENDING_TIMEOUT_MS = 90_000L
        const val STATUS_OFF = 0
        const val STATUS_STARTING = 1
        const val STATUS_RUNNING = 2
        const val STATUS_STOPPING = 3

        private fun savedRemoteMode(prefs: HubPrefs): RemoteMode =
            runCatching { RemoteMode.valueOf(prefs.remoteMode) }.getOrDefault(RemoteMode.BUTTONS)
                .takeUnless { it == RemoteMode.KEYBOARD } ?: RemoteMode.BUTTONS
        private const val HBUS_MIN_BACKOFF_MS = 3_000L
        private const val HBUS_MAX_BACKOFF_MS = 60_000L

        fun friendlyError(err: Throwable): String {
            val msg = err.message.orEmpty()
            return when {
                err is java.net.SocketTimeoutException -> "the hub didn't answer in time"
                err is java.net.ConnectException || msg.contains("ECONNREFUSED") -> "the hub refused the connection"
                err is java.net.UnknownHostException || err is java.net.NoRouteToHostException ->
                    "the hub isn't reachable on this network"
                msg.contains("401") || msg.contains("Unauthorized", ignoreCase = true) -> "the hub needs a sign-in"
                msg.isBlank() -> err::class.java.simpleName
                else -> msg
            }
        }
    }
}
