/*
 * codex_webui's write_send_problem: the engineCode and needsPairing members a
 * failed send or activity start adds to its reply (docs/API.md "Send
 * failures"). Includes the real source; nothing touches a hub. The engine
 * replies are the ones the hub's codex_hbus prints, copied from a hub's
 * /data/codex/ir-events.log with only the ids changed.
 */
#define main codex_webui_main
#include "../../payload/source/codex_webui.c"
#undef main

static int failures, checks;

static void expect(const char *name, const char *device_id, const char *reply, int bt_failed, const char *want) {
    char *got = NULL;
    size_t len = 0;
    FILE *f = open_memstream(&got, &len);
    if (!f) {
        printf("FAIL %s: open_memstream\n", name);
        failures++;
        return;
    }
    write_send_problem(f, device_id, reply, bt_failed);
    fclose(f);
    checks++;
    if (strcmp(got, want) != 0) {
        printf("FAIL %s\n  want %s\n  got  %s\n", name, want, got);
        failures++;
    }
    free(got);
}

static void sent(const char *name, const char *reply, int want) {
    int got = send_result_of(reply);
    checks++;
    if (got != want) {
        printf("FAIL sent: %s: want %d got %d\n", name, want, got);
        failures++;
    }
}

int main(void) {
    expect("a Sony TV that no longer knows the hub (held key)", "1001",
        "{\"cmd\":\"harmony.engine?holdaction\",\"code\":403,\"id\":\"codex-hold-abc-1\","
        "\"msg\":\"Request Forbidden Reauthentication Required\",\"data\":{\"deviceId\":\"1001\"}}",
        0, ",\"engineCode\":403,\"needsPairing\":{\"deviceId\":\"1001\",\"kind\":\"ip-register\",\"reason\":\"ip-reauth\"}");
    expect("the same from a tap, with the trailing newline codex_hbus prints", "1001",
        "{\"cmd\":\"harmony.engine?holdaction\",\"code\":403,\"id\":\"codex-1-2-3\","
        "\"msg\":\"Request Forbidden Reauthentication Required\"}\n",
        0, ",\"engineCode\":403,\"needsPairing\":{\"deviceId\":\"1001\",\"kind\":\"ip-register\",\"reason\":\"ip-reauth\"}");
    expect("an activity start names the device in data, not the request", NULL,
        "{\"cmd\":\"harmony.engine?startactivity\",\"code\":403,"
        "\"msg\":\"Request Forbidden Reauthentication Required\",\"data\":{\"deviceId\":\"2002\"}}",
        0, ",\"engineCode\":403,\"needsPairing\":{\"deviceId\":\"2002\",\"kind\":\"ip-register\",\"reason\":\"ip-reauth\"}");
    expect("an activity start that names no device gets the code only", NULL,
        "{\"code\":403,\"msg\":\"Request Forbidden Reauthentication Required\"}",
        0, ",\"engineCode\":403");
    expect("another 403 isn't a pairing problem", "1001",
        "{\"code\":403,\"msg\":\"Forbidden\"}", 0, ",\"engineCode\":403");
    expect("the engine's Bluetooth connection timeout", "3003",
        "{\"cmd\":\"harmony.engine?holdaction\",\"code\":506,\"msg\":\"Bluetooth connection timeout\"}",
        0, ",\"engineCode\":506,\"needsPairing\":{\"deviceId\":\"3003\",\"kind\":\"bluetooth\",\"reason\":\"bt-not-connected\"}");
    expect("Melodious's own Bluetooth connect failed (no engine reply)", "3003",
        "Could not connect Bluetooth device 3003 at AA:BB:CC:DD:EE:FF (native code 500).",
        1, ",\"needsPairing\":{\"deviceId\":\"3003\",\"kind\":\"bluetooth\",\"reason\":\"bt-not-connected\"}");
    expect("an unknown command: the code, nothing to pair", "1001",
        "{\"cmd\":\"harmony.engine?holdaction\",\"code\":566,\"id\":\"codex-1-2-3\","
        "\"msg\":\"Command not found for device id:1001\"}\n",
        0, ",\"engineCode\":566");
    expect("the engine before its configuration loads", "1001",
        "{\"cmd\":\"harmony.engine?holdaction\",\"code\":560,\"msg\":\"Account config data is not available\"}",
        0, ",\"engineCode\":560");
    expect("codex_hbus failed: no engine reply, nothing added", "1001",
        "codex_hbus: connect failed", 0, "");
    expect("a nested code is not the engine's", "1001",
        "{\"data\":{\"code\":403},\"msg\":\"Reauthentication\"}", 0, "");
    expect("a data.deviceId that isn't a label names no device", NULL,
        "{\"code\":506,\"msg\":\"x\",\"data\":{\"deviceId\":\"1\\\"2\"}}", 0, ",\"engineCode\":506");
    expect("... and the request's device stands", "3003",
        "{\"code\":506,\"msg\":\"x\",\"data\":{\"deviceId\":\"1\\\"2\"}}", 0,
        ",\"engineCode\":506,\"needsPairing\":{\"deviceId\":\"3003\",\"kind\":\"bluetooth\",\"reason\":\"bt-not-connected\"}");
    expect("a quoted code is the engine's too", "1001",
        "{\"code\":\"403\",\"msg\":\"Request Forbidden Reauthentication Required\"}", 0,
        ",\"engineCode\":403,\"needsPairing\":{\"deviceId\":\"1001\",\"kind\":\"ip-register\",\"reason\":\"ip-reauth\"}");
    expect("no reply at all", "1001", NULL, 0, "");
    /* Whether a tap went out: only the engine's own 200. */
    sent("the engine's 200", "{\"cmd\":\"harmony.engine?holdaction\",\"code\":200,\"id\":\"codex-1\",\"msg\":\"OK\"}\n", SEND_OK);
    sent("a quoted 200", "{\"code\":\"200\",\"msg\":\"OK\"}", SEND_OK);
    sent("a refusal", "{\"code\":566,\"msg\":\"Command not found\"}\n", SEND_REFUSED);
    sent("no code", "{\"msg\":\"OK\"}", SEND_REFUSED);
    sent("a 200 nested in data", "{\"data\":{\"code\":200}}", SEND_REFUSED);
    sent("codex_hbus's own error text", "codex_hbus: connect failed", SEND_REFUSED);
    sent("nothing", "", SEND_REFUSED);
    sent("no buffer", NULL, SEND_REFUSED);
    if (failures) {
        printf("FAIL send-problem (%d of %d)\n", failures, checks);
        return 1;
    }
    printf("PASS send-problem (%d checks)\n", checks);
    return 0;
}
