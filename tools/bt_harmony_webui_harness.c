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
    if (argc > 1 && strcmp(argv[1], "set") == 0) {
        memset(&inv, 0, sizeof(inv));
        inv.device_count = 4;
        snprintf(inv.devices[0].id, sizeof(inv.devices[0].id), "bt_1730000000_42");
        snprintf(inv.devices[0].name, sizeof(inv.devices[0].name), "Homatics Box R 4k");
        snprintf(inv.devices[0].type, sizeof(inv.devices[0].type), "btkeyboard");
        inv.devices[0].harmony = 1;
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
