/* Pure parsers and data shaping for the setup pages.
   No network, no DOM — every export is unit-testable under node:test.
   Transport (fetch) lives in api.js, which imports from here. */

/** Serialize a plain object into URLSearchParams for a form POST.
    false / null / undefined keys are omitted; true encodes as "on". */
export function serializeForm(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === false || value === null || value === undefined) continue;
    params.append(key, value === true ? "on" : String(value));
  }
  return params;
}

const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };

export function decodeHtmlEntities(text) {
  return String(text).replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, "");
}


/** First <div class='msg'> / <div class="msg"> body from legacy hub HTML. */
export function extractMsgDiv(html) {
  const match = String(html).match(/<div\s[^>]*class\s*=\s*["']msg["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!match) return "";
  return decodeHtmlEntities(stripTags(match[1])).trim();
}

/** GET /export/mqtt returns the settings JSON. Returns every non-secret
    field plus passwordSet — the broker password value is never returned. */
export function parseMqttConfig(jsonText) {
  let cfg;
  try {
    cfg = JSON.parse(jsonText);
  } catch (_) {
    cfg = {};
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const broker = cfg.broker && typeof cfg.broker === "object" ? cfg.broker : {};
  return {
    baseTopic: cfg.baseTopic ?? "",
    broker: {
      host: broker.host ?? "",
      port: broker.port ?? "",
      username: broker.username ?? "",
    },
    clientId: cfg.clientId ?? "",
    discoveryPrefix: cfg.discoveryPrefix ?? "",
    enabled: Boolean(cfg.enabled),
    haDiscovery: Boolean(cfg.haDiscovery),
    keepAlive: cfg.keepAlive ?? "",
    name: cfg.name ?? "",
    pollSeconds: cfg.pollSeconds ?? "",
    passwordSet: Boolean(broker.password),
  };
}

/** Raw wpa_supplicant.conf text. Handles the escaped quoted SSID the
    C config writer emits. The psk value is never returned. */
export function parseWpaSupplicant(text) {
  const src = String(text);
  const ssidMatch = src.match(/^\s*ssid\s*=\s*"((?:[^"\\]|\\.)*)"/m);
  const ssid = ssidMatch ? ssidMatch[1].replace(/\\(.)/g, "$1") : "";
  const scanMatch = src.match(/^\s*scan_ssid\s*=\s*(\d+)/m);
  const hidden = scanMatch ? scanMatch[1] === "1" : false;
  const keyMatch = src.match(/^\s*key_mgmt\s*=\s*(\S+)/im);
  const keyMgmt = keyMatch ? keyMatch[1].toUpperCase() : "";
  return {
    ssid,
    hidden,
    open: keyMgmt === "NONE",
    keyMgmt,
    passwordSet: /^\s*psk\s*=/m.test(src),
  };
}

/** GET /export/cloud returns a bare "1" / "0" text body. */
export function parseCloudFlag(text) {
  const trimmed = String(text).trim().toLowerCase();
  return trimmed === "1" || trimmed === "true" || trimmed === "on";
}
