/*
 * The network TV and Switch 2 routes that pair, forget or replace devices
 * take only a same-origin JSON request (request_same_origin_json), so another
 * web page can't drive them with a form or a text/plain POST. Includes the
 * real source and runs each request through handle_client over a socketpair;
 * nothing touches a hub, and codex_androidtv isn't running, so an accepted
 * request ends at the relay (never 403).
 */
#define main codex_webui_main
#include "../../payload/source/codex_webui.c"
#undef main

static int failures, checks;

/* The status code handle_client answers. */
static int post(const char *path, const char *type, const char *origin, const char *body) {
    int sv[2], code = 0;
    char request[1024], buf[512];
    ssize_t got;
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return -1;
    snprintf(request, sizeof(request),
        "POST %s HTTP/1.1\r\nHost: hub.local:8080\r\nContent-Type: %s\r\n%s%s%s"
        "Content-Length: %lu\r\n\r\n%s",
        path, type, origin ? "Origin: " : "", origin ? origin : "", origin ? "\r\n" : "",
        (unsigned long)strlen(body), body);
    send_all(sv[1], request, strlen(request));
    shutdown(sv[1], SHUT_WR);
    handle_client(sv[0]);
    close(sv[0]);
    got = read(sv[1], buf, sizeof(buf) - 1);
    close(sv[1]);
    buf[got > 0 ? got : 0] = 0;
    sscanf(buf, "HTTP/1.%*d %d", &code);
    return code;
}

static void expect(const char *name, int refused, int code) {
    checks++;
    if (refused ? code != 403 : (code == 403 || code == 0)) {
        printf("FAIL %s: HTTP %d\n", name, code);
        failures++;
    }
}

int main(void) {
    static const char *const routes[] = {
        "/api/androidtv/pair-start", "/api/androidtv/pair-finish", "/api/androidtv/pair-cancel",
        "/api/androidtv/forget", "/api/androidtv/rename", "/api/androidtv/devices",
        "/api/switch2/devices",
    };
    char name[160];
    size_t i;
    signal(SIGPIPE, SIG_IGN);
    for (i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        snprintf(name, sizeof(name), "%s refuses a form post", routes[i]);
        expect(name, 1, post(routes[i], "application/x-www-form-urlencoded", NULL, "id=androidtv1a2b3c4d"));
        snprintf(name, sizeof(name), "%s refuses text/plain JSON", routes[i]);
        expect(name, 1, post(routes[i], "text/plain", "http://hub.local:8080", "{\"id\":\"androidtv1a2b3c4d\"}"));
        snprintf(name, sizeof(name), "%s refuses another site's JSON", routes[i]);
        expect(name, 1, post(routes[i], "application/json", "http://evil.example", "{\"id\":\"androidtv1a2b3c4d\"}"));
        snprintf(name, sizeof(name), "%s takes the web app's JSON", routes[i]);
        expect(name, 0, post(routes[i], "application/json", "http://hub.local:8080", "{\"devices\":[],\"dryRun\":true}"));
        snprintf(name, sizeof(name), "%s takes JSON with no Origin (a script)", routes[i]);
        expect(name, 0, post(routes[i], "application/json; charset=utf-8", NULL, "{\"devices\":[],\"dryRun\":true}"));
    }
    if (failures) {
        printf("FAIL tv-routes-origin (%d of %d)\n", failures, checks);
        return 1;
    }
    printf("PASS tv-routes-origin (%d checks)\n", checks);
    return 0;
}
