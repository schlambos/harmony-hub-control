import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLE_FILES,
  CLOUD_DISABLE_VALUES,
  CLOUD_ENABLE_VALUES,
  IMPORT_LABELS,
  MAX_REQUEST_BODY,
  REQUEST_WARN_BYTES,
  RESOURCES,
  encodedImportSize,
  exportHref,
  formatBytes,
  preflightImport,
  utf8ByteLength,
  validateImportPayload,
} from "../public/js/views/backup-model.js";

/* Payload shapes mirror the real exports — no secrets, minimal records. */
const BUNDLE_V2 = JSON.stringify({
  format: "harmony-owner-bundle-v2",
  files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
});
const BUNDLE_V1 = "{\"format\":\"harmony-owner-bundle-v1\",\"DeviceList.json\":\"{\\\"DevicesWithFeatures\\\":[]}\"}";

describe("validateImportPayload — bundle", () => {
  it("accepts v1 and v2 owner bundles", () => {
    assert.deepEqual(validateImportPayload("bundle", BUNDLE_V2), { ok: true });
    assert.deepEqual(validateImportPayload("bundle", BUNDLE_V1), { ok: true });
  });

  it("accepts surrounding whitespace like trim_payload", () => {
    assert.deepEqual(validateImportPayload("bundle", `  ${BUNDLE_V2}\n`), { ok: true });
  });

  it("rejects a bundle without DeviceList.json", () => {
    const result = validateImportPayload("bundle", '{"format":"harmony-owner-bundle-v2"}');
    assert.equal(result.ok, false);
    assert.match(result.message, /harmony-owner-bundle-v1 or v2/);
  });

  it("rejects non-object bundles", () => {
    assert.equal(validateImportPayload("bundle", '["DeviceList.json"]').ok, false);
  });

  it("rejects empty payload", () => {
    const result = validateImportPayload("bundle", "   ");
    assert.equal(result.ok, false);
    assert.equal(result.message, "Import payload is empty.");
  });
});

describe("validateImportPayload — bundle cloud-blocker guard", () => {
  /* The hub's handle_import_bundle skips an absent/empty cloud-blocker.conf
     and preserves the current state, so a bundle without the key is safe. */
  it("accepts a v2 bundle with no cloud-blocker.conf key", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
    });
    assert.deepEqual(validateImportPayload("bundle", bundle), { ok: true });
  });

  it("accepts a v1 bundle with no cloud-blocker.conf key", () => {
    const bundle = '{"format":"harmony-owner-bundle-v1","DeviceList.json":"{\\\"DevicesWithFeatures\\\":[]}"}';
    assert.deepEqual(validateImportPayload("bundle", bundle), { ok: true });
  });

  it("accepts a bundle with an empty cloud-blocker.conf value", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
      "cloud-blocker.conf": "",
    });
    assert.deepEqual(validateImportPayload("bundle", bundle), { ok: true });
  });

  for (const value of ["1", "on", "true", "enabled"]) {
    it(`accepts a bundle with cloud-blocker.conf set to ${JSON.stringify(value)}`, () => {
      const bundle = JSON.stringify({
        format: "harmony-owner-bundle-v2",
        files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
        "cloud-blocker.conf": value,
      });
      assert.deepEqual(validateImportPayload("bundle", bundle), { ok: true });
    });
  }

  it("accepts enable values with surrounding whitespace and trailing newline (hub trim)", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
      "cloud-blocker.conf": "  Enabled\n",
    });
    assert.deepEqual(validateImportPayload("bundle", bundle), { ok: true });
  });

  for (const value of ["0", "off", "false", "disabled", "allow", "allowed"]) {
    it(`rejects a bundle with cloud-blocker.conf set to ${JSON.stringify(value)}`, () => {
      const bundle = JSON.stringify({
        format: "harmony-owner-bundle-v2",
        files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
        "cloud-blocker.conf": value,
      });
      const result = validateImportPayload("bundle", bundle);
      assert.equal(result.ok, false);
      assert.match(result.message, /cannot be disabled/);
      assert.match(result.message, new RegExp(`\\b${value}\\b`));
    });
  }

  it("rejects a disable value with surrounding whitespace and trailing newline", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
      "cloud-blocker.conf": "  off\n",
    });
    const result = validateImportPayload("bundle", bundle);
    assert.equal(result.ok, false);
    assert.match(result.message, /cannot be disabled/);
  });

  it("rejects an unknown cloud-blocker.conf value", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
      "cloud-blocker.conf": "maybe",
    });
    const result = validateImportPayload("bundle", bundle);
    assert.equal(result.ok, false);
    assert.match(result.message, /unknown cloud-blocker\.conf value/);
  });

  it("rejects a disable value embedded in a v1-style flat bundle", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v1",
      "DeviceList.json": "{\"DevicesWithFeatures\":[]}",
      "cloud-blocker.conf": "0",
    });
    const result = validateImportPayload("bundle", bundle);
    assert.equal(result.ok, false);
    assert.match(result.message, /cannot be disabled/);
  });

  it("exposes exactly the disable values", () => {
    assert.deepEqual(CLOUD_DISABLE_VALUES, ["0", "off", "false", "disabled", "allow", "allowed"]);
  });

  it("preflight surfaces the cloud-blocker rejection as an error", () => {
    const bundle = JSON.stringify({
      format: "harmony-owner-bundle-v2",
      files: { "DeviceList.json": "{\"DevicesWithFeatures\":[]}" },
      "cloud-blocker.conf": "0",
    });
    const result = preflightImport("bundle", bundle);
    assert.equal(result.valid, false);
    assert.equal(result.level, "error");
    assert.match(result.message, /cannot be disabled/);
  });
});

describe("validateImportPayload — resource targets", () => {
  const cases = [
    ["devices", '{"DevicesWithFeatures":[]}', "DeviceList import must contain DevicesWithFeatures."],
    ["functions", '{"FunctionMaps":[]}', "FunctionList import must contain FunctionMaps."],
    ["protocols", '{"Protocols":[]}', "ProtocolList import must contain Protocols."],
    ["activities", '{"Activities":[]}', "ActivityList import must contain Activities."],
    ["maps", '{"ButtonMaps":[]}', "MapList import must contain ButtonMaps."],
  ];

  for (const [target, valid, expectedMessage] of cases) {
    it(`accepts a valid ${target} payload`, () => {
      assert.deepEqual(validateImportPayload(target, valid), { ok: true });
    });

    it(`rejects ${target} missing its key with the hub's message`, () => {
      const result = validateImportPayload(target, '{"other":1}');
      assert.equal(result.ok, false);
      assert.equal(result.message, expectedMessage);
    });

    it(`rejects a ${target} JSON array as not an object`, () => {
      const result = validateImportPayload(target, "[]");
      assert.equal(result.ok, false);
      assert.equal(result.message, `${IMPORT_LABELS[target]} import must be a JSON object.`);
    });
  }

  it("accepts automation as any JSON object", () => {
    assert.deepEqual(validateImportPayload("automation", '{"anything":true}'), { ok: true });
  });

  it("rejects an unknown target", () => {
    const result = validateImportPayload("nope", "{}");
    assert.equal(result.ok, false);
    assert.match(result.message, /Unknown import target/);
  });
});

describe("validateImportPayload — mqtt / wifi / bluetooth", () => {
  it("accepts mqtt with broker and baseTopic", () => {
    assert.deepEqual(validateImportPayload("mqtt", '{"broker":{"host":"h"},"baseTopic":"t"}'), { ok: true });
  });

  it("rejects mqtt missing baseTopic", () => {
    const result = validateImportPayload("mqtt", '{"broker":{"host":"h"}}');
    assert.equal(result.message, "MQTT import must contain broker and baseTopic.");
  });

  it("accepts a wpa_supplicant network block", () => {
    assert.deepEqual(validateImportPayload("wifi", 'network={\n  ssid="x"\n}'), { ok: true });
  });

  it("rejects wifi without ssid", () => {
    const result = validateImportPayload("wifi", "network={\n}");
    assert.match(result.message, /network block and ssid/);
  });

  it("accepts bluetooth with a devices list", () => {
    assert.deepEqual(validateImportPayload("bluetooth", '{"devices":[]}'), { ok: true });
  });

  it("rejects bluetooth without devices", () => {
    assert.equal(validateImportPayload("bluetooth", '{"paired":[]}').ok, false);
  });
});

describe("validateImportPayload — cloud is enable-only", () => {
  it("exposes exactly the enable values", () => {
    assert.deepEqual(CLOUD_ENABLE_VALUES, ["1", "on", "true", "enabled"]);
  });

  for (const value of ["1", "on", "true", "enabled", "TRUE", " Enabled ", "1\n"]) {
    it(`accepts enable value ${JSON.stringify(value)}`, () => {
      assert.deepEqual(validateImportPayload("cloud", value), { ok: true });
    });
  }

  for (const value of ["0", "off", "false", "disabled", "allow", "allowed", "block"]) {
    it(`refuses disable/foreign value ${JSON.stringify(value)}`, () => {
      const result = validateImportPayload("cloud", value);
      assert.equal(result.ok, false);
      assert.match(result.message, /only enables the cloud blocker/);
    });
  }
});

describe("encodedImportSize", () => {
  it("matches the exact form-urlencoded body length", () => {
    assert.equal(encodedImportSize("cloud", "1"), "target=cloud&payload=1".length);
  });

  it("counts percent-encoding expansion", () => {
    assert.equal(encodedImportSize("cloud", "a b{1}"), "target=cloud&payload=a+b%7B1%7D".length);
  });

  it("counts multibyte UTF-8 payloads by byte, not char", () => {
    assert.equal(encodedImportSize("cloud", "é"), "target=cloud&payload=%C3%A9".length);
  });
});

describe("preflightImport levels", () => {
  it("reports ok for a small valid payload", () => {
    const result = preflightImport("devices", '{"DevicesWithFeatures":[]}');
    assert.equal(result.valid, true);
    assert.equal(result.level, "ok");
    assert.match(result.message, /1 MiB limit/);
  });

  it("warns near the 900 KB threshold", () => {
    const payload = `network={\nssid="${"x".repeat(950 * 1024)}"\n}`;
    const result = preflightImport("wifi", payload);
    assert.equal(result.valid, true);
    assert.equal(result.level, "warn");
    assert.ok(result.requestBytes >= REQUEST_WARN_BYTES);
    assert.ok(result.requestBytes <= MAX_REQUEST_BODY);
  });

  it("errors past the 1 MiB request body limit", () => {
    const payload = `{"DevicesWithFeatures":"${"x".repeat(1100 * 1024)}"}`;
    const result = preflightImport("devices", payload);
    assert.equal(result.valid, false);
    assert.equal(result.level, "error");
    assert.match(result.message, /over the hub's 1 MiB body limit/);
  });

  it("errors on shape before size", () => {
    const result = preflightImport("maps", '{"nope":1}');
    assert.equal(result.valid, false);
    assert.equal(result.level, "error");
    assert.match(result.message, /ButtonMaps/);
  });
});

describe("export surface mirrors the hub", () => {
  it("lists the ten individual exports in hub order", () => {
    assert.deepEqual(
      RESOURCES.map((r) => r.target),
      ["devices", "functions", "protocols", "activities", "maps", "automation", "mqtt", "wifi", "cloud", "bluetooth"],
    );
  });

  it("lists the bundle manifest in send_bundle_download order", () => {
    assert.deepEqual(
      BUNDLE_FILES.map((f) => f.name),
      [
        "DeviceList.json", "FunctionList.json", "ProtocolList.json", "ActivityList.json",
        "MapList.json", "AutomationConfig.json", "mqtt-config.json", "wpa_supplicant.conf",
        "bt-devices.json", "cloud-blocker.conf",
      ],
    );
    assert.deepEqual(BUNDLE_FILES.filter((f) => f.secret).map((f) => f.name), [
      "mqtt-config.json", "wpa_supplicant.conf",
    ]);
  });

  it("builds same-origin export hrefs", () => {
    assert.equal(exportHref("bundle"), "/export/bundle");
    assert.equal(exportHref("devices"), "/export/devices");
  });

  it("labels every import target", () => {
    assert.equal(Object.keys(IMPORT_LABELS).length, 11);
    assert.equal(IMPORT_LABELS.devices, "DeviceList.json");
    assert.equal(IMPORT_LABELS.cloud, "cloud blocker setting");
  });
});

describe("formatBytes / utf8ByteLength", () => {
  it("formats human sizes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1048576), "1.00 MB");
  });

  it("counts UTF-8 bytes", () => {
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength(""), 0);
  });
});
