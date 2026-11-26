/*
 * Pairing the devices the stock engine keeps the pairing for (codex_webui.c
 * "Pairing a device the stock engine pairs"): a Sony TV's registration,
 * sent from the device's own RegisterSection template to a fake TV on
 * 127.0.0.1 that wants code 1234, the cookie stored in the engine's cookies
 * file without touching other devices' entries, and a stock Bluetooth device
 * paired through a fake codex_hbus (run.sh). Includes the real source;
 * nothing touches a hub or the network.
 */
#include <unistd.h>
#include <sys/prctl.h>
/* write_file_atomic syncs every filesystem; on a big host that can take
 * minutes, and the test checks the files, not the disk. */
#define sync() ((void)0)
#define main codex_webui_main
#include "../../payload/source/codex_webui.c"
#undef main

static int failures, checks;
static int tv_port;
static pid_t tv_pid;

static void check(const char *name, int ok, const char *detail) {
    checks++;
    if (!ok) {
        printf("FAIL %s\n  %s\n", name, detail ? detail : "");
        failures++;
    }
}

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

static char *get(const char *name) {
    static char buf[16384];
    char path[512];
    FILE *f;
    size_t n;
    snprintf(path, sizeof(path), "%s/%s", TEST_DIR, name);
    buf[0] = 0;
    f = fopen(path, "r");
    if (!f) return buf;
    n = fread(buf, 1, sizeof(buf) - 1, f);
    buf[n] = 0;
    fclose(f);
    return buf;
}

/* A fake Sony TV: 401 without Authorization or with the wrong code, 200 and
 * a cookie for Basic ":1234". Each request it gets goes to tv-last. */
static void fake_tv(int ls) {
    for (;;) {
        char req[4096];
        size_t n = 0;
        const char *reply;
        int c = accept(ls, NULL, NULL);
        if (c < 0) continue;
        for (;;) {
            ssize_t r = recv(c, req + n, sizeof(req) - 1 - n, 0);
            char *hdr_end;
            if (r <= 0) break;
            n += (size_t)r;
            req[n] = 0;
            hdr_end = strstr(req, "\r\n\r\n");
            if (hdr_end) {
                const char *cl = strstr(req, "Content-Length: ");
                size_t want = cl ? (size_t)atoi(cl + 16) : 0;
                if (n >= (size_t)(hdr_end + 4 - req) + want) break;
            }
        }
        req[n] = 0;
        put("tv-last", req);
        if (strstr(get("tv-mode"), "registered") && !strstr(req, "Authorization"))
            /* A TV that knows this hub already: no code. */
            reply = "HTTP/1.1 200 OK\r\nSet-Cookie: auth=AGAINCOOKIE; Path=/sony/\r\nContent-Length: 0\r\n\r\n";
        else if (strstr(get("tv-mode"), "oddcookie"))
            reply = "HTTP/1.1 200 OK\r\nSet-Cookie: xauth=NOTIT; Path=/\r\nSet-Cookie: auth=bad\x01byte; Path=/\r\nContent-Length: 0\r\n\r\n";
        else if (strstr(req, "\r\nAuthorization: Basic OjEyMzQ=\r\n")) /* base64(":1234") */
            reply = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: auth=TVSECRETCOOKIE; Path=/sony/; Max-Age=1209600\r\n"
                "Content-Length: 22\r\nConnection: close\r\n\r\n{\"result\":[],\"id\":13}";
        else
            reply = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        send(c, reply, strlen(reply), 0);
        close(c);
    }
}

static void start_tv(void) {
    struct sockaddr_in a;
    socklen_t alen = sizeof(a);
    int ls = socket(AF_INET, SOCK_STREAM, 0), one = 1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(ls, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(ls, 4) != 0) exit(1);
    getsockname(ls, (struct sockaddr *)&a, &alen);
    tv_port = ntohs(a.sin_port);
    tv_pid = fork();
    if (tv_pid == 0) {
        prctl(PR_SET_PDEATHSIG, SIGKILL); /* never outlive the test */
        fake_tv(ls);
    }
    close(ls);
}

/* One route's answer (status line, headers, body). */
static char *call(void (*route)(int, const struct request *), const char *body) {
    static char buf[4096];
    struct request req;
    int sv[2];
    ssize_t got, n = 0;
    memset(&req, 0, sizeof(req));
    snprintf(req.method, sizeof(req.method), "POST");
    req.body = (char *)body;
    req.body_len = strlen(body);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) exit(1);
    route(sv[0], &req);
    close(sv[0]);
    while ((got = read(sv[1], buf + n, sizeof(buf) - 1 - n)) > 0) n += got;
    close(sv[1]);
    buf[n] = 0;
    return buf;
}

static char *find_call(const char *path) {
    static char buf[2048];
    struct request req;
    int sv[2];
    ssize_t got, n = 0;
    memset(&req, 0, sizeof(req));
    snprintf(req.method, sizeof(req.method), "GET");
    snprintf(req.path, sizeof(req.path), "%s", path);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) exit(1);
    render_pairing_find(sv[0], &req);
    close(sv[0]);
    while ((got = read(sv[1], buf + n, sizeof(buf) - 1 - n)) > 0) n += got;
    close(sv[1]);
    buf[n] = 0;
    return buf;
}

#define HAS(name, hay, needle) check(name, strstr(hay, needle) != NULL, hay)
#define LACKS(name, hay, needle) check(name, strstr(hay, needle) == NULL, hay)

static void write_device_list(void) {
    char list[4096];
    snprintf(list, sizeof(list),
        "{\"DevicesWithFeatures\":["
        "{\"Device\":{\"Id-\":101,\"Name\":\"Sony TV\",\"Transport\":65,\"BTAddress\":null,"
        "\"AutoDetectedDevice\":{\"Name\":\"TV\",\"Id\":\"5a1e0001-5a05\",\"USN\":\"uuid:5a1e0001-5a05::urn:schemas-sony-com:service:IRCC:1\"},"
        "\"RegisterSection\":{\"Header\":\"{\\\"Authorization\\\":\\\"{Authorization}\\\"}\",\"Timeout\":\"10\","
        "\"Url\":\"http://{IP}:%d/sony/accessControl\",\"Method\":\"POST\","
        "\"Body\":\"{\\\"id\\\":13,\\\"method\\\":\\\"actRegister\\\",\\\"version\\\":\\\"1.0\\\",\\\"params\\\":[{\\\"clientid\\\":\\\"{clientId}\\\",\\\"nickname\\\":\\\"{clientName}\\\"},[{\\\"clientid\\\":\\\"{clientId}\\\",\\\"value\\\":\\\"yes\\\",\\\"nickname\\\":\\\"{clientName}\\\",\\\"function\\\":\\\"WOL\\\"}]]}\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":102,\"Name\":\"Elsewhere\",\"Transport\":65,"
        "\"RegisterSection\":{\"Url\":\"http://example.com/{IP}/x\",\"Method\":\"POST\",\"Header\":\"\",\"Body\":\"{}\"}},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":201,\"Name\":\"Shield\",\"Transport\":32,\"BTAddress\":\"00:04:4B:12:34:56\",\"RegisterSection\":null},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":401,\"Name\":\"Amp\",\"Transport\":1},\"Commands\":[]},"
        "{\"Device\":{\"Id-\":303,\"Name\":\"Laptop\",\"Transport\":64,\"AutoDetectedDevice\":{\"Id\":\"melodious-bt-303\"}},\"Commands\":[]}"
        "]}", tv_port);
    put("DeviceList.json", list);
}

int main(void) {
    char *r, out[512];
    struct register_values v = {"192.168.1.40", "00:04:20:12:34:56", "Logitech Harmony", ""};
    int port;
    signal(SIGPIPE, SIG_IGN);
    start_tv();
    write_device_list();
    mkdir(TEST_DIR "/markers", 0700);

    /* -- the template ------------------------------------------------------- */
    register_fill("http://{IP}/x?c={clientId}&n={clientName}&{other}", &v, out, sizeof(out));
    check("tokens fill; unknown ones stay", strcmp(out, "http://192.168.1.40/x?c=00:04:20:12:34:56&n=Logitech Harmony&{other}") == 0, out);
    check("a fill that doesn't fit fails", register_fill("{clientName}{clientName}", &v, out, 20) == -1, out);
    check("the URL goes to the chosen address", register_url_parts("http://{IP}/sony/accessControl", &port, out, sizeof(out)) && port == 80 &&
        strcmp(out, "/sony/accessControl") == 0, out);
    check("with its port", register_url_parts("http://{IP}:52323/a", &port, out, sizeof(out)) && port == 52323, out);
    check("never elsewhere", !register_url_parts("http://example.com/{IP}", &port, out, sizeof(out)), "");
    check("nor to another host after it", !register_url_parts("http://{IP}.evil.example/", &port, out, sizeof(out)), "");
    check("nor over https", !register_url_parts("https://{IP}/", &port, out, sizeof(out)), "");
    check("nor with a space in the path", !register_url_parts("http://{IP}/a b", &port, out, sizeof(out)), "");
    check("an empty header is left out", register_headers("{\"Authorization\":\"{Authorization}\"}", &v, out, sizeof(out)) && out[0] == 0, out);
    v.authorization = "Basic OjEyMzQ=";
    check("a filled one is sent", register_headers("{\"Authorization\":\"{Authorization}\"}", &v, out, sizeof(out)) &&
        strcmp(out, "Authorization: Basic OjEyMzQ=\r\n") == 0, out);
    check("Host and Content-Length can't be replaced", register_headers("{\"Host\":\"evil\",\"Content-Length\":\"1\"}", &v, out, sizeof(out)) &&
        out[0] == 0, out);
    check("a header name with a colon is refused", !register_headers("{\"X:Y\":\"1\"}", &v, out, sizeof(out)), "");
    check("no headers at all is fine", register_headers("", &v, out, sizeof(out)) && out[0] == 0, out);
    base64_encode_text(":1234", out, sizeof(out));
    check("base64", strcmp(out, "OjEyMzQ=") == 0, out);
    check("a LAN address is allowed", pairing_host_allowed("192.168.1.30") && pairing_host_allowed("10.0.0.5") &&
        pairing_host_allowed("172.20.1.1"), "");
    check("others aren't", !pairing_host_allowed("8.8.8.8") && !pairing_host_allowed("172.32.0.1") &&
        !pairing_host_allowed("192.168.1.4:80") && !pairing_host_allowed("tv.local") && !pairing_host_allowed(""), "");

    /* -- the device --------------------------------------------------------- */
    r = call(render_pairing_start, "{}");
    HAS("start needs a device", r, "400 Bad Request");
    r = call(render_pairing_start, "{\"deviceId\":\"999\"}");
    HAS("an unknown device", r, "404 Not Found");
    r = call(render_pairing_start, "{\"deviceId\":\"401\"}");
    HAS("an IR device doesn't pair here", r, "409 Conflict");

    /* -- a Sony TV ---------------------------------------------------------- */
    r = call(render_pairing_start, "{\"deviceId\":\"101\"}");
    HAS("a TV needs its address", r, "400 Bad Request");
    r = call(render_pairing_start, "{\"deviceId\":\"101\",\"host\":\"8.8.8.8\"}");
    HAS("only on the LAN", r, "400 Bad Request");
    r = call(render_pairing_start, "{\"deviceId\":\"102\",\"host\":\"127.0.0.1\"}");
    HAS("a template that sends elsewhere is refused", r, "409 Conflict");
    r = call(render_pairing_start, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\"}");
    HAS("start: the TV shows a code", r, "{\"ok\":true,\"step\":\"code\"}");
    r = get("tv-last");
    HAS("sent to the template's path", r, "POST /sony/accessControl HTTP/1.1\r\n");
    {
        char want[64];
        snprintf(want, sizeof(want), "\r\nHost: 127.0.0.1:%d\r\n", tv_port);
        HAS("Host carries the template's port", r, want);
    }
    HAS("as JSON", r, "Content-Type: application/json");
    HAS("with the hub's client id (lower case, as the engine sends it)", r, "\"clientid\":\"00:04:20:12:34:56\"");
    HAS("and the engine's name", r, "\"nickname\":\"Logitech Harmony\"");
    LACKS("no Authorization before a code", r, "Authorization");

    put("cookies", "{\"cookie\":{\"777\":{\"{cookie}\":\"auth=OTHER\",\"{renewpin}\":\"4321\"}}}");
    r = call(render_pairing_finish, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\",\"code\":\"12a4\"}");
    HAS("a code is digits", r, "400 Bad Request");
    r = call(render_pairing_finish, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\",\"code\":\"9999\"}");
    HAS("a wrong code says so", r, "\"wrongCode\":true");
    HAS("with 409", r, "409 Conflict");
    HAS("the code went as Basic auth", get("tv-last"), "Authorization: Basic Ojk5OTk=\r\n");
    put("markers/101", "ip-reauth\nVolumeUp");
    put("reload_resources", "DeviceList\n");
    r = call(render_pairing_finish, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\",\"code\":\"1234\"}");
    HAS("the right code pairs it", r, "{\"ok\":true,\"step\":\"done\",\"reloading\":true}");
    check("an earlier reload request is kept (the flag is appended to)", strstr(get("reload_resources"), "DeviceList") != NULL, get("reload_resources"));
    LACKS("the cookie never comes back", r, "TVSECRET");
    LACKS("nor the code", r, "1234");
    r = get("cookies");
    HAS("the cookie and code are stored for the engine", r, "\"101\":{\"{cookie}\":\"auth=TVSECRETCOOKIE\",\"{renewpin}\":\"1234\"}");
    HAS("other devices' entries stay", r, "\"777\":{\"{cookie}\":\"auth=OTHER\",\"{renewpin}\":\"4321\"}");
    HAS("the engine reloads everything", get("reload_resources"), "all");
    check("its needs-pairing marker is gone", access(TEST_DIR "/markers/101", F_OK) != 0, "");

    /* Pairing again replaces the entry, not adds one. */
    r = call(render_pairing_finish, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\",\"code\":\"1234\"}");
    r = get("cookies");
    check("one entry per device", strstr(r, "\"101\"") && !strstr(strstr(r, "\"101\"") + 5, "\"101\""), r);

    /* A TV that knows the hub already shows no code: keep the code the
     * engine has, or say how to make the TV forget the hub. */
    put("tv-mode", "registered");
    r = call(render_pairing_start, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\"}");
    HAS("registered again with the stored code", r, "\"step\":\"done\"");
    HAS("the new cookie, the old code", get("cookies"), "\"101\":{\"{cookie}\":\"auth=AGAINCOOKIE\",\"{renewpin}\":\"1234\"}");
    put("cookies", "{\"cookie\":{}}");
    r = call(render_pairing_start, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\"}");
    HAS("no stored code: the TV has to forget the hub", r, "\"alreadyRegistered\":true");
    HAS("and says where", r, "Deregister remote device");
    HAS("nothing stored", get("cookies"), "{\"cookie\":{}}");
    put("tv-mode", "oddcookie");
    r = call(render_pairing_finish, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\",\"code\":\"1234\"}");
    HAS("only a clean auth cookie is taken (not xauth, no control bytes)", r, "sent no registration back");
    HAS("and nothing is written", get("cookies"), "{\"cookie\":{}}");
    put("tv-mode", "");

    /* -- the cookies file --------------------------------------------------- */
    unlink(TEST_DIR "/cookies");
    check("no file yet", engine_cookie_store("5", "auth=A", "1111") == 0, "");
    HAS("a new file", get("cookies"), "{\"cookie\":{\"5\":{\"{cookie}\":\"auth=A\",\"{renewpin}\":\"1111\"}}}");
    put("cookies", "{\"other\":1}");
    check("a file with no cookies member", engine_cookie_store("5", "auth=A", "1111") == 0, "");
    HAS("gets one, keeping the rest", get("cookies"), "{\"cookie\":{\"5\":{\"{cookie}\":\"auth=A\",\"{renewpin}\":\"1111\"}},\"other\":1}");
    put("cookies", "{\"cookie\":{}}");
    check("an empty cookies member", engine_cookie_store("5", "auth=\"q", "1111") == 0, "");
    HAS("is filled, escaped", get("cookies"), "{\"cookie\":{\"5\":{\"{cookie}\":\"auth=\\\"q\",\"{renewpin}\":\"1111\"}}}");
    put("cookies", "{\"cookie\":{\"15\":{\"{cookie}\":\"auth=B\",\"{renewpin}\":\"5\"}}}");
    engine_cookie_store("5", "auth=A", "1111");
    HAS("device 5 isn't device 15", get("cookies"), "\"15\":{\"{cookie}\":\"auth=B\",\"{renewpin}\":\"5\"}");
    HAS("both kept", get("cookies"), "\"5\":{\"{cookie}\":\"auth=A\"");
    put("cookies", "not json");
    check("a file this doesn't understand is left alone", engine_cookie_store("5", "auth=A", "1111") == -1 &&
        strcmp(get("cookies"), "not json") == 0, get("cookies"));
    put("cookies", "{\"cookie\":[]}");
    check("the engine's emptied table ([]) is an empty object", engine_cookie_store("5", "auth=A", "1111") == 0, "");
    HAS("and is filled", get("cookies"), "{\"cookie\":{\"5\":{\"{cookie}\":\"auth=A\",\"{renewpin}\":\"1111\"}}}");
    check("nothing is appended", get("cookies")[strlen(get("cookies")) - 1] == '}', get("cookies"));
    put("cookies", "{\"cookie\":[1]}");
    check("a cookies member that is a real array is left alone", engine_cookie_store("5", "auth=A", "1111") == -1, get("cookies"));
    {
        struct stat st;
        put("cookies", "{\"cookie\":{}}");
        chmod(TEST_DIR "/cookies", 0640);
        engine_cookie_store("5", "auth=A", "1111");
        check("the file keeps its mode", stat(TEST_DIR "/cookies", &st) == 0 && (st.st_mode & 0777) == 0640, "");
        unlink(TEST_DIR "/cookies");
        engine_cookie_store("5", "auth=A", "1111");
        check("a new one is 0600", stat(TEST_DIR "/cookies", &st) == 0 && (st.st_mode & 0777) == 0600, "");
    }
    {
        /* A file the hub can't read (here: too big) is never replaced by a
         * fresh one, which would drop every other device's entry. */
        static char big[70000];
        memset(big, ' ', sizeof(big) - 1);
        big[0] = '{';
        big[sizeof(big) - 2] = '}';
        put("cookies", big);
        check("an unreadable file is left alone", engine_cookie_store("5", "auth=A", "1111") == -1 &&
            strlen(get("cookies")) > 16000, "");
    }

    /* -- the device's own name ---------------------------------------------- */
    {
        char name[64];
        device_top_string("{\"AutoDetectedDevice\":{\"Name\":\"Bedroom TV\"},\"AppLaunchConfigs\":[{\"Name\":\"Netflix\"}],\"Name\":\"Sony \\\"A80\\\"\"}",
            "Name", name, sizeof(name));
        check("a device's own Name, not a nested one", strcmp(name, "Sony \"A80\"") == 0, name);
    }

    /* -- nothing at that address -------------------------------------------- */
    kill(tv_pid, SIGKILL);
    waitpid(tv_pid, NULL, 0);
    r = call(render_pairing_start, "{\"deviceId\":\"101\",\"host\":\"127.0.0.1\"}");
    HAS("a TV that's off", r, "502 Bad Gateway");
    HAS("says to check it's on", r, "Nothing answered at 127.0.0.1");

    /* -- a stock Bluetooth device -------------------------------------------- */
    unlink(TEST_DIR "/hbus.log");
    put("markers/201", "bt-not-connected\nHome");
    r = call(render_pairing_start, "{\"deviceId\":\"201\"}");
    HAS("start: the device lists the hub", r, "{\"ok\":true,\"step\":\"select\"}");
    r = get("hbus.log");
    HAS("the old target is cleared first", r, "harmony.engine?bluetoothunpairing {\"deviceId\":\"201\"}\nharmony.engine?bluetoothpairing {\"deviceId\":\"201\"}");
    r = call(render_pairing_finish, "{\"deviceId\":\"201\"}");
    HAS("not picked yet", r, "{\"ok\":true,\"step\":\"select\",\"waiting\":true}");
    put("bt-selected", "");
    r = call(render_pairing_finish, "{\"deviceId\":\"201\"}");
    HAS("picked: paired", r, "{\"ok\":true,\"step\":\"done\"}");
    HAS("DeviceList gets the new address for the pre-connect", get("DeviceList.json"), "\"Id-\":201,\"Name\":\"Shield\",\"Transport\":32,\"BTAddress\":\"AA:BB:CC:DD:EE:01\"");
    HAS("the Sony keeps its null", get("DeviceList.json"), "\"Transport\":65,\"BTAddress\":null");
    HAS("the hub stops being discoverable", get("discoverable.log"), "off");
    check("its marker is gone", access(TEST_DIR "/markers/201", F_OK) != 0, "");
    unlink(TEST_DIR "/discoverable.log");
    r = call(render_pairing_cancel, "{\"deviceId\":\"201\"}");
    HAS("cancel with the device still connected keeps it", r, "{\"ok\":true,\"step\":\"done\"}");
    HAS("and stops being discoverable", get("discoverable.log"), "off");
    unlink(TEST_DIR "/bt-selected");
    unlink(TEST_DIR "/discoverable.log");
    r = call(render_pairing_cancel, "{\"deviceId\":\"201\"}");
    HAS("cancel otherwise just answers", r, "{\"ok\":true}");
    HAS("and stops it too", get("discoverable.log"), "off");
    /* A tab that never cancels: the hub stops by itself. */
    unlink(TEST_DIR "/discoverable.log");
    r = call(render_pairing_start, "{\"deviceId\":\"201\"}");
    check("start leaves a time limit", access(TEST_DIR "/bt-session", F_OK) == 0, r);
    sleep(3);
    HAS("which turns discoverability off", get("discoverable.log"), "off");
    check("and clears the session", access(TEST_DIR "/bt-session", F_OK) != 0, "");
    unlink(TEST_DIR "/discoverable.log");
    r = call(render_pairing_start, "{\"deviceId\":\"201\"}");
    r = call(render_pairing_cancel, "{\"deviceId\":\"201\"}");
    sleep(3);
    check("a cancel first leaves the timer nothing to do", strstr(get("discoverable.log"), "off\noff") == NULL, get("discoverable.log"));
    put("bt-fail", "");
    r = call(render_pairing_start, "{\"deviceId\":\"201\"}");
    HAS("an engine failure (a quoted code) is a 502", r, "502 Bad Gateway");
    HAS("with the engine's code", r, "\"engineCode\":506");

    /* -- a Bluetooth failure names the device's real kind -------------------- */
    {
        char *got = NULL;
        size_t len = 0;
        FILE *f = open_memstream(&got, &len);
        write_send_problem(f, "303", "Enter", "Could not connect Bluetooth device 303", 1);
        write_send_problem(f, "201", "Home", "Could not connect Bluetooth device 201", 1);
        fclose(f);
        HAS("a keyboard target is bt-keyboard", got, "{\"deviceId\":\"303\",\"kind\":\"bt-keyboard\"");
        HAS("a stock device is bluetooth", got, "{\"deviceId\":\"201\",\"kind\":\"bluetooth\"");
        free(got);
        pairing_marker_clear("201", "Back");
        check("any good send clears a Bluetooth connect failure", access(TEST_DIR "/markers/201", F_OK) != 0, "");
    }

    /* -- SSDP answers -------------------------------------------------------- */
    {
        char a[512];
        const char *st = "urn:schemas-sony-com:service:IRCC:1", *udn = "5a1e0001-5a05";
        snprintf(a, sizeof(a), "HTTP/1.1 200 OK\r\nLocation: http://x\r\nUSN: colortouch:ecp:60:f1:89\r\n\r\n");
        check("an answer about something else is dropped", ssdp_answer_match(a, st, udn) == -1, "");
        snprintf(a, sizeof(a), "HTTP/1.1 200 OK\r\nST: %s\r\nUSN: uuid:5A1E0001-5A05::%s\r\n\r\n", st, st);
        check("the device's own answer matches (any case)", ssdp_answer_match(a, st, udn) == 1, "");
        snprintf(a, sizeof(a), "HTTP/1.1 200 OK\r\nST: %s\r\nUSN: uuid:other-tv::%s\r\nX-Note: 5a1e0001-5a05\r\n\r\n", st, st);
        check("another TV doesn't, even with the UDN on another line", ssdp_answer_match(a, st, udn) == 0, "");
    }

    /* -- where the TV is ----------------------------------------------------- */
    r = find_call("/api/pairing/find?deviceId=201");
    HAS("nothing to search for without a USN", r, "{\"ok\":true,\"searched\":false,\"found\":[]}");
    r = find_call("/api/pairing/find?deviceId=abc");
    HAS("a bad id", r, "404 Not Found");

    if (failures) {
        printf("FAIL pairing-engine (%d of %d)\n", failures, checks);
        return 1;
    }
    printf("PASS pairing-engine (%d checks)\n", checks);
    return 0;
}
