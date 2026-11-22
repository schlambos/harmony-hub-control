package app.melodious.ui.devices

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.melodious.CatalogTabState
import app.melodious.MelodiousUiState
import app.melodious.MelodiousViewModel
import app.melodious.ui.theme.MelodiousColors
import app.melodious.protocol.model.HubDevice
import kotlinx.coroutines.delay

/**
 * The Import sheet's Logitech catalog tab, mirroring the web sheet: intro,
 * account row, Brand/Model with the anonymous model check, Search, results
 * with Download, the preview (summary, first 24 rows, every skipped command
 * with its reason), Import, and "Open a catalog package…" at the bottom.
 */
@Composable
fun CatalogImportTab(
    state: MelodiousUiState,
    viewModel: MelodiousViewModel,
    device: HubDevice,
    onImported: () -> Unit,
) {
    val tab: CatalogTabState = state.catalogTab ?: CatalogTabState(deviceId = device.id)
    val context = LocalContext.current

    var brand by rememberSaveable(device.id) { mutableStateOf(device.manufacturer) }
    var model by rememberSaveable(device.id) { mutableStateOf(device.model) }
    val initialBrand = rememberSaveable(device.id) { device.manufacturer.trim() }
    val initialModel = rememberSaveable(device.id) { device.model.trim() }

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            val name = uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "catalog package"
            val text = runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    val bytes = input.readBytes()
                    if (bytes.size > 4 * 1024 * 1024) error("too large")
                    bytes.toString(Charsets.UTF_8)
                }
            }.getOrNull()
            if (text == null) {
                viewModel.openCatalogFileUnreadable(name)
            } else {
                viewModel.openCatalogFile(name, text)
            }
        }
    }

    // The model check: debounced 600 ms, never for pre-filled or blank values.
    // The ViewModel runs at most one at a time and this effect only shows a
    // result whose key still matches the displayed fields.
    LaunchedEffect(brand, model) {
        val m = brand.trim()
        val n = model.trim()
        if (m.isEmpty() || n.isEmpty() || (m == initialBrand && n == initialModel)) return@LaunchedEffect
        delay(600)
        viewModel.checkCatalogModel(m, n)
    }
    val modelCheckText = if (tab.modelCheckKey == "${brand.trim()}\u0000${model.trim()}") tab.modelCheck else ""

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            "Use the code set from Logitech's own catalog for ${device.manufacturer} ${device.model}. " +
                "Commands whose IR protocol this hub has, knows natively, or receives in the package are imported; any others are listed below, not dropped silently.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Account row
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    if (state.catalogSignedIn) "Signed in to Logitech" else "Logitech account",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    if (state.catalogSignedIn) "Your sign-in stays on this phone; the hub never sees it."
                    else "Sign in to search and download from Logitech's catalog.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (state.catalogSignedIn) {
                OutlinedButton(
                    onClick = { viewModel.catalogSignOut() },
                    enabled = !state.catalogBusy,
                ) { Text("Sign out") }
            } else {
                Button(
                    onClick = { viewModel.catalogSignIn() },
                    enabled = !state.catalogBusy,
                ) { Text("Sign in") }
            }
        }

        OutlinedTextField(
            value = brand,
            onValueChange = { if (it.length <= 64) brand = it },
            label = { Text("Brand") },
            placeholder = { Text("e.g. Sony") },
            singleLine = true,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = model,
                onValueChange = { if (it.length <= 64) model = it },
                label = { Text("Model") },
                placeholder = { Text("e.g. STR-DG720") },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            if (modelCheckText.isNotEmpty()) {
                Text(
                    modelCheckText,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Button(
            onClick = { viewModel.catalogSearch(brand, model) },
            enabled = !state.catalogBusy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            if (state.catalogBusy) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text("Search Logitech catalog")
        }

        if (tab.status.isNotEmpty()) {
            Text(
                tab.status,
                fontSize = 14.sp,
                color = if (tab.statusError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // Search results
        tab.matches.forEach { match ->
            val detail = listOf(match.deviceType, match.description).filter { it.isNotEmpty() }.joinToString(" · ")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(match.displayText, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                    if (detail.isNotEmpty()) {
                        Text(detail, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                OutlinedButton(
                    onClick = { viewModel.catalogDownload(match) },
                    enabled = !state.catalogBusy,
                ) { Text("Download") }
            }
            HorizontalDivider(color = MelodiousColors.Divider)
        }

        // Preview
        val preview = tab.preview
        if (preview != null) {
            Text(tab.previewSummary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            val missingHint = app.melodious.protocol.catalog.missingProtocolsHint(preview.missingProtocols)
            if (missingHint.isNotEmpty()) {
                Text(
                    missingHint,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val sample = preview.rows.take(24).joinToString("\n") { row ->
                "${row.name} · ${row.protocol.ifEmpty { "raw" }}"
            }
            Text(
                sample.ifEmpty { "(no importable commands)" },
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp),
            )
            if (preview.skipped.isNotEmpty()) {
                Text("Skipped:", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    preview.skipped.joinToString("\n") { "${it.name} — ${it.reason}" },
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp),
                )
            }
            Button(
                onClick = { viewModel.catalogImport(device, onImported) },
                enabled = preview.rows.isNotEmpty() && !state.catalogBusy,
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Text("Import ${preview.rows.size} command${if (preview.rows.size == 1) "" else "s"} to ${device.name}")
            }
        }

        OutlinedButton(
            onClick = { filePicker.launch(arrayOf("application/json", "text/plain", "text/json")) },
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("Open a catalog package…")
        }
        Text(
            "Or open a harmony-catalog-*.json file from tools/catalog/harmony_catalog.py. " +
                "Your Logitech sign-in stays on this phone; the hub never sees it.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
