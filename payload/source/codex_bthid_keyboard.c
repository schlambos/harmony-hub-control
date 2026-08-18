#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define HAL_PORT 16716
#define LTCP_FRAME_SIZE 64
#define MAX_JSON_SIZE 16383
#define MAX_RESPONSE_SIZE 4096
#define DEFAULT_FIFO "/tmp/bthid_input"
#define DEFAULT_STATUS "/tmp/bthid_status"
#define DEFAULT_LOG "/cache/codex-bthid-keyboard.log"
#define TARGET_FILE "/data/codex/bthid_target"
#define PROFILE_FILE "/data/codex/bthid_profile"
#define PID_FILE "/var/run/codex-bthid-keyboard.pid"
#define LOG_MAX_BYTES 32768

static const unsigned char RELEASE_REPORT[10] = {0xa1, 0x01, 0, 0, 0, 0, 0, 0, 0, 0};
static int owns_pid_file = 0;
static int last_native_code = -1;

static int extract_bt_addr(const char *text, char *out, size_t outlen);

static int send_all(int fd, const unsigned char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, buf + sent, len - sent, 0);
        if (n <= 0) return -1;
        sent += (size_t)n;
    }
    return 0;
}

static unsigned long read_number(const unsigned char *buf, size_t len) {
    unsigned long out = 0;
    size_t i;
    for (i = 0; i < len; i++) out = (out << 8) | buf[i];
    return out;
}

static int append_payload(unsigned char **payload, size_t *payload_len,
                          const unsigned char *chunk, size_t chunk_len) {
    unsigned char *next = (unsigned char *)realloc(*payload, *payload_len + chunk_len + 1);
    if (!next) return -1;
    *payload = next;
    memcpy(*payload + *payload_len, chunk, chunk_len);
    *payload_len += chunk_len;
    (*payload)[*payload_len] = 0;
    return 0;
}

static size_t skip_frame_padding(const unsigned char *buf, size_t pos, size_t len) {
    size_t next_frame = ((pos / LTCP_FRAME_SIZE) + 1) * LTCP_FRAME_SIZE;
    size_t i;
    if (next_frame <= pos || next_frame >= len) return pos;
    for (i = pos; i < next_frame; i++) {
        if (buf[i] != 0) return pos;
    }
    return next_frame;
}

static int decode_ltcp_payload(const unsigned char *buf, size_t len,
                               unsigned char **payload, size_t *payload_len) {
    size_t pos = 0;
    unsigned int param_count, packets = 0, i;
    *payload = NULL;
    *payload_len = 0;
    if (len < 4 || buf[0] != 0xff) return -1;
    param_count = buf[3] & 0x3f;
    pos = 4;
    for (i = 0; i < param_count; i++) {
        unsigned int tag, plen;
        if (pos >= len) return -1;
        tag = buf[pos++];
        plen = tag & 0x3f;
        if (plen == 0) {
            while (pos < len && buf[pos] != 0) pos++;
            if (pos >= len) return -1;
            pos++;
        } else {
            if (pos + plen > len) return -1;
            packets = (unsigned int)read_number(buf + pos, plen);
            pos += plen;
        }
    }
    if (packets == 0) return 0;
    packets--;
    while (packets > 0 && pos + 2 <= len) {
        unsigned int hdr, chunk_len;
        pos = skip_frame_padding(buf, pos, len);
        if (pos + 2 > len) return -1;
        pos++;
        hdr = buf[pos++];
        if (hdr & 0x40) {
            if (pos >= len) return -1;
            chunk_len = ((hdr & 0x3f) << 8) | buf[pos++];
        } else {
            chunk_len = hdr & 0x3f;
        }
        if (pos + chunk_len > len) return -1;
        if (append_payload(payload, payload_len, buf + pos, chunk_len) != 0) return -1;
        pos += chunk_len;
        packets--;
    }
    if (packets > 0) {
        free(*payload);
        *payload = NULL;
        *payload_len = 0;
    }
    return 0;
}

static int json_native_code(const char *json) {
    const char *p, *colon;
    char *end;
    long value;
    if (!json) return -1;
    p = strstr(json, "\"code\"");
    if (!p) return -1;
    colon = strchr(p, ':');
    if (!colon) return -1;
    errno = 0;
    value = strtol(colon + 1, &end, 10);
    if (errno != 0 || end == colon + 1 || value < 0 || value > 999) return -1;
    return (int)value;
}

static int json_native_connected(const char *json) {
    const char *p, *colon;
    if (!json) return 0;
    p = strstr(json, "\"connected\"");
    if (!p) return 0;
    colon = strchr(p, ':');
    if (!colon) return 0;
    colon++;
    while (*colon && isspace((unsigned char)*colon)) colon++;
    return strncmp(colon, "true", 4) == 0;
}

static int json_native_string(const char *json, const char *key,
                              char *out, size_t outlen) {
    char needle[96];
    const char *p, *colon, *start, *end;
    size_t len;
    if (!json || !key || !out || outlen < 2 ||
        strlen(key) + 3 >= sizeof(needle)) {
        return 0;
    }
    out[0] = 0;
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    p = strstr(json, needle);
    if (!p) return 0;
    colon = strchr(p, ':');
    if (!colon) return 0;
    start = colon + 1;
    while (*start && isspace((unsigned char)*start)) start++;
    if (*start != '"') return 0;
    start++;
    end = strchr(start, '"');
    if (!end) return 0;
    len = (size_t)(end - start);
    if (len >= outlen) return 0;
    memcpy(out, start, len);
    out[len] = 0;
    return 1;
}

static int read_native_response(int fd, char *response, size_t response_len) {
    unsigned char raw[MAX_RESPONSE_SIZE];
    unsigned char *payload = NULL;
    size_t total = 0, payload_len = 0;
    int code = -1;
    if (response && response_len) response[0] = 0;
    while (total < sizeof(raw)) {
        ssize_t n = recv(fd, raw + total, sizeof(raw) - total, 0);
        unsigned char *complete = NULL;
        size_t complete_len = 0;
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            return -1;
        }
        if (n == 0) break;
        total += (size_t)n;
        if (decode_ltcp_payload(raw, total, &complete, &complete_len) == 0 &&
            complete) {
            payload = complete;
            payload_len = complete_len;
            break;
        }
        free(complete);
    }
    if (!payload) {
        decode_ltcp_payload(raw, total, &payload, &payload_len);
    }
    if (payload) {
        if (response && response_len) {
            size_t copy = payload_len < response_len - 1
                ? payload_len : response_len - 1;
            memcpy(response, payload, copy);
            response[copy] = 0;
        }
        code = json_native_code((const char *)payload);
    }
    free(payload);
    return code;
}

static int run_self_test(void) {
    unsigned char frame[LTCP_FRAME_SIZE];
    const char *reply = "{\"id\":1,\"code\":200}";
    unsigned char *payload = NULL;
    size_t payload_len = 0;
    size_t reply_len = strlen(reply);
    char addr[32];
    int failed = 0;

    memset(frame, 0, sizeof(frame));
    frame[0] = 0xff;
    frame[3] = 0x01;
    frame[4] = 0x01;
    frame[5] = 0x02;
    frame[6] = 0x01;
    frame[7] = (unsigned char)(0x80 | reply_len);
    memcpy(frame + 8, reply, reply_len);

    if (decode_ltcp_payload(frame, sizeof(frame), &payload, &payload_len) != 0 ||
        !payload || payload_len != reply_len ||
        memcmp(payload, reply, reply_len) != 0 ||
        json_native_code((const char *)payload) != 200) {
        fputs("FAIL LTCP native response decode\n", stderr);
        failed = 1;
    }
    free(payload);
    if (json_native_code("{\"id\":1,\"code\":505}") != 505 ||
        json_native_code("{\"id\":1}") != -1 ||
        json_native_code("{\"code\":-1}") != -1 ||
        !json_native_connected("{\"code\":200,\"data\":{\"connected\":true}}") ||
        json_native_connected("{\"code\":200,\"data\":{\"connected\":false}}") ||
        !json_native_string(
            "{\"data\":{\"bdaddr\":\"22:22:7C:82:96:9E\"}}",
            "bdaddr", addr, sizeof(addr)
        ) ||
        strcmp(addr, "22:22:7C:82:96:9E") != 0) {
        fputs("FAIL native response code validation\n", stderr);
        failed = 1;
    }
    if (extract_bt_addr("Connections:\n< ACL 00:00:00:00:00:00 handle 0", addr, sizeof(addr)) ||
        !extract_bt_addr("Connections:\n< ACL 00:04:4B:72:67:03 handle 1", addr, sizeof(addr)) ||
        strcmp(addr, "00:04:4B:72:67:03") != 0) {
        fputs("FAIL Bluetooth placeholder address filtering\n", stderr);
        failed = 1;
    }
    if (!failed) puts("PASS Bluetooth HID native response validation");
    return failed;
}

static int connect_hal(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr;
    struct timeval tv;
    unsigned char hello = 0x06;
    if (fd < 0) return -1;
    tv.tv_sec = 10;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(HAL_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    if (send_all(fd, &hello, 1) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int send_ltcp_command(int fd, const unsigned char *payload, size_t len) {
    unsigned char primary[6] = {0xff, 0x08, 0x00, 0x01, 0x01, 0x02};
    unsigned char secondary[3];
    unsigned char *stream;
    size_t secondary_len, stream_len = 0, pos = 0;
    if (len > MAX_JSON_SIZE) return -1;
    secondary[0] = 0x01;
    if (len > 63) {
        secondary[1] = (unsigned char)(0x80 | 0x40 | ((len >> 8) & 0x3f));
        secondary[2] = (unsigned char)(len & 0xff);
        secondary_len = 3;
    } else {
        secondary[1] = (unsigned char)(0x80 | len);
        secondary_len = 2;
    }
    stream = (unsigned char *)malloc(sizeof(primary) + secondary_len + len);
    if (!stream) return -1;
    memcpy(stream + stream_len, primary, sizeof(primary));
    stream_len += sizeof(primary);
    memcpy(stream + stream_len, secondary, secondary_len);
    stream_len += secondary_len;
    memcpy(stream + stream_len, payload, len);
    stream_len += len;
    while (pos < stream_len) {
        unsigned char frame[LTCP_FRAME_SIZE];
        size_t chunk = stream_len - pos;
        if (chunk > sizeof(frame)) chunk = sizeof(frame);
        memset(frame, 0, sizeof(frame));
        memcpy(frame, stream + pos, chunk);
        if (send_all(fd, frame, sizeof(frame)) != 0) {
            free(stream);
            return -1;
        }
        pos += chunk;
    }
    free(stream);
    return 0;
}

static int native_hid_ready(const char *type, const char *bdaddr) {
    char json[256], response[512], current_addr[32];
    int fd, rc, code;
    response[0] = 0;
    current_addr[0] = 0;
    snprintf(json, sizeof(json),
        "{\"id\":1,\"cmd\":\"bthid.status\",\"data\":{\"type\":\"%s\"},\"timeout\":4}",
        type);
    fd = connect_hal();
    if (fd < 0) {
        last_native_code = -1;
        return 0;
    }
    rc = send_ltcp_command(fd, (const unsigned char *)json, strlen(json));
    code = rc == 0
        ? read_native_response(fd, response, sizeof(response))
        : -1;
    close(fd);
    last_native_code = code;
    return code == 200 &&
        json_native_connected(response) &&
        json_native_string(
            response, "bdaddr", current_addr, sizeof(current_addr)
        ) &&
        strcasecmp(current_addr, bdaddr) == 0;
}

static int safe_bt_addr(const char *s) {
    int i;
    if (!s || strlen(s) != 17) return 0;
    for (i = 0; i < 17; i++) {
        if ((i % 3) == 2) {
            if (s[i] != ':') return 0;
        } else if (!isxdigit((unsigned char)s[i])) {
            return 0;
        }
    }
    return 1;
}

static int safe_bt_type(const char *s) {
    return s && (
        strcmp(s, "btkeyboard") == 0 ||
        strcmp(s, "btkeyboard-nexus") == 0 ||
        strcmp(s, "fire") == 0 ||
        strcmp(s, "ps3") == 0 ||
        strcmp(s, "wii") == 0);
}

static int send_report(const char *type, const char *bdaddr, const unsigned char *report, size_t report_len) {
    char json[256];
    unsigned char request[512];
    int fd, rc;
    size_t json_len;
    snprintf(json, sizeof(json),
        "{\"id\":1,\"cmd\":\"bthid.report\",\"data\":{\"type\":\"%s\",\"bdaddr\":\"%s\"},\"timeout\":8}",
        type, bdaddr);
    if (!native_hid_ready(type, bdaddr)) {
        if (last_native_code == 200) last_native_code = 409;
        return -1;
    }
    json_len = strlen(json);
    if (json_len + report_len > sizeof(request)) return -1;
    memcpy(request, json, json_len);
    memcpy(request + json_len, report, report_len);
    fd = connect_hal();
    if (fd < 0) return -1;
    rc = send_ltcp_command(fd, request, json_len + report_len);
    if (rc == 0) {
        last_native_code = read_native_response(fd, NULL, 0);
        if (last_native_code != 200) rc = -1;
    } else {
        last_native_code = -1;
    }
    close(fd);
    return rc;
}

static void rotate_log_if_needed(void) {
    struct stat st;
    if (stat(DEFAULT_LOG, &st) == 0 && st.st_size > LOG_MAX_BYTES) {
        unlink(DEFAULT_LOG ".1");
        rename(DEFAULT_LOG, DEFAULT_LOG ".1");
    }
}

static void log_line(const char *fmt, ...) {
    FILE *f;
    va_list ap;
    time_t now = time(NULL);
    rotate_log_if_needed();
    f = fopen(DEFAULT_LOG, "a");
    if (!f) return;
    fprintf(f, "%ld ", (long)now);
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

static int process_alive(long pid) {
    if (pid <= 1) return 0;
    if (kill((pid_t)pid, 0) == 0) return 1;
    return errno == EPERM;
}

static int acquire_pid_file(void) {
    int attempt;
    for (attempt = 0; attempt < 3; attempt++) {
        int fd = open(PID_FILE, O_WRONLY | O_CREAT | O_EXCL, 0644);
        if (fd >= 0) {
            char buf[32];
            int n = snprintf(buf, sizeof(buf), "%ld\n", (long)getpid());
            if (write(fd, buf, (size_t)n) != n) {
                close(fd);
                unlink(PID_FILE);
                return -1;
            }
            close(fd);
            owns_pid_file = 1;
            return 0;
        }
        if (errno != EEXIST) return -1;
        {
            FILE *f = fopen(PID_FILE, "r");
            long pid = 0;
            if (f) {
                if (fscanf(f, "%ld", &pid) != 1) pid = 0;
                fclose(f);
            }
            if (process_alive(pid)) return 1;
        }
        unlink(PID_FILE);
    }
    return -1;
}

static void release_pid_file(void) {
    if (owns_pid_file) {
        unlink(PID_FILE);
        owns_pid_file = 0;
    }
}

static void stop_signal(int signo) {
    release_pid_file();
    _exit(128 + signo);
}

static void status_json_string(FILE *f, const char *s) {
    const unsigned char *p = (const unsigned char *)(s ? s : "");
    fputc('"', f);
    while (*p) {
        if (*p == '"' || *p == '\\') {
            fputc('\\', f);
            fputc(*p, f);
        } else if (*p == '\n') {
            fputs("\\n", f);
        } else if (*p == '\r') {
            fputs("\\r", f);
        } else if (*p == '\t') {
            fputs("\\t", f);
        } else if (*p < 32) {
            fprintf(f, "\\u%04x", (unsigned int)*p);
        } else {
            fputc(*p, f);
        }
        p++;
    }
    fputc('"', f);
}

static void write_status(const char *state, const char *target, unsigned long sent, unsigned long skipped, const char *error) {
    FILE *f = fopen(DEFAULT_STATUS ".new", "w");
    time_t now = time(NULL);
    if (!f) return;
    fprintf(f, "{\"ok\":true,\"runtime\":true,\"pid\":%ld,\"updated\":%ld,\"state\":",
        (long)getpid(), (long)now);
    status_json_string(f, state ? state : "unknown");
    fputs(",\"target\":", f);
    status_json_string(f, target ? target : "");
    fprintf(f, ",\"sent\":%lu,\"skipped\":%lu,\"error\":", sent, skipped);
    status_json_string(f, error ? error : "");
    fputs("}\n", f);
    fclose(f);
    rename(DEFAULT_STATUS ".new", DEFAULT_STATUS);
}

static int extract_bt_addr(const char *text, char *out, size_t outlen) {
    const char *p = text;
    if (!text || !out || outlen < 18) return 0;
    out[0] = 0;
    while (*p) {
        if (isxdigit((unsigned char)p[0]) && isxdigit((unsigned char)p[1]) &&
            p[2] == ':' && isxdigit((unsigned char)p[3]) && isxdigit((unsigned char)p[4])) {
            char candidate[18];
            int i;
            for (i = 0; i < 17 && p[i]; i++) candidate[i] = (char)toupper((unsigned char)p[i]);
            candidate[17] = 0;
            if (safe_bt_addr(candidate) && strcmp(candidate, "00:00:00:00:00:00") != 0) {
                snprintf(out, outlen, "%s", candidate);
                return 1;
            }
        }
        p++;
    }
    return 0;
}

static int read_target_file(char *type, size_t typelen, char *addr, size_t addrlen) {
    FILE *f = fopen(TARGET_FILE, "r");
    char line[160];
    if (!f) return 0;
    while (fgets(line, sizeof(line), f)) {
        char *v;
        while (*line && isspace((unsigned char)*line)) memmove(line, line + 1, strlen(line));
        v = strchr(line, '=');
        if (!v) continue;
        *v++ = 0;
        while (*v && isspace((unsigned char)*v)) v++;
        line[strcspn(line, " \t\r\n")] = 0;
        v[strcspn(v, " \t\r\n")] = 0;
        if (strcmp(line, "type") == 0 && safe_bt_type(v)) snprintf(type, typelen, "%s", v);
        else if (strcmp(line, "bdaddr") == 0 && safe_bt_addr(v)) snprintf(addr, addrlen, "%s", v);
    }
    fclose(f);
    return safe_bt_addr(addr);
}

static int read_profile_file(char *type, size_t typelen) {
    FILE *f = fopen(PROFILE_FILE, "r");
    char line[96];
    if (!f) return 0;
    while (fgets(line, sizeof(line), f)) {
        char *v = strchr(line, '=');
        if (!v) continue;
        *v++ = 0;
        line[strcspn(line, " \t\r\n")] = 0;
        v[strcspn(v, " \t\r\n")] = 0;
        if (strcmp(line, "type") == 0 && safe_bt_type(v)) {
            snprintf(type, typelen, "%s", v);
            fclose(f);
            return 1;
        }
    }
    fclose(f);
    return 0;
}

static int text_has_bt_addr(const char *text, const char *wanted) {
    const char *p = text;
    if (!text || !safe_bt_addr(wanted)) return 0;
    while (*p) {
        if (isxdigit((unsigned char)p[0]) && isxdigit((unsigned char)p[1]) &&
            p[2] == ':' && isxdigit((unsigned char)p[3]) && isxdigit((unsigned char)p[4])) {
            char candidate[18];
            int i;
            for (i = 0; i < 17 && p[i]; i++) candidate[i] = (char)toupper((unsigned char)p[i]);
            candidate[17] = 0;
            if (safe_bt_addr(candidate) && strcasecmp(candidate, wanted) == 0) return 1;
        }
        p++;
    }
    return 0;
}

static int detect_connected_target(char *type, size_t typelen, char *addr, size_t addrlen) {
    FILE *p;
    char buf[512], all[2048], profile_type[40] = "", target_type[40] = "", target_addr[32] = "";
    size_t n = 0;
    addr[0] = 0;
    read_profile_file(profile_type, sizeof(profile_type));
    read_target_file(target_type, sizeof(target_type), target_addr, sizeof(target_addr));
    if (profile_type[0]) snprintf(type, typelen, "%s", profile_type);
    else if (target_type[0]) snprintf(type, typelen, "%s", target_type);
    else if (!type[0]) snprintf(type, typelen, "%s", "btkeyboard");
    p = popen("hcitool con 2>/dev/null", "r");
    if (p) {
        all[0] = 0;
        while (fgets(buf, sizeof(buf), p)) {
            size_t len = strlen(buf);
            if (n + len + 1 < sizeof(all)) {
                memcpy(all + n, buf, len);
                n += len;
                all[n] = 0;
            }
        }
        pclose(p);
        if (safe_bt_addr(target_addr) && text_has_bt_addr(all, target_addr)) {
            snprintf(addr, addrlen, "%s", target_addr);
            return 1;
        }
        if (extract_bt_addr(all, addr, addrlen)) return 1;
    }
    addr[0] = 0;
    return 0;
}

static int map_ascii(unsigned char ch, unsigned char *mod, unsigned char *usage) {
    *mod = 0;
    *usage = 0;
    if (ch >= 'a' && ch <= 'z') {
        *usage = (unsigned char)(0x04 + (ch - 'a'));
        return 1;
    }
    if (ch >= 'A' && ch <= 'Z') {
        *mod = 0x02;
        *usage = (unsigned char)(0x04 + (ch - 'A'));
        return 1;
    }
    if (ch >= '1' && ch <= '9') {
        *usage = (unsigned char)(0x1e + (ch - '1'));
        return 1;
    }
    if (ch == '0') { *usage = 0x27; return 1; }
    if (ch == '\n' || ch == '\r') { *usage = 0x28; return 1; }
    if (ch == '\t') { *usage = 0x2b; return 1; }
    if (ch == ' ') { *usage = 0x2c; return 1; }
    switch (ch) {
    case '!': *mod = 0x02; *usage = 0x1e; return 1;
    case '@': *mod = 0x02; *usage = 0x1f; return 1;
    case '#': *mod = 0x02; *usage = 0x20; return 1;
    case '$': *mod = 0x02; *usage = 0x21; return 1;
    case '%': *mod = 0x02; *usage = 0x22; return 1;
    case '^': *mod = 0x02; *usage = 0x23; return 1;
    case '&': *mod = 0x02; *usage = 0x24; return 1;
    case '*': *mod = 0x02; *usage = 0x25; return 1;
    case '(': *mod = 0x02; *usage = 0x26; return 1;
    case ')': *mod = 0x02; *usage = 0x27; return 1;
    case '-': *usage = 0x2d; return 1;
    case '_': *mod = 0x02; *usage = 0x2d; return 1;
    case '=': *usage = 0x2e; return 1;
    case '+': *mod = 0x02; *usage = 0x2e; return 1;
    case '[': *usage = 0x2f; return 1;
    case '{': *mod = 0x02; *usage = 0x2f; return 1;
    case ']': *usage = 0x30; return 1;
    case '}': *mod = 0x02; *usage = 0x30; return 1;
    case '\\': *usage = 0x31; return 1;
    case '|': *mod = 0x02; *usage = 0x31; return 1;
    case ';': *usage = 0x33; return 1;
    case ':': *mod = 0x02; *usage = 0x33; return 1;
    case '\'': *usage = 0x34; return 1;
    case '"': *mod = 0x02; *usage = 0x34; return 1;
    case '`': *usage = 0x35; return 1;
    case '~': *mod = 0x02; *usage = 0x35; return 1;
    case ',': *usage = 0x36; return 1;
    case '<': *mod = 0x02; *usage = 0x36; return 1;
    case '.': *usage = 0x37; return 1;
    case '>': *mod = 0x02; *usage = 0x37; return 1;
    case '/': *usage = 0x38; return 1;
    case '?': *mod = 0x02; *usage = 0x38; return 1;
    default: return 0;
    }
}

static int send_ascii_char(const char *type, const char *addr, unsigned char ch, int release_ms, int gap_ms) {
    unsigned char mod, usage;
    unsigned char report[10] = {0xa1, 0x01, 0, 0, 0, 0, 0, 0, 0, 0};
    if (!map_ascii(ch, &mod, &usage)) return 0;
    report[2] = mod;
    report[4] = usage;
    if (send_report(type, addr, report, sizeof(report)) != 0) return -1;
    usleep((useconds_t)release_ms * 1000);
    if (send_report(type, addr, RELEASE_REPORT, sizeof(RELEASE_REPORT)) != 0) return -1;
    usleep((useconds_t)gap_ms * 1000);
    return 1;
}

static void ensure_fifo(const char *fifo) {
    struct stat st;
    if (stat(fifo, &st) == 0 && !S_ISFIFO(st.st_mode)) unlink(fifo);
    if (stat(fifo, &st) != 0) mkfifo(fifo, 0666);
    chmod(fifo, 0666);
}

int main(int argc, char **argv) {
    const char *fifo = DEFAULT_FIFO;
    char type[40] = "btkeyboard";
    char addr[32] = "";
    unsigned long sent = 0, skipped = 0;
    int gap_ms = 20, release_ms = 5;
    int i, lock_rc;
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return run_self_test();
    for (i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--fifo=", 7) == 0) fifo = argv[i] + 7;
        else if (strncmp(argv[i], "--type=", 7) == 0 && safe_bt_type(argv[i] + 7)) snprintf(type, sizeof(type), "%s", argv[i] + 7);
        else if (strncmp(argv[i], "--gap-ms=", 9) == 0) gap_ms = atoi(argv[i] + 9);
        else if (strncmp(argv[i], "--release-ms=", 13) == 0) release_ms = atoi(argv[i] + 13);
    }
    if (gap_ms < 5) gap_ms = 5;
    if (gap_ms > 1000) gap_ms = 1000;
    if (release_ms < 2) release_ms = 2;
    if (release_ms > 100) release_ms = 100;

    lock_rc = acquire_pid_file();
    if (lock_rc > 0) {
        log_line("bthid keyboard runtime already running; duplicate start ignored");
        return 0;
    }
    if (lock_rc < 0) {
        log_line("bthid keyboard runtime could not acquire %s: %s", PID_FILE, strerror(errno));
        return 1;
    }
    atexit(release_pid_file);
    signal(SIGTERM, stop_signal);
    signal(SIGINT, stop_signal);

    ensure_fifo(fifo);
    log_line("bthid keyboard runtime start fifo=%s type=%s gap=%d release=%d", fifo, type, gap_ms, release_ms);

    for (;;) {
        int fd;
        if (!detect_connected_target(type, sizeof(type), addr, sizeof(addr))) {
            write_status("no_target", "", sent, skipped, "no live Bluetooth HID connection");
            sleep(1);
            continue;
        }
        fd = open(fifo, O_RDWR | O_NONBLOCK);
        if (fd < 0) {
            write_status("fifo_error", addr, sent, skipped, strerror(errno));
            sleep(1);
            continue;
        }
        write_status("listening", addr, sent, skipped, "");
        log_line("listening target=%s type=%s", addr, type);
        while (1) {
            fd_set rfds;
            struct timeval tv;
            unsigned char buf[256];
            ssize_t n;
            char latest_type[40] = "";
            char latest_addr[32] = "";
            FD_ZERO(&rfds);
            FD_SET(fd, &rfds);
            tv.tv_sec = 2;
            tv.tv_usec = 0;
            if (select(fd + 1, &rfds, NULL, NULL, &tv) <= 0) {
                if (!detect_connected_target(latest_type, sizeof(latest_type), latest_addr, sizeof(latest_addr)) ||
                    strcmp(latest_addr, addr) != 0) {
                    close(fd);
                    break;
                }
                write_status("listening", addr, sent, skipped, "");
                continue;
            }
            n = read(fd, buf, sizeof(buf));
            if (n <= 0) continue;
            for (i = 0; i < n; i++) {
                int rc;
                if (buf[i] >= 0x80) {
                    skipped++;
                    continue;
                }
                rc = send_ascii_char(type, addr, buf[i], release_ms, gap_ms);
                if (rc > 0) sent++;
                else if (rc == 0) skipped++;
                else {
                    char send_error[96];
                    skipped++;
                    if (last_native_code >= 0) {
                        snprintf(send_error, sizeof(send_error),
                            "Harmony HAL rejected bthid.report (code %d)", last_native_code);
                    } else {
                        snprintf(send_error, sizeof(send_error),
                            "Harmony HAL did not return a valid bthid.report response");
                    }
                    write_status("send_error", addr, sent, skipped, send_error);
                    log_line("send failed target=%s byte=%u native_code=%d",
                        addr, (unsigned int)buf[i], last_native_code);
                    close(fd);
                    fd = -1;
                    break;
                }
            }
            if (fd >= 0) write_status("listening", addr, sent, skipped, "");
            if (fd < 0) break;
        }
        if (fd >= 0) close(fd);
    }
}
