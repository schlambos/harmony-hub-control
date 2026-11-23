package app.melodious.ui.activities

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.SettingsRemote
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.RemoteTarget
import app.melodious.ui.components.ConfirmDialog
import app.melodious.ui.components.ScreenTitle
import app.melodious.ui.components.SectionLabel
import app.melodious.ui.components.StatusDot
import app.melodious.ui.components.ActivityTile
import app.melodious.ui.components.rememberHaptics
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.HubActivity

private const val FEW_BUTTONS = 5

@Composable
fun ActivitiesTab(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    onOpenRemote: () -> Unit,
) {
    val haptics = rememberHaptics(state.hapticsEnabled)
    var pendingDelete by remember { mutableStateOf<HubActivity?>(null) }
    val running = state.runningActivity
    val others = state.activities.filter { it.id != running?.id }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenTitle(
            title = "Activities",
            subtitle = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusDot(if (state.hbusConnected) MelodiousColors.Live else MaterialTheme.colorScheme.outline)
                    Text(
                        if (state.hbusConnected) "Hub · live" else "Hub · connected",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            action = {
                FilledTonalIconButton(onClick = viewModel::openNewActivityWizard, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Filled.Add, contentDescription = "New activity")
                }
            },
        )

        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (running != null) {
                RunningCard(
                    activity = running,
                    devices = state.deviceNamesFor(running).joinToString(" · "),
                    turningOff = state.pendingActivityId == "-1",
                    onOpenRemote = onOpenRemote,
                    onTurnOff = { haptics.longPress(); viewModel.powerOff() },
                    onEdit = { viewModel.openEditActivityWizard(running) },
                )
                if (others.isNotEmpty()) SectionLabel("Start something else", Modifier.padding(top = 12.dp), MaterialTheme.colorScheme.onSurfaceVariant)
            }

            others.forEach { activity ->
                val buttonCount = state.keyMap(RemoteTarget.Activity(activity.id)).size
                ActivityRow(
                    activity = activity,
                    devices = state.deviceNamesFor(activity).joinToString(" · "),
                    buttonCount = buttonCount,
                    starting = state.pendingActivityId == activity.id,
                    onStart = {
                        haptics.tap()
                        viewModel.startActivity(activity.id)
                        onOpenRemote()
                    },
                    onEdit = { viewModel.openEditActivityWizard(activity) },
                    onEditButtons = { viewModel.openEditActivityWizard(activity, initialStep = MelodiousViewModel.WIZARD_LAST_STEP) },
                    onEditScreen = { viewModel.openTouchEditor(activity.id) },
                    onDelete = { pendingDelete = activity },
                )
            }

            if (state.activities.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No activities yet", fontSize = 20.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(8.dp))
                    Text("An activity turns on the right devices and sets up the remote for you.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = viewModel::openNewActivityWizard) { Text("Create an activity") }
                }
            }
        }
    }

    pendingDelete?.let { activity ->
        ConfirmDialog(
            title = "Delete “${activity.name}”?",
            text = "This removes the activity and its button setup from the hub and your universal remote.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = { viewModel.deleteActivity(activity.id) },
            onDismiss = { pendingDelete = null },
        )
    }
}

@Composable
private fun RunningCard(
    activity: HubActivity,
    devices: String,
    turningOff: Boolean,
    onOpenRemote: () -> Unit,
    onTurnOff: () -> Unit,
    onEdit: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .background(MelodiousColors.RunningCard)
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ActivityTile(activity, size = 52, container = MaterialTheme.colorScheme.primaryContainer, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("RUNNING NOW", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp, color = MaterialTheme.colorScheme.primary)
                Text(activity.name, fontSize = 22.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(devices, fontSize = 13.sp, color = androidx.compose.ui.graphics.Color(0xFFB6BFD3), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = onEdit) { Icon(Icons.Outlined.Edit, contentDescription = "Edit ${activity.name}") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = onOpenRemote, modifier = Modifier.weight(1f).height(48.dp)) {
                Icon(Icons.Filled.SettingsRemote, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.size(8.dp))
                Text("Open remote", fontSize = 15.sp)
            }
            Button(
                onClick = onTurnOff,
                enabled = !turningOff,
                modifier = Modifier.height(48.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MelodiousColors.PowerContainer,
                    contentColor = MelodiousColors.OnPowerContainer,
                ),
            ) {
                if (turningOff) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MelodiousColors.OnPowerContainer)
                } else {
                    Icon(Icons.Filled.PowerSettingsNew, contentDescription = null, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.size(8.dp))
                Text("Turn off", fontSize = 15.sp)
            }
        }
    }
}

@Composable
private fun ActivityRow(
    activity: HubActivity,
    devices: String,
    buttonCount: Int,
    starting: Boolean,
    onStart: () -> Unit,
    onEdit: () -> Unit,
    onEditButtons: () -> Unit,
    onEditScreen: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(MelodiousColors.Card)
            .padding(start = 14.dp, end = 4.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ActivityTile(activity, size = 48, container = androidx.compose.ui.graphics.Color(0xFF23302A), tint = androidx.compose.ui.graphics.Color(0xFFA8E6C8))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(activity.name, fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (buttonCount < FEW_BUTTONS) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Outlined.Info, contentDescription = null, tint = MelodiousColors.Warning, modifier = Modifier.size(14.dp))
                    Text(
                        if (buttonCount == 0) "No buttons set up" else "Only $buttonCount button${if (buttonCount == 1) "" else "s"} set up",
                        fontSize = 13.sp,
                        color = MelodiousColors.Warning,
                    )
                }
            } else {
                Text(devices, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
            if (starting) {
                CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            } else {
                FilledIconButton(
                    onClick = onStart,
                    modifier = Modifier.size(48.dp),
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = MelodiousColors.KeyRaised,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                ) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = "Start ${activity.name}")
                }
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = "More options for ${activity.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Edit") },
                    leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    onClick = { menuOpen = false; onEdit() },
                )
                DropdownMenuItem(
                    text = { Text("Set up buttons") },
                    leadingIcon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                    onClick = { menuOpen = false; onEditButtons() },
                )
                DropdownMenuItem(
                    text = { Text("On-screen buttons & sequences") },
                    leadingIcon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                    onClick = { menuOpen = false; onEditScreen() },
                )
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = { menuOpen = false; onDelete() },
                )
            }
        }
    }
}
