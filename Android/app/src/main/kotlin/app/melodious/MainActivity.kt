package app.melodious

import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SettingsRemote
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SettingsRemote
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import app.melodious.system.AuthTabSignIn
import app.melodious.system.PowerOffTileService
import app.melodious.ui.activities.ActivitiesTab
import app.melodious.ui.activities.ActivityEditor
import app.melodious.ui.devices.DeviceDetailScreen
import app.melodious.ui.devices.DevicesTab
import app.melodious.ui.remote.RemoteTab
import app.melodious.ui.settings.AdvancedScreen
import app.melodious.ui.settings.BluetoothScreen
import app.melodious.ui.settings.ConnectGate
import app.melodious.ui.settings.HubSettingsScreen
import app.melodious.ui.settings.SettingsTab
import app.melodious.ui.theme.MelodiousColors
import app.melodious.ui.theme.MelodiousTheme

private enum class AppTab(val label: String, val icon: ImageVector, val selectedIcon: ImageVector) {
    REMOTE("Remote", Icons.Outlined.SettingsRemote, Icons.Filled.SettingsRemote),
    ACTIVITIES("Activities", Icons.Outlined.PlayArrow, Icons.Filled.PlayArrow),
    DEVICES("Devices", Icons.Outlined.Tv, Icons.Filled.Tv),
    SETTINGS("Settings", Icons.Outlined.Settings, Icons.Filled.Settings),
}

/** Secondary full-screen pages pushed over the tabs. */
private sealed interface Page {
    data class Device(val id: String) : Page
    data class DeviceSettings(val id: String) : Page
    data object Hub : Page
    data object Bluetooth : Page
    data object Advanced : Page
}

class MainActivity : ComponentActivity() {
    private val viewModel: MelodiousViewModel by viewModels()

    private val authTabLauncher = androidx.browser.auth.AuthTabIntent.registerActivityResultLauncher(this) { result ->
        AuthTabSignIn.onResult(result)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        AuthTabSignIn.bind(applicationContext, authTabLauncher)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(MelodiousColors.Canvas.toArgbInt()),
            navigationBarStyle = SystemBarStyle.dark(MelodiousColors.NavBar.toArgbInt()),
        )
        super.onCreate(savedInstanceState)
        handleDeepLinkIntent(intent)

        setContent {
            MelodiousTheme {
                val state by viewModel.uiState.collectAsState()
                MelodiousApp(state, viewModel, onAddQuickTile = ::requestQuickTile, onAddWidget = ::requestPinWidget)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        viewModel.onAppForeground()
    }

    override fun onStop() {
        viewModel.onAppBackground()
        super.onStop()
    }

    override fun onDestroy() {
        AuthTabSignIn.unbind(authTabLauncher)
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLinkIntent(intent)
    }

    /** Phone volume rocker drives the TV / receiver while the app is in front. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val isUp = keyCode == KeyEvent.KEYCODE_VOLUME_UP
        if ((isUp || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) && viewModel.handleHardwareVolumeKey(isUp)) {
            if (viewModel.uiState.value.hapticsEnabled) {
                window.decorView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun handleDeepLinkIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "melodious" && uri.host == "hub") {
            val segments = uri.pathSegments
            if (segments.firstOrNull() == "poweroff") {
                viewModel.powerOff()
            } else if (segments.size >= 2 && segments[0] == "activity") {
                viewModel.startActivity(segments[1])
            }
        }
    }

    private fun requestPinWidget(onFallback: () -> Unit) {
        val manager = android.appwidget.AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, app.melodious.system.ActivityWidgetProvider::class.java)
        if (manager.isRequestPinAppWidgetSupported) {
            manager.requestPinAppWidget(provider, null, null)
        } else {
            onFallback()
        }
    }

    private fun requestQuickTile(onFallback: () -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val sbm = getSystemService(StatusBarManager::class.java)
            sbm.requestAddTileService(
                ComponentName(this, PowerOffTileService::class.java),
                getString(R.string.quick_tile_label),
                Icon.createWithResource(this, R.drawable.ic_stat_melodious),
                mainExecutor,
            ) { }
        } else {
            onFallback()
        }
    }
}

private fun androidx.compose.ui.graphics.Color.toArgbInt(): Int =
    android.graphics.Color.argb((alpha * 255).toInt(), (red * 255).toInt(), (green * 255).toInt(), (blue * 255).toInt())

@Composable
private fun MelodiousApp(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    onAddQuickTile: (onFallback: () -> Unit) -> Unit,
    onAddWidget: (onFallback: () -> Unit) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(AppTab.REMOTE) }
    val notificationPermission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted -> viewModel.onNotificationPermissionResult(granted) }
    val requestNotifications: () -> Unit = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        } else {
            viewModel.onNotificationPermissionResult(true)
        }
    }
    var page by remember { mutableStateOf<Page?>(null) }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(state.message?.id) {
        val msg = state.message ?: return@LaunchedEffect
        snackbar.currentSnackbarData?.dismiss()
        snackbar.showSnackbar(msg.text, duration = if (msg.isError) SnackbarDuration.Long else SnackbarDuration.Short)
        viewModel.consumeMessage(msg.id)
    }

    // First run or the hub has never answered: nothing useful to show but the connect flow.
    if (state.configSnapshot == null) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            snackbarHost = { AppSnackbarHost(snackbar) },
        ) { pad ->
            Box(Modifier.padding(pad)) { ConnectGate(state, viewModel) }
        }
        return
    }

    if (state.touchDraft != null) {
        app.melodious.ui.activities.TouchScreenEditor(state, viewModel)
        SnackOverlay(snackbar)
        return
    }

    if (state.wizardOpen) {
        ActivityEditor(state, viewModel)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            AppSnackbarHost(snackbar, Modifier.padding(bottom = 96.dp))
        }
        return
    }

    BackHandler(enabled = page != null) { page = null }
    BackHandler(enabled = page == null && tab != AppTab.REMOTE) { tab = AppTab.REMOTE }

    when (val p = page) {
        is Page.Device -> {
            DeviceDetailScreen(state, viewModel, p.id, onBack = { page = null }, onOpenSettings = { page = Page.DeviceSettings(p.id) })
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) { AppSnackbarHost(snackbar) }
            return
        }
        is Page.DeviceSettings -> {
            app.melodious.ui.devices.DeviceSettingsScreen(state, viewModel, p.id, onBack = { page = Page.Device(p.id) })
            SnackOverlay(snackbar)
            return
        }
        Page.Hub -> { HubSettingsScreen(state, viewModel, onBack = { page = null }); SnackOverlay(snackbar); return }
        Page.Bluetooth -> { BluetoothScreen(state, viewModel, onBack = { page = null }); SnackOverlay(snackbar); return }
        Page.Advanced -> { AdvancedScreen(state, viewModel, onBack = { page = null }); SnackOverlay(snackbar); return }
        null -> Unit
    }

    UpdateDialogs(state, viewModel)

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { AppSnackbarHost(snackbar) },
        topBar = {
            ConnectionBanner(state, onRetry = viewModel::retryConnection, onOpenHub = { page = Page.Hub })
        },
        bottomBar = {
            NavigationBar(containerColor = MelodiousColors.NavBar) {
                AppTab.entries.forEach { t ->
                    val selected = t == tab
                    NavigationBarItem(
                        selected = selected,
                        onClick = { tab = t },
                        icon = { Icon(if (selected) t.selectedIcon else t.icon, contentDescription = null) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (tab) {
                AppTab.REMOTE -> RemoteTab(
                    state, viewModel,
                    onSetUpKeyboard = { page = Page.Bluetooth },
                    onRequestNotificationPermission = requestNotifications,
                )
                AppTab.ACTIVITIES -> ActivitiesTab(state, viewModel, onOpenRemote = { tab = AppTab.REMOTE })
                AppTab.DEVICES -> DevicesTab(state, onOpenDevice = { page = Page.Device(it) })
                AppTab.SETTINGS -> SettingsTab(
                    state = state,
                    viewModel = viewModel,
                    onOpenHub = { page = Page.Hub },
                    onOpenBluetooth = { page = Page.Bluetooth },
                    onOpenAdvanced = { page = Page.Advanced },
                    onAddQuickTile = {
                        onAddQuickTile {
                            snackbarFallback(viewModel)
                        }
                    },
                    onAddWidget = { onAddWidget { viewModel.showHint("Long-press your home screen, tap Widgets, then find Melodious.") } },
                    onRequestNotificationPermission = requestNotifications,
                )
            }
        }
    }
}

private fun snackbarFallback(viewModel: MelodiousViewModel) {
    viewModel.showHint("Swipe down twice, tap the pencil, then drag “Melodious: Turn off” into your tiles.")
}

/** Asks once whether to check GitHub for updates, then shows "a newer version is out". */
@Composable
private fun UpdateDialogs(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    if (state.updateChecks == null && state.isConnected) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = {},
            title = { Text("Check for updates?") },
            text = {
                Text(
                    "Melodious can ask GitHub once a day whether a newer version is out. GitHub sees your IP " +
                        "address and this app's version; nothing about your hub or devices is sent. Nothing " +
                        "downloads unless you choose to. You can change this in Settings."
                )
            },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { viewModel.setUpdateChecks(true) }) { Text("Check daily") } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { viewModel.setUpdateChecks(false) }) { Text("Not now") } },
        )
        return
    }
    val context = androidx.compose.ui.platform.LocalContext.current
    state.hubUpdateStep?.let { step ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = {},
            title = { Text("Updating the hub") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(step)
                    androidx.compose.material3.LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    Text(
                        "Keep the hub plugged in. Once the files are on the hub it finishes by itself, even if this phone drops off Wi-Fi.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = {},
        )
        return
    }
    state.hubUpdateOutcome?.let { text ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = viewModel::dismissHubUpdateOutcome,
            title = { Text(if (state.hubUpdateOk) "The hub was updated" else "The hub wasn't updated") },
            text = { Text(text) },
            confirmButton = { androidx.compose.material3.TextButton(onClick = viewModel::dismissHubUpdateOutcome) { Text("OK") } },
        )
        return
    }
    if (state.hubKeyNeeded) {
        HubKeyDialog(viewModel)
        return
    }
    state.hubUpdateConfirm?.let { release ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = viewModel::cancelHubUpdate,
            title = { Text("Update the hub to Melodious ${release.version}?") },
            text = {
                Text(
                    "Melodious downloads the hub software from GitHub, checks it, and installs it on " +
                        "${state.activeEndpoint?.host ?: "the hub"} over SSH with your hub key, the way the installer does. " +
                        "Remotes and activities pause for about a minute while the hub restarts. If anything goes wrong, " +
                        "the hub keeps its current software. Keep the hub plugged in."
                )
            },
            confirmButton = { androidx.compose.material3.TextButton(onClick = viewModel::confirmHubUpdate) { Text("Update hub") } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = viewModel::cancelHubUpdate) { Text("Cancel") } },
        )
        return
    }
    state.appUpdateProgress?.let { progress ->
        val percent = if (progress.total > 0) (progress.done * 100 / progress.total).toInt() else -1
        androidx.compose.material3.AlertDialog(
            onDismissRequest = {},
            title = { Text("Updating Melodious") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        when (progress.stage) {
                            AppUpdateStage.DOWNLOADING -> if (percent >= 0) "Downloading from GitHub… $percent%" else "Downloading from GitHub…"
                            AppUpdateStage.CHECKING -> "Checking the download…"
                            AppUpdateStage.INSTALLING -> "Installing. Melodious restarts when it's done."
                        }
                    )
                    if (progress.stage == AppUpdateStage.DOWNLOADING && percent >= 0) {
                        androidx.compose.material3.LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
                    } else {
                        androidx.compose.material3.LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = {},
            dismissButton = if (progress.stage == AppUpdateStage.DOWNLOADING) {
                { androidx.compose.material3.TextButton(onClick = viewModel::cancelAppUpdate) { Text("Cancel") } }
            } else null,
        )
        return
    }
    if (state.installPermissionNeeded) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = viewModel::dismissInstallPermission,
            title = { Text("Allow Melodious to install updates") },
            text = {
                Text(
                    "Android asks once. Turn on \u201cAllow from this source\u201d for Melodious, then come back: " +
                        "the update carries on by itself."
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    context.startActivity(app.melodious.system.AppUpdater.unknownSourcesIntent(context))
                }) { Text("Open settings") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = viewModel::dismissInstallPermission) { Text("Cancel") } },
        )
        return
    }
    val prompt = state.updatePrompt ?: return
    androidx.compose.material3.AlertDialog(
        onDismissRequest = viewModel::dismissUpdatePrompt,
        title = { Text(prompt.title) },
        text = { Text(prompt.text) },
        confirmButton = {
            if (prompt.forHub) {
                androidx.compose.material3.TextButton(onClick = {
                    viewModel.dismissUpdatePrompt()
                    viewModel.startHubUpdate()
                }) { Text("Update hub") }
            } else {
                androidx.compose.material3.TextButton(onClick = viewModel::installAppUpdate) { Text("Install") }
            }
        },
        dismissButton = { androidx.compose.material3.TextButton(onClick = viewModel::dismissUpdatePrompt) { Text("Later") } },
    )
}

/** Asks once for the installer's SSH key (harmony_owner_…): paste it or pick the file. */
@Composable
private fun HubKeyDialog(viewModel: MelodiousViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var text by remember { mutableStateOf("") }
    val pick = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes().take(16384).toByteArray().toString(Charsets.UTF_8) }
            }.getOrNull()?.let { if (!viewModel.saveHubKey(it)) text = "" }
        }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = viewModel::cancelHubUpdate,
        title = { Text("Your hub's SSH key") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Updating the hub uses the installer's SSH key: the harmony_owner_… file (not the .pub) made when " +
                        "the hub was rooted. Pick the file or paste it. It stays on this phone, encrypted."
                )
                androidx.compose.material3.OutlinedButton(onClick = { pick.launch(arrayOf("*/*")) }) { Text("Choose file") }
                androidx.compose.material3.OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Or paste the key") },
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = { viewModel.saveHubKey(text) }, enabled = text.isNotBlank()) { Text("Save key") }
        },
        dismissButton = { androidx.compose.material3.TextButton(onClick = viewModel::cancelHubUpdate) { Text("Cancel") } },
    )
}

@Composable
private fun SnackOverlay(snackbar: SnackbarHostState) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) { AppSnackbarHost(snackbar) }
}

@Composable
private fun AppSnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(state, modifier) { data ->
        Snackbar(
            snackbarData = data,
            shape = MaterialTheme.shapes.medium,
            containerColor = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        )
    }
}

/** Slim banner shown only when a previously working hub stops answering. */
@Composable
private fun ConnectionBanner(state: MelodiousUiState, onRetry: () -> Unit, onOpenHub: () -> Unit) {
    val lost = state.connection == HubConnection.UNREACHABLE || state.connection == HubConnection.NOT_FOUND
    val reconnecting = state.connection == HubConnection.CONNECTING || state.connection == HubConnection.SEARCHING
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(top = statusBarTopPadding())) {
        AnimatedVisibility(visible = lost || reconnecting) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(if (lost) MelodiousColors.PowerContainer else MelodiousColors.Card)
                    .clickable(onClick = if (lost) onRetry else onOpenHub)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (reconnecting) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Outlined.WifiOff, contentDescription = null, tint = MelodiousColors.OnPowerContainer, modifier = Modifier.size(18.dp))
                }
                Text(
                    if (reconnecting) "Reconnecting to your hub…" else "Can't reach your hub · tap to retry",
                    fontSize = 14.sp,
                    color = if (lost) MelodiousColors.OnPowerContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun statusBarTopPadding() = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
