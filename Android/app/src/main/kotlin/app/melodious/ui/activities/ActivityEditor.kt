package app.melodious.ui.activities

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.ui.components.ConfirmDialog
import app.melodious.ui.components.IconTile
import app.melodious.ui.components.RoleLabels
import app.melodious.ui.components.deviceIcon
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.HubActivity
import app.melodious.protocol.model.HubDevice
import app.melodious.protocol.model.RemoteLayout
import app.melodious.protocol.model.WizardButtonMapping
import app.melodious.protocol.model.WizardRoleDraft

private val STEP_NAMES = listOf("Name", "Devices", "Inputs", "Start & end", "Buttons")

/** Assignable remote keys grouped the way people think about a remote. */
private val BUTTON_GROUPS: List<Pair<String, List<String>>> = listOf(
    "Volume & channel" to listOf("VolumeUp", "VolumeDown", "VolumeMute", "ChannelUp", "ChannelDown"),
    "Navigation" to listOf("DirectionUp", "DirectionDown", "DirectionLeft", "DirectionRight", "Select", "PrevChannel", "Menu", "Exit", "Guide", "Info", "Dvr"),
    "Playback" to listOf("Play", "Pause", "Rewind", "FastForward", "Stop", "Record"),
    "Colour keys" to listOf("Red", "Green", "Yellow", "Blue"),
    "Numbers" to listOf("Number1", "Number2", "Number3", "Number4", "Number5", "Number6", "Number7", "Number8", "Number9", "Number0"),
)

private fun keyLabel(key: String): String = when (key) {
    "Select" -> "OK"
    "Dvr" -> "DVR"
    "VolumeMute" -> "Mute"
    else -> RemoteLayout.LABEL_BY_BUTTON_KEY[key] ?: key
}

@Composable
fun ActivityEditor(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val draft = state.wizardDraft
    val step = state.wizardStep
    var confirmClose by remember { mutableStateOf(false) }

    BackHandler {
        if (step > 0) viewModel.setWizardStep(step - 1) else confirmClose = true
    }

    val canAdvance = when (step) {
        0 -> draft.name.isNotBlank()
        1 -> draft.roles.any { it.deviceId.isNotBlank() }
        else -> true
    }

    // Surface supplies the light content color; this screen is drawn outside the main Scaffold.
    androidx.compose.material3.Surface(color = MaterialTheme.colorScheme.background) {
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding(),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { confirmClose = true }) {
                Icon(Icons.Filled.Close, contentDescription = "Close without saving")
            }
            Text(
                if (draft.editActivityId == null) "New activity" else "Edit “${draft.name.ifBlank { "activity" }}”",
                fontSize = 18.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text("Step ${step + 1} of ${STEP_NAMES.size}", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 12.dp))
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            STEP_NAMES.forEachIndexed { i, name ->
                Box(
                    Modifier
                        .weight(1f)
                        .height(4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(if (i <= step) MaterialTheme.colorScheme.primary else MelodiousColors.KeyRaised)
                        .clickable(onClickLabel = "Go to $name", enabled = i < step || (i > step && canAdvance && draft.name.isNotBlank() && draft.roles.isNotEmpty())) {
                            viewModel.setWizardStep(i)
                        },
                )
            }
        }

        Box(Modifier.weight(1f)) {
            when (step) {
                0 -> NameStep(draft.name, draft.type, onChange = viewModel::updateWizardNameAndType)
                1 -> DevicesStep(draft.roles, state.devices, onChange = viewModel::updateWizardRoles)
                2 -> InputsStep(draft.roles, state.devices, onChange = viewModel::updateWizardRoles)
                3 -> StartEndStep(state, viewModel)
                else -> ButtonsStep(state, viewModel)
            }
        }

        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (step > 0) {
                OutlinedButton(onClick = { viewModel.setWizardStep(step - 1) }, modifier = Modifier.weight(1f).height(52.dp)) {
                    Text("Back", fontSize = 15.sp)
                }
            }
            Button(
                onClick = {
                    if (step < MelodiousViewModel.WIZARD_LAST_STEP) viewModel.setWizardStep(step + 1)
                    else viewModel.saveWizardActivity()
                },
                enabled = canAdvance && !state.wizardSaving,
                modifier = Modifier.weight(2f).height(52.dp),
            ) {
                if (state.wizardSaving) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    Spacer(Modifier.size(10.dp))
                    Text("Saving to hub…", fontSize = 15.sp)
                } else {
                    Text(
                        when (step) {
                            0 -> "Next: devices"
                            1 -> "Next: inputs"
                            2 -> "Next: start & end"
                            3 -> "Next: buttons"
                            else -> "Save activity"
                        },
                        fontSize = 15.sp,
                    )
                }
            }
        }
    }

    }

    if (confirmClose) {
        ConfirmDialog(
            title = "Discard changes?",
            text = "Nothing has been saved to the hub yet.",
            confirmLabel = "Discard",
            destructive = true,
            onConfirm = viewModel::closeActivityWizard,
            onDismiss = { confirmClose = false },
        )
    }
}

@Composable
private fun StepIntro(title: String, body: String) {
    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, fontSize = 26.sp, fontWeight = FontWeight.Medium, lineHeight = 32.sp)
        Text(body, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, lineHeight = 21.sp)
    }
}

// ---------------------------------------------------------------------------
// Step 1: name & type
// ---------------------------------------------------------------------------

@Composable
private fun NameStep(name: String, type: Int, onChange: (String, Int) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        StepIntro("What's this activity called?", "Pick a short name you'd say out loud, like “Watch TV” or “Xbox”.")
        OutlinedTextField(
            value = name,
            onValueChange = { onChange(it, type) },
            label = { Text("Name") },
            singleLine = true,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )
        Text("What kind of activity is it?", fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 20.dp, top = 28.dp, bottom = 12.dp))
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            HubActivity.ACTIVITY_TYPE_LABELS.forEach { (value, label) ->
                SelectableCard(title = label, selected = type == value, onClick = { onChange(name, value) })
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SelectableCard(title: String, selected: Boolean, onClick: () -> Unit, subtitle: String? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer else MelodiousColors.Card)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 60.dp)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp, color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
    }
}

// ---------------------------------------------------------------------------
// Step 2: devices by role
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DevicesStep(roles: List<WizardRoleDraft>, devices: List<HubDevice>, onChange: (List<WizardRoleDraft>) -> Unit) {
    var editingRole by remember { mutableStateOf<String?>(null) }
    var addingRole by remember { mutableStateOf(false) }
    val byId = devices.associateBy { it.id }
    val sortedRoles = roles.sortedBy { RoleLabels.order.indexOf(it.roleType).let { i -> if (i < 0) 99 else i } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        StepIntro("Which device does what?", "We use this to turn the right things on and set up the buttons for you.")
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            sortedRoles.forEach { role ->
                val device = byId[role.deviceId]
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(MelodiousColors.Card)
                        .clickable(onClickLabel = "Change ${RoleLabels.label(role.roleType)}") { editingRole = role.roleType }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    IconTile(device?.let(::deviceIcon) ?: Icons.Filled.Add, size = 40)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(RoleLabels.label(role.roleType), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(device?.name ?: "Choose a device", fontSize = 17.sp, fontWeight = FontWeight.Medium)
                    }
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val missing = RoleLabels.order.filter { type -> roles.none { it.roleType == type } }
            if (missing.isNotEmpty()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(20.dp))
                        .clickable(role = Role.Button) { addingRole = true }
                        .heightIn(min = 64.dp)
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp).padding(8.dp))
                    Text("Add another job", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    if (addingRole) {
        PickerSheet(title = "What should it do?", onDismiss = { addingRole = false }) {
            RoleLabels.order.filter { type -> roles.none { it.roleType == type } }.forEach { type ->
                SheetOption(RoleLabels.label(type)) {
                    addingRole = false
                    editingRole = type
                }
            }
        }
    }

    editingRole?.let { roleType ->
        val current = roles.firstOrNull { it.roleType == roleType }
        PickerSheet(title = RoleLabels.label(roleType), onDismiss = { editingRole = null }) {
            devices.forEach { device ->
                SheetOption(
                    title = device.name,
                    subtitle = listOf(device.manufacturer, device.model).filter { it.isNotBlank() }.joinToString(" "),
                    selected = current?.deviceId == device.id,
                ) {
                    editingRole = null
                    val updated = roles.filterNot { it.roleType == roleType } +
                        WizardRoleDraft(roleType, device.id, input = device.inputs.firstOrNull().takeIf { roleType != "PlayMovieActivityRole" && roleType != "KeyboardTextEntryActivityRole" })
                    onChange(updated)
                }
            }
            if (current != null) {
                SheetOption(title = "Not used in this activity", destructive = true) {
                    editingRole = null
                    onChange(roles.filterNot { it.roleType == roleType })
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Step 3: inputs
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InputsStep(roles: List<WizardRoleDraft>, devices: List<HubDevice>, onChange: (List<WizardRoleDraft>) -> Unit) {
    val byId = devices.associateBy { it.id }
    val withInputs = roles.distinctBy { it.deviceId }.filter { byId[it.deviceId]?.inputs?.isNotEmpty() == true }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        StepIntro(
            "Which input should each device use?",
            "When this activity starts, the hub switches each device to the input you pick here.",
        )
        if (withInputs.isEmpty()) {
            Text(
                "Nothing to set. None of these devices need input switching.",
                fontSize = 15.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        }
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            withInputs.forEach { role ->
                val device = byId.getValue(role.deviceId)
                val selected = roles.firstOrNull { it.deviceId == role.deviceId && it.input != null }?.input
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(MelodiousColors.Card).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        IconTile(deviceIcon(device), size = 36)
                        Text(device.name, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        device.inputs.forEach { input ->
                            FilterChip(
                                selected = input == selected,
                                onClick = {
                                    onChange(roles.map { if (it.deviceId == device.id) it.copy(input = input) else it })
                                },
                                label = { Text(input) },
                                modifier = Modifier.heightIn(min = 40.dp),
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ---------------------------------------------------------------------------
// Step 4: buttons
// ---------------------------------------------------------------------------

@Composable
private fun ButtonsStep(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val draft = state.wizardDraft
    val byId = state.devices.associateBy { it.id }
    var editingKey by rememberSaveable { mutableStateOf<String?>(null) }
    val total = BUTTON_GROUPS.sumOf { it.second.size }
    val mapped = BUTTON_GROUPS.sumOf { g -> g.second.count { it in draft.buttons } }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            StepIntro(
                "Check the buttons",
                "We filled these in from the devices you picked. Tap any button to change what it does. $mapped of $total set.",
            )
            TextButton(onClick = viewModel::resetWizardButtonsToDefaults, modifier = Modifier.padding(start = 8.dp)) {
                Text("Reset to suggested")
            }
        }
        BUTTON_GROUPS.forEach { (group, keys) ->
            item(key = "g-$group") {
                Text(group, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp))
            }
            item(key = "c-$group") {
                Column(Modifier.padding(horizontal = 16.dp).clip(RoundedCornerShape(24.dp)).background(MelodiousColors.Card)) {
                    keys.forEachIndexed { i, key ->
                        val mapping = draft.buttons[key]
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(onClickLabel = "Change ${keyLabel(key)}") { editingKey = key }
                                .heightIn(min = 56.dp)
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(keyLabel(key), fontSize = 16.sp, modifier = Modifier.weight(1f))
                            Text(
                                mapping?.let { "${byId[it.deviceId]?.name ?: "Device"} · ${it.commandName}" } ?: "Not set",
                                fontSize = 13.sp,
                                color = if (mapping == null) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1.4f),
                                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                            )
                        }
                        if (i < keys.lastIndex) androidx.compose.material3.HorizontalDivider(color = MelodiousColors.Divider)
                    }
                }
            }
        }
    }

    editingKey?.let { key ->
        val roleDevices = draft.roles.mapNotNull { byId[it.deviceId] }.distinctBy { it.id }
        CommandPickerSheet(
            title = keyLabel(key),
            devices = roleDevices,
            current = draft.buttons[key],
            onPick = { device, command ->
                viewModel.updateWizardButtonMapping(key, WizardButtonMapping(device.id, command.name, command.functionId))
                editingKey = null
            },
            onClear = {
                viewModel.updateWizardButtonMapping(key, null)
                editingKey = null
            },
            onDismiss = { editingKey = null },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun CommandPickerSheet(
    title: String,
    devices: List<HubDevice>,
    current: WizardButtonMapping?,
    onPick: (HubDevice, app.melodious.protocol.model.DeviceCommand) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    var deviceId by rememberSaveable { mutableStateOf(current?.deviceId ?: devices.firstOrNull()?.id) }
    var query by rememberSaveable { mutableStateOf("") }
    val device = devices.firstOrNull { it.id == deviceId }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.fillMaxHeight(0.9f)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("“$title” button", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                if (current != null) TextButton(onClick = onClear) { Text("Clear", color = MaterialTheme.colorScheme.error) }
            }
            FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                devices.forEach { d ->
                    FilterChip(selected = d.id == deviceId, onClick = { deviceId = d.id }, label = { Text(d.name) }, modifier = Modifier.heightIn(min = 40.dp))
                }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text("Search commands") },
                singleLine = true,
                shape = RoundedCornerShape(26.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
            val commands = device?.commands.orEmpty().filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
            // Open scrolled to the command this button already uses, so the checkmark is visible.
            val listState = androidx.compose.foundation.lazy.rememberLazyListState(
                initialFirstVisibleItemIndex = commands.indexOfFirst { it.name == current?.commandName && device?.id == current.deviceId }
                    .coerceAtLeast(0).let { (it - 2).coerceAtLeast(0) },
            )
            LazyColumn(Modifier.fillMaxWidth().weight(1f), state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                items(commands, key = { it.name }) { cmd ->
                    val isCurrent = current?.deviceId == device?.id && current?.commandName == cmd.name
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) { device?.let { onPick(it, cmd) } }
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(cmd.name, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        if (isCurrent) Icon(Icons.Filled.Check, contentDescription = "Current", tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PickerSheet(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            Text(title, fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 8.dp, bottom = 12.dp))
            content()
        }
    }
}

@Composable
private fun SheetOption(
    title: String,
    subtitle: String? = null,
    selected: Boolean = false,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f) else Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp, color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            if (!subtitle.isNullOrBlank()) Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
    }
}

// ---------------------------------------------------------------------------
// Step 4: power order and start/end steps
// ---------------------------------------------------------------------------

/** The hub sends power and input itself; Logitech never allowed them as start/end steps either. */
private fun isPowerOrInput(command: String): Boolean =
    command.startsWith("power", ignoreCase = true) || command.startsWith("input", ignoreCase = true)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StartEndStep(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val draft = state.wizardDraft
    val byId = state.devices.associateBy { it.id }
    val onOrder = app.melodious.protocol.graph.ActivityGraphBuilder.devicePowerOrders(draft.roles, draft.powerOnOrder)
        .entries.sortedBy { it.value }.map { it.key }
    val sameOff = draft.powerOffOrder.isEmpty() || draft.powerOffOrder.filter { it in onOrder } == onOrder
    val offOrder = if (sameOff) onOrder else app.melodious.protocol.graph.ActivityGraphBuilder.devicePowerOrders(draft.roles, draft.powerOffOrder)
        .entries.sortedBy { it.value }.map { it.key }
    val activityDevices = onOrder.mapNotNull { byId[it] }
    var pickingFor by remember { mutableStateOf<String?>(null) } // "enter" or "leave"

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        StepIntro("Start and end", "Choose the order devices turn on, and any extra commands to send when this activity starts or ends.")

        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Turn on in this order", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp))
            onOrder.forEachIndexed { i, deviceId ->
                val device = byId[deviceId] ?: return@forEachIndexed
                val delayMs = draft.roles.firstOrNull { it.deviceId == deviceId }?.powerDelay ?: 0
                OrderRow(
                    position = i + 1,
                    device = device,
                    canMoveUp = i > 0,
                    canMoveDown = i < onOrder.lastIndex,
                    onMove = { delta ->
                        val next = onOrder.toMutableList().apply { add((i + delta).coerceIn(0, lastIndex), removeAt(i)) }
                        viewModel.updateWizardPowerOrder(next, if (sameOff) emptyList() else offOrder)
                    },
                    trailing = if (i < onOrder.lastIndex) {
                        {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("then wait", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                // 0 is a chosen value, distinct from "never set" (null).
                                TextButton(onClick = { viewModel.updateWizardPowerDelay(deviceId, (delayMs - 500).coerceAtLeast(0)) }, enabled = delayMs > 0) { Text("−") }
                                Text(formatSeconds(delayMs / 1000.0), fontSize = 14.sp)
                                TextButton(onClick = { viewModel.updateWizardPowerDelay(deviceId, (delayMs + 500).coerceAtMost(30_000)) }) { Text("+") }
                            }
                        }
                    } else null,
                )
            }

            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(20.dp))
                    .clickable(role = Role.Switch) {
                        viewModel.updateWizardPowerOrder(onOrder, if (sameOff) onOrder.reversed() else emptyList())
                    }
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Turn off in the same order", fontSize = 15.sp, modifier = Modifier.weight(1f))
                androidx.compose.material3.Switch(checked = sameOff, onCheckedChange = null)
            }
            if (!sameOff) {
                Text("Turn off in this order", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp))
                offOrder.forEachIndexed { i, deviceId ->
                    val device = byId[deviceId] ?: return@forEachIndexed
                    OrderRow(
                        position = i + 1,
                        device = device,
                        canMoveUp = i > 0,
                        canMoveDown = i < offOrder.lastIndex,
                        onMove = { delta ->
                            val next = offOrder.toMutableList().apply { add((i + delta).coerceIn(0, lastIndex), removeAt(i)) }
                            viewModel.updateWizardPowerOrder(onOrder, next)
                        },
                        trailing = null,
                    )
                }
            }

            StepsSection(
                title = "When this activity starts",
                hint = "Sent after everything is on and on the right input.",
                steps = draft.enterSteps,
                devices = activityDevices,
                onChange = { viewModel.updateWizardSteps(it, draft.leaveSteps) },
                onAddCommand = { pickingFor = "enter" },
            )
            StepsSection(
                title = "When this activity ends",
                hint = "Sent before devices turn off.",
                steps = draft.leaveSteps,
                devices = activityDevices,
                onChange = { viewModel.updateWizardSteps(draft.enterSteps, it) },
                onAddCommand = { pickingFor = "leave" },
            )
        }
        Spacer(Modifier.height(24.dp))
    }

    pickingFor?.let { target ->
        ModalBottomSheet(
            onDismissRequest = { pickingFor = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        ) {
            Column(Modifier.fillMaxHeight(0.9f).padding(horizontal = 16.dp)) {
                Text("Add a command", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(bottom = 4.dp))
                Text("Power and input commands aren't listed: the hub already sends those.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                CommandPicker(activityDevices, selected = null, modifier = Modifier.weight(1f), exclude = ::isPowerOrInput) { picked ->
                    if (target == "enter") viewModel.updateWizardSteps(draft.enterSteps.orEmpty() + picked, draft.leaveSteps)
                    else viewModel.updateWizardSteps(draft.enterSteps, draft.leaveSteps.orEmpty() + picked)
                    pickingFor = null
                }
            }
        }
    }
}

@Composable
private fun StepsSection(
    title: String,
    hint: String,
    steps: List<app.melodious.protocol.graph.SequenceStep>?,
    devices: List<HubDevice>,
    onChange: (List<app.melodious.protocol.graph.SequenceStep>) -> Unit,
    onAddCommand: () -> Unit,
) {
    Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp))
        Text(hint, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp, bottom = 4.dp))
        if (steps == null) {
            Text(
                "This activity already has steps Melodious can't edit (such as channel changes). They're kept exactly as they are.",
                fontSize = 14.sp,
                color = MelodiousColors.Warning,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        } else {
            StepListEditor(steps, devices, emptyText = "Nothing extra.", onChange = onChange, onAddCommand = onAddCommand)
        }
    }
}

@Composable
private fun OrderRow(
    position: Int,
    device: HubDevice,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onMove: (Int) -> Unit,
    trailing: (@Composable () -> Unit)?,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(MelodiousColors.Card)
            .padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("$position", fontSize = 13.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(end = 12.dp))
            IconTile(deviceIcon(device), size = 36)
            Text(device.name, fontSize = 16.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f).padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            IconButton(onClick = { onMove(-1) }, enabled = canMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Move ${device.name} earlier") }
            IconButton(onClick = { onMove(1) }, enabled = canMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Move ${device.name} later") }
        }
        if (trailing != null) {
            Row(Modifier.padding(start = 24.dp)) { trailing() }
        }
    }
}
