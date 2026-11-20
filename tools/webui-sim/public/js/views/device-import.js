/* Import codes, the app's ImportSheet, for one device: Find codes (IRDB
   search and a code file), Paste (with RemoteCentral) and Type a code.

   The library index and its files are fetched by this browser, never by
   the hub, and only after a click on Search IRDB or Preview; only the final
   Import posts codes to the hub (/api/irdb-import). tools/harmony_shell_smoke.mjs
   pins that to the functions and button seams below. Everything from a
   library or a file is built with textContent, never innerHTML. */

import { getJson, importCatalog, postApiForm } from "../api.js";
import { catalogRows, describeCatalogRows, isCatalogPackage, supportedHubProtocolNames } from "../logitech-catalog.js";
import * as hub from "../state.js";
import { clear, el, setText } from "../setup-kit.js";
import { openSheet, snackbar } from "../ui/shell.js";
import { changeNote, renderCommandForm, saveCommand, setMessage } from "./device-sheets.js";
import { LIMITS, normalizeRemoteCentralPath, remoteCentralCommands } from "./ir-model.js";
import {
  DOC_LINKS,
  describeCodeSet,
  fetchLibraryFile,
  filterLibraryIndex,
  formatSourceErrors,
  loadLibraryIndex,
  parseLibraryText,
  planImport,
  rowsToImportPayload,
} from "../ir-library.js";

const TABS = [
  { id: "find", label: "Find codes" },
  { id: "catalog", label: "Logitech catalog" },
  { id: "paste", label: "Paste" },
  { id: "type", label: "Type a code" },
];

let sheetCount = 0;

export function openImportSheet({ device }) {
  const id = `import${(sheetCount += 1)}`;
  const refs = {};
  const findState = {
    matches: [],
    preview: null, // { path, source, format, rows, supported, text, plan }
    indexError: "",
    sourceErrors: [],
  };
  let importing = false;
  let commandForm = null;

  /* ---------------- tiny builders ---------------- */
  function button(label, className, onClick, extra = {}) {
    const b = el("button", {
      text: label,
      className: `btn ${className}`,
      attrs: { type: "button", ...(extra.attrs || {}) },
    });
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function field(labelText, input, hint) {
    const children = [el("label", { text: labelText, attrs: { for: input.id } }), input];
    if (hint) children.push(el("p", { className: "m-field-hint", text: hint }));
    return el("div", { className: "m-field", children });
  }

  function textInput(inputId, { value = "", placeholder = "", maxlength } = {}) {
    return el("input", {
      attrs: { id: `${id}${inputId}`, type: "text", value, placeholder, maxlength, autocomplete: "off", spellcheck: "false" },
    });
  }

  function status() {
    return el("p", { className: "form-msg", attrs: { role: "status", "aria-live": "polite" } });
  }

  function message(kind, text) {
    return el("p", { className: "form-msg", text, attrs: { "data-kind": kind } });
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function existingCount() {
    return hub.deviceById(device.id)?.commands.length ?? 0;
  }

  /* An import is written in one request; afterwards the device page shows
     the new commands, so the sheet closes, as in the app. */
  async function sendImport(payload, statusEl, buttonEl) {
    importing = true;
    buttonEl.disabled = true;
    setMessage(statusEl, "Importing… the hub backs up its device list first.");
    try {
      const j = await postApiForm("/api/irdb-import", { deviceId: device.id, payload });
      try {
        await hub.refreshConfig();
      } catch (_) {
        // The import is in; the page catches up on its next read.
      }
      refs.close();
      snackbar(`Imported to ${device.name}. ${j.message || ""}`.trim());
    } catch (error) {
      setMessage(statusEl, error.message || "Import failed.", "error");
    } finally {
      importing = false;
      buttonEl.disabled = false;
    }
  }

  /* ---------------- Paste ---------------- */

  /* Pasted text goes through the same parser and plan as Find codes, and the
     hub receives the transformed pipe payload, not the raw paste. */
  function pastedImportPlan() {
    const parsed = parseLibraryText(refs.importPayload.value);
    const plan = planImport(parsed.rows, existingCount());
    const payload = rowsToImportPayload(parsed.rows, { max: plan.willImport });
    return { parsed, plan, payload };
  }

  function updateImportPreview() {
    const { parsed, plan, payload } = pastedImportPlan();
    const raw = parsed.rows.filter((r) => r.supported && r.mode === "raw").length;
    const keycode = parsed.rows.filter((r) => r.supported && r.mode === "keycode").length;
    setText(refs.importPreview, parsed.rows.length
      ? `${plan.summary} (${raw} raw, ${keycode} keycode.)${plan.truncated ? ` ${plan.notes.at(-1)}` : ""}`
      : "");
    refs.importBtn.disabled = importing || plan.willImport <= 0 || !payload.trim();
    setText(refs.importBtn, plan.willImport > 0 ? `Import ${plural(plan.willImport, "command")}` : "Import");
  }

  async function doImport() {
    const { plan, payload } = pastedImportPlan();
    if (plan.found <= 0) {
      setMessage(refs.importStatus, "Paste some codes to import first.", "error");
      return;
    }
    if (plan.willImport <= 0 || !payload.trim()) {
      setMessage(refs.importStatus, plan.supported <= 0
        ? `No supported commands to import (${plan.summary})`
        : "Nothing is left to send after the checks.", "error");
      return;
    }
    await sendImport(payload, refs.importStatus, refs.importBtn);
  }

  /* RemoteCentral: the hub fetches the page itself (an outbound exception
     that predates the browser-side search), and only on Fetch. */
  async function doRemoteCentral() {
    const path = normalizeRemoteCentralPath(refs.rcPath.value);
    if (!path.startsWith("/cgi-bin/codes/")) {
      setMessage(refs.rcStatus, "The path has to stay inside /cgi-bin/codes/; the hub refuses anything else.", "error");
      return;
    }
    refs.rcBtn.disabled = true;
    clear(refs.rcResults);
    setMessage(refs.rcStatus, "Asking the hub to fetch it (this goes online and may time out)…");
    try {
      const j = await getJson(`/api/remotecentral-fetch?path=${encodeURIComponent(path)}`);
      if (!j.ok) {
        setMessage(refs.rcStatus, `RemoteCentral fetch failed: ${j.error || "unknown error"}. Nothing was imported.`, "warn");
        return;
      }
      const rows = remoteCentralCommands(j.html);
      if (!rows.length) {
        setMessage(refs.rcStatus, "The page has no Pronto codes to convert.", "info");
        return;
      }
      setMessage(refs.rcStatus, `Found ${plural(rows.length, "Pronto code")}. Add the ones you want to the paste box.`, "ok");
      const list = el("div", { className: "m-list" });
      rows.forEach((r) => {
        const add = button("Add", "btn-outlined btn-sm", () => {
          if (!r.raw) return;
          const name = r.name.replace(/[|,"\\]/g, "").trim() || "Command";
          refs.importPayload.value += `${name}|raw|${r.raw}\n`;
          updateImportPreview();
          setMessage(refs.importStatus, `Added “${name}” to the paste box.`);
        });
        if (!r.raw) add.disabled = true;
        list.appendChild(el("div", {
          className: "m-row",
          children: [
            el("span", { className: "m-row-text", children: [
              el("span", { className: "m-row-title", text: r.name }),
              el("span", { className: "m-row-sub mono", text: r.raw ? `raw ${r.raw.slice(0, 40)}…` : "unsupported Pronto format" }),
            ] }),
            add,
          ],
        }));
      });
      refs.rcResults.appendChild(list);
    } catch (error) {
      setMessage(refs.rcStatus, `RemoteCentral fetch failed: ${error.message}.`, "error");
    } finally {
      refs.rcBtn.disabled = false;
    }
  }

  /* ---------------- Find codes ---------------- */
  function renderFindResults() {
    clear(refs.findResults);
    if (findState.indexError) {
      refs.findResults.appendChild(message("error", findState.indexError));
      return;
    }
    if (findState.sourceErrors.length) {
      refs.findResults.appendChild(message("warn", formatSourceErrors(findState.sourceErrors)));
    }
    if (!findState.matches.length) return;
    const list = el("div", { className: "m-list import-results" });
    findState.matches.forEach((m) => {
      const btn = button("Preview", "btn-outlined btn-sm", () => previewLibraryEntry(m));
      const detail = m.summary
        ? `${m.source} · ${describeCodeSet(m.summary.rows).label}`
        : m.summaryError
          ? `${m.source} · couldn't load this file`
          : m.source;
      list.appendChild(el("div", {
        className: "m-row",
        children: [
          el("span", { className: "m-row-text", children: [
            el("span", { className: "m-row-title mono", text: m.path }),
            el("span", { className: "m-row-sub", text: detail }),
          ] }),
          btn,
        ],
      }));
    });
    refs.findResults.appendChild(list);
  }

  function renderFindPreview() {
    clear(refs.findPreview);
    const p = findState.preview;
    if (!p) {
      refs.findImportBtn.hidden = true;
      return;
    }
    const plan = planImport(p.rows, existingCount());
    p.plan = plan;
    const sample = p.rows
      .filter((r) => r.supported)
      .slice(0, 24)
      .map((r) => `${r.name} · ${r.mode} · ${r.meta || ""}`)
      .join("\n");
    refs.findPreview.appendChild(el("div", {
      className: "m-card import-preview",
      children: [
        el("p", { className: "import-source mono", text: `${p.source} · ${p.path || p.filename || "file"} · ${p.format}` }),
        el("p", { text: plan.summary }),
        el("p", { className: "m-field-hint", text: plan.notes.slice(1).join(" ") }),
        el("pre", { className: "import-rows mono", text: sample || "(no supported commands)" }),
      ],
    }));
    refs.findImportBtn.hidden = false;
    refs.findImportBtn.disabled = importing || plan.willImport <= 0;
    setText(refs.findImportBtn, plan.willImport > 0 ? `Import ${plural(plan.willImport, "command")} to ${device.name}` : "Nothing to import");
  }

  async function doFindSearch() {
    const q = {
      manufacturer: refs.findMfr.value.trim(),
      model: refs.findModel.value.trim(),
      type: device.typeLabel || "",
    };
    refs.findSearchBtn.disabled = true;
    findState.indexError = "";
    findState.sourceErrors = [];
    findState.matches = [];
    findState.preview = null;
    setMessage(refs.findStatus, "Loading the IRDB index in this browser…");
    renderFindResults();
    renderFindPreview();
    try {
      const { entries, errors, skipped } = await loadLibraryIndex({ sources: ["irdb"] });
      findState.sourceErrors = errors;
      const { matches, totalMatches, message: text } = filterLibraryIndex(entries, q, { sourceErrors: errors });
      findState.matches = matches;
      /* Annotate the best few code sets with what they actually contain
         (discrete power? inputs? how many commands?) so the owner can pick
         without previewing 40 files. Only the top rows are fetched. */
      const annotated = matches.slice(0, 8);
      await Promise.all(annotated.map(async (m) => {
        try {
          const text = await fetchLibraryFile(m);
          const parsed = parseLibraryText(text, { filename: m.path, formatHint: "irdb-csv" });
          m.summary = parsed;
        } catch (error) {
          m.summaryError = error.message || String(error);
        }
      }));
      if (annotated.length) {
        annotated.sort((a, b) =>
          (describeCodeSet(b.summary?.rows ?? []).rank - describeCodeSet(a.summary?.rows ?? []).rank)
          || b.score - a.score || a.path.localeCompare(b.path));
        findState.matches = [...annotated, ...matches.slice(annotated.length)];
      }
      /* Skipped rows describe the index, not a failed source, so they only add a
         note; the severity still follows the matches and the errors. */
      let statusText = skipped
        ? `${text} Skipped ${skipped} index entr${skipped === 1 ? "y" : "ies"} with unusable file names.`
        : text;
      if (q.model && totalMatches) {
        statusText +=
          ` IRDB files code sets by maker, type and remote address, not by model — ` +
          `code sets that match ${device.typeLabel || "this type"} of device come first. ` +
          "Preview one, then try Power and an input before you rely on it.";
      }
      setMessage(refs.findStatus, statusText, !matches.length || errors.length ? "warn" : "ok");
      renderFindResults();
    } catch (error) {
      findState.indexError = error.message || String(error);
      setMessage(refs.findStatus, findState.indexError, "error");
      renderFindResults();
    } finally {
      refs.findSearchBtn.disabled = false;
    }
  }

  async function previewLibraryEntry(entry) {
    setMessage(refs.findStatus, `Fetching ${entry.path} in this browser…`);
    refs.findSearchBtn.disabled = true;
    try {
      const text = await fetchLibraryFile(entry);
      const parsed = parseLibraryText(text, {
        filename: entry.path,
        formatHint: entry.source === "irdb" ? "irdb-csv" : entry.source === "flipper" ? "flipper" : "",
      });
      findState.preview = { ...parsed, source: entry.source, path: entry.path, text };
      setMessage(refs.findStatus, parsed.supported
        ? `Preview ready: ${plural(parsed.supported, "supported command")}.`
        : "The file loaded, but no supported commands were decoded.", parsed.supported ? "ok" : "warn");
      renderFindPreview();
      refs.findPreview.scrollIntoView({ block: "nearest" });
    } catch (error) {
      setMessage(refs.findStatus, error.message || "Fetch failed.", "error");
    } finally {
      refs.findSearchBtn.disabled = false;
    }
  }

  function previewLocalFile(file, text) {
    const parsed = parseLibraryText(text, { filename: file.name });
    findState.preview = { ...parsed, source: "file", filename: file.name, path: file.name, text };
    findState.matches = [];
    renderFindResults();
    renderFindPreview();
    setMessage(refs.findStatus,
      `Detected ${parsed.format} · ${plural(parsed.supported, "supported command")} in ${file.name}.`,
      parsed.supported ? "ok" : "warn");
  }

  async function doFindImport() {
    const p = findState.preview;
    if (!p?.rows?.length) {
      setMessage(refs.findStatus, "Nothing to import yet: preview a file with supported commands first.", "error");
      return;
    }
    const plan = planImport(p.rows, existingCount());
    const payload = rowsToImportPayload(p.rows, { max: plan.willImport });
    if (!payload || plan.willImport <= 0) {
      setMessage(refs.findStatus, `No importable rows (${plan.summary})`, "error");
      return;
    }
    await sendImport(payload, refs.findStatus, refs.findImportBtn);
  }

  /* ---------------- Logitech catalog ---------------- */
  const catalogState = {
    pkg: null,
    rows: [],
    skipped: [],
    protocols: null,
    protocolsUsed: [],
    missingProtocols: [],
    signedIn: false,
    matches: [],
    initialBrand: String(device.manufacturer ?? "").trim(),
    initialModel: String(device.model ?? "").trim(),
    modelTimer: null,
    modelInFlight: false,
    modelVersion: 0,
    modelPending: null,
    busy: false,
    closed: false,
  };
  let desktop = null;

  function clearCatalogPackage() {
    Object.assign(catalogState, { pkg: null, rows: [], skipped: [], protocolsUsed: [], missingProtocols: [] });
    renderCatalogPreview();
  }

  function setCatalogBusy(busy) {
    catalogState.busy = busy;
    for (const node of [refs.catalogSearchBtn, refs.catalogSignInBtn, refs.catalogSignOutBtn, refs.catalogFile, ...refs.catalogResults.querySelectorAll("button")]) node.disabled = busy;
    refs.catalogImportBtn.disabled = busy || importing || !catalogState.rows.length;
  }

  async function loadHubProtocols() {
    if (Array.isArray(catalogState.protocols)) return catalogState.protocols;
    try {
      const res = await fetch("/export/protocols", { cache: "no-store" });
      if (!res.ok) return null;
      const names = supportedHubProtocolNames(JSON.parse(await res.text()));
      if (!names) return null;
      catalogState.protocols = names;
      return catalogState.protocols;
    } catch (_) {
      return null;
    }
  }

  function renderCatalogAccount() {
    if (!refs.catalogAccount) return;
    clear(refs.catalogAccount);
    refs.catalogAccount.append(
      el("span", {
        className: "m-row-text",
        children: [
          el("span", {
            className: "m-row-title",
            text: catalogState.signedIn ? "Signed in to Logitech" : "Logitech account",
          }),
          el("span", {
            className: "m-row-sub",
            text: catalogState.signedIn
              ? "Your sign-in stays on this Mac; the hub never sees it."
              : "Sign in to search and download from Logitech's catalog.",
          }),
        ],
      }),
      catalogState.signedIn ? refs.catalogSignOutBtn : refs.catalogSignInBtn,
    );
  }

  function renderCatalogResults() {
    if (!refs.catalogResults) return;
    clear(refs.catalogResults);
    if (!catalogState.matches.length) return;
    const list = el("div", { className: "m-list import-results" });
    catalogState.matches.forEach((m) => {
      const title = m.displayText || `${m.manufacturer || ""} ${m.model || ""}`.trim() || "Device";
      const detail = [m.deviceType, m.description].filter(Boolean).join(" · ");
      const btn = button("Download", "btn-outlined btn-sm", () => doCatalogDownload(m));
      list.appendChild(el("div", {
        className: "m-row",
        children: [
          el("span", { className: "m-row-text", children: [
            el("span", { className: "m-row-title", text: title }),
            ...(detail ? [el("span", { className: "m-row-sub", text: detail })] : []),
          ] }),
          btn,
        ],
      }));
    });
    refs.catalogResults.appendChild(list);
  }

  function renderCatalogPreview() {
    clear(refs.catalogPreview);
    refs.catalogImportBtn.hidden = !catalogState.rows.length;
    refs.catalogImportBtn.disabled = importing || catalogState.busy || !catalogState.rows.length;
    if (!catalogState.pkg) return;
    const summary = describeCatalogRows({
      rows: catalogState.rows,
      skipped: catalogState.skipped,
      protocolsUsed: catalogState.protocolsUsed,
      missingProtocols: catalogState.missingProtocols,
    });
    const sample = catalogState.rows.slice(0, 24).map((r) => `${r.name} · ${r.protocol || "raw"}`).join("\n");
    const skippedSample = catalogState.skipped.map((s) => `${s.name} — ${s.reason}`).join("\n");
    refs.catalogPreview.appendChild(el("div", {
      className: "m-card import-preview",
      children: [
        el("p", { text: summary }),
        el("pre", { className: "import-rows mono", text: sample || "(no importable commands)" }),
        ...(skippedSample
          ? [el("p", { className: "m-field-hint", text: "Skipped:" }), el("pre", { className: "import-rows mono", text: skippedSample })]
          : []),
      ],
    }));
    setText(refs.catalogImportBtn, catalogState.rows.length
      ? `Import ${plural(catalogState.rows.length, "command")} to ${device.name}` : "Nothing to import");
  }

  async function previewCatalogPackage(pkg, label) {
    if (!isCatalogPackage(pkg)) {
      setMessage(refs.catalogStatus, `${label} is not a Logitech catalog package from tools/catalog/harmony_catalog.py.`, "error");
      return;
    }
    catalogState.pkg = pkg;
    const protocols = await loadHubProtocols();
    const converted = catalogRows(pkg, protocols ?? []);
    catalogState.rows = converted.rows;
    catalogState.skipped = converted.skipped;
    catalogState.protocolsUsed = converted.protocolsUsed;
    catalogState.missingProtocols = converted.missingProtocols;
    renderCatalogPreview();
    setMessage(refs.catalogStatus,
      protocols !== null
        ? `Loaded ${label}: ${describeCatalogRows(converted)}.`
        : `Loaded ${label}, but the hub's protocol list couldn't be read, so no KeyCode can be checked yet.`,
      converted.rows.length ? "ok" : "warn");
  }

  async function previewCatalogFile(file, text) {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (_) {
      setMessage(refs.catalogStatus, `${file.name} is not a catalog package (not JSON).`, "error");
      return;
    }
    await previewCatalogPackage(pkg, file.name);
  }

  async function doCatalogSignIn() {
    if (!desktop || catalogState.busy) return;
    setCatalogBusy(true);
    setMessage(refs.catalogStatus, "Signing in to Logitech…");
    try {
      const res = await desktop.signIn();
      catalogState.signedIn = Boolean(res?.signedIn);
      renderCatalogAccount();
      setMessage(
        refs.catalogStatus,
        catalogState.signedIn ? "Signed in to Logitech." : "",
        catalogState.signedIn ? "ok" : "info",
      );
    } catch (error) {
      setMessage(refs.catalogStatus, error.message || "Sign-in failed.", "error");
    } finally {
      setCatalogBusy(false);
    }
  }

  async function doCatalogSignOut() {
    if (!desktop || catalogState.busy) return;
    setCatalogBusy(true);
    try {
      await desktop.signOut();
      catalogState.signedIn = false;
      renderCatalogAccount();
      setMessage(refs.catalogStatus, "Signed out of Logitech.");
    } catch (error) {
      setMessage(refs.catalogStatus, error.message || "Sign-out failed.", "error");
    } finally {
      setCatalogBusy(false);
    }
  }

  function checkCatalogModel() {
    if (!desktop) return;
    clearTimeout(catalogState.modelTimer);
    const version = ++catalogState.modelVersion;
    setText(refs.catalogModelCheck, "");
    const mfr0 = refs.catalogBrand.value.trim();
    const mdl0 = refs.catalogModel.value.trim();
    if (!mfr0 || !mdl0 || (mfr0 === catalogState.initialBrand && mdl0 === catalogState.initialModel)) {
      setText(refs.catalogModelCheck, "");
      return;
    }
    catalogState.modelTimer = setTimeout(async () => {
      if (catalogState.modelPending) await catalogState.modelPending;
      if (version !== catalogState.modelVersion || catalogState.closed) return;
      const mfr = refs.catalogBrand.value.trim();
      const mdl = refs.catalogModel.value.trim();
      if (catalogState.modelInFlight || !mfr || !mdl || (mfr === catalogState.initialBrand && mdl === catalogState.initialModel)) return;
      catalogState.modelInFlight = true;
      try {
        const request = desktop.checkModel({ manufacturer: mfr, model: mdl });
        catalogState.modelPending = request.then(() => {}, () => {});
        const res = await request;
        if (version !== catalogState.modelVersion || catalogState.closed || refs.catalogBrand.value.trim() !== mfr || refs.catalogModel.value.trim() !== mdl) return;
        setText(refs.catalogModelCheck, res?.found ? `Logitech knows this as ${res.model || mdl}` : "Not found under that name");
      } catch (_) {
        if (version === catalogState.modelVersion) setText(refs.catalogModelCheck, "");
      } finally {
        catalogState.modelInFlight = false;
        catalogState.modelPending = null;
      }
    }, 600);
  }

  function handleCatalogError(error, fallback) {
    if (/sign in/i.test(error?.message || "")) {
      catalogState.signedIn = false;
      renderCatalogAccount();
    }
    setMessage(refs.catalogStatus, error?.message || fallback, "error");
  }

  async function doCatalogSearch() {
    if (!desktop || catalogState.busy) return;
    const manufacturer = refs.catalogBrand.value.trim();
    const model = refs.catalogModel.value.trim();
    if (!manufacturer || !model) {
      setMessage(refs.catalogStatus, "Enter both the brand and the model (part of the model is enough).", "error");
      return;
    }
    setCatalogBusy(true);
    catalogState.matches = [];
    clearCatalogPackage();
    renderCatalogResults();
    renderCatalogPreview();
    setMessage(refs.catalogStatus, "Searching Logitech's catalog…");
    try {
      const matches = await desktop.search({ manufacturer, model });
      catalogState.signedIn = true;
      renderCatalogAccount();
      catalogState.matches = Array.isArray(matches) ? matches : [];
      renderCatalogResults();
      const n = catalogState.matches.length;
      setMessage(refs.catalogStatus, n ? `Found ${n} catalog match${n === 1 ? "" : "es"}. Pick one to download its commands.` : `No catalog device matches ${manufacturer} ${model}`, n ? "ok" : "warn");
    } catch (error) {
      handleCatalogError(error, "Catalog search failed.");
    } finally {
      setCatalogBusy(false);
    }
  }

  async function doCatalogDownload(match) {
    if (!desktop || !match || catalogState.busy) return;
    const manufacturer = String(match.manufacturer || refs.catalogBrand.value || "").trim();
    const model = String(match.model || refs.catalogModel.value || "").trim();
    setCatalogBusy(true);
    clearCatalogPackage();
    setMessage(refs.catalogStatus, `Downloading ${match.displayText || `${manufacturer} ${model}`.trim()} from Logitech…`);
    try {
      const pkg = await desktop.download({ id: Number(match.id), manufacturer, model });
      catalogState.signedIn = true;
      renderCatalogAccount();
      await previewCatalogPackage(pkg, "Logitech catalog");
    } catch (error) {
      handleCatalogError(error, "Catalog download failed.");
    } finally {
      setCatalogBusy(false);
    }
  }

  async function doCatalogImport() {
    if (desktop && catalogState.busy) return;
    if (!catalogState.rows.length) {
      setMessage(refs.catalogStatus, "Nothing to import yet: open a catalog package with importable commands first.", "error");
      return;
    }
    importing = true;
    if (desktop) setCatalogBusy(true);
    refs.catalogImportBtn.disabled = true;
    setMessage(refs.catalogStatus, "Importing… the hub backs up its device list first.");
    try {
      const j = await importCatalog({ deviceId: device.id, commands: catalogState.rows });
      try { await hub.refreshConfig(); } catch (_) { /* page catches up */ }
      refs.close();
      snackbar(`Imported to ${device.name}. ${j.message || ""}`.trim());
    } catch (error) {
      const msg = desktop && error?.status === 404
        ? "Your hub's Melodious software is older than this app; update the hub"
        : error.message || "Import failed.";
      setMessage(refs.catalogStatus, msg, "error");
    } finally {
      importing = false;
      if (desktop) setCatalogBusy(false);
      refs.catalogImportBtn.disabled = false;
    }
  }

  /* ---------------- Type a code ---------------- */
  async function doAddCommand() {
    refs.addBtn.disabled = true;
    setMessage(refs.addStatus, "Adding the command…");
    try {
      const result = await saveCommand(device, null, commandForm.values());
      refs.close();
      snackbar(changeNote(result, `Saved “${commandForm.values().name.trim()}”`));
    } catch (error) {
      setMessage(refs.addStatus, error.message || "Saving failed.", "error");
    } finally {
      refs.addBtn.disabled = false;
    }
  }

  /* ---------------- tabs ---------------- */
  function showTab(tab) {
    if (desktop && tab !== "catalog") {
      clearTimeout(catalogState.modelTimer);
      catalogState.modelVersion++;
    }
    refs.tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    for (const t of TABS) refs.panels[t.id].hidden = t.id !== tab;
    if (tab === "catalog" && desktop) {
      Promise.resolve(desktop.status()).then((s) => {
        if (catalogState.busy || catalogState.closed) return;
        catalogState.signedIn = Boolean(s?.signedIn);
        renderCatalogAccount();
      }).catch(() => {});
    }
  }

  /* ---------------- mount (static skeleton) ---------------- */
  function mount(content, close) {
    desktop = window.melodiousDesktop?.catalog;
    refs.close = close;
    refs.panels = {};
    refs.tabs = TABS.map((t) => {
      const tabBtn = el("button", {
        className: "seg-tab",
        text: t.label,
        attrs: { type: "button", role: "tab", id: `${id}tab-${t.id}`, "aria-controls": `${id}panel-${t.id}`, "data-tab": t.id },
      });
      tabBtn.addEventListener("click", () => showTab(t.id));
      return tabBtn;
    });
    const limits = `Up to ${LIMITS.storedCommands} commands per device and ${LIMITS.batchCommands} per import. ` +
      "The hub backs up its device list before it writes.";

    // Find codes
    refs.findMfr = textInput("Mfr", { value: device.manufacturer, placeholder: "Any spelling" });
    refs.findModel = textInput("Model", { placeholder: "Optional" });
    refs.findSearchBtn = button("Search IRDB", "btn-secondary", doFindSearch);
    refs.findStatus = status();
    refs.findResults = el("div");
    refs.findFile = el("input", {
      className: "import-file-input",
      attrs: { type: "file", id: `${id}File`, accept: ".csv,.ir,.txt,.conf,.lirc,.lircd,text/csv,text/plain" },
    });
    refs.findFile.addEventListener("change", () => {
      const file = refs.findFile.files && refs.findFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => previewLocalFile(file, String(reader.result || ""));
      reader.onerror = () => setMessage(refs.findStatus, `Couldn't read ${file.name}.`, "error");
      reader.readAsText(file);
      refs.findFile.value = "";
    });
    refs.findPreview = el("div");
    refs.findImportBtn = button("Import", "btn-filled btn-block", doFindImport);
    refs.findImportBtn.hidden = true;
    const docLinks = el("p", {
      className: "m-field-hint import-sources",
      children: [
        el("span", { text: "Sources, to open in your browser: " }),
        ...DOC_LINKS.flatMap((d, i) => {
          const nodes = [el("a", { attrs: { href: d.href, target: "_blank", rel: "noopener noreferrer" }, text: d.label })];
          if (i < DOC_LINKS.length - 1) nodes.push(el("span", { text: " · " }));
          return nodes;
        }),
      ],
    });
    refs.panels.find = el("div", {
      className: "import-panel",
      children: [
        el("p", { className: "sheet-text", text:
          `Search the IRDB library for ${device.name}'s codes. IRDB files code sets by maker and type, not by model, ` +
          `so code sets for ${device.typeLabel || "this type"} of device come first. The search runs in this browser, ` +
          "so the hub stays offline, and nothing is saved until you import. " +
          "Contains/accesses irdb by Simon Peter and contributors, used under permission. For licensing details and " +
          "for information on how to contribute to the database, see https://github.com/probonopd/irdb" }),
        field("Manufacturer", refs.findMfr),
        field("Model", refs.findModel),
        el("div", { className: "import-actions", children: [refs.findSearchBtn] }),
        refs.findStatus,
        refs.findResults,
        el("div", { className: "import-file", children: [
          el("label", { className: "btn btn-outlined", text: "Open a code file…", attrs: { for: refs.findFile.id } }),
          refs.findFile,
          el("p", { className: "m-field-hint", text:
            "IRDB CSV, a Flipper .ir file you downloaded, name|code lines or Pronto hex. The format is detected for you." }),
        ] }),
        refs.findPreview,
        refs.findImportBtn,
        el("p", { className: "m-field-hint", text: limits }),
        docLinks,
      ],
    });

    // Paste (+ RemoteCentral)
    refs.importPayload = el("textarea", {
      className: "import-paste",
      attrs: { id: `${id}Paste`, placeholder: "Paste here", spellcheck: "false", "aria-label": "Codes to import" },
    });
    refs.importPayload.addEventListener("input", updateImportPreview);
    refs.importPreview = el("p", { className: "m-field-hint", attrs: { "aria-live": "polite" } });
    refs.importBtn = button("Import", "btn-filled btn-block", doImport);
    refs.importStatus = status();
    refs.rcPath = textInput("Rc", { placeholder: "/cgi-bin/codes/… or a remotecentral.com address" });
    refs.rcBtn = button("Fetch", "btn-outlined", doRemoteCentral);
    refs.rcStatus = status();
    refs.rcResults = el("div");
    refs.panels.paste = el("div", {
      className: "import-panel",
      children: [
        el("p", { className: "sheet-text", text:
          `Paste codes from IRDB (CSV), name|mode|code lines, or a Pronto hex code. They'll be added to ${device.name}.` }),
        refs.importPayload,
        refs.importPreview,
        refs.importBtn,
        refs.importStatus,
        el("h3", { className: "m-section", text: "Fetch from RemoteCentral" }),
        el("p", { className: "m-field-hint", text:
          "The hub fetches remotecentral.com itself, so this one goes online. Nothing is fetched until you press Fetch." }),
        field("Page", refs.rcPath),
        el("div", { className: "import-actions", children: [refs.rcBtn] }),
        refs.rcStatus,
        refs.rcResults,
      ],
    });

    // Logitech catalog
    refs.catalogFile = el("input", {
      className: "import-file-input",
      attrs: { type: "file", id: `${id}CatalogFile`, accept: ".json,application/json" },
    });
    refs.catalogFile.addEventListener("change", () => {
      const file = refs.catalogFile.files && refs.catalogFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => previewCatalogFile(file, String(reader.result || ""));
      reader.onerror = () => setMessage(refs.catalogStatus, `Couldn't read ${file.name}.`, "error");
      reader.readAsText(file);
      refs.catalogFile.value = "";
    });
    refs.catalogStatus = status();
    refs.catalogPreview = el("div");
    refs.catalogImportBtn = button("Import", "btn-filled btn-block", doCatalogImport);
    refs.catalogImportBtn.hidden = true;
    const catalogIntro = `Use the code set from Logitech's own catalog for ${device.manufacturer || "this maker"} ${device.model || ""}`.trim() + ". ";
    const catalogGateNote = "Only commands whose IR protocol this hub already has are imported; the rest are listed below, not dropped silently.";
    const catalogFileWrap = el("div", { className: "import-file", children: [
      el("label", { className: "btn btn-outlined", text: "Open a catalog package…", attrs: { for: refs.catalogFile.id } }),
      refs.catalogFile,
      el("p", { className: "m-field-hint", text:
        (desktop ? "Or open a harmony-catalog-*.json file from tools/catalog/harmony_catalog.py." : "A harmony-catalog-*.json file from the helper.") +
        " Your Logitech sign-in stays on your computer; the hub never sees it." }),
    ] });
    if (desktop) {
      refs.catalogSignInBtn = button("Sign in", "btn-tonal btn-sm", doCatalogSignIn);
      refs.catalogSignOutBtn = button("Sign out", "btn-outlined btn-sm", doCatalogSignOut);
      refs.catalogAccount = el("div", { className: "m-row" });
      renderCatalogAccount();
      refs.catalogBrand = textInput("CatalogBrand", { value: device.manufacturer, placeholder: "e.g. Sony", maxlength: 64 });
      refs.catalogModel = textInput("CatalogModel", { value: device.model, placeholder: "e.g. STR-DG720", maxlength: 64 });
      refs.catalogModel.addEventListener("input", checkCatalogModel);
      refs.catalogModelCheck = el("p", { className: "m-field-hint", attrs: { "aria-live": "polite" } });
      const modelField = field("Model", refs.catalogModel);
      modelField.appendChild(refs.catalogModelCheck);
      refs.catalogSearchBtn = button("Search Logitech catalog", "btn-secondary", doCatalogSearch);
      refs.catalogResults = el("div");
      refs.panels.catalog = el("div", {
        className: "import-panel",
        children: [
          el("p", { className: "sheet-text", text: catalogIntro + catalogGateNote }),
          el("div", { className: "m-list", children: [refs.catalogAccount] }),
          field("Brand", refs.catalogBrand),
          modelField,
          el("div", { className: "import-actions", children: [refs.catalogSearchBtn] }),
          refs.catalogStatus,
          refs.catalogResults,
          refs.catalogPreview,
          refs.catalogImportBtn,
          catalogFileWrap,
        ],
      });
    } else {
      refs.panels.catalog = el("div", {
        className: "import-panel",
        children: [
          el("p", { className: "sheet-text", text:
            catalogIntro + "On your computer, run tools/catalog/harmony_catalog.py once to sign in and download the package, then open it here. " + catalogGateNote }),
          catalogFileWrap,
          refs.catalogStatus,
          refs.catalogPreview,
          refs.catalogImportBtn,
        ],
      });
    }

    // Type a code
    const formHost = el("div");
    refs.addBtn = button("Add command", "btn-filled btn-block", doAddCommand);
    refs.addStatus = status();
    refs.panels.type = el("div", {
      className: "import-panel",
      children: [
        el("p", { className: "sheet-text", text:
          `Add one command to ${device.name} by its code. The hub stores keycodes and NEC codes compactly and replays raw timings.` }),
        formHost,
        refs.addStatus,
        refs.addBtn,
      ],
    });
    commandForm = renderCommandForm(formHost);

    for (const t of TABS) {
      const panel = refs.panels[t.id];
      panel.id = `${id}panel-${t.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `${id}tab-${t.id}`);
    }
    content.append(
      el("h2", { className: "sheet-title", text: "Import codes", attrs: { tabindex: "-1", autofocus: "" } }),
      el("div", { className: "seg-tabs import-tabs", attrs: { role: "tablist", "aria-label": "Import codes" }, children: refs.tabs }),
      refs.panels.find,
      refs.panels.catalog,
      refs.panels.paste,
      refs.panels.type,
    );
    showTab("find");
    updateImportPreview();
  }

  return openSheet({ label: `Import codes to ${device.name}`, className: "import-sheet", render: mount, onClose: () => {
    catalogState.closed = true;
    catalogState.modelVersion++;
    clearTimeout(catalogState.modelTimer);
  } });
}
