/* MQTT setup: broker connection, Home Assistant discovery, and the live
   topic map the bridge publishes. Settings round-trip through the legacy
   hub pages: GET /export/mqtt for the readback, POST /mqtt (form-encoded,
   full-page HTML reply) to save, POST /system action=rediscover to
   re-publish discovery.

   The stored broker password is never rendered, logged, or pre-filled —
   the export only tells us whether one is set. */

import { el, notice, setText, viewHead } from "../setup-kit.js";
import { getText, postHubForm } from "../api.js";
import { parseMqttConfig } from "../setup-parsers.js";

/* codex_webui.c defaults (load_mqtt) and storage limits: char[128] string
   buffers keep 127 chars, password[256] keeps 255. Numeric fields are
   atoi'd with <=0 falling back to the default, and the bridge encodes
   keepAlive as an MQTT 16-bit value — ranges below mirror that. */
const NUMERIC = {
  port: { label: "Broker port", def: "1883", min: 1, max: 65535 },
  pollSeconds: { label: "State publish interval", def: "10", min: 1, max: 86400 },
  keepAlive: { label: "Keepalive", def: "60", min: 1, max: 65535 },
};
const TEXT_DEFAULTS = {
  name: "Harmony Hub",
  baseTopic: "harmony/hub",
  discoveryPrefix: "homeassistant",
  clientId: "harmony-local-mqtt",
};

/* Discovery ids go through codexmqtt.lua's safeId(): lowercase, runs of
   non-alphanumerics collapsed to single underscores. */
function safeId(value) {
  return (
    String(value || "harmony_hub")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/_+/g, "_") || "harmony_hub"
  );
}

function isEmptyExport(text) {
  try {
    const value = JSON.parse(text);
    return !value || typeof value !== "object" || Object.keys(value).length === 0;
  } catch (_) {
    return true;
  }
}

/* Checkbox rows fight the global input reset (full-width, 38px tall), and
   shared CSS is off-limits here — restyle inline, but only with tokens. */
function toggle(key, labelText, hint) {
  const id = `mqtt-${key}`;
  const input = el("input", { attrs: { type: "checkbox", id, name: key } });
  Object.assign(input.style, {
    width: "auto",
    minHeight: "0",
    margin: "3px 0 0",
    flex: "none",
    accentColor: "var(--accent-primary)",
  });
  const title = el("span", { text: labelText });
  Object.assign(title.style, { display: "block", color: "var(--text-primary)", fontWeight: "500" });
  const label = el("label", { attrs: { for: id }, children: [input, el("span", { children: [title, el("span", { className: "setup-field-hint", text: hint })] })] });
  Object.assign(label.style, {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-3)",
    margin: "0",
    fontSize: "var(--text-body-sm)",
    letterSpacing: "0",
    textTransform: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
  });
  return { row: label, input };
}

export function createMqttView(section) {
  let loadEpoch = 0; // bumps on every fetch and on hide; stale replies die
  let passwordSet = false;
  const fields = {};

  function textField(key, label, hint, attrs) {
    const input = el("input", { attrs: { id: `mqtt-${key}`, name: key, type: "text", ...attrs } });
    fields[key] = input;
    const wrap = el("div", { children: [el("label", { text: label, attrs: { for: input.id } }), input] });
    if (hint) wrap.appendChild(el("p", { className: "setup-field-hint", text: hint }));
    return wrap;
  }

  function numericField(key, hint) {
    const spec = NUMERIC[key];
    const input = el("input", {
      attrs: {
        id: `mqtt-${key}`,
        name: key,
        type: "number",
        inputmode: "numeric",
        min: String(spec.min),
        max: String(spec.max),
        step: "1",
      },
    });
    fields[key] = input;
    return el("div", {
      children: [
        el("label", { text: spec.label, attrs: { for: input.id } }),
        input,
        el("p", { className: "setup-field-hint", text: `${hint} ${spec.min}–${spec.max}; blank resets to ${spec.def}.` }),
      ],
    });
  }

  /* -- Static skeleton (built once; populated on every show) ----------- */

  const head = viewHead("MQTT", "Point the hub at an MQTT broker to publish activity state, availability, and Home Assistant discovery.");

  const chip = el("span", { className: "pill pill-dim", text: "Bridge disabled" });
  const exportLink = el("a", {
    className: "btn btn-quiet btn-sm",
    text: "Export settings",
    attrs: { href: "/export/mqtt", download: "mqtt-config.json", title: "Download the stored MQTT config JSON" },
  });
  head.appendChild(el("div", { className: "view-actions", children: [chip, exportLink] }));

  const statusBox = el("div", { className: "setup-status", attrs: { role: "status", "aria-live": "polite" } });
  const body = el("div", { className: "stagger" });

  /* Broker panel */
  const enabledToggle = toggle("enabled", "MQTT bridge enabled", "The hub connects to the broker and publishes state and availability.");
  fields.enabled = enabledToggle.input;

  const passwordInput = el("input", {
    attrs: { id: "mqtt-password", name: "password", type: "password", maxlength: "255", autocomplete: "new-password" },
  });
  fields.password = passwordInput;
  const passwordHint = el("p", { className: "setup-field-hint" });
  const passwordWrap = el("div", {
    children: [el("label", { text: "Password", attrs: { for: passwordInput.id } }), passwordInput, passwordHint],
  });

  const brokerPanel = el("section", {
    className: "panel setup-panel",
    attrs: { "aria-label": "Broker connection" },
    children: [
      el("div", { className: "panel-head", children: [el("h3", { text: "Broker connection" })] }),
      enabledToggle.row,
      el("div", {
        className: "setup-fields",
        children: [
          el("div", {
            className: "row",
            children: [
              textField("host", "Broker address", "IP address or DNS name of the MQTT broker.", { maxlength: "127", autocomplete: "off", spellcheck: "false", placeholder: "192.168.1.20" }),
              numericField("port", "Usually 1883."),
            ],
          }),
          el("div", {
            className: "row",
            children: [
              textField("username", "Username", "Leave blank for anonymous brokers.", { maxlength: "127", autocomplete: "off" }),
              passwordWrap,
            ],
          }),
        ],
      }),
    ],
  });
  brokerPanel.style.setProperty("--i", "0");

  /* Home Assistant panel */
  const discoveryToggle = toggle("haDiscovery", "Publish Home Assistant discovery", "Announces the hub as entities so Home Assistant picks it up automatically.");
  fields.haDiscovery = discoveryToggle.input;

  const saveButton = el("button", { className: "btn btn-primary", text: "Save MQTT settings", attrs: { type: "submit" } });
  const haPanel = el("section", {
    className: "panel setup-panel",
    attrs: { "aria-label": "Home Assistant integration" },
    children: [
      el("div", { className: "panel-head", children: [el("h3", { text: "Home Assistant integration" })] }),
      el("div", {
        className: "setup-fields",
        children: [
          el("div", {
            className: "row",
            children: [
              textField("name", "Device name", "How the hub appears in Home Assistant.", { maxlength: "127" }),
              textField("clientId", "Client ID", "MQTT client ID; also seeds the discovery entity IDs.", { maxlength: "127", autocomplete: "off", spellcheck: "false" }),
            ],
          }),
          el("div", {
            className: "row",
            children: [
              textField("baseTopic", "Base topic", "Root for state, availability, and command topics.", { maxlength: "127", autocomplete: "off", spellcheck: "false" }),
              textField("discoveryPrefix", "Discovery prefix", "Home Assistant MQTT discovery prefix.", { maxlength: "127", autocomplete: "off", spellcheck: "false" }),
            ],
          }),
          el("div", {
            className: "row",
            children: [
              numericField("pollSeconds", "How often hub state is republished, in seconds."),
              numericField("keepAlive", "MQTT keepalive in seconds."),
            ],
          }),
          discoveryToggle.row,
        ],
      }),
      el("div", { className: "setup-actions", children: [saveButton] }),
    ],
  });
  haPanel.style.setProperty("--i", "1");

  const form = el("form", { attrs: { novalidate: "" }, children: [brokerPanel, haPanel] });
  form.addEventListener("submit", onSave);
  form.addEventListener("input", refreshLive);

  /* Topic map panel */
  const rediscoverButton = el("button", { className: "btn btn-quiet btn-sm", text: "Reload discovery", attrs: { type: "button" } });
  rediscoverButton.addEventListener("click", onRediscover);

  const topicRows = {};
  function topicRow(key, label) {
    const value = el("dd", { className: "mono" });
    // .setup-kv dd forces nowrap+ellipsis; topics must stay fully readable,
    // so override per-dd (shared CSS is off-limits to this view).
    Object.assign(value.style, { whiteSpace: "normal", wordBreak: "break-all", overflow: "visible", textOverflow: "clip" });
    topicRows[key] = value;
    return el("div", { children: [el("dt", { text: label }), value] });
  }
  const topicList = el("dl", {
    className: "setup-kv",
    children: [
      topicRow("state", "State"),
      topicRow("availability", "Availability"),
      topicRow("command", "Commands"),
      topicRow("discovery", "Discovery"),
    ],
  });

  const wirePanel = el("section", {
    className: "panel setup-panel panel-inset",
    attrs: { "aria-label": "Published topics" },
    children: [
      el("div", { className: "panel-head", children: [el("h3", { text: "Topics on the wire" }), rediscoverButton] }),
      topicList,
      el("p", { className: "setup-field-hint", text: "Updates live as you type. The settings export includes the broker password — treat that file as a secret." }),
    ],
  });
  wirePanel.style.setProperty("--i", "2");

  section.appendChild(head);
  section.appendChild(statusBox);
  section.appendChild(body);

  /* -- Live pieces ------------------------------------------------------- */

  function refreshLive() {
    chip.replaceChildren();
    if (fields.enabled.checked) {
      chip.className = "pill pill-live";
      chip.appendChild(el("span", { className: "live-dot", attrs: { "aria-hidden": "true" } }));
      chip.appendChild(document.createTextNode("Bridge enabled"));
    } else {
      chip.className = "pill pill-dim";
      chip.appendChild(document.createTextNode("Bridge disabled"));
    }

    const base = fields.baseTopic.value;
    const prefix = fields.discoveryPrefix.value;
    const ident = safeId(fields.clientId.value);
    setText(topicRows.state, `${base}/state`);
    setText(topicRows.availability, `${base}/status`);
    setText(topicRows.command, `${base}/activity/set`);
    setText(topicRows.discovery, `${prefix}/select/${ident}_activity/config`);
    topicRows.discovery.parentElement.hidden = !fields.haDiscovery.checked;
  }

  function setStatus(kind, message) {
    statusBox.replaceChildren();
    if (message) statusBox.appendChild(notice(kind, message));
  }

  function refreshPasswordHint() {
    setText(
      passwordHint,
      passwordSet
        ? "A broker password is stored. Leave blank to keep it, or type a new one to replace it."
        : "No broker password is stored. Leave blank if the broker allows anonymous access.",
    );
    passwordInput.placeholder = passwordSet ? "kept unless replaced" : "optional";
  }

  function populate(cfg) {
    passwordSet = cfg.passwordSet;
    fields.enabled.checked = cfg.enabled;
    fields.haDiscovery.checked = cfg.haDiscovery;
    fields.host.value = cfg.broker.host;
    fields.username.value = cfg.broker.username;
    fields.password.value = ""; // never pre-fill a stored secret
    fields.port.value = cfg.broker.port === "" ? NUMERIC.port.def : String(cfg.broker.port);
    fields.pollSeconds.value = cfg.pollSeconds === "" ? NUMERIC.pollSeconds.def : String(cfg.pollSeconds);
    fields.keepAlive.value = cfg.keepAlive === "" ? NUMERIC.keepAlive.def : String(cfg.keepAlive);
    fields.name.value = cfg.name || TEXT_DEFAULTS.name;
    fields.baseTopic.value = cfg.baseTopic || TEXT_DEFAULTS.baseTopic;
    fields.discoveryPrefix.value = cfg.discoveryPrefix || TEXT_DEFAULTS.discoveryPrefix;
    fields.clientId.value = cfg.clientId || TEXT_DEFAULTS.clientId;
    refreshPasswordHint();
    refreshLive();
  }

  /* -- States ------------------------------------------------------------- */

  function showSkeleton() {
    body.replaceChildren(
      el("div", { className: "panel setup-panel", children: [
        el("div", { className: "state-block", children: [
          el("div", { className: "skel", attrs: { style: "width:38%" } }),
          el("div", { className: "skel" }),
          el("div", { className: "skel", attrs: { style: "width:62%" } }),
        ] }),
      ] }),
    );
  }

  function showError(error) {
    const retry = el("button", { className: "btn btn-secondary btn-sm", text: "Retry", attrs: { type: "button", "data-mqtt-retry": "" } });
    retry.addEventListener("click", () => loadConfig(true));
    body.replaceChildren(
      el("div", { className: "panel setup-panel", children: [
        el("div", { className: "state-block", children: [
          el("span", { className: "state-title", text: "Couldn't read MQTT settings" }),
          document.createTextNode(error.message),
          el("div", { attrs: { style: "margin-top:var(--space-3)" }, children: [retry] }),
        ] }),
      ] }),
    );
  }

  function showForm() {
    if (!body.contains(form)) body.replaceChildren(form, wirePanel);
  }

  /* -- Transport ---------------------------------------------------------- */

  async function loadConfig(initial, warnPrefix) {
    const token = ++loadEpoch;
    if (initial) {
      setStatus("", "");
      showSkeleton();
    }
    let text;
    try {
      text = await getText("/export/mqtt");
    } catch (error) {
      if (token !== loadEpoch) return;
      if (initial) {
        showError(error);
      } else {
        setStatus("warn", `${warnPrefix} but the settings read-back failed: ${error.message}`);
      }
      return;
    }
    if (token !== loadEpoch) return;
    const unconfigured = isEmptyExport(text);
    const cfg = parseMqttConfig(text);
    // A stored false is authoritative; with nothing stored, use the C
    // default (load_mqtt ships with discovery on).
    if (unconfigured) cfg.haDiscovery = true;
    populate(cfg);
    showForm();
    if (initial) {
      if (unconfigured) {
        setStatus("info", "No MQTT configuration is stored on the hub yet — factory defaults are shown below.");
      } else {
        setStatus("", "");
      }
    }
  }

  function normalizeNumbers() {
    const out = {};
    for (const [key, spec] of Object.entries(NUMERIC)) {
      const raw = fields[key].value.trim();
      if (raw === "") {
        out[key] = spec.def; // codex_webui falls back to defaults on atoi <= 0
        continue;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        return { ok: false, message: `${spec.label} must be a whole number between ${spec.min} and ${spec.max}.` };
      }
      out[key] = String(value);
    }
    return { ok: true, values: out };
  }

  function setBusy(on) {
    saveButton.disabled = on;
    rediscoverButton.disabled = on;
    setText(saveButton, on ? "Saving…" : "Save MQTT settings");
  }

  /* Every C field is sent on every save — the legacy handler rewrites the
     whole config from the POST body, so an omitted key would blank it.
     serializeForm drops the unchecked boxes, which the C parser reads as
     off. keep_password=on with a blank password keeps the stored secret. */
  async function onSave(event) {
    event.preventDefault();
    const numbers = normalizeNumbers();
    if (!numbers.ok) {
      setStatus("error", numbers.message);
      return;
    }
    const newPassword = fields.password.value;
    setBusy(true);
    setStatus("info", "Saving MQTT settings…");
    try {
      const result = await postHubForm("/mqtt", {
        enabled: fields.enabled.checked,
        haDiscovery: fields.haDiscovery.checked,
        host: fields.host.value,
        port: numbers.values.port,
        username: fields.username.value,
        password: newPassword,
        keep_password: newPassword === "",
        baseTopic: fields.baseTopic.value,
        discoveryPrefix: fields.discoveryPrefix.value,
        clientId: fields.clientId.value,
        name: fields.name.value,
        pollSeconds: numbers.values.pollSeconds,
        keepAlive: numbers.values.keepAlive,
      });
      fields.password.value = "";
      setStatus("ok", result.msg || "MQTT settings saved.");
      await loadConfig(false, "Settings were saved,");
    } catch (error) {
      setStatus("error", error.message || "Saving failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onRediscover() {
    setBusy(true);
    setStatus("info", "Requesting a discovery reload…");
    try {
      const result = await postHubForm("/system", { action: "rediscover" });
      setStatus("ok", result.msg || "MQTT discovery reload requested.");
      await loadConfig(false, "Discovery reload was requested,");
    } catch (error) {
      setStatus("error", error.message || "Discovery reload failed.");
    } finally {
      setBusy(false);
    }
  }

  /* -- Lifecycle ------------------------------------------------------------ */

  return {
    onShow() {
      loadConfig(true);
    },
    onHide() {
      loadEpoch++; // drop any in-flight readback; nothing else to tear down
    },
  };
}
