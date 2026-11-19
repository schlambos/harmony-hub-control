/*
 * Host-side harness for codex_webui's Bluetooth Harmony pieces. It includes
 * the real source and calls its static functions; nothing touches a hub.
 * Built and driven by tools/bt_harmony_webui_smoke.py.
 */
#define main codex_webui_main
#include "../payload/source/codex_webui.c"
#undef main

static void report(const char *key) {
    char press[96], release[32], err[256];
    if (bt_keyboard_report_hex(key, press, sizeof(press), release, sizeof(release),
            err, sizeof(err)) == 0) {
        printf("report %s %s %s\n", key, press, release[0] ? release : "-");
    } else {
        printf("report %s error\n", key);
    }
}

/* Runs one /api/bt-webhook request against a socketpair and prints the
   status line. The host has no saved-device store, so a well-formed call
   ends at "no Harmony device" (404) and nothing is sent. */
static void webhook(const char *body) {
    int sv[2];
    char buf[1024];
    ssize_t got;
    struct request req;
    char *nl;
    memset(&req, 0, sizeof(req));
    snprintf(req.method, sizeof(req.method), "POST");
    snprintf(req.path, sizeof(req.path), "/api/bt-webhook");
    req.body = body ? strdup(body) : NULL;
    req.body_len = body ? strlen(body) : 0;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return;
    render_bt_webhook_json(sv[0], &req);
    close(sv[0]);
    got = read(sv[1], buf, sizeof(buf) - 1);
    close(sv[1]);
    buf[got > 0 ? got : 0] = 0;
    nl = strchr(buf, '\r');
    if (nl) *nl = 0;
    printf("webhook %s\n", buf);
    free(req.body);
}

/* Sends one unauthenticated POST to handle_client over a real loopback TCP
   connection (the Harmony engine's path) and prints the status line. The
   smoke test builds this with WEBUI_AUTH_CONFIG naming a file that turns
   sign-in on. */
static void loopback_post(const char *path, const char *body) {
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    int listener, client, server;
    char request[1024], buf[1024], *nl;
    ssize_t got;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0 || bind(listener, (struct sockaddr *)&addr, sizeof(addr)) != 0 ||
            listen(listener, 1) != 0 || getsockname(listener, (struct sockaddr *)&addr, &len) != 0) {
        printf("loopback %s setup-failed\n", path);
        return;
    }
    client = socket(AF_INET, SOCK_STREAM, 0);
    if (client < 0 || connect(client, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        printf("loopback %s setup-failed\n", path);
        return;
    }
    server = accept(listener, NULL, NULL);
    snprintf(request, sizeof(request),
        "POST %s HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nContent-Type: application/json\r\n"
        "Content-Length: %lu\r\n\r\n%s", path, (unsigned long)strlen(body), body);
    send_all(client, request, strlen(request));
    handle_client(server);
    close(server);
    got = read(client, buf, sizeof(buf) - 1);
    buf[got > 0 ? got : 0] = 0;
    nl = strchr(buf, '\r');
    if (nl) *nl = 0;
    printf("loopback %s %s\n", path, buf);
    close(client);
    close(listener);
}

int main(int argc, char **argv) {
    static struct bt_inventory inv;
    char *set;
    int i;
    if (argc > 1 && strcmp(argv[1], "webhook") == 0) {
        webhook(NULL);
        webhook("{\"device\":\"bt_1730000000_42\",\"command\":\"tv home\"}");
        webhook("{\"device\":\"../etc\",\"command\":\"tvhome\"}");
        webhook("{\"device\":\"bt_1730000000_42\",\"command\":\"tvhome\"}");
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "webhook-saved") == 0) {
        for (i = 2; i < argc; i++) {
            struct timespec t0, t1;
            long ms;
            clock_gettime(CLOCK_MONOTONIC, &t0);
            webhook(argv[i]);
            clock_gettime(CLOCK_MONOTONIC, &t1);
            ms = (long)((t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000);
            printf("elapsed_ms %ld\n", ms);
            fflush(stdout);
            /* Give worker 1 a brief head start so it holds the flock inside
               WAIT 400 before request 2 arrives — deterministic ordering and
               direct proof that request 2 answers while worker 1 is mid-WAIT. */
            if (i == 2) bt_sleep_ms(60);
        }
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "auth") == 0) {
        loopback_post("/api/bt-webhook", "{\"device\":\"bt_1730000000_42\",\"command\":\"tvhome\"}");
        loopback_post("/api/bt-harmony-device", "{}");
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "set") == 0) {
        static const char *saved_names[] = {
            "Wake and Sign In",
            "D\xc3\xa9" "verrouiller Caf\xc3\xa9",
            "De\xcc\x81" "tente",
            "Stra\xc3\x9f" "e & C\xc5\x93" "ur",
            "Home",
            "poweron",
            "Wake Laptop And Enter Sign In Password On Lock Screen Now",
            "Wake Laptop And Enter Sign In Password On Lock Screen Later",
            "Caf\xc3\xa9",
            "Cafe",
            "!!!",
        };
        memset(&inv, 0, sizeof(inv));
        inv.device_count = 4;
        snprintf(inv.devices[0].id, sizeof(inv.devices[0].id), "bt_1730000000_42");
        snprintf(inv.devices[0].name, sizeof(inv.devices[0].name), "Homatics Box R 4k");
        snprintf(inv.devices[0].type, sizeof(inv.devices[0].type), "btkeyboard");
        snprintf(inv.devices[0].bdaddr, sizeof(inv.devices[0].bdaddr), "AA:BB:CC:DD:EE:FF");
        inv.devices[0].harmony = 1;
        for (i = 0; i < (int)(sizeof(saved_names) / sizeof(saved_names[0])); i++) {
            snprintf(inv.devices[0].commands[i].name, sizeof(inv.devices[0].commands[i].name), "%s", saved_names[i]);
            snprintf(inv.devices[0].commands[i].script, sizeof(inv.devices[0].commands[i].script), "KEY escape");
            inv.devices[0].commands[i].delay_ms = 35;
        }
        inv.devices[0].command_count = (int)(sizeof(saved_names) / sizeof(saved_names[0]));
        snprintf(inv.devices[1].id, sizeof(inv.devices[1].id), "bt_1730000001_7");
        snprintf(inv.devices[1].name, sizeof(inv.devices[1].name), "Not published");
        snprintf(inv.devices[1].type, sizeof(inv.devices[1].type), "btkeyboard");
        snprintf(inv.devices[2].id, sizeof(inv.devices[2].id), "bt_1730000002_8");
        snprintf(inv.devices[2].name, sizeof(inv.devices[2].name), "Fire stick");
        snprintf(inv.devices[2].type, sizeof(inv.devices[2].type), "fire");
        inv.devices[2].harmony = 1;
        snprintf(inv.devices[3].id, sizeof(inv.devices[3].id), "bt_1730000003_9\"x");
        snprintf(inv.devices[3].name, sizeof(inv.devices[3].name), "Odd \"id\"");
        snprintf(inv.devices[3].type, sizeof(inv.devices[3].type), "btkeyboard");
        inv.devices[3].harmony = 1;
        set = bt_harmony_set_json(&inv);
        if (!set) return 1;
        printf("%s\n", set);
        free(set);
        return 0;
    }
    for (i = 1; i < argc; i++) report(argv[i]);
    return 0;
}
