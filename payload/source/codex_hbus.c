#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define MAX_PARAMS_BYTES (2 * 1024 * 1024)
#define MAX_RESPONSE_BYTES (2 * 1024 * 1024)
#define RESPONSE_TIMEOUT_MS 95000
#define REQUEST_TIMEOUT_SECONDS 90
#define MAX_RESPONSE_FRAMES 256

#ifdef CODEX_HBUS_DEBUG
#define HBUS_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
#define HBUS_DEBUG(...) ((void)0)
#endif

static int send_all(int fd, const unsigned char *data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, data + sent, len - sent, 0);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return -1;
        }
        sent += (size_t)n;
    }
    return 0;
}

static int read_exact(int fd, unsigned char *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = recv(fd, buf + got, len - got, 0);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return -1;
        }
        got += (size_t)n;
    }
    return 0;
}

static int connect_local(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr;
    struct timeval tv;
    if (fd < 0) {
        return -1;
    }
    tv.tv_sec = 95;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    tv.tv_sec = 8;
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8088);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int websocket_handshake(int fd, const char *hub_id) {
    char req[512];
    unsigned char resp[2048];
    size_t got = 0;
    snprintf(req, sizeof(req),
        "GET /?domain=svcs.myharmony.com&hubId=%s HTTP/1.1\r\n"
        "Host: 127.0.0.1:8088\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n", hub_id);
    if (send_all(fd, (const unsigned char *)req, strlen(req)) != 0) {
        return -1;
    }
    while (got + 1 < sizeof(resp)) {
        ssize_t n = recv(fd, resp + got, 1, 0);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return -1;
        }
        got += (size_t)n;
        if (got >= 4 && memcmp(resp + got - 4, "\r\n\r\n", 4) == 0) {
            break;
        }
    }
    if (got < 4 || memcmp(resp + got - 4, "\r\n\r\n", 4) != 0) {
        return -1;
    }
    resp[got] = 0;
    if (!strstr((char *)resp, "101 Switching Protocols")) {
        fprintf(stderr, "%s\n", resp);
        return -1;
    }
    return 0;
}

static int send_ws_frame(
    int fd,
    unsigned char opcode,
    const unsigned char *payload,
    size_t len
) {
    unsigned char hdr[14];
    unsigned char mask[4] = {0x13, 0x37, 0x42, 0x99};
    unsigned long long wire_len = (unsigned long long)len;
    size_t hlen = 0;
    size_t i;
    hdr[hlen++] = (unsigned char)(0x80 | (opcode & 0x0f));
    if (len < 126) {
        hdr[hlen++] = 0x80 | (unsigned char)len;
    } else if (len <= 65535) {
        hdr[hlen++] = 0x80 | 126;
        hdr[hlen++] = (unsigned char)((len >> 8) & 0xff);
        hdr[hlen++] = (unsigned char)(len & 0xff);
    } else {
        hdr[hlen++] = 0x80 | 127;
        for (i = 0; i < 8; i++) {
            hdr[hlen++] = (unsigned char)((wire_len >> (56 - 8 * i)) & 0xff);
        }
    }
    memcpy(hdr + hlen, mask, 4);
    hlen += 4;
    if (send_all(fd, hdr, hlen) != 0) {
        return -1;
    }
    for (i = 0; i < len; i += 1024) {
        unsigned char out[1024];
        size_t j;
        size_t chunk = len - i > sizeof(out) ? sizeof(out) : len - i;
        for (j = 0; j < chunk; j++) {
            out[j] = payload[i + j] ^ mask[(i + j) & 3];
        }
        if (send_all(fd, out, chunk) != 0) {
            return -1;
        }
    }
    return 0;
}

static int send_ws_text(int fd, const char *payload) {
    return send_ws_frame(
        fd, 0x1, (const unsigned char *)payload, strlen(payload));
}

static long long now_millis(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000LL + (long long)tv.tv_usec / 1000LL;
}

static int set_recv_timeout_ms(int fd, long long timeout_ms) {
    struct timeval tv;
    if (timeout_ms < 1) timeout_ms = 1;
    tv.tv_sec = (time_t)(timeout_ms / 1000);
    tv.tv_usec = (suseconds_t)((timeout_ms % 1000) * 1000);
    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
}

static int recv_ws_frame(
    int fd,
    int *fin,
    unsigned char *opcode,
    unsigned char **payload_out,
    size_t *len_out
) {
    unsigned char hdr[2];
    unsigned char mask[4];
    unsigned long long wire_len;
    unsigned char *payload = NULL;
    size_t len, i;
    int masked;
    *payload_out = NULL;
    *len_out = 0;
    if (read_exact(fd, hdr, 2) != 0) {
        return -1;
    }
    if ((hdr[0] & 0x70) != 0) {
        return -1;
    }
    *fin = (hdr[0] & 0x80) != 0;
    *opcode = hdr[0] & 0x0f;
    masked = (hdr[1] & 0x80) != 0;
    wire_len = hdr[1] & 0x7f;
    if (wire_len == 126) {
        unsigned char ext[2];
        if (read_exact(fd, ext, 2) != 0) return -1;
        wire_len = ((unsigned long long)ext[0] << 8) | ext[1];
    } else if (wire_len == 127) {
        unsigned char ext[8];
        if (read_exact(fd, ext, 8) != 0) return -1;
        wire_len = 0;
        for (i = 0; i < 8; i++) {
            wire_len = (wire_len << 8) | ext[i];
        }
    }
    if (wire_len > MAX_RESPONSE_BYTES || wire_len > (unsigned long long)((size_t)-1)) {
        return -1;
    }
    len = (size_t)wire_len;
    if (masked && read_exact(fd, mask, sizeof(mask)) != 0) {
        return -1;
    }
    payload = (unsigned char *)malloc(len + 1);
    if (!payload) {
        return -1;
    }
    if (read_exact(fd, payload, len) != 0) {
        free(payload);
        return -1;
    }
    if (masked) {
        for (i = 0; i < len; i++) {
            payload[i] ^= mask[i & 3];
        }
    }
    payload[len] = 0;
    *payload_out = payload;
    *len_out = len;
    return 0;
}

static int response_id_matches(
    const unsigned char *payload,
    size_t len,
    const char *request_id
) {
    static const char key[] = "\"id\"";
    size_t id_len = strlen(request_id);
    size_t i;
    for (i = 0; i + sizeof(key) - 1 < len; i++) {
        size_t p;
        if (memcmp(payload + i, key, sizeof(key) - 1) != 0) {
            continue;
        }
        p = i + sizeof(key) - 1;
        while (p < len && (payload[p] == ' ' || payload[p] == '\t' ||
                payload[p] == '\r' || payload[p] == '\n')) {
            p++;
        }
        if (p >= len || payload[p++] != ':') continue;
        while (p < len && (payload[p] == ' ' || payload[p] == '\t' ||
                payload[p] == '\r' || payload[p] == '\n')) {
            p++;
        }
        if (p >= len || payload[p++] != '"') continue;
        if (p + id_len < len &&
            memcmp(payload + p, request_id, id_len) == 0 &&
            payload[p + id_len] == '"') {
            return 1;
        }
    }
    return 0;
}

static int recv_ws_response(int fd, const char *request_id) {
    unsigned char *message = NULL;
    size_t message_len = 0;
    long long deadline = now_millis() + RESPONSE_TIMEOUT_MS;
    int frame_count;
    for (frame_count = 0; frame_count < MAX_RESPONSE_FRAMES; frame_count++) {
        unsigned char *frame = NULL;
        size_t frame_len = 0;
        unsigned char opcode;
        long long remaining = deadline - now_millis();
        int fin;
        if (remaining <= 0 || set_recv_timeout_ms(fd, remaining) != 0) {
            break;
        }
        if (recv_ws_frame(fd, &fin, &opcode, &frame, &frame_len) != 0) {
            break;
        }
        HBUS_DEBUG("frame=%d opcode=%u fin=%d bytes=%lu\n",
            frame_count + 1, (unsigned int)opcode, fin,
            (unsigned long)frame_len);
        if (opcode == 0x8) {
            free(frame);
            break;
        }
        if (opcode == 0x9) {
            int pong_rc = send_ws_frame(fd, 0xA, frame, frame_len);
            free(frame);
            if (pong_rc != 0) break;
            continue;
        }
        if (opcode == 0xA) {
            free(frame);
            continue;
        }
        if (opcode == 0x1) {
            free(message);
            message = frame;
            message_len = frame_len;
            frame = NULL;
        } else if (opcode == 0x0 && message) {
            unsigned char *combined;
            if (frame_len > MAX_RESPONSE_BYTES - message_len) {
                free(frame);
                break;
            }
            combined = (unsigned char *)realloc(
                message, message_len + frame_len + 1);
            if (!combined) {
                free(frame);
                break;
            }
            message = combined;
            memcpy(message + message_len, frame, frame_len);
            message_len += frame_len;
            message[message_len] = 0;
            free(frame);
            frame = NULL;
        } else {
            free(frame);
            continue;
        }
        if (!fin) {
            continue;
        }
        if (response_id_matches(message, message_len, request_id)) {
            HBUS_DEBUG("matched response id after %d frames\n", frame_count + 1);
            if (fwrite(message, 1, message_len, stdout) != message_len ||
                fputc('\n', stdout) == EOF) {
                free(message);
                return -1;
            }
            free(message);
            return 0;
        }
        HBUS_DEBUG("ignored text message bytes=%lu without matching id\n",
            (unsigned long)message_len);
        free(message);
        message = NULL;
        message_len = 0;
    }
    free(message);
    fprintf(stderr, "timed out waiting for HBus response id %s\n", request_id);
    return -1;
}

static char *read_params_file(const char *path) {
    FILE *f;
    struct stat st;
    char *data;
    size_t got;
    if (!path || !path[0] || stat(path, &st) != 0 ||
        st.st_size < 0 || st.st_size > MAX_PARAMS_BYTES) {
        return NULL;
    }
    f = fopen(path, "rb");
    if (!f) return NULL;
    data = (char *)malloc((size_t)st.st_size + 1);
    if (!data) {
        fclose(f);
        return NULL;
    }
    got = fread(data, 1, (size_t)st.st_size, f);
    fclose(f);
    if (got != (size_t)st.st_size) {
        free(data);
        return NULL;
    }
    data[got] = 0;
    return data;
}

int main(int argc, char **argv) {
    const char *hub_id;
    const char *cmd;
    const char *params;
    char *params_owned = NULL;
    char *payload;
    char request_id[96];
    struct timeval request_time;
    size_t payload_len;
    int fd;
    int rc = 1;
    if (argc < 3) {
        fprintf(stderr, "usage: %s <hub_id> <cmd> [params-json|@params-file]\n", argv[0]);
        return 2;
    }
    hub_id = argv[1];
    cmd = argv[2];
    if (argc > 3 && argv[3][0] == '@' && argv[3][1]) {
        params_owned = read_params_file(argv[3] + 1);
        if (!params_owned) {
            fprintf(stderr, "unable to read params file\n");
            return 2;
        }
        params = params_owned;
    } else {
        params = argc > 3 ? argv[3] : "{}";
    }
    gettimeofday(&request_time, NULL);
    snprintf(request_id, sizeof(request_id), "codex-%ld-%ld-%ld",
        (long)request_time.tv_sec, (long)request_time.tv_usec, (long)getpid());
    payload_len = strlen(hub_id) + strlen(cmd) + strlen(params) +
        strlen(request_id) + 256;
    payload = (char *)malloc(payload_len);
    if (!payload) {
        free(params_owned);
        return 1;
    }
    snprintf(payload, payload_len,
        "{\"hubId\":\"%s\",\"timeout\":%d,\"hbus\":{\"id\":\"%s\",\"cmd\":\"%s\",\"params\":%s}}",
        hub_id, REQUEST_TIMEOUT_SECONDS, request_id, cmd, params);
    fd = connect_local();
    if (fd < 0) {
        perror("connect");
        goto out;
    }
    if (websocket_handshake(fd, hub_id) != 0) {
        goto close_out;
    }
    if (send_ws_text(fd, payload) != 0) {
        perror("send");
        goto close_out;
    }
    if (recv_ws_response(fd, request_id) == 0) {
        rc = 0;
    }
close_out:
    close(fd);
out:
    free(payload);
    free(params_owned);
    return rc;
}
