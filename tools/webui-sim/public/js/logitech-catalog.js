/* Browser-side reader for the Logitech global catalog packages that
   tools/catalog/harmony_catalog.py downloads (schema 0.2.0).

   The flow this enables: the owner signs in to their own Logitech account
   on their computer, the helper downloads a device's command set, and the
   browser then imports only the commands this hub can actually play —
   KeyCodes whose named protocol has a ProtocolList record here. Raw codes
   pass through untouched. Everything unimportable is reported by name,
   never silently dropped. */

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

/**
 * Convert a 0.2.0 catalog package into import rows plus a report of what
 * was left out and why. `hubProtocolNames` is the set of protocol names
 * with a ProtocolList record on this hub.
 * @returns {{ rows: Array, skipped: Array, protocolsUsed: string[], missingProtocols: string[] }}
 */
export function catalogRows(packageJson, hubProtocolNames) {
  const resources = packageJson?.resources ?? {};
  const commands = Array.isArray(resources.global_language_commands)
    ? resources.global_language_commands
    : [];
  const have = new Set(hubProtocolNames ?? []);
  const rows = [];
  const skipped = [];
  const used = new Set();
  const missing = new Set();
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
        missing.add(protocol);
        skipped.push({ name, reason: `protocol “${protocol}” is not on this hub` });
        continue;
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
  };
}

/**
 * Protocols the hub knows natively (ensure_builtin_protocol_for_id in
 * payload/source/codex_webui.c) and automatically writes to ProtocolList.json
 * on import, even on a brand-new blank hub whose ProtocolList starts empty.
 */
export const BUILTIN_HUB_PROTOCOLS = Object.freeze(["Toshiba 32 Bit", "MemorexO1 32 Bit"]);

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

/** Human summary of a conversion, for the sheet's status line. */
export function describeCatalogRows(result) {
  const { rows, skipped, protocolsUsed, missingProtocols } = result;
  const bits = [`${rows.length} importable`];
  if (protocolsUsed.length) bits.push(`protocols: ${protocolsUsed.join(", ")}`);
  if (skipped.length) bits.push(`${skipped.length} skipped`);
  if (missingProtocols.length) bits.push(`missing on hub: ${missingProtocols.join(", ")}`);
  return bits.join(" · ");
}
