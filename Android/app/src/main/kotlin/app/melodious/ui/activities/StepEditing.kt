package app.melodious.ui.activities

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.protocol.graph.SequenceStep
import app.melodious.protocol.model.DeviceCommand
import app.melodious.protocol.model.HubDevice
import app.melodious.ui.theme.MelodiousColors

// Pieces shared by the on-screen button editor and the activity editor's start/end step.

internal fun describe(step: SequenceStep, devices: List<HubDevice>): String = when (step) {
    is SequenceStep.Command -> "${devices.firstOrNull { it.id == step.deviceId }?.name ?: "Device"} · ${step.command}"
    is SequenceStep.Delay -> "Wait ${formatSeconds(step.seconds)}"
}

internal fun formatSeconds(seconds: Double): String =
    if (seconds % 1.0 == 0.0) "${seconds.toInt()} s" else "$seconds s"

internal data class PickerCommandMatch(
    val device: HubDevice,
    val command: DeviceCommand,
    val label: String,
)

/**
 * Search commands across devices: with an empty query returns only the active device's
 * commands; when searching, returns matching commands on the active device first
 * (unprefixed) and other devices underneath ("Device · Command") so any command can be
 * found regardless of device count.
 */
internal fun filterPickerCommands(
    devices: List<HubDevice>,
    activeDeviceId: String?,
    query: String,
    exclude: (String) -> Boolean = { false },
): List<PickerCommandMatch> {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val active = devices.firstOrNull { it.id == activeDeviceId }
    if (words.isEmpty()) {
        return active?.commands.orEmpty()
            .filterNot { exclude(it.name) }
            .map { PickerCommandMatch(active!!, it, it.name) }
    }
    val ordered = if (active != null) listOf(active) + devices.filter { it.id != active.id } else devices
    val matches = mutableListOf<PickerCommandMatch>()
    for (device in ordered) {
        val isActive = active != null && device.id == active.id
        for (cmd in device.commands) {
            if (exclude(cmd.name)) continue
            val text = "${device.name} ${cmd.name}".lowercase()
            if (words.all { text.contains(it) }) {
                matches += PickerCommandMatch(
                    device = device,
                    command = cmd,
                    label = if (isActive) cmd.name else "${device.name} · ${cmd.name}",
                )
            }
        }
    }
    return matches
}


// ---------------------------------------------------------------------------
// Shared pickers
// ---------------------------------------------------------------------------

@Composable
internal fun CommandPicker(
    devices: List<HubDevice>,
    selected: SequenceStep.Command?,
    modifier: Modifier = Modifier,
    /** Commands to hide, e.g. power and input in start/end steps, which the hub handles itself. */
    exclude: (String) -> Boolean = { false },
    onPick: (SequenceStep.Command) -> Unit,
) {
    var deviceId by rememberSaveable { mutableStateOf(selected?.deviceId ?: devices.firstOrNull()?.id) }
    var query by rememberSaveable { mutableStateOf("") }
    val chipRowState = rememberLazyListState()
    LaunchedEffect(deviceId, devices) {
        val idx = devices.indexOfFirst { it.id == deviceId }
        if (idx >= 0) chipRowState.scrollToItem(idx)
    }
    val matches = filterPickerCommands(devices, deviceId, query, exclude)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LazyRow(
            state = chipRowState,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 2.dp),
        ) {
            items(devices, key = { it.id }) { d ->
                FilterChip(
                    selected = d.id == deviceId,
                    onClick = {
                        deviceId = d.id
                        if (query.isNotEmpty()) query = ""
                    },
                    label = { Text(d.name) },
                    modifier = Modifier.heightIn(min = 40.dp),
                )
            }
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            placeholder = { Text("Search commands") },
            singleLine = true,
            shape = RoundedCornerShape(26.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            items(matches, key = { "${it.device.id}:${it.command.name}" }) { match ->
                val isSelected = selected?.deviceId == match.device.id && selected?.command == match.command.name
                Column {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) {
                                onPick(SequenceStep.Command(match.device.id, match.command.name, match.command.functionId))
                            }
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(match.label, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        if (isSelected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
                    }
                    HorizontalDivider(color = MelodiousColors.Divider)
                }
            }
        }
    }
}


/**
 * Inline list of commands and waits (start/end steps). Commands are added through [onAddCommand],
 * which the caller shows as a picker sheet; waits change in half-second steps.
 */
@Composable
internal fun StepListEditor(
    steps: List<SequenceStep>,
    devices: List<HubDevice>,
    emptyText: String,
    onChange: (List<SequenceStep>) -> Unit,
    onAddCommand: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (steps.isEmpty()) {
            Text(emptyText, fontSize = 14.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp))
        }
        steps.forEachIndexed { i, step ->
            StepRow(
                index = i,
                step = step,
                devices = devices,
                canMoveUp = i > 0,
                onMoveUp = { onChange(steps.toMutableList().apply { add(i - 1, removeAt(i)) }) },
                onRemove = { onChange(steps.filterIndexed { j, _ -> j != i }) },
                onDelayChange = { seconds -> onChange(steps.mapIndexed { j, s -> if (j == i) SequenceStep.Delay(seconds) else s }) },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 2.dp)) {
            androidx.compose.material3.OutlinedButton(onClick = onAddCommand, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("+ Command") }
            androidx.compose.material3.OutlinedButton(onClick = { onChange(steps + SequenceStep.Delay(1.0)) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("+ Wait") }
        }
    }
}

@Composable
private fun StepRow(
    index: Int,
    step: SequenceStep,
    devices: List<HubDevice>,
    canMoveUp: Boolean,
    onMoveUp: () -> Unit,
    onRemove: () -> Unit,
    onDelayChange: (Double) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(MelodiousColors.Card)
            .heightIn(min = 56.dp)
            .padding(start = 14.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("${index + 1}", fontSize = 13.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(end = 12.dp))
        if (step is SequenceStep.Delay) {
            Text("Wait", fontSize = 15.sp, modifier = Modifier.weight(1f))
            androidx.compose.material3.TextButton(onClick = { onDelayChange((step.seconds - 0.5).coerceAtLeast(0.5)) }) { Text("−") }
            Text(formatSeconds(step.seconds), fontSize = 15.sp)
            androidx.compose.material3.TextButton(onClick = { onDelayChange((step.seconds + 0.5).coerceAtMost(30.0)) }) { Text("+") }
        } else {
            Text(describe(step, devices), fontSize = 15.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        androidx.compose.material3.IconButton(onClick = onMoveUp, enabled = canMoveUp) {
            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Move step ${index + 1} up")
        }
        androidx.compose.material3.IconButton(onClick = onRemove) {
            Icon(Icons.Filled.Close, contentDescription = "Remove step ${index + 1}")
        }
    }
}
