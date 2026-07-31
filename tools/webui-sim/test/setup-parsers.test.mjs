import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serializeForm,
  decodeHtmlEntities,
  extractMsgDiv,
  parseMqttConfig,
  parseWpaSupplicant,
  parseCloudFlag,
  parseSystemHtml,
} from "../public/js/setup-parsers.js";

describe("serializeForm", () => {
  it("encodes string and number values", () => {
    const params = serializeForm({ host: "192.168.1.1", port: 1883 });
    assert.equal(params.get("host"), "192.168.1.1");
    assert.equal(params.get("port"), "1883");
  });

  it("encodes true as on", () => {
    assert.equal(serializeForm({ enabled: true }).get("enabled"), "on");
  });

  it("omits false, null, and undefined keys", () => {
    const params = serializeForm({ a: false, b: null, c: undefined, d: "keep" });
    assert.equal(params.has("a"), false);
    assert.equal(params.has("b"), false);
    assert.equal(params.has("c"), false);
    assert.equal(params.get("d"), "keep");
  });

  it("returns empty params for empty object", () => {
    assert.equal(serializeForm({}).toString(), "");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes common entities", () => {
    assert.equal(decodeHtmlEntities("&amp; &lt; &gt; &quot; &#39;"), '& < > " \'');
  });

  it("passes through plain text", () => {
    assert.equal(decodeHtmlEntities("hello world"), "hello world");
  });
});

describe("extractMsgDiv", () => {
  it("extracts single- and double-quoted class msg", () => {
    assert.equal(extractMsgDiv("<div class='msg'>Saved OK</div>"), "Saved OK");
    assert.equal(extractMsgDiv('<div class="msg">Done</div>'), "Done");
  });

  it("strips nested tags and decodes entities", () => {
    assert.equal(extractMsgDiv("<div class='msg'><b>Bold</b> a &amp; b</div>"), "Bold a & b");
  });

  it("returns empty string when no msg div", () => {
    assert.equal(extractMsgDiv("<p>no msg here</p>"), "");
  });
});

describe("parseMqttConfig", () => {
  const json = JSON.stringify({
    baseTopic: "harmony/living-room",
    broker: { host: "192.168.1.50", password: "not-a-real-secret", port: 1883, username: "ha_bridge" },
    clientId: "harmony-hub-01",
    discoveryPrefix: "homeassistant",
    enabled: true,
    haDiscovery: true,
    keepAlive: 60,
    name: "Harmony Hub",
    pollSeconds: 10,
  });

  it("returns every non-secret field", () => {
    const result = parseMqttConfig(json);
    assert.equal(result.baseTopic, "harmony/living-room");
    assert.equal(result.broker.host, "192.168.1.50");
    assert.equal(result.broker.port, 1883);
    assert.equal(result.broker.username, "ha_bridge");
    assert.equal(result.clientId, "harmony-hub-01");
    assert.equal(result.discoveryPrefix, "homeassistant");
    assert.equal(result.enabled, true);
    assert.equal(result.haDiscovery, true);
    assert.equal(result.keepAlive, 60);
    assert.equal(result.name, "Harmony Hub");
    assert.equal(result.pollSeconds, 10);
  });

  it("reports passwordSet but never exposes the value", () => {
    const result = parseMqttConfig(json);
    assert.equal(result.passwordSet, true);
    assert.equal(result.broker.password, undefined);
    assert.ok(!JSON.stringify(result).includes("not-a-real-secret"));
  });

  it("handles empty broker password and invalid JSON", () => {
    assert.equal(parseMqttConfig("not json").passwordSet, false);
    assert.equal(parseMqttConfig("{}").broker.host, "");
    assert.equal(parseMqttConfig('{"broker":{}}').passwordSet, false);
  });
});

describe("parseWpaSupplicant", () => {
  it("parses a WPA-PSK network without returning the psk", () => {
    const conf = [
      "ctrl_interface=/var/run/wpa_supplicant",
      "ap_scan=1",
      "",
      "network={",
      "\tssid=\"LivingRoom-5G\"",
      "\tkey_mgmt=WPA-PSK",
      "\tpsk=\"not-a-real-passphrase\"",
      "}",
    ].join("\n");
    const result = parseWpaSupplicant(conf);
    assert.equal(result.ssid, "LivingRoom-5G");
    assert.equal(result.hidden, false);
    assert.equal(result.open, false);
    assert.equal(result.keyMgmt, "WPA-PSK");
    assert.equal(result.passwordSet, true);
    assert.ok(!JSON.stringify(result).includes("not-a-real-passphrase"));
  });

  it("handles escaped quotes in the SSID", () => {
    const conf = 'network={\n\tssid="My \\"Quoted\\" Net"\n\tkey_mgmt=NONE\n}';
    const result = parseWpaSupplicant(conf);
    assert.equal(result.ssid, 'My "Quoted" Net');
    assert.equal(result.open, true);
    assert.equal(result.passwordSet, false);
  });

  it("detects a hidden network via scan_ssid=1", () => {
    const conf = 'network={\n\tssid="HiddenNet"\n\tscan_ssid=1\n\tkey_mgmt=WPA-PSK\n\tpsk="x"\n}';
    assert.equal(parseWpaSupplicant(conf).hidden, true);
  });

  it("returns defaults for empty input", () => {
    const result = parseWpaSupplicant("");
    assert.equal(result.ssid, "");
    assert.equal(result.hidden, false);
    assert.equal(result.open, false);
    assert.equal(result.passwordSet, false);
  });
});

describe("parseCloudFlag", () => {
  it("parses truthy and falsy bodies", () => {
    assert.equal(parseCloudFlag("1\n"), true);
    assert.equal(parseCloudFlag("true"), true);
    assert.equal(parseCloudFlag("on"), true);
    assert.equal(parseCloudFlag("0"), false);
    assert.equal(parseCloudFlag(""), false);
    assert.equal(parseCloudFlag("off"), false);
  });
});

describe("parseSystemHtml", () => {
  // Minimal fake mirroring the real POST /system render_page() output:
  // firmware/uptime stat cards + System information and Logs <details>.
  const html = [
    "<div class='msg'>Saved.</div>",
    "<section id='view-overview'>",
    "<div class='cards dashboard-cards'>",
    "<div class='stat'><div class='label'>Firmware</div><div class='value'>1.9.4-hub</div></div>",
    "<div class='stat'><div class='label'>Uptime</div><div class='value'>3d 2h 14m</div></div>",
    "</div></section>",
    "<section id='view-system' class='section'><div class='grid'>",
    "<details><summary>System information</summary><pre>--- uname ---",
    "Linux harmony 3.10.107 #1 SMP armv7l GNU/Linux",
    "",
    "--- memory ---",
    "MemTotal:         511840 kB",
    "MemFree:          102400 kB",
    "",
    "--- mounts ---",
    "/dev/root on / type squashfs (ro,relatime)",
    "",
    "--- processes ---",
    "  PID USER   COMMAND",
    "    1 root   /sbin/init</pre></details>",
    "<details><summary>Logs</summary><pre>--- startup log ---",
    "codex: boot ok",
    "",
    "--- local service syslog ---",
    "Jan  1 00:00:01 hub codex: ready</pre></details>",
    "</div>",
    "<div class='panel'><h3>Web UI sign-in</h3>",
    "<div class='help'>Current mode: <strong>open on local network</strong>.</div></div>",
    "</section>",
  ].join("\n");

  it("parses uname and MemTotal from the System information pre", () => {
    const result = parseSystemHtml(html);
    assert.equal(result.uname, "Linux harmony 3.10.107 #1 SMP armv7l GNU/Linux");
    assert.equal(result.memTotal, "511840 kB");
  });

  it("captures mounts and processes sections", () => {
    const result = parseSystemHtml(html);
    assert.ok(result.mounts.includes("/dev/root on / type squashfs"));
    assert.ok(result.processes.includes("/sbin/init"));
  });

  it("parses firmware and uptime from stat cards", () => {
    const result = parseSystemHtml(html);
    assert.equal(result.firmware, "1.9.4-hub");
    assert.equal(result.uptime, "3d 2h 14m");
  });

  it("parses auth mode from the sign-in panel", () => {
    assert.equal(parseSystemHtml(html).authMode, "open on local network");
  });

  it("parses the Logs details separately, not the first pre", () => {
    const result = parseSystemHtml(html);
    assert.ok(result.logs.includes("codex: boot ok"));
    assert.ok(result.logs.includes("codex: ready"));
    assert.ok(!result.logs.includes("MemTotal"));
  });

  it("returns empty strings when sections are absent", () => {
    const result = parseSystemHtml("<p>nothing here</p>");
    assert.equal(result.uname, "");
    assert.equal(result.firmware, "");
    assert.equal(result.logs, "");
  });
});
