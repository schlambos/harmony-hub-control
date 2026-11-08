package app.melodious.ui.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.NotificationsActive
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.FixIt
import app.melodious.ui.components.HaStateStrip
import app.melodious.protocol.model.FixItDevice
import app.melodious.ui.components.RoleLabels
import app.melodious.ui.components.deviceIcon
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.RemoteMode
import app.melodious.RemoteTarget
import app.melodious.ui.components.IconTile
import app.melodious.ui.components.PowerButton
import app.melodious.ui.components.StatusDot
import app.melodious.ui.components.activityIcon
import app.melodious.ui.components.rememberHaptics
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.HubActivity

@Composable
fun RemoteTab(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    onSetUpKeyboard: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
) {
    val pending = state.pendingActivityId
    val running = state.runningActivity
    val status = state.activityStatus
    when {
        // Our own request in flight, or a start/stop begun elsewhere (physical remote, widget).
        pending == "-1" || (pending == null && status == MelodiousViewModel.STATUS_STOPPING) ->
            BusyState("Turning everything off…")
        pending != null -> BusyState("Starting ${state.activity(pending)?.name ?: "activity"}…")
        status == MelodiousViewModel.STATUS_STARTING && running != null -> BusyState("Starting ${running.name}…")
        running == null -> OffState(state, onStart = viewModel::startActivity)
        else -> ActivityRemote(state, viewModel, running, onSetUpKeyboard, onRequestNotificationPermission)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ActivityRemote(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    activity: HubActivity,
    onSetUpKeyboard: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
) {
    val target = RemoteTarget.Activity(activity.id)
    val haptics = rememberHaptics(state.hapticsEnabled)
    val controller = rememberRemoteController(viewModel, target, state.keyMap(target), haptics)
    var showSwitcher by rememberSaveable { mutableStateOf(false) }
    var showMoreKeys by rememberSaveable { mutableStateOf(false) }
    var showFixIt by rememberSaveable { mutableStateOf(false) }
    var showSleep by rememberSaveable { mutableStateOf(false) }

    DisposableEffect(activity.id) {
        viewModel.visibleRemoteTarget = target
        onDispose {
            if (viewModel.visibleRemoteTarget == target) viewModel.visibleRemoteTarget = null
            viewModel.stopHold()
        }
    }

    Column(Modifier.fillMaxSize()) {
        RemoteHeader(
            title = activity.name,
            subtitle = state.deviceNamesFor(activity).joinToString(", ").ifBlank { "On" },
            live = true,
            onTitleClick = { showSwitcher = true },
            titleClickLabel = "Switch activity",
            onPower = { haptics.longPress(); viewModel.powerOff() },
            powerLabel = "Turn off ${activity.name}",
            onFix = { showFixIt = true },
        )
        state.sleepTimerEndsAtMillis?.let { endsAt ->
            SleepTimerPill(endsAt, onClick = { showSleep = true })
        }
        val showPrompt = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
            !state.notificationPermissionGranted && !state.notificationPromptHandled
        if (showPrompt) {
            LockScreenPrompt(
                onEnable = onRequestNotificationPermission,
                onDismiss = viewModel::dismissNotificationPrompt,
            )
        }
        val deviceIds = activity.roles.map { it.deviceId }.toSet()
        val devices = state.devices.filter { it.id in deviceIds }
        HaStateStrip(
            devices.mapNotNull { d -> state.haStrip(d)?.let { d to it } },
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
        RemoteModeTabs(state.remoteMode, onSelect = { haptics.tick(); viewModel.setRemoteMode(it) })
        when (state.remoteMode) {
            RemoteMode.BUTTONS -> ButtonsSurface(controller, onMoreKeys = { showMoreKeys = true }, Modifier.weight(1f))
            RemoteMode.TOUCHPAD -> TouchpadSurface(controller, onMoreKeys = { showMoreKeys = true }, Modifier.weight(1f))
            RemoteMode.KEYBOARD -> KeyboardSurface(
                keyboardReady = state.btTextHelperStatus.live,
                onRefreshStatus = viewModel::refreshKeyboardStatus,
                haptics = haptics,
                onSendText = viewModel::sendBluetoothKeyboardText,
                onSendKey = viewModel::sendBluetoothHidKey,
                onSetUpKeyboard = onSetUpKeyboard,
                modifier = Modifier.weight(1f),
            )
        }

        if (showFixIt) {
            FixItSheet(
                fixes = FixIt.devicesFor(
                    activity, state.devices, RoleLabels::label,
                    powerOverrides = state.devices.mapNotNull { d -> state.deviceSettings(d.id)?.let { d.id to it } }.toMap(),
                    haState = state.haState,
                ),
                onSend = { deviceId, command -> haptics.tap(); viewModel.sendFix(deviceId, command) },
                onSendAll = { haptics.tap(); viewModel.sendFixes(it); showFixIt = false },
                onHubHelp = if (state.hbusConnected) ({ haptics.tap(); viewModel.runHubHelp(activity.id); showFixIt = false }) else null,
                onDismiss = { showFixIt = false },
            )
        }

        if (showMoreKeys) {
            MoreKeysSheet(
                title = activity.name,
                controller = controller,
                devices = devices,
                onSendDeviceCommand = viewModel::sendDeviceCommand,
                onDismiss = { showMoreKeys = false },
                softButtons = state.softButtons(activity.id),
                onSoftButton = { viewModel.pressSoftButton(activity.id, it) },
                onEditSoftButtons = {
                    showMoreKeys = false
                    viewModel.openTouchEditor(activity.id)
                },
            )
        }
    }

    if (showSleep) {
        SleepTimerSheet(
            active = state.sleepTimerEndsAtMillis != null,
            onPick = { minutes -> haptics.tap(); viewModel.setSleepTimer(minutes); showSleep = false },
            onCancel = { haptics.tap(); viewModel.cancelSleepTimer(); showSleep = false },
            onDismiss = { showSleep = false },
        )
    }

    if (showSwitcher) {
        ModalBottomSheet(
            onDismissRequest = { showSwitcher = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding()) {
                Text("Switch activity", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 4.dp, bottom = 12.dp))
                state.activities.forEach { other ->
                    val isCurrent = other.id == activity.id
                    SheetRow(
                        title = other.name,
                        icon = activityIcon(other),
                        selected = isCurrent,
                        onClick = {
                            showSwitcher = false
                            if (!isCurrent) {
                                haptics.tap()
                                viewModel.startActivity(other.id)
                            }
                        },
                    )
                }
                Spacer(Modifier.height(8.dp))
                SheetRow(
                    title = if (state.sleepTimerEndsAtMillis != null) "Sleep timer · on" else "Sleep timer",
                    icon = Icons.Outlined.Bedtime,
                    onClick = {
                        showSwitcher = false
                        showSleep = true
                    },
                )
                SheetRow(
                    title = "Turn everything off",
                    icon = Icons.Filled.PowerSettingsNew,
                    destructive = true,
                    onClick = {
                        showSwitcher = false
                        haptics.longPress()
                        viewModel.powerOff()
                    },
                )
            }
        }
    }
}

@Composable
fun RemoteHeader(
    title: String,
    subtitle: String,
    live: Boolean,
    onTitleClick: (() -> Unit)?,
    titleClickLabel: String?,
    onPower: () -> Unit,
    powerLabel: String,
    onFix: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(12.dp))
                .then(
                    if (onTitleClick != null) Modifier.clickable(onClickLabel = titleClickLabel, role = Role.Button, onClick = onTitleClick)
                    else Modifier
                )
                .padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontSize = 24.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (onTitleClick != null) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (live) StatusDot(MelodiousColors.Live)
                Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (onFix != null) {
            androidx.compose.material3.FilledTonalIconButton(
                onClick = onFix,
                modifier = Modifier.size(52.dp),
                colors = androidx.compose.material3.IconButtonDefaults.filledTonalIconButtonColors(containerColor = MelodiousColors.Key),
            ) {
                Icon(Icons.Outlined.Build, contentDescription = "Fix it: something didn't turn on or switch input")
            }
        }
        PowerButton(contentDescription = powerLabel, onClick = onPower)
    }
}

@Composable
fun RemoteModeTabs(selected: RemoteMode, onSelect: (RemoteMode) -> Unit, modes: List<RemoteMode> = RemoteMode.entries) {
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(50))
            .background(MelodiousColors.Card)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        modes.forEach { mode ->
            val isSelected = mode == selected
            Box(
                Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(50))
                    .background(if (isSelected) MaterialTheme.colorScheme.primaryContainer else MelodiousColors.Card)
                    .semantics { role = Role.Tab; this.selected = isSelected }
                    .clickable { onSelect(mode) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    when (mode) {
                        RemoteMode.BUTTONS -> "Buttons"
                        RemoteMode.TOUCHPAD -> "Touchpad"
                        RemoteMode.KEYBOARD -> "Keyboard"
                    },
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SheetRow(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
    selected: Boolean = false,
    destructive: Boolean = false,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f) else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 60.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        IconTile(
            icon,
            size = 40,
            container = if (destructive) MelodiousColors.PowerContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
            tint = if (destructive) MelodiousColors.OnPowerContainer else androidx.compose.ui.graphics.Color(0xFFC3C8D2),
        )
        Text(
            title,
            fontSize = 17.sp,
            modifier = Modifier.weight(1f),
            color = if (destructive) MelodiousColors.OnPowerContainer else MaterialTheme.colorScheme.onSurface,
        )
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Running", tint = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun OffState(state: MelodiousUiState, onStart: (String) -> Unit) {
    val haptics = rememberHaptics(state.hapticsEnabled)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
    ) {
        Column(Modifier.padding(start = 4.dp, top = 20.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Everything's off", fontSize = 28.sp, fontWeight = FontWeight.Medium)
            Text("What do you want to do?", fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.activities.isEmpty()) {
            Text(
                "No activities yet. Create one in the Activities tab.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(4.dp),
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            state.activities.forEach { activity ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(24.dp))
                        .background(MelodiousColors.Card)
                        .clickable(onClickLabel = "Start ${activity.name}", role = Role.Button) {
                            haptics.tap()
                            onStart(activity.id)
                        }
                        .padding(horizontal = 16.dp, vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    IconTile(activityIcon(activity), size = 52, container = MaterialTheme.colorScheme.primaryContainer, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(activity.name, fontSize = 18.sp, fontWeight = FontWeight.Medium)
                        Text(
                            state.deviceNamesFor(activity).joinToString(" · "),
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun BusyState(text: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(72.dp), strokeWidth = 4.dp)
            Icon(Icons.Filled.Tv, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.height(24.dp))
        Text(text, fontSize = 20.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your hub is switching devices and inputs. This can take a few seconds.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun LockScreenPrompt(onEnable: () -> Unit, onDismiss: () -> Unit) {
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(MelodiousColors.RunningCard)
            .padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Outlined.NotificationsActive, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 2.dp))
        Column(Modifier.weight(1f)) {
            Text("Control from your lock screen", fontWeight = FontWeight.Medium)
            Text(
                "Volume, play/pause and turn off in your notifications while something's on.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                androidx.compose.material3.TextButton(onClick = onEnable) { Text("Turn on") }
                androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Not now", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FixItSheet(
    fixes: List<FixItDevice>,
    onSend: (deviceId: String, command: DeviceCommand) -> Unit,
    onSendAll: (List<Pair<String, DeviceCommand>>) -> Unit,
    onHubHelp: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    // "Resend everything" is only safe when no device would need a power *toggle* (which could turn it off).
    val needsPower = fixes.filter { it.powerOn != null || it.powerToggle != null }
    val allDiscrete = needsPower.all { it.powerOn != null }
    val bulk = fixes.flatMap { f ->
        listOfNotNull(f.powerOn?.let { f.device.id to it }) + listOfNotNull(f.inputCommand?.let { f.device.id to it })
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(
            Modifier
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp)
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Something not right?", fontSize = 20.sp, fontWeight = FontWeight.Medium)
                Text(
                    "Tap the fix for what's wrong. Melodious resends just that command and nothing else changes.",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (onHubHelp != null) {
                // The hub tracks each device's power state, so its Help is safe even with toggle-only devices.
                androidx.compose.material3.Button(
                    onClick = onHubHelp,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) { Text("Resend everything") }
                Text(
                    "Your hub checks each device and resends only the power and input commands it needs.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                Text("Or fix one device", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp, top = 8.dp))
            } else if (allDiscrete && bulk.isNotEmpty()) {
                androidx.compose.material3.Button(
                    onClick = { onSendAll(bulk) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) { Text("Resend power and inputs for everything") }
            }
            fixes.filter { it.hasAnyFix }.forEach { fix ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(MelodiousColors.Card)
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        IconTile(deviceIcon(fix.device), size = 40)
                        Column(Modifier.weight(1f)) {
                            Text(fix.device.name, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                            Text(fix.roleLabels.joinToString(" · "), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            fix.haHint?.let { hint ->
                                Text(
                                    hint,
                                    fontSize = 13.sp,
                                    color = if (fix.haInfo?.let { it.known && it.power == "on" } == true) MelodiousColors.Live
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    val powerOn = fix.powerOn
                    val powerToggle = fix.powerToggle
                    val inputCommand = fix.inputCommand
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        when {
                            powerOn != null -> androidx.compose.material3.FilledTonalButton(
                                onClick = { onSend(fix.device.id, powerOn) },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            ) { Text("It's off") }
                            powerToggle != null -> androidx.compose.material3.OutlinedButton(
                                onClick = { onSend(fix.device.id, powerToggle) },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            ) { Text("Press power") }
                        }
                        if (inputCommand != null) {
                            androidx.compose.material3.FilledTonalButton(
                                onClick = { onSend(fix.device.id, inputCommand) },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            ) { Text("Switch to ${fix.inputName}", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                    if (fix.powerOn == null && fix.powerToggle != null) {
                        Text(
                            "This device only has a power toggle. Only press it if the device is off, or it will turn off.",
                            fontSize = 12.sp,
                            color = MelodiousColors.Warning,
                        )
                    }
                }
            }
        }
    }
}

private val SLEEP_OPTIONS = listOf(15, 30, 45, 60, 90, 120)

@Composable
private fun SleepTimerPill(endsAtMillis: Long, onClick: () -> Unit) {
    var now by androidx.compose.runtime.remember { mutableStateOf(System.currentTimeMillis()) }
    androidx.compose.runtime.LaunchedEffect(endsAtMillis) {
        while (true) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(15_000)
        }
    }
    val minutes = ((endsAtMillis - now + 59_999) / 60_000).coerceAtLeast(0)
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(50))
            .background(MelodiousColors.Card)
            .clickable(onClickLabel = "Change sleep timer", role = Role.Button, onClick = onClick)
            .heightIn(min = 40.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Bedtime, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Text(
            if (minutes <= 1) "Turning off in under a minute" else "Everything turns off in $minutes min",
            fontSize = 13.sp,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SleepTimerSheet(active: Boolean, onPick: (Int) -> Unit, onCancel: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Sleep timer", fontSize = 20.sp, fontWeight = FontWeight.Medium)
                Text(
                    "Your hub turns everything off after this long, even if your phone is off.",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SLEEP_OPTIONS.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { minutes ->
                        androidx.compose.material3.FilledTonalButton(
                            onClick = { onPick(minutes) },
                            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                        ) { Text(if (minutes < 60 || minutes % 60 != 0) "$minutes min" else "${minutes / 60} h") }
                    }
                }
            }
            if (active) {
                androidx.compose.material3.OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text("Turn off sleep timer")
                }
            }
        }
    }
}
