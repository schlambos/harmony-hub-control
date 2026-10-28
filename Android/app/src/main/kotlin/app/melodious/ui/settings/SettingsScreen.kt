package app.melodious.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.ui.components.GroupDivider
import app.melodious.ui.components.IconTile
import app.melodious.ui.components.ListGroup
import app.melodious.ui.components.ListRow
import app.melodious.ui.components.ScreenTitle
import app.melodious.ui.components.SectionLabel
import app.melodious.ui.components.SwitchRow
import app.melodious.protocol.update.GitHubReleases
import app.melodious.protocol.update.HubSoftware
import java.text.DateFormat
import java.util.Date

@Composable
fun SettingsTab(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    onOpenHub: () -> Unit,
    onOpenBluetooth: () -> Unit,
    onOpenAdvanced: () -> Unit,
    onAddQuickTile: () -> Unit,
    onAddWidget: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenTitle("Settings")
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            ListGroup {
                val endpoint = state.activeEndpoint
                ListRow(
                    title = "Hub",
                    subtitle = buildString {
                        append(if (state.isConnected) "Connected" else "Not connected")
                        endpoint?.let { append(" · ${it.host}") }
                        if (state.isConnected) append(if (state.hbusConnected) " · live updates on" else " · live updates off")
                    },
                    leading = {
                        IconTile(
                            if (state.isConnected) Icons.Filled.Wifi else Icons.Filled.WifiOff,
                            size = 48,
                            container = if (state.isConnected) Color(0xFF1E3329) else MaterialTheme.colorScheme.surfaceContainerHighest,
                            tint = if (state.isConnected) Color(0xFF8FE0BC) else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    trailing = { OutlinedButton(onClick = onOpenHub) { Text("Change") } },
                    onClick = onOpenHub,
                )
            }

            Column {
                SectionLabel("Logitech account")
                ListGroup {
                    ListRow(
                        title = if (state.catalogSignedIn) "Signed in to Logitech" else "Not signed in",
                        subtitle = if (state.catalogSignedIn)
                            "Your sign-in stays on this phone; the hub never sees it."
                        else
                            "Used only to search and download device codes from Logitech's catalog.",
                        trailing = {
                            if (state.catalogBusy) {
                                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            } else if (state.catalogSignedIn) {
                                OutlinedButton(onClick = viewModel::catalogSignOut) { Text("Sign out") }
                            } else {
                                OutlinedButton(onClick = viewModel::catalogSignIn) { Text("Sign in") }
                            }
                        },
                    )
                }
            }

            UpdatesSection(state, viewModel)

            Column {
                SectionLabel("This phone")
                ListGroup {
                    SwitchRow(
                        title = "Volume buttons control the TV",
                        subtitle = "While the app is open",
                        checked = state.volumeKeysEnabled,
                        onCheckedChange = viewModel::setVolumeKeysEnabled,
                    )
                    GroupDivider()
                    SwitchRow(
                        title = "Vibrate on button press",
                        checked = state.hapticsEnabled,
                        onCheckedChange = viewModel::setHapticsEnabled,
                    )
                    GroupDivider()
                    SwitchRow(
                        title = "Lock-screen controls",
                        subtitle = if (state.notificationPermissionGranted || !state.notificationRemoteEnabled)
                            "Volume, play/pause and turn off in notifications while something's on"
                        else "Needs permission to show notifications",
                        checked = state.notificationRemoteEnabled && state.notificationPermissionGranted,
                        onCheckedChange = { on ->
                            if (on && !state.notificationPermissionGranted) onRequestNotificationPermission()
                            else viewModel.setNotificationRemoteEnabled(on)
                        },
                    )
                    GroupDivider()
                    ListRow(
                        title = "Add home-screen widget",
                        subtitle = "Start an activity or turn everything off with one tap",
                        showChevron = true,
                        onClick = onAddWidget,
                    )
                    GroupDivider()
                    ListRow(
                        title = "Add Quick Settings tile",
                        subtitle = "Turn everything off from the notification shade",
                        showChevron = true,
                        onClick = onAddQuickTile,
                    )
                }
            }

            Column {
                SectionLabel("Hub")
                ListGroup {
                    ListRow(
                        title = "Bluetooth keyboard",
                        subtitle = when {
                            state.btTextHelperStatus.live -> "Connected" + state.btTextHelperStatus.target.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
                            else -> "Not connected · pair with your TV"
                        },
                        showChevron = true,
                        enabled = state.isConnected,
                        onClick = onOpenBluetooth,
                    )
                    GroupDivider()
                    ListRow(
                        title = "Find my hub",
                        subtitle = "Blink the hub's light",
                        enabled = state.isConnected,
                        onClick = viewModel::flashLocateHubLed,
                    )
                    GroupDivider()
                    ListRow(
                        title = "Advanced",
                        subtitle = "Hub status, recent commands, IR sweep, SSH recovery",
                        showChevron = true,
                        onClick = onOpenAdvanced,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun UpdatesSection(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val uriHandler = LocalUriHandler.current
    val open: (String) -> Unit = { url -> if (GitHubReleases.isGitHubUrl(url)) uriHandler.openUri(url) }
    val lastChecked = if (state.updateLastChecked > 0)
        "Last checked " + DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(state.updateLastChecked))
    else "Not checked yet"
    Column {
        SectionLabel("Updates")
        ListGroup {
            val app = state.latestApp
            ListRow(
                title = if (app != null) "Melodious ${app.version} is available" else "Melodious ${state.appVersion}",
                subtitle = if (app != null) "You have ${state.appVersion}. Install downloads it from GitHub and updates this app."
                else lastChecked,
                trailing = if (app != null) {
                    {
                        if (state.appUpdateProgress != null) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else OutlinedButton(onClick = viewModel::installAppUpdate) { Text("Install") }
                    }
                } else null,
            )
            state.hubSoftware?.let { hub ->
                GroupDivider()
                val note = state.hubUpdateNote
                val latestHub = state.latestHub
                ListRow(
                    title = when (hub) {
                        HubSoftware.Legacy -> "Hub: Melodious 1.2 or older"
                        is HubSoftware.Known -> "Hub: Melodious ${hub.version}"
                    },
                    subtitle = (state.hubUpdateStep ?: note).ifEmpty { if (latestHub != null) "Up to date" else "" }.ifEmpty { null },
                    trailing = if (note.isNotEmpty() && latestHub != null) {
                        {
                            if (state.hubUpdateStep != null) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            else OutlinedButton(onClick = viewModel::startHubUpdate, enabled = state.isConnected) { Text("Update") }
                        }
                    } else null,
                )
            }
            if (state.hubKeySaved) {
                GroupDivider()
                ListRow(
                    title = "Hub SSH key",
                    subtitle = "Saved on this phone, encrypted. Used only to update the hub.",
                    trailing = { OutlinedButton(onClick = viewModel::forgetHubKey) { Text("Forget") } },
                )
            }
            GroupDivider()
            SwitchRow(
                title = "Check for updates daily",
                subtitle = "Asks GitHub for Melodious's releases. GitHub sees your IP address and this app's version; nothing about your hub is sent.",
                checked = state.updateChecks == true,
                onCheckedChange = viewModel::setUpdateChecks,
            )
            GroupDivider()
            ListRow(
                title = "Check now",
                trailing = if (state.updateChecking) {
                    { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                } else null,
                enabled = !state.updateChecking,
                onClick = { viewModel.checkForUpdates(manual = true) },
            )
        }
    }
}
