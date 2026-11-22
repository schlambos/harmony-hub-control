/* Browser-side reader for the Logitech global catalog packages that
   tools/catalog/harmony_catalog.py downloads (schema 0.2.0).

   The flow this enables: the owner signs in to their own Logitech account
   on their computer, the helper downloads a device's command set (and any
   matching protocol records from the account's ProtocolList), and the
   browser then imports the commands this hub can play — KeyCodes whose
   named protocol is already on the hub, built into the hub, or validly
   bundled in the package. Raw codes pass through untouched. Everything
   unimportable is reported by name, never silently dropped. */

/** True when `pkg` is a schema 0.2.0 Logitech catalog package. */
export function isCatalogPackage(pkg) {
  return Boolean(
    pkg &&
      typeof pkg === "object" &&
      !Array.isArray(pkg) &&
      pkg.schema_version === "0.2.0" &&
      Array.isArray(pkg.resources?.global_language_commands),
  );
}

/** True when `record` looks like a usable Harmony IrProtocol definition. */
export function isValidProtocolRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.__type !== "IrProtocol") return false;
  const pid = record["Id-"];
  if (!Number.isInteger(pid) || pid <= 0 || pid > 999999) return false;
  const name = record.Name;
  if (typeof name !== "string" || !name || name.length > 127) return false;
  if (/[:\\"\u0000-\u001f\u007f]/.test(name)) return false;
  const freq = record.CarrierFrequency;
  if (typeof freq !== "number" || !Number.isFinite(freq) || freq < 10000 || freq > 500000) {
    return false;
  }
  if (!record.KeyCode || typeof record.KeyCode !== "object" || Array.isArray(record.KeyCode)) {
    return false;
  }
  if (!Array.isArray(record.IRSegments)) return false;
  if (record.CodeSegments !== undefined && record.CodeSegments !== null && !Array.isArray(record.CodeSegments)) {
    return false;
  }
  const hasIr = record.IRSegments.some((s) => s && typeof s === "object" && !Array.isArray(s));
  const hasCode =
    Array.isArray(record.CodeSegments) &&
    record.CodeSegments.some((s) => s && typeof s === "object" && !Array.isArray(s));
  return hasIr || hasCode;
}

/** Valid IrProtocol records bundled inside a catalog package, deduplicated by Id- and Name. */
export function packageProtocols(packageJson) {
  const raw = packageJson?.resources?.protocols;
  if (!Array.isArray(raw)) return [];
  const valid = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (const proto of raw) {
    if (!isValidProtocolRecord(proto)) continue;
    const pid = proto["Id-"];
    const name = proto.Name;
    if (seenIds.has(pid) || seenNames.has(name)) continue;
    seenIds.add(pid);
    seenNames.add(name);
    valid.push(proto);
  }
  return valid;
}

/**
 * Convert a 0.2.0 catalog package into import rows plus a report of what
 * was left out and why. `hubProtocolNames` is the set of protocol names
 * with a ProtocolList record on this hub (or built into the hub). Valid
 * protocol records bundled in `packageJson.resources.protocols` also make
 * their KeyCodes importable and are returned in `protocolsToAdd`.
 * @returns {{ rows: Array, skipped: Array, protocolsUsed: string[], missingProtocols: string[], protocolsToAdd: Array }}
 */
export function catalogRows(packageJson, hubProtocolNames) {
  const resources = packageJson?.resources ?? {};
  const commands = Array.isArray(resources.global_language_commands)
    ? resources.global_language_commands
    : [];
  const have = new Set(hubProtocolNames ?? []);
  const bundledByName = new Map();
  for (const proto of packageProtocols(packageJson)) {
    bundledByName.set(proto.Name, proto);
  }
  const rows = [];
  const skipped = [];
  const used = new Set();
  const missing = new Set();
  const toAddByName = new Map();
  for (const command of commands) {
    const name = String(command?.Name ?? "").trim();
    if (!name) {
      skipped.push({ name: "(unnamed)", reason: "no command name" });
      continue;
    }
    const keycode = typeof command?.KeyCode === "string" ? command.KeyCode : "";
    const raw = typeof command?.Raw === "string" ? command.Raw : "";
    if (keycode.startsWith("G:")) {
      const protocol = keycode.slice(2).split(":", 1)[0];
      if (!protocol) {
        skipped.push({ name, reason: "KeyCode names no protocol" });
        continue;
      }
      if (!have.has(protocol)) {
        const bundled = bundledByName.get(protocol);
        if (!bundled) {
          missing.add(protocol);
          skipped.push({ name, reason: `protocol “${protocol}” is not on this hub` });
          continue;
        }
        toAddByName.set(protocol, bundled);
      }
      used.add(protocol);
      rows.push({ name, keycode, raw: "", protocol });
    } else if (raw) {
      rows.push({ name, keycode: "", raw, protocol: "" });
    } else if (keycode) {
      skipped.push({ name, reason: "KeyCode is not in Harmony G: form" });
    } else {
      skipped.push({ name, reason: "no KeyCode or Raw code" });
    }
  }
  return {
    rows,
    skipped,
    protocolsUsed: [...used].sort(),
    missingProtocols: [...missing].sort(),
    protocolsToAdd: [...toAddByName.values()],
  };
}

/**
 * Protocols the hub knows natively (BUILTIN_PROTOCOLS /
 * ensure_builtin_protocol_for_id in payload/source/codex_webui.c) and
 * automatically writes to ProtocolList.json on import, even on a brand-new
 * blank hub whose ProtocolList starts empty.
 */
export const BUILTIN_HUB_PROTOCOLS = Object.freeze([
  "Toshiba 32 Bit",
  "Sony 15 Bit",
  "Sony 20 Bit",
  "Saitek 11 Bit",
  "MemorexO1 32 Bit",
  "Samsung 16 and 20 Bit",
]);

/** Protocol names the hub has, read from an exported ProtocolList. */
export function hubProtocolNames(protocolList) {
  const protocols = Array.isArray(protocolList?.Protocols) ? protocolList.Protocols : [];
  return protocols.map((p) => String(p?.Name ?? "")).filter(Boolean);
}

/**
 * Protocol names the hub can accept for catalog KeyCodes, given a parsed
 * `/export/protocols` ProtocolList export: every name already in ProtocolList
 * plus the hub's built-in protocols. Returns null if `protocolList` is not a
 * valid ProtocolList object.
 */
export function supportedHubProtocolNames(protocolList) {
  if (!protocolList || typeof protocolList !== "object" || !Array.isArray(protocolList.Protocols)) {
    return null;
  }
  const merged = [...hubProtocolNames(protocolList)];
  const seen = new Set(merged);
  for (const name of BUILTIN_HUB_PROTOCOLS) {
    if (!seen.has(name)) {
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

/** Human explanation and workaround when a catalog package needs missing IR protocols. */
export function missingProtocolsHint(missingProtocols) {
  const list = Array.isArray(missingProtocols) ? missingProtocols.filter(Boolean) : [];
  if (!list.length) return "";
  return (
    `This hub does not have the IR timing definition for ${list.join(", ")}, ` +
    "so it cannot play those KeyCodes. Learn the buttons from your original remote, " +
    "or import the device from IRDB or a Flipper .ir file in Find codes."
  );
}

/** Human summary of a conversion, for the sheet's status line. */
export function describeCatalogRows(result) {
  const { rows, skipped, protocolsUsed, missingProtocols, protocolsToAdd } = result;
  const bits = [`${rows.length} importable`];
  if (protocolsUsed.length) bits.push(`protocols: ${protocolsUsed.join(", ")}`);
  if (Array.isArray(protocolsToAdd) && protocolsToAdd.length) {
    bits.push(`adds protocols: ${protocolsToAdd.map((p) => p.Name).sort().join(", ")}`);
  }
  if (skipped.length) bits.push(`${skipped.length} skipped`);
  if (missingProtocols.length) bits.push(`missing on hub: ${missingProtocols.join(", ")}`);
  return bits.join(" · ");
}
