package app.melodious.ui.activities

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.protocol.graph.SequenceDraft
import app.melodious.protocol.graph.SequenceStep
import app.melodious.protocol.graph.SoftButtonAction
import app.melodious.protocol.graph.SoftButtonDraft
import app.melodious.protocol.graph.TouchScreenDraft
import app.melodious.protocol.graph.TouchScreenGraph
import app.melodious.protocol.model.HubDevice
import app.melodious.ui.components.ConfirmDialog
import app.melodious.ui.theme.MelodiousColors

/** Which sheet is open over the editor. Indexes refer to the draft's lists; -1 means "new". */
private sealed interface EditorSheet {
    data class Button(val index: Int) : EditorSheet
    data class Sequence(val index: Int) : EditorSheet
}

/**
 * Edit an activity's on-screen buttons and the sequences they run. Changes stay in the draft until
 * Save, which goes through the same hub save as the activity editor.
 */
@Composable
fun TouchScreenEditor(state: MelodiousUiState, viewModel: MelodiousViewModel) {
    val draft = state.touchDraft ?: return
    val activity = state.activity(draft.activityId)
    var sheet by remember { mutableStateOf<EditorSheet?>(null) }
    var confirmClose by remember { mutableStateOf(false) }
    val close = { if (state.touchDraftDirty) confirmClose = true else viewModel.closeTouchEditor() }
    BackHandler(onBack = close)

    // Devices in the activity first: those are the ones its buttons usually control.
    val roleIds = activity?.roles?.map { it.deviceId }.orEmpty().toSet()
    val devices = state.devices.sortedBy { if (it.id in roleIds) 0 else 1 }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = close) { Icon(Icons.Filled.Close, contentDescription = "Close") }
                Column(Modifier.weight(1f)) {
                    Text("On-screen buttons", fontSize = 18.sp, fontWeight = FontWeight.Medium)
                    Text(activity?.name.orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Button(
                    onClick = viewModel::saveTouchDraft,
                    enabled = state.touchDraftDirty && !state.touchSaving,
                    modifier = Modifier.padding(end = 8.dp),
                ) {
                    if (state.touchSaving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else Text("Save")
                }
            }

            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp)) {
                item {
                    Text(
                        "These appear under More keys in this activity, and on remotes with a screen. A button sends one command or runs a sequence.",
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
                    )
                    SectionHeader("Buttons")
                }
                if (draft.buttons.isEmpty()) {
                    item { EmptyHint("No on-screen buttons yet.") }
                }
                itemsIndexed(draft.buttons, key = { i, b -> "b$i-${b.buttonId}-${b.label}" }) { i, button ->
                    ReorderRow(
                        title = button.label,
                        subtitle = describe(button, draft, state),
                        canMoveUp = i > 0,
                        canMoveDown = i < draft.buttons.lastIndex,
                        onMove = { delta -> viewModel.updateTouchDraft(draft.copy(buttons = draft.buttons.move(i, delta))) },
                        onClick = { sheet = EditorSheet.Button(i) },
                    )
                }
                item {
                    AddRow("Add button") { sheet = EditorSheet.Button(-1) }
                    SectionHeader("Sequences", Modifier.padding(top = 20.dp))
                    Text(
                        "A sequence runs several commands in order, with waits between them. For example: Home, wait 2 s, open an app.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                    )
                }
                if (draft.sequences.isEmpty()) {
                    item { EmptyHint("No sequences yet.") }
                }
                itemsIndexed(draft.sequences, key = { i, s -> "s$i-${s.key}" }) { i, seq ->
                    ReorderRow(
                        title = seq.name,
                        subtitle = "${seq.steps.size} step${if (seq.steps.size == 1) "" else "s"}",
                        canMoveUp = false,
                        canMoveDown = false,
                        onMove = {},
                        onClick = { sheet = EditorSheet.Sequence(i) },
                    )
                }
                item { AddRow("New sequence") { sheet = EditorSheet.Sequence(-1) } }
            }
        }
    }

    when (val s = sheet) {
        is EditorSheet.Button -> ButtonSheet(
            initial = draft.buttons.getOrNull(s.index),
            sequences = draft.sequences,
            devices = devices,
            onSave = { updated ->
                val buttons = if (s.index < 0) draft.buttons + updated else draft.buttons.mapIndexed { i, b -> if (i == s.index) updated else b }
                viewModel.updateTouchDraft(draft.copy(buttons = buttons))
                sheet = null
            },
            onDelete = if (s.index >= 0) ({
                viewModel.updateTouchDraft(draft.copy(buttons = draft.buttons.filterIndexed { i, _ -> i != s.index }))
                sheet = null
            }) else null,
            onDismiss = { sheet = null },
        )
        is EditorSheet.Sequence -> SequenceSheet(
            initial = draft.sequences.getOrNull(s.index),
            devices = devices,
            onTest = { steps -> viewModel.runSteps(steps, draft.activityId) },
            onSave = { updated ->
                val sequences = if (s.index < 0) draft.sequences + updated else draft.sequences.mapIndexed { i, q -> if (i == s.index) updated else q }
                viewModel.updateTouchDraft(draft.copy(sequences = sequences))
                sheet = null
            },
            onDelete = if (s.index >= 0) ({
                val key = draft.sequences[s.index].key
                // A button that ran this sequence would do nothing; remove those buttons with it.
                viewModel.updateTouchDraft(
                    draft.copy(
                        sequences = draft.sequences.filterIndexed { i, _ -> i != s.index },
                        buttons = draft.buttons.filterNot { (it.action as? SoftButtonAction.RunSequence)?.sequenceKey == key },
                    )
                )
                sheet = null
            }) else null,
            usedByButtons = draft.sequences.getOrNull(s.index)?.let { seq ->
                draft.buttons.count { (it.action as? SoftButtonAction.RunSequence)?.sequenceKey == seq.key }
            } ?: 0,
            onDismiss = { sheet = null },
        )
        null -> Unit
    }

    if (confirmClose) {
        ConfirmDialog(
            title = "Discard changes?",
            text = "Your button changes haven't been saved to the hub.",
            confirmLabel = "Discard",
            destructive = true,
            onConfirm = viewModel::closeTouchEditor,
            onDismiss = { confirmClose = false },
        )
    }
}

private fun <T> List<T>.move(index: Int, delta: Int): List<T> {
    val target = (index + delta).coerceIn(0, lastIndex)
    if (target == index) return this
    return toMutableList().apply { add(target, removeAt(index)) }
}

private fun describe(button: SoftButtonDraft, draft: TouchScreenDraft, state: MelodiousUiState): String = when (val action = button.action) {
    is SoftButtonAction.Command -> {
        val base = "${state.device(action.step.deviceId)?.name ?: "Device"} · ${action.step.command}"
        when (TouchScreenGraph.pressModeOf(button)) {
            "oneShot" -> "$base · One-shot"
            "custom" -> TouchScreenGraph.longPressOf(button)?.let { "$base · Hold: ${it.command}" } ?: base
            else -> base
        }
    }
    is SoftButtonAction.RunSequence -> "Runs “${draft.sequences.firstOrNull { it.key == action.sequenceKey }?.name ?: "missing sequence"}”"
}

@Composable
private fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(text, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, modifier = modifier.padding(start = 4.dp, top = 8.dp, bottom = 8.dp))
}

@Composable
private fun EmptyHint(text: String) {
    Text(text, fontSize = 14.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
}

@Composable
private fun ReorderRow(
    title: String,
    subtitle: String,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onMove: (Int) -> Unit,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .padding(vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(MelodiousColors.Card)
            .clickable(onClickLabel = "Edit $title", role = Role.Button, onClick = onClick)
            .heightIn(min = 64.dp)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
            Text(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (canMoveUp || canMoveDown) {
            IconButton(onClick = { onMove(-1) }, enabled = canMoveUp) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Move $title up") }
            IconButton(onClick = { onMove(1) }, enabled = canMoveDown) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Move $title down") }
        }
    }
}

@Composable
private fun AddRow(label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .padding(vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(20.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(label, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ---------------------------------------------------------------------------
// Button sheet
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ButtonSheet(
    initial: SoftButtonDraft?,
    sequences: List<SequenceDraft>,
    devices: List<HubDevice>,
    onSave: (SoftButtonDraft) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var label by rememberSaveable { mutableStateOf(initial?.label.orEmpty()) }
    var useSequence by rememberSaveable { mutableStateOf(initial?.action is SoftButtonAction.RunSequence) }
    var command by remember { mutableStateOf((initial?.action as? SoftButtonAction.Command)?.step) }
    var pressMode by rememberSaveable {
        mutableStateOf(initial?.let(TouchScreenGraph::pressModeOf) ?: command?.let { app.melodious.protocol.graph.ActivityGraphBuilder.recommendedPressMode(it.command) })
    }
    var longCommand by remember {
        mutableStateOf(initial?.let(TouchScreenGraph::longPressOf)?.takeIf { initial.let(TouchScreenGraph::pressModeOf) == "custom" })
    }
    var pickingHold by rememberSaveable { mutableStateOf(false) }
    var sequenceKey by rememberSaveable { mutableStateOf((initial?.action as? SoftButtonAction.RunSequence)?.sequenceKey) }
    val action: SoftButtonAction? = if (useSequence) sequenceKey?.let { SoftButtonAction.RunSequence(it) } else command?.let { SoftButtonAction.Command(it) }
    val effectiveMode = if (useSequence) null else pressMode ?: command?.let { app.melodious.protocol.graph.ActivityGraphBuilder.recommendedPressMode(it.command) }
    val canSave = action != null && label.isNotBlank() && (useSequence || effectiveMode != "custom" || longCommand != null)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.fillMaxHeight(0.92f).padding(horizontal = 16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (initial == null) "New button" else "Edit button", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                if (onDelete != null) {
                    IconButton(onClick = onDelete) { Icon(Icons.Outlined.Delete, contentDescription = "Delete button", tint = MaterialTheme.colorScheme.error) }
                }
            }
            OutlinedTextField(
                value = label,
                onValueChange = { label = it.take(MAX_LABEL) },
                label = { Text("Label") },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !useSequence, onClick = { useSequence = false }, label = { Text("Send a command") }, modifier = Modifier.heightIn(min = 40.dp))
                FilterChip(selected = useSequence, onClick = { useSequence = true; pickingHold = false }, label = { Text("Run a sequence") }, modifier = Modifier.heightIn(min = 40.dp))
            }
            if (useSequence) {
                if (sequences.isEmpty()) {
                    Text("Create a sequence first, under Sequences.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    sequences.forEach { seq ->
                        PickRow(seq.name, "${seq.steps.size} steps", selected = seq.key == sequenceKey) {
                            sequenceKey = seq.key
                            if (label.isBlank()) label = seq.name.take(MAX_LABEL)
                        }
                    }
                }
            } else {
                if (command != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("standard" to "Standard", "oneShot" to "One-shot", "custom" to "Separate Hold").forEach { (mode, modeLabel) ->
                            FilterChip(
                                selected = effectiveMode == mode,
                                onClick = {
                                    pressMode = mode
                                    if (mode != "custom") {
                                        longCommand = null
                                        pickingHold = false
                                    } else {
                                        pickingHold = true
                                    }
                                },
                                label = { Text(modeLabel) },
                                modifier = Modifier.heightIn(min = 36.dp),
                            )
                        }
                    }
                    if (effectiveMode == "custom") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(
                                selected = !pickingHold,
                                onClick = { pickingHold = false },
                                label = { Text("Press: ${command?.command.orEmpty()}") },
                                modifier = Modifier.heightIn(min = 36.dp),
                            )
                            FilterChip(
                                selected = pickingHold,
                                onClick = { pickingHold = true },
                                label = { Text(longCommand?.let { "Hold: ${it.command}" } ?: "Pick Hold command") },
                                modifier = Modifier.heightIn(min = 36.dp),
                            )
                        }
                    }
                }
                if (effectiveMode == "custom" && pickingHold) {
                    CommandPicker(devices, selected = longCommand, modifier = Modifier.weight(1f)) { picked ->
                        longCommand = picked
                        pressMode = "custom"
                    }
                } else {
                    CommandPicker(devices, selected = command, modifier = Modifier.weight(1f)) { picked ->
                        command = picked
                        if (effectiveMode != "custom") {
                            pressMode = app.melodious.protocol.graph.ActivityGraphBuilder.recommendedPressMode(picked.command)
                        }
                        if (label.isBlank()) label = app.melodious.protocol.graph.ActivityGraphBuilder.humanizeLabel(picked.command).take(MAX_LABEL)
                    }
                }
            }
            Button(
                onClick = {
                    action?.let { act ->
                        val resolvedLong = when (effectiveMode) {
                            "oneShot" -> command
                            "custom" -> longCommand
                            else -> null
                        }
                        onSave(
                            (initial ?: SoftButtonDraft(label, act)).copy(
                                label = label.trim(),
                                action = act,
                                pressMode = effectiveMode,
                                longPress = resolvedLong,
                            )
                        )
                    }
                },
                enabled = canSave,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(bottom = 12.dp),
            ) { Text("Done") }
        }
    }
}

// ---------------------------------------------------------------------------
// Sequence sheet
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SequenceSheet(
    initial: SequenceDraft?,
    devices: List<HubDevice>,
    usedByButtons: Int,
    onTest: (List<SequenceStep>) -> Unit,
    onSave: (SequenceDraft) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(initial?.name.orEmpty()) }
    var steps by remember { mutableStateOf(initial?.steps.orEmpty()) }
    var addingCommand by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.fillMaxHeight(0.92f).padding(horizontal = 16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (initial == null) "New sequence" else "Edit sequence", fontSize = 20.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                if (onDelete != null) {
                    IconButton(onClick = { if (usedByButtons > 0) confirmDelete = true else onDelete() }) {
                        Icon(Icons.Outlined.Delete, contentDescription = "Delete sequence", tint = MaterialTheme.colorScheme.error)
                    }
                }
            }
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(MAX_LABEL) },
                label = { Text("Name") },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            )

            if (addingCommand) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Pick a command to add", fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { addingCommand = false }) { Text("Cancel") }
                }
                CommandPicker(devices, selected = null, modifier = Modifier.weight(1f)) { picked ->
                    steps = steps + picked
                    addingCommand = false
                }
            } else {
                LazyColumn(Modifier.weight(1f)) {
                    if (steps.isEmpty()) {
                        item { EmptyHint("Add commands and waits. They run top to bottom.") }
                    }
                    itemsIndexed(steps) { i, step ->
                        Row(
                            Modifier
                                .padding(vertical = 3.dp)
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(16.dp))
                                .background(MelodiousColors.Card)
                                .heightIn(min = 56.dp)
                                .padding(start = 14.dp, end = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("${i + 1}", fontSize = 13.sp, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(end = 12.dp))
                            if (step is SequenceStep.Delay) {
                                Icon(Icons.Outlined.Timer, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(8.dp))
                                Text("Wait", fontSize = 15.sp, modifier = Modifier.weight(1f))
                                TextButton(onClick = { steps = steps.replace(i, SequenceStep.Delay((step.seconds - 0.5).coerceAtLeast(0.5))) }) { Text("−") }
                                Text(formatSeconds(step.seconds), fontSize = 15.sp, fontWeight = FontWeight.Medium)
                                TextButton(onClick = { steps = steps.replace(i, SequenceStep.Delay((step.seconds + 0.5).coerceAtMost(30.0))) }) { Text("+") }
                            } else {
                                Text(describe(step, devices), fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            }
                            IconButton(onClick = { steps = steps.move(i, -1) }, enabled = i > 0) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Move step ${i + 1} up") }
                            IconButton(onClick = { steps = steps.filterIndexed { j, _ -> j != i } }) { Icon(Icons.Filled.Close, contentDescription = "Remove step ${i + 1}") }
                        }
                    }
                    item {
                        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { addingCommand = true }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(6.dp))
                                Text("Command")
                            }
                            OutlinedButton(onClick = { steps = steps + SequenceStep.Delay(1.0) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                                Icon(Icons.Outlined.Timer, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(6.dp))
                                Text("Wait")
                            }
                        }
                    }
                }
            }

            if (!addingCommand) {
                Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = { onTest(steps) },
                        enabled = steps.any { it is SequenceStep.Command },
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Test")
                    }
                    Button(
                        onClick = {
                            onSave(
                                (initial ?: SequenceDraft(key = "new-${System.nanoTime()}", name = name, steps = steps))
                                    .copy(name = name.trim(), steps = steps)
                            )
                        },
                        enabled = name.isNotBlank() && steps.any { it is SequenceStep.Command },
                        modifier = Modifier.weight(2f).heightIn(min = 52.dp),
                    ) { Text("Done") }
                }
            }
        }
    }

    if (confirmDelete && onDelete != null) {
        ConfirmDialog(
            title = "Delete “$name”?",
            text = "$usedByButtons button${if (usedByButtons == 1) "" else "s"} run this sequence and will be removed too.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = onDelete,
            onDismiss = { confirmDelete = false },
        )
    }
}

private fun <T> List<T>.replace(index: Int, value: T): List<T> = mapIndexed { i, v -> if (i == index) value else v }

@Composable
private fun PickRow(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f) else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp)
            Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
    }
}

/** Long labels truncate on remotes with a screen. */
private const val MAX_LABEL = 24
