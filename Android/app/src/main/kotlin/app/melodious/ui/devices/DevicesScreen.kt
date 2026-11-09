package app.melodious.ui.devices

import app.melodious.protocol.model.HaDeviceInfo
import app.melodious.protocol.model.HaState
import app.melodious.ui.components.HaStateStrip
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.SettingsRemote
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.RemoteTarget
import app.melodious.ui.components.DetailPage
import app.melodious.ui.components.GroupDivider
import app.melodious.ui.components.IconTile
import app.melodious.ui.components.ListGroup
import app.melodious.ui.components.ScreenTitle
import app.melodious.ui.components.deviceIcon
import app.melodious.ui.components.rememberHaptics
import app.melodious.ui.remote.ButtonsSurface
import app.melodious.ui.remote.MoreKeysSheet
import app.melodious.ui.remote.rememberRemoteController
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.DeviceTouchScreen
import app.melodious.protocol.model.HubDevice

@Composable
fun DevicesTab(state: MelodiousUiState, onOpenDevice: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim()
    val rows = state.devices.mapNotNull { device ->
        val nameHit = q.isEmpty() || device.name.contains(q, true) || device.model.contains(q, true) || device.manufacturer.contains(q, true)
        val commandHits = if (q.isEmpty()) 0 else device.commands.count { it.name.contains(q, true) }
        if (nameHit || commandHits > 0) Triple(device, nameHit, commandHits) else null
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenTitle("Devices")
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            placeholder = { Text("Search devices or commands") },
            singleLine = true,
            shape = RoundedCornerShape(26.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        )
        if (rows.isEmpty()) {
            Text(
                if (q.isEmpty()) "No devices on this hub yet." else "Nothing matches “$q”.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
        } else {
            ListGroup(Modifier.padding(horizontal = 16.dp)) {
                rows.forEachIndexed { i, (device, _, commandHits) ->
                    DeviceRow(
                        device = device,
                        subtitle = if (commandHits > 0) "$commandHits matching command${if (commandHits == 1) "" else "s"}"
                        else state.haStrip(device)?.summary
                            ?: listOf(device.model.ifBlank { device.manufacturer }, "${device.commands.size} commands").filter { it.isNotBlank() }.joinToString(" · "),
                        onClick = { onOpenDevice(device.id) },
                    )
                    if (i < rows.lastIndex) GroupDivider()
                }
            }
        }
        Text(
            "Open a device to control it directly, outside any activity. Each device also has Learn a button and Import codes.",
            fontSize = 13.sp,
            lineHeight = 19.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
        )
    }
}

@Composable
private fun DeviceRow(device: HubDevice, subtitle: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = "Open ${device.name}", role = Role.Button, onClick = onClick)
            .heightIn(min = 72.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        IconTile(deviceIcon(device))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(device.name, fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TransportBadge(device)
    }
}

@Composable
private fun TransportBadge(device: HubDevice) {
    val bt = device.isBluetoothHid || device.isHubBluetooth
    Text(
        when {
            bt -> "Bluetooth"
            device.isHomeAssistant -> "Home Assistant"
            device.isNetworkTv -> "Network"
            else -> "IR"
        },
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        color = if (bt) Color(0xFFB9CBFF) else Color(0xFFC3C8D2),
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (bt) MelodiousColors.RunningCard else MaterialTheme.colorScheme.surfaceContainerHighest)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

// ============================================================================
// Device detail
// ============================================================================

private enum class DeviceTab { REMOTE, COMMANDS }

@Composable
fun DeviceDetailScreen(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    deviceId: String,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val device = state.device(deviceId)
    if (device == null) {
        DetailPage(title = "Device", onBack = onBack) { pad ->
            Text("This device is no longer on the hub.", modifier = Modifier.padding(pad).padding(20.dp))
        }
        return
    }
    val target = RemoteTarget.Device(device.id)
    val haptics = rememberHaptics(state.hapticsEnabled)
    val controller = rememberRemoteController(viewModel, target, state.keyMap(target), haptics)
    var tab by rememberSaveable { mutableStateOf(DeviceTab.REMOTE) }
    var showMoreKeys by rememberSaveable { mutableStateOf(false) }
    var showLearn by rememberSaveable { mutableStateOf(false) }
    var showImport by rememberSaveable { mutableStateOf(false) }
    var menuOpen by rememberSaveable { mutableStateOf(false) }
    // The hub builds the Touch screen from the device's commands; Logitech's own screens and
    // Home Assistant devices (whose screens follow the device set) are left alone.
    val touchScreen = state.deviceTouchScreen(device.id)

    DisposableEffect(device.id) {
        viewModel.visibleRemoteTarget = target
        onDispose {
            if (viewModel.visibleRemoteTarget == target) viewModel.visibleRemoteTarget = null
            viewModel.stopHold()
        }
    }

    DetailPage(
        title = device.name,
        onBack = onBack,
        actions = {
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Outlined.Tune, contentDescription = "${device.name} settings")
            }
            IconButton(onClick = { haptics.longPress(); viewModel.powerOffDevice(device.id) }) {
                Icon(Icons.Filled.PowerSettingsNew, contentDescription = "Power ${device.name}", tint = MelodiousColors.OnPowerContainer)
            }
            if (touchScreen == DeviceTouchScreen.NONE || touchScreen == DeviceTouchScreen.MADE) {
                Box {
                    IconButton(onClick = { menuOpen = true }, enabled = !state.deviceScreenSaving) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More options for ${device.name}")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(if (touchScreen == DeviceTouchScreen.MADE) "Rebuild Touch screen" else "Make Touch screen") },
                            leadingIcon = {
                                Icon(
                                    if (touchScreen == DeviceTouchScreen.MADE) Icons.Outlined.Refresh else Icons.Outlined.SettingsRemote,
                                    contentDescription = null,
                                )
                            },
                            onClick = { menuOpen = false; viewModel.saveDeviceScreen(device.id, remove = false) },
                        )
                        if (touchScreen == DeviceTouchScreen.MADE) {
                            DropdownMenuItem(
                                text = { Text("Remove Touch screen") },
                                leadingIcon = { Icon(Icons.Outlined.Remove, contentDescription = null) },
                                onClick = { menuOpen = false; viewModel.saveDeviceScreen(device.id, remove = true) },
                            )
                        }
                    }
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            Row(
                Modifier
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(50))
                    .background(MelodiousColors.Card)
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                DeviceTab.entries.forEach { t ->
                    val sel = t == tab
                    Box(
                        Modifier
                            .weight(1f)
                            .height(40.dp)
                            .clip(RoundedCornerShape(50))
                            .background(if (sel) MaterialTheme.colorScheme.primaryContainer else MelodiousColors.Card)
                            .clickable(role = Role.Tab) { tab = t },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (t == DeviceTab.REMOTE) "Remote" else "Commands (${device.commands.size})",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (sel) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            state.haStrip(device)?.let { info ->
                HaStateStrip(listOf(device to info), Modifier.padding(horizontal = 16.dp, vertical = 6.dp), single = true)
            }
            when (tab) {
                DeviceTab.REMOTE -> ButtonsSurface(controller, onMoreKeys = { showMoreKeys = true }, Modifier.weight(1f))
                DeviceTab.COMMANDS -> CommandsList(
                    device = device,
                    haInfo = state.haInfo(device),
                    onSend = { haptics.tap(); viewModel.sendDeviceCommand(device.id, it) },
                    onLearn = { showLearn = true },
                    onImport = { showImport = true },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }

    if (showMoreKeys) {
        MoreKeysSheet(
            title = device.name,
            controller = controller,
            devices = listOf(device),
            onSendDeviceCommand = viewModel::sendDeviceCommand,
            onDismiss = { showMoreKeys = false },
        )
    }
    if (showLearn) LearnSheet(state, viewModel, device, onDismiss = { showLearn = false; viewModel.clearIrCapture() })
    if (showImport) ImportSheet(state, viewModel, device, onDismiss = { showImport = false })
}

@Composable
private fun CommandsList(
    device: HubDevice,
    haInfo: HaDeviceInfo?,
    onSend: (String) -> Unit,
    onLearn: () -> Unit,
    onImport: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val commands = device.commands.filter { query.isBlank() || it.name.contains(query.trim(), true) }
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onLearn, modifier = Modifier.weight(1f).height(48.dp)) {
                    Icon(Icons.Outlined.SettingsRemote, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("Learn a button")
                }
                OutlinedButton(onClick = onImport, modifier = Modifier.weight(1f).height(48.dp)) {
                    Icon(Icons.Outlined.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("Import codes")
                }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text("Search ${device.commands.size} commands") },
                singleLine = true,
                shape = RoundedCornerShape(26.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 8.dp),
            )
            Text(
                "Tap a command to send it.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
        }
        items(commands, key = { it.name }) { cmd ->
            // Dimmed, still sendable: Home Assistant says it would change nothing right now.
            val redundant = HaState.isCommandRedundant(cmd.name, haInfo)
            Column(Modifier.alpha(if (redundant) 0.55f else 1f)) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(onClickLabel = "Send ${cmd.name}", role = Role.Button) { onSend(cmd.name) }
                        .heightIn(min = 52.dp)
                        .padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(cmd.name, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    if (cmd.isLearned) Text("Learned", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider(Modifier.padding(start = 20.dp), color = MelodiousColors.Divider)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LearnSheet(state: MelodiousUiState, viewModel: MelodiousViewModel, device: HubDevice, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    val capture = state.lastIrCapture?.takeIf { !it.empty }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(
            Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().imePadding(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Learn a button", fontSize = 20.sp, fontWeight = FontWeight.Medium)
            when {
                state.irCapturing -> {
                    Text("Listening… Point your original ${device.name} remote at the hub and press the button once.", fontSize = 15.sp)
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                capture == null -> {
                    Text(
                        "Point your original ${device.name} remote at the front of the hub, then tap Start and press the button you want to copy.",
                        fontSize = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(onClick = { viewModel.captureIrFromRemote() }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                        Text("Start listening")
                    }
                }
                else -> {
                    Text("Got it. ${capture.analysis.ifBlank { capture.mode.uppercase() + " signal" }}", fontSize = 15.sp, color = MelodiousColors.Live)
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Command name (e.g. InputHdmi3)") },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = { viewModel.testLearnedCommand(device.id, name) }, modifier = Modifier.weight(1f).height(52.dp)) {
                            Text("Test")
                        }
                        Button(
                            onClick = { viewModel.saveLearnedCommand(device.id, name) },
                            enabled = name.isNotBlank() && !state.irBusy,
                            modifier = Modifier.weight(2f).height(52.dp),
                        ) {
                            if (state.irBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Save to ${device.name}")
                        }
                    }
                    androidx.compose.material3.TextButton(onClick = { viewModel.captureIrFromRemote() }) { Text("Learn again") }
                }
            }
        }
    }
}

private enum class ImportTab { CATALOG, PASTE }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImportSheet(state: MelodiousUiState, viewModel: MelodiousViewModel, device: HubDevice, onDismiss: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf(ImportTab.CATALOG) }
    androidx.compose.runtime.LaunchedEffect(device.id) { viewModel.openCatalogTab(device.id) }
    androidx.compose.runtime.DisposableEffect(device.id) {
        onDispose { viewModel.closeCatalogTab() }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(
            Modifier
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp)
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Import codes", fontSize = 20.sp, fontWeight = FontWeight.Medium)
            // Tab row, in the web sheet's order; the sheet opens on the first tab.
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(50))
                    .background(MelodiousColors.Card)
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ImportTab.entries.forEach { t ->
                    val sel = t == tab
                    Box(
                        Modifier
                            .weight(1f)
                            .height(40.dp)
                            .clip(RoundedCornerShape(50))
                            .background(if (sel) MaterialTheme.colorScheme.primaryContainer else MelodiousColors.Card)
                            .clickable(role = Role.Tab) { tab = t },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (t == ImportTab.CATALOG) "Logitech catalog" else "Paste",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (sel) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            when (tab) {
                ImportTab.CATALOG -> CatalogImportTab(state, viewModel, device, onImported = onDismiss)
                ImportTab.PASTE -> PasteImportTab(state, viewModel, device, onDismiss)
            }
        }
    }
}

@Composable
private fun PasteImportTab(state: MelodiousUiState, viewModel: MelodiousViewModel, device: HubDevice, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            "Paste codes from IRDB (CSV), name|mode|code lines, or a Pronto hex code. They'll be added to ${device.name}.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("Paste here") },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 280.dp),
        )
        Button(
            onClick = { if (viewModel.importIrPayload(device.id, text)) onDismiss() },
            enabled = text.isNotBlank() && !state.irBusy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("Import")
        }
    }
}
