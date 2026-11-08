#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

static const char *page =
    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n"
    "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>Harmony Recovery</title><style>"
    "body{font-family:sans-serif;margin:2rem;max-width:34rem}label{display:block;margin:.9rem 0 .3rem}"
    "input{font-size:1rem;padding:.55rem;width:100%;box-sizing:border-box}button{margin-top:1rem;padding:.7rem 1rem;font-size:1rem}"
    "</style></head><body><h1>Harmony Wi-Fi Recovery</h1>"
    "<form method='post' action='/wifi'>"
    "<label>SSID</label><input name='ssid' required>"
    "<label>Password</label><input name='password' type='password'>"
    "<label><input name='hidden' type='checkbox' value='1' style='width:auto'> Hidden network</label>"
    "<button type='submit'>Save and reboot</button></form></body></html>";

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void url_decode(char *s) {
    char *r = s;
    char *w = s;
    while (*r) {
        if (*r == '+') {
            *w++ = ' ';
            r++;
        } else if (*r == '%' && isxdigit((unsigned char)r[1]) && isxdigit((unsigned char)r[2])) {
            *w++ = (char)(hexval(r[1]) * 16 + hexval(r[2]));
            r += 3;
        } else {
            *w++ = *r++;
        }
    }
    *w = 0;
}

static void form_value(const char *body, const char *name, char *out, size_t outlen) {
    size_t namelen = strlen(name);
    const char *p = body;
    out[0] = 0;
    while (p && *p) {
        const char *eq = strchr(p, '=');
        const char *amp = strchr(p, '&');
        size_t keylen;
        size_t vallen;
        if (!eq) return;
        if (amp && amp < eq) {
            p = amp + 1;
            continue;
        }
        keylen = (size_t)(eq - p);
        if (keylen == namelen && strncmp(p, name, namelen) == 0) {
            const char *vstart = eq + 1;
            const char *vend = amp ? amp : p + strlen(p);
            vallen = (size_t)(vend - vstart);
            if (vallen >= outlen) vallen = outlen - 1;
            memcpy(out, vstart, vallen);
            out[vallen] = 0;
            url_decode(out);
            return;
        }
        p = amp ? amp + 1 : NULL;
    }
}

static void write_quoted(FILE *f, const char *s) {
    fputc('"', f);
    while (*s) {
        unsigned char c = (unsigned char)*s;
        /* Never let a control character (incl. \n / \r) break out of the
           quoted wpa_supplicant value and inject a new config line. */
        if (c < 0x20 || c == 0x7f) {
            s++;
            continue;
        }
        if (*s == '"' || *s == '\\') {
            fputc('\\', f);
        }
        fputc(*s, f);
        s++;
    }
    fputc('"', f);
}

static int valid_ssid(const char *s) {
    size_t n = strlen(s);
    size_t i;
    if (n < 1 || n > 32) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x20 || c == 0x7f) return 0;
    }
    return 1;
}

static int valid_password(const char *s) {
    size_t n = strlen(s);
    size_t i;
    if (n == 0) return 1; /* open network */
    if (n == 64) {
        for (i = 0; i < n; i++) {
            if (!isxdigit((unsigned char)s[i])) break;
        }
        if (i == n) return 1; /* raw 64-hex PSK */
    }
    if (n < 8 || n > 63) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x20 || c > 0x7e) return 0;
    }
    return 1;
}

static int save_wifi(const char *ssid, const char *password, int hidden) {
    FILE *f = fopen("/etc/wpa_supplicant.conf", "w");
    if (!f) {
        return -1;
    }
    fprintf(f, "ctrl_interface=/var/run/wpa_supplicant\n");
    fprintf(f, "ap_scan=1\n\n");
    fprintf(f, "network={\n");
    fprintf(f, "\tssid=");
    write_quoted(f, ssid);
    fprintf(f, "\n");
    if (hidden) {
        fprintf(f, "\tscan_ssid=1\n");
    }
    if (password && password[0]) {
        fprintf(f, "\tkey_mgmt=WPA-PSK\n\tpsk=");
        write_quoted(f, password);
        fprintf(f, "\n");
    } else {
        fprintf(f, "\tkey_mgmt=NONE\n");
    }
    fprintf(f, "}\n");
    fclose(f);
    chmod("/etc/wpa_supplicant.conf", 0600);
    sync();
    return 0;
}

static int content_length(const char *headers) {
    const char *needle = "Content-Length:";
    const char *p = headers;
    size_t nlen = strlen(needle);
    while (*p) {
        size_t i;
        for (i = 0; i < nlen; i++) {
            if (!p[i] || tolower((unsigned char)p[i]) != tolower((unsigned char)needle[i])) {
                break;
            }
        }
        if (i == nlen) {
            break;
        }
        p++;
    }
    if (!*p) return 0;
    p += 15;
    while (*p == ' ' || *p == '\t') p++;
    return atoi(p);
}

static void send_text(int fd, const char *status, const char *body) {
    char hdr[256];
    snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        status, (unsigned long)strlen(body));
    send(fd, hdr, strlen(hdr), 0);
    send(fd, body, strlen(body), 0);
}

static void handle_client(int client) {
    char buf[8192];
    int n;
    char *body;
    int clen;
    n = recv(client, buf, sizeof(buf) - 1, 0);
    if (n <= 0) return;
    buf[n] = 0;
    if (strncmp(buf, "GET ", 4) == 0) {
        send(client, page, strlen(page), 0);
        return;
    }
    if (strncmp(buf, "POST /wifi ", 11) != 0) {
        send_text(client, "404 Not Found", "not found\n");
        return;
    }
    body = strstr(buf, "\r\n\r\n");
    if (!body) {
        send_text(client, "400 Bad Request", "bad request\n");
        return;
    }
    body += 4;
    clen = content_length(buf);
    while ((int)strlen(body) < clen && n < (int)sizeof(buf) - 1) {
        int got = recv(client, buf + n, sizeof(buf) - 1 - n, 0);
        if (got <= 0) break;
        n += got;
        buf[n] = 0;
    }
    {
        char ssid[256];
        char password[256];
        char hidden[16];
        form_value(body, "ssid", ssid, sizeof(ssid));
        form_value(body, "password", password, sizeof(password));
        form_value(body, "hidden", hidden, sizeof(hidden));
        if (!ssid[0]) {
            send_text(client, "400 Bad Request", "missing ssid\n");
            return;
        }
        if (!valid_ssid(ssid)) {
            send_text(client, "400 Bad Request", "invalid ssid: 1-32 bytes, no control characters\n");
            return;
        }
        if (!valid_password(password)) {
            send_text(client, "400 Bad Request", "invalid password: 8-63 printable ASCII characters or 64 hex digits\n");
            return;
        }
        if (save_wifi(ssid, password, hidden[0] != 0) == 0) {
            send_text(client, "200 OK", "saved; rebooting\n");
            system("/sbin/reboot");
        } else {
            send_text(client, "500 Internal Server Error", "failed to save wifi\n");
        }
    }
}

int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 80;
    /* Bind only to the recovery AP address (AP_IP in recovery_ap.sh), never
       INADDR_ANY: the portal must not be reachable from any other interface. */
    const char *bind_ip = argc > 2 ? argv[2] : "192.168.76.1";
    int fd;
    int one = 1;
    struct sockaddr_in addr;
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = inet_addr(bind_ip);
    if (addr.sin_addr.s_addr == INADDR_NONE) {
        fprintf(stderr, "invalid bind address: %s\n", bind_ip);
        return 1;
    }
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        return 1;
    }
    if (listen(fd, 8) != 0) {
        perror("listen");
        return 1;
    }
    fprintf(stderr, "codex_portal listening on %s:%d\n", bind_ip, port);
    while (1) {
        int client = accept(fd, NULL, NULL);
        struct timeval tv;
        if (client < 0) continue;
        /* A stalled or silent client must not block this single-threaded
           portal forever. */
        tv.tv_sec = 5;
        tv.tv_usec = 0;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        handle_client(client);
        close(client);
    }
}
