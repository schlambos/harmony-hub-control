package app.melodious.ui.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.protocol.model.DeviceSettingsModel
import app.melodious.protocol.model.IrOutput
import app.melodious.protocol.model.PowerType
import app.melodious.ui.components.ConfirmDialog
import app.melodious.ui.components.DetailPage
import app.melodious.ui.components.GroupDivider
import app.melodious.ui.components.ListGroup
import app.melodious.ui.components.SectionLabel
import app.melodious.ui.components.SwitchRow
import app.melodious.ui.theme.MelodiousColors

/** Which power command a picker sheet is choosing. */
private enum class PowerSlot(val title: String) { ON("On command"), OFF("Off command"), TOGGLE("Power command") }

/** Device › Settings: how the hub powers this device on and off, and how fast it can send to it. */
@Composable
fun DeviceSettingsScreen(state: MelodiousUiState, viewModel: MelodiousViewModel, deviceId: String, onBack: () -> Unit) {
    val device = state.device(deviceId)
    val saved = state.deviceSettings(deviceId)
    if (device == null || saved == null) {
        DetailPage(title = "Device settings", onBack = onBack) { pad ->
            Text("This device is no longer on the hub.", modifier = Modifier.padding(pad).padding(20.dp))
        }
        return
    }
    var settings by remember(deviceId, saved) { mutableStateOf(saved) }
    var picking by remember { mutableStateOf<PowerSlot?>(null) }
    var confirmLeave by remember { mutableStateOf(false) }
    val names = state.deviceCommandNames(deviceId)
    val problems = DeviceSettingsModel.validate(settings, names, wakeOnly = device.isSwitch2Wake)
    val dirty = settings != saved
    val leave = { if (dirty) confirmLeave = true else onBack() }
    BackHandler(onBack = leave)

    DetailPage(
        title = "${device.name} settings",
        onBack = leave,
        bottomBar = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.background)
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                if (dirty && problems.isNotEmpty()) {
                    Text(problems.first(), fontSize = 13.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 8.dp))
                }
                Button(
                    onClick = { viewModel.saveDeviceSettings(deviceId, settings, onSaved = onBack) },
                    enabled = dirty && problems.isEmpty() && !state.deviceSettingsSaving,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    if (state.deviceSettingsSaving) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        Spacer(Modifier.size(10.dp))
                        Text("Saving to hub…")
                    } else {
                        Text("Save")
                    }
                }
            }
        },
    ) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            if (!saved.hasPowerFeature) {
                Text(
                    "This device has no power settings yet. The choices below are suggestions from its command names; save to apply them.",
                    fontSize = 14.sp,
                    color = MelodiousColors.Warning,
                )
            }

            Column {
                SectionLabel("Power")
                ListGroup {
                    PowerType.entries.forEachIndexed { i, type ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(role = Role.RadioButton) { settings = settings.copy(powerType = type) }
                                .heightIn(min = 56.dp)
                                .padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = settings.powerType == type, onClick = null)
                            Text(type.label, fontSize = 15.sp, modifier = Modifier.padding(start = 8.dp))
                        }
                        if (i < PowerType.entries.lastIndex) GroupDivider()
                    }
                }
            }

            when (settings.powerType) {
                PowerType.DISCRETE -> ListGroup {
                    CommandRow("On command", settings.powerOn) { picking = PowerSlot.ON }
                    if (!device.isSwitch2Wake || settings.powerOff.isNotBlank()) {
                        GroupDivider()
                        CommandRow("Off command", settings.powerOff) { picking = PowerSlot.OFF }
                    }
                }
                PowerType.TOGGLE -> ListGroup {
                    CommandRow("Power command", settings.powerToggle) { picking = PowerSlot.TOGGLE }
                }
                PowerType.NONE -> Unit
            }

            if (settings.powerType != PowerType.NONE) {
                Column {
                    SectionLabel("Turning on")
                    ListGroup {
                        Stepper(
                            title = "Warm-up time",
                            subtitle = "How long it needs after turning on before it accepts commands",
                            value = settings.powerOnDelayMs,
                            step = 500,
                            range = DeviceSettingsModel.POWER_ON_DELAY_MS,
                            format = ::seconds,
                            onChange = { settings = settings.copy(powerOnDelayMs = it) },
                        )
                        GroupDivider()
                        SwitchRow(
                            title = "Always on",
                            subtitle = "Activities never turn it off",
                            checked = settings.alwaysOn,
                            onCheckedChange = { settings = settings.copy(alwaysOn = it) },
                        )
                        GroupDivider()
                        SwitchRow(
                            title = "Keep on between activities",
                            subtitle = "Stays on when you switch to an activity that doesn't use it",
                            checked = settings.onBetweenActivities,
                            onCheckedChange = { settings = settings.copy(onBetweenActivities = it) },
                        )
                    }
                }
            }

            if (settings.isIrDevice) {
                Column {
                    SectionLabel("IR output")
                    Text(
                        "Which IR emitter sends this device's commands.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
                    )
                    if (settings.irOutput == null && settings.storedControlPort != null) {
                        Text(
                            "The hub has this device set to output ${settings.storedControlPort}, which this app " +
                                "doesn't name. It stays as it is unless you pick one below.",
                            fontSize = 13.sp,
                            color = MelodiousColors.Warning,
                            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
                        )
                    }
                    ListGroup {
                        IrOutput.entries.forEachIndexed { i, output ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable(role = Role.RadioButton) { settings = settings.copy(irOutput = output) }
                                    .heightIn(min = 56.dp)
                                    .padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = settings.irOutput == output, onClick = null)
                                Text(output.label, fontSize = 15.sp, modifier = Modifier.padding(start = 8.dp))
                            }
                            if (i < IrOutput.entries.lastIndex) GroupDivider()
                        }
                    }
                }
            }

            Column {
                SectionLabel("Timing")
                Text(
                    "Raise these if the device misses commands or responds to only some presses.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
                )
                ListGroup {
                    Stepper(
                        title = "Delay between commands",
                        subtitle = "Pause between two commands to this device",
                        value = settings.interKeyDelayMs,
                        step = 50,
                        range = DeviceSettingsModel.INTER_KEY_DELAY_MS,
                        format = { "$it ms" },
                        onChange = { settings = settings.copy(interKeyDelayMs = it) },
                    )
                    GroupDivider()
                    Stepper(
                        title = "Delay before this device",
                        subtitle = "Pause when switching to this device from another",
                        value = settings.interDeviceDelayMs,
                        step = 100,
                        range = DeviceSettingsModel.INTER_DEVICE_DELAY_MS,
                        format = { "$it ms" },
                        onChange = { settings = settings.copy(interDeviceDelayMs = it) },
                    )
                    GroupDivider()
                    Stepper(
                        title = "Repeats",
                        subtitle = "How many times each IR signal is sent",
                        value = settings.repeats,
                        step = 1,
                        range = DeviceSettingsModel.REPEATS,
                        format = { it.toString() },
                        onChange = { settings = settings.copy(repeats = it) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }

    picking?.let { slot ->
        CommandSheet(
            title = slot.title,
            names = names,
            selected = when (slot) {
                PowerSlot.ON -> settings.powerOn
                PowerSlot.OFF -> settings.powerOff
                PowerSlot.TOGGLE -> settings.powerToggle
            },
            onPick = { name ->
                settings = when (slot) {
                    PowerSlot.ON -> settings.copy(powerOn = name)
                    PowerSlot.OFF -> settings.copy(powerOff = name)
                    PowerSlot.TOGGLE -> settings.copy(powerToggle = name)
                }
                picking = null
            },
            onDismiss = { picking = null },
        )
    }

    if (confirmLeave) {
        ConfirmDialog(
            title = "Discard changes?",
            text = "These settings haven't been saved to the hub.",
            confirmLabel = "Discard",
            destructive = true,
            onConfirm = onBack,
            onDismiss = { confirmLeave = false },
        )
    }
}

private fun seconds(ms: Int): String = if (ms % 1000 == 0) "${ms / 1000} s" else "${ms / 1000.0} s"

@Composable
private fun CommandRow(title: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = "Choose $title", role = Role.Button, onClick = onClick)
            .heightIn(min = 60.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Text(value.ifBlank { "Choose…" }, fontSize = 14.sp, color = if (value.isBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun Stepper(
    title: String,
    subtitle: String,
    value: Int,
    step: Int,
    range: IntRange,
    format: (Int) -> String,
    onChange: (Int) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp)
            Text(subtitle, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = { onChange((value - step).coerceIn(range)) }, enabled = value > range.first) { Text("−", fontSize = 18.sp) }
        Text(format(value), fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = 2.dp))
        TextButton(onClick = { onChange((value + step).coerceIn(range)) }, enabled = value < range.last) { Text("+", fontSize = 18.sp) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CommandSheet(title: String, names: List<String>, selected: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    // Power-ish commands first: they're what this sheet is almost always looking for.
    val sorted = names.sortedBy { if (it.contains("power", ignoreCase = true)) 0 else 1 }
        .filter { query.isBlank() || it.contains(query.trim(), ignoreCase = true) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.fillMaxHeight(0.9f).padding(horizontal = 16.dp)) {
            Text(title, fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(bottom = 8.dp))
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text("Search commands") },
                singleLine = true,
                shape = RoundedCornerShape(26.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
                items(sorted, key = { it }) { name ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(role = Role.Button) { onPick(name) }
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(name, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        if (name.equals(selected, ignoreCase = true)) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }
}
