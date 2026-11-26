/*
 * GET /api/pairing (codex_webui.c render_pairing_json) and the failure
 * markers: which devices pair with something, and what the files say about
 * each. Includes the real source; run.sh points DeviceList, the engine's
 * cookies and the marker directory into a temporary directory. Nothing
 * touches a hub.
 */
#define main codex_webui_main
#include "../../payload/source/codex_webui.c"
#undef main

static int failures, checks;

static void put(const char *name, const char *text) {
    char path[512];
    FILE *f;
    snprintf(path, sizeof(path), "%s/%s", TEST_DIR, name);
    f = fopen(path, "w");
    if (!f) {
        printf("FAIL cannot write %s\n", path);
        exit(1);
    }
    fputs(text, f);
    fclose(f);
}

/* The body GET /api/pairing answers. */
static char *pairing(void) {
    static char buf[4096];
    int sv[2];
    ssize_t got, n = 0;
    char *body;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) exit(1);
    render_pairing_json(sv[0]);
    close(sv[0]);
    while ((got = read(sv[1], buf + n, sizeof(buf) - 1 - n)) > 0) n += got;
    close(sv[1]);
    buf[n] = 0;
    body = strstr(buf, "\r\n\r\n");
    return body ? body + 4 : buf;
}

static void expect_has(const char *name, const char *body, const char *want) {
    checks++;
    if (!strstr(body, want)) {
        printf("FAIL %s\n  want %s\n  in   %s\n", name, want, body);
        failures++;
    }
}

static void expect_not(const char *name, const char *body, const char *unwanted) {
    checks++;
    if (strstr(body, unwanted)) {
        printf("FAIL %s\n  unwanted %s\n  in       %s\n", name, unwanted, body);
        failures++;
    }
}

#define SONY_REGISTER "\"RegisterSection\":{\"Url\":\"http://{IP}/sony/accessControl\",\"Header\":\"\",\"Body\":\"{}\"}"

int main(void) {
    char *body, reason[32];
    put("DeviceList.json",
        "{\"DevicesWithFeatures\":["
        "{\"Device\":{\"Id-\":101,\"Name\":\"Sony TV\",\"Transport\":65," SONY_REGISTER "},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":102,\"Name\":\"Den Sony\",\"Transport\":65," SONY_REGISTER "},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":103,\"Name\":\"Roku\",\"Transport\":64,\"RegisterSection\":null},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":201,\"Name\":\"Shield\",\"Transport\":32,\"BTAddress\":\"\"},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":202,\"Name\":\"Apple TV\",\"Transport\":32,\"BTAddress\":\"00:04:4B:12:34:56\"},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":301,\"Name\":\"Den TV\",\"Transport\":64,\"AutoDetectedDevice\":{\"Id\":\"melodious-androidtv-301\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":302,\"Name\":\"LG\",\"Transport\":64,\"AutoDetectedDevice\":{\"Id\":\"melodious-webos-302\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":303,\"Name\":\"Laptop\",\"Transport\":64,\"AutoDetectedDevice\":{\"Id\":\"melodious-bt-303\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":304,\"Name\":\"Lamp\",\"Transport\":64,\"AutoDetectedDevice\":{\"Id\":\"melodious-ha-304\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":401,\"Name\":\"Amp\",\"Transport\":1},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":402,\"Name\":\"Old Amp\"},\"Commands\":[]}"
        "]}");
    /* 101 has a cookie; 102's key appears only as another device's PIN. */
    put("cookies", "{\"cookie\":{\"101\":{\"{cookie}\":\"auth=SECRETCOOKIE\",\"{renewpin}\":\"102\"}}}");

    body = pairing();
    expect_has("a Sony TV with a cookie is paired", body, "{\"deviceId\":\"101\",\"kind\":\"ip-register\",\"state\":\"paired\"}");
    expect_has("a Sony TV without one isn't", body, "{\"deviceId\":\"102\",\"kind\":\"ip-register\",\"state\":\"not-paired\"}");
    expect_not("an IP device with no registration template pairs with nothing", body, "\"103\"");
    expect_has("a Bluetooth device without an address isn't paired", body, "{\"deviceId\":\"201\",\"kind\":\"bluetooth\",\"state\":\"not-paired\"}");
    expect_has("one with an address is unknown (maybe another hub's)", body, "{\"deviceId\":\"202\",\"kind\":\"bluetooth\",\"state\":\"unknown\"}");
    expect_has("an Android TV is left to its live status", body, "{\"deviceId\":\"301\",\"kind\":\"androidtv\",\"state\":\"unknown\"}");
    expect_has("a webOS TV too", body, "{\"deviceId\":\"302\",\"kind\":\"webos\",\"state\":\"unknown\"}");
    expect_has("a Bluetooth keyboard target", body, "{\"deviceId\":\"303\",\"kind\":\"bt-keyboard\",\"state\":\"unknown\"}");
    expect_not("Home Assistant devices pair with nothing", body, "\"304\"");
    expect_not("IR devices pair with nothing", body, "\"401\"");
    expect_not("nor do ones with no Transport", body, "\"402\"");
    expect_not("the cookie never leaves the hub", body, "SECRET");
    expect_has("the answer is one JSON object", body, "{\"ok\":true,\"devices\":[");

    /* A failed send that needs pairing leaves a marker; a good one removes it. */
    {
        char *got = NULL;
        size_t len = 0;
        FILE *f = open_memstream(&got, &len);
        write_send_problem(f, "101", "VolumeUp", "{\"code\":403,\"msg\":\"Request Forbidden Reauthentication Required\"}", 0);
        write_send_problem(f, "201", "Home", "Could not connect Bluetooth device 201", 1);
        write_send_problem(f, "401", "Guide", "{\"code\":566,\"msg\":\"Command not found\"}", 0);
        fclose(f);
        free(got);
    }
    body = pairing();
    expect_has("a refused send marks a paired TV", body, "{\"deviceId\":\"101\",\"kind\":\"ip-register\",\"state\":\"needs-attention\",\"reason\":\"ip-reauth\"}");
    expect_has("a failed Bluetooth connect marks the device", body, "{\"deviceId\":\"201\",\"kind\":\"bluetooth\",\"state\":\"needs-attention\",\"reason\":\"bt-not-connected\"}");
    checks++;
    if (pairing_marker_read("401", reason, sizeof(reason))) {
        printf("FAIL an unknown command leaves no marker\n");
        failures++;
    }
    pairing_marker_clear("101", "PowerOn");
    body = pairing();
    expect_has("another command working leaves the marker (IR still works)", body, "{\"deviceId\":\"101\",\"kind\":\"ip-register\",\"state\":\"needs-attention\"");
    pairing_marker_clear("101", "VolumeUp");
    body = pairing();
    expect_has("the command that failed working clears it", body, "{\"deviceId\":\"101\",\"kind\":\"ip-register\",\"state\":\"paired\"}");
    put("markers/202", "garbage");
    body = pairing();
    expect_has("a marker with an unknown reason is ignored", body, "{\"deviceId\":\"202\",\"kind\":\"bluetooth\",\"state\":\"unknown\"}");
    {
        char *got = NULL;
        size_t len = 0;
        FILE *f = open_memstream(&got, &len);
        write_send_problem(f, NULL, NULL, "{\"code\":403,\"msg\":\"Request Forbidden Reauthentication Required\",\"data\":{\"deviceId\":\"102\"}}", 0);
        fclose(f);
        free(got);
    }
    pairing_marker_clear("102", "AnyCommand");
    body = pairing();
    expect_has("an activity start's marker names no command: any good send clears it", body, "{\"deviceId\":\"102\",\"kind\":\"ip-register\",\"state\":\"not-paired\"}");
    checks++;
    pairing_marker_set("../etc", "ip-reauth", "x");
    if (access(TEST_DIR "/etc", F_OK) == 0) {
        printf("FAIL a device id that isn't digits makes no file\n");
        failures++;
    }

    /* No cookies file, an empty DeviceList: still a valid answer. */
    put("cookies", "");
    body = pairing();
    expect_has("no cookies: the TV isn't paired", body, "{\"deviceId\":\"101\",\"kind\":\"ip-register\",\"state\":\"not-paired\"}");
    put("DeviceList.json", "");
    expect_has("no devices: an empty list", pairing(), "{\"ok\":true,\"devices\":[]}");

    /* The fixture the web app's pairingKindOf is tested against too. */
    {
        char path[512], *kinds;
        const char *q;
        int seen;
        snprintf(path, sizeof(path), "%s/kinds.json", TEST_DIR);
        kinds = read_file_alloc(path, 1 << 20, NULL);
        if (!kinds) {
            printf("FAIL cannot read %s\n", path);
            return 1;
        }
        put("DeviceList.json", kinds);
        put("cookies", "");
        body = pairing();
        seen = 0;
        for (q = kinds; (q = strstr(q, "\"Device\":{")) != NULL;) {
            const char *obj = strchr(q, '{'), *end = find_matching_json(obj, '{', '}');
            char expect[32], name[96], want[96];
            long id;
            if (!end) break;
            id = json_long_range(obj, end, "Id-", 0);
            json_string_range(obj, end, "ExpectKind", expect, sizeof(expect));
            json_string_range(obj, end, "Name", name, sizeof(name));
            q = end + 1;
            seen++;
            if (expect[0]) {
                snprintf(want, sizeof(want), "{\"deviceId\":\"%ld\",\"kind\":\"%s\"", id, expect);
                expect_has(name, body, want);
            } else {
                snprintf(want, sizeof(want), "\"deviceId\":\"%ld\"", id);
                expect_not(name, body, want);
            }
        }
        free(kinds);
        checks++;
        if (seen != 17) {
            printf("FAIL the kinds fixture has 17 devices, read %d (keep it compact: \"Device\":{)\n", seen);
            failures++;
        }
    }

    if (failures) {
        printf("FAIL pairing-status (%d of %d)\n", failures, checks);
        return 1;
    }
    printf("PASS pairing-status (%d checks)\n", checks);
    return 0;
}
