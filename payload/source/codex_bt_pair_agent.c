#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/*
 * The Harmony Hub image exposes the controller directly to Logitech's HAL and
 * does not run bluetoothd.  Logitech's mobile app normally relays SSP prompts
 * back to bthid.connect.  This small helper performs that relay locally while
 * pairing mode is active.
 *
 * Keep the Linux Bluetooth ABI declarations local so the helper can be built
 * with the repository's small static cross-toolchain without libbluetooth.
 */
#ifndef AF_BLUETOOTH
#define AF_BLUETOOTH 31
#endif

#define BTPROTO_HCI 1
#define SOL_HCI 0
#define HCI_DATA_DIR 1
#define HCI_FILTER 2
#define HCI_CMSG_DIR 0x0001
#define HCI_CHANNEL_RAW 0

#define HCI_EVENT_PKT 0x04
#define HCI_COMMAND_PKT 0x01
#define HCI_ACLDATA_PKT 0x02
#define EVT_CONN_COMPLETE 0x03
#define EVT_CONN_REQUEST 0x04
#define EVT_DISCONN_COMPLETE 0x05
#define EVT_AUTH_COMPLETE 0x06
#define EVT_LINK_KEY_NOTIFY 0x18
#define EVT_CMD_COMPLETE 0x0e
#define EVT_CMD_STATUS 0x0f
#define EVT_USER_CONFIRM_REQUEST 0x33
#define EVT_SIMPLE_PAIRING_COMPLETE 0x36

#define OGF_LINK_CTL 0x01
#define OCF_USER_CONFIRM_REPLY 0x002c

#define HCICONFIG_CLIENT "/usr/bin/hciconfig"
#define HCITOOL_CLIENT "/usr/bin/hcitool"
#define BT_STORAGE_ROOT "/var/lib/bluetooth"
#define HCI_ADDRESS_PATH "/sys/class/bluetooth/hci0/address"
#define PIN_FIFO_PATH "/etc/bluetooth/pin_exchange_fifo"
#define DEFAULT_TIMEOUT_SECONDS 120
#define MAX_TIMEOUT_SECONDS 600

#define L2CAP_SIGNALING_CID 0x0001
#define HID_CONTROL_PSM 0x0011
#define L2CAP_CONN_REQUEST 0x02
#define L2CAP_CONN_RESPONSE 0x03
#define HID_TRANS_GET_REPORT 0x04
#define HID_REPORT_INPUT 0x01

struct sockaddr_hci {
    sa_family_t hci_family;
    unsigned short hci_dev;
    unsigned short hci_channel;
};

struct hci_filter {
    uint32_t type_mask;
    uint32_t event_mask[2];
    uint16_t opcode;
};

static volatile sig_atomic_t stop_requested;

static void on_signal(int sig) {
    (void)sig;
    stop_requested = 1;
}

static void close_inherited_fds(void) {
    long limit = sysconf(_SC_OPEN_MAX);
    int fd;
    if (limit < 0 || limit > 4096) limit = 1024;
    for (fd = 3; fd < limit; fd++) close(fd);
}

static int safe_profile(const char *value) {
    return value && (
        strcmp(value, "btkeyboard") == 0 ||
        strcmp(value, "btkeyboard-nexus") == 0 ||
        strcmp(value, "fire") == 0 ||
        strcmp(value, "ps3") == 0 ||
        strcmp(value, "wii") == 0);
}

static int safe_bt_address(const char *value) {
    size_t i;
    if (!value || strlen(value) != 17) return 0;
    for (i = 0; i < 17; i++) {
        if (i == 2 || i == 5 || i == 8 || i == 11 || i == 14) {
            if (value[i] != ':') return 0;
        } else if (!((value[i] >= '0' && value[i] <= '9') ||
                     (value[i] >= 'A' && value[i] <= 'F') ||
                     (value[i] >= 'a' && value[i] <= 'f'))) {
            return 0;
        }
    }
    return 1;
}

static void filter_event(struct hci_filter *filter, unsigned int event) {
    if (event < 64) {
        filter->event_mask[event >> 5] |= (uint32_t)1U << (event & 31);
    }
}

static void format_addr(const unsigned char *raw, char *out, size_t outlen) {
    snprintf(out, outlen, "%02X:%02X:%02X:%02X:%02X:%02X",
        raw[5], raw[4], raw[3], raw[2], raw[1], raw[0]);
}

static void reap_children(void) {
    int status;
    while (waitpid(-1, &status, WNOHANG) > 0) {
    }
}

/*
 * Logitech's HAL waits for the mobile app to return the SSP number through
 * this FIFO.  libhal_kbd_sendpin_using_fifo writes one length byte followed by
 * the ASCII PIN, so reproduce that wire format locally.
 */
static int send_pin_fifo(const char *pin) {
    unsigned char length;
    size_t pin_length;
    int attempt;
    int saved_errno = ENXIO;

    if (!pin) {
        errno = EINVAL;
        return -1;
    }
    pin_length = strlen(pin);
    if (pin_length == 0 || pin_length > 255) {
        errno = EINVAL;
        return -1;
    }
    length = (unsigned char)pin_length;

    /*
     * The HAL pairing thread and the HCI event can become runnable in either
     * order.  Give its nonblocking FIFO reader a short window to appear.
     */
    for (attempt = 0; attempt < 25; attempt++) {
        int fd = open(PIN_FIFO_PATH, O_WRONLY | O_NONBLOCK);
        if (fd >= 0) {
            size_t sent = 0;
            ssize_t written;

            written = write(fd, &length, 1);
            if (written != 1) {
                saved_errno = written < 0 ? errno : EIO;
                close(fd);
                errno = saved_errno;
                return -1;
            }
            while (sent < pin_length) {
                written = write(fd, pin + sent, pin_length - sent);
                if (written < 0 && errno == EINTR) continue;
                if (written <= 0) {
                    saved_errno = written < 0 ? errno : EIO;
                    close(fd);
                    errno = saved_errno;
                    return -1;
                }
                sent += (size_t)written;
            }
            close(fd);
            return 0;
        }
        saved_errno = errno;
        if (saved_errno != ENXIO && saved_errno != ENOENT &&
            saved_errno != EAGAIN) {
            errno = saved_errno;
            return -1;
        }
        usleep(20000);
    }
    errno = saved_errno;
    return -1;
}

static int find_linkkeys_path(char *out, size_t outlen) {
    DIR *dir;
    struct dirent *entry;
    struct stat st;
    FILE *address_file;
    char local_address[32];

    address_file = fopen(HCI_ADDRESS_PATH, "r");
    if (address_file) {
        if (fgets(local_address, sizeof(local_address), address_file)) {
            local_address[strcspn(local_address, "\r\n")] = 0;
            if (safe_bt_address(local_address)) {
                snprintf(out, outlen, "%s/%s/linkkeys",
                    BT_STORAGE_ROOT, local_address);
                fclose(address_file);
                return 0;
            }
        }
        fclose(address_file);
    }

    dir = opendir(BT_STORAGE_ROOT);
    if (!dir) return -1;
    while ((entry = readdir(dir)) != NULL) {
        if (!safe_bt_address(entry->d_name)) continue;
        snprintf(out, outlen, "%s/%s", BT_STORAGE_ROOT, entry->d_name);
        if (stat(out, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        snprintf(out, outlen, "%s/%s/linkkeys", BT_STORAGE_ROOT, entry->d_name);
        closedir(dir);
        return 0;
    }
    closedir(dir);
    return -1;
}

static int persist_link_key(const char *peer, const unsigned char *key,
                            unsigned int type, char *saved_path,
                            size_t saved_path_len) {
    char path[256], temp[288], line[256], key_hex[33];
    FILE *input = NULL;
    FILE *output = NULL;
    int fd = -1;
    size_t i;

    if (!safe_bt_address(peer) ||
        find_linkkeys_path(path, sizeof(path)) != 0) {
        errno = ENOENT;
        return -1;
    }
    snprintf(temp, sizeof(temp), "%s.codex-%ld", path, (long)getpid());
    fd = open(temp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return -1;
    output = fdopen(fd, "w");
    if (!output) {
        close(fd);
        unlink(temp);
        return -1;
    }
    fd = -1;

    input = fopen(path, "r");
    if (input) {
        while (fgets(line, sizeof(line), input)) {
            if (strncasecmp(line, peer, 17) == 0 &&
                (line[17] == ' ' || line[17] == '\t')) {
                continue;
            }
            fputs(line, output);
        }
        fclose(input);
    }

    for (i = 0; i < 16; i++) {
        snprintf(key_hex + (i * 2), sizeof(key_hex) - (i * 2),
            "%02X", key[i]);
    }
    key_hex[32] = 0;
    fprintf(output, "%s %s %u 0\n", peer, key_hex, type);
    fflush(output);
    if (fsync(fileno(output)) != 0) {
        fclose(output);
        unlink(temp);
        return -1;
    }
    if (fclose(output) != 0) {
        unlink(temp);
        return -1;
    }
    output = NULL;
    if (chmod(temp, 0600) != 0 || rename(temp, path) != 0) {
        unlink(temp);
        return -1;
    }
    if (saved_path && saved_path_len) {
        snprintf(saved_path, saved_path_len, "%s", path);
    }
    return 0;
}

static int load_link_key(const char *peer) {
    pid_t pid;
    int status;

    pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        execl(HCICONFIG_CLIENT, "hciconfig", "hci0", "putkey",
            peer, (char *)NULL);
        _exit(127);
    }
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int load_all_link_keys(void) {
    char path[256], line[256], peer[24];
    FILE *input;
    int loaded = 0;

    if (find_linkkeys_path(path, sizeof(path)) != 0) return 0;
    input = fopen(path, "r");
    if (!input) return 0;
    while (fgets(line, sizeof(line), input)) {
        peer[0] = 0;
        if (sscanf(line, "%23s", peer) != 1 || !safe_bt_address(peer)) {
            continue;
        }
        if (load_link_key(peer) == 0) {
            loaded++;
            printf("pair-agent link-key-loaded peer=%s\n", peer);
        } else {
            fprintf(stderr, "pair-agent link-key-load peer=%s failed: %s\n",
                peer, strerror(errno));
        }
    }
    fclose(input);
    return loaded;
}

static int run_hcitool(const char *action, const char *peer) {
    pid_t pid;
    int status;

    pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        execl(HCITOOL_CLIENT, "hcitool", action, peer, (char *)NULL);
        _exit(127);
    }
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int direct_acl_connect(const char *peer) {
    if (load_link_key(peer) != 0) return -1;
    if (run_hcitool("cc", peer) != 0) return -1;
    if (run_hcitool("auth", peer) != 0) return -1;
    return 0;
}

static int confirm_pairing(int fd, const unsigned char *peer) {
    unsigned char command[10];
    uint16_t opcode = (uint16_t)((OGF_LINK_CTL << 10) | OCF_USER_CONFIRM_REPLY);
    ssize_t written;

    command[0] = 0x01; /* HCI command packet */
    command[1] = (unsigned char)(opcode & 0xff);
    command[2] = (unsigned char)(opcode >> 8);
    command[3] = 6;
    memcpy(command + 4, peer, 6);
    written = write(fd, command, sizeof(command));
    return written == (ssize_t)sizeof(command) ? 0 : -1;
}

static int send_hid_control_payload(int fd, unsigned int handle,
                                    unsigned int remote_cid,
                                    const unsigned char *hid_payload,
                                    size_t hid_payload_len) {
    unsigned char packet[64];
    unsigned int acl_payload_len = 4 + (unsigned int)hid_payload_len;
    ssize_t written;

    if (handle > 0x0fff || remote_cid < 0x0040 ||
        remote_cid > 0xffff || !hid_payload || hid_payload_len == 0 ||
        acl_payload_len + 5 > sizeof(packet)) {
        errno = EINVAL;
        return -1;
    }

    memset(packet, 0, acl_payload_len + 5);
    packet[0] = HCI_ACLDATA_PKT;
    packet[1] = (unsigned char)(handle & 0xff);
    packet[2] = (unsigned char)((handle >> 8) & 0x0f);
    packet[3] = (unsigned char)(acl_payload_len & 0xff);
    packet[4] = (unsigned char)(acl_payload_len >> 8);
    packet[5] = (unsigned char)(hid_payload_len & 0xff);
    packet[6] = (unsigned char)(hid_payload_len >> 8);
    packet[7] = (unsigned char)(remote_cid & 0xff);
    packet[8] = (unsigned char)(remote_cid >> 8);
    memcpy(packet + 9, hid_payload, hid_payload_len);

    written = write(fd, packet, acl_payload_len + 5);
    return written == (ssize_t)(acl_payload_len + 5) ? 0 : -1;
}

static size_t hid_input_report_size(unsigned int report_id) {
    switch (report_id) {
    case 0x01: return 9; /* keyboard */
    case 0x02: return 8; /* mouse */
    case 0x03: return 5; /* consumer control */
    case 0x04: return 2; /* system control */
    case 0xac: return 2; /* wireless radio controls */
    case 0xad: return 2; /* vendor controls */
    case 0xff: return 2; /* generic device controls */
    case 0x10: return 7; /* vendor data */
    default: return 0;
    }
}

static int send_hid_input_report_reply(int fd, unsigned int handle,
                                       unsigned int remote_cid,
                                       unsigned int report_id) {
    unsigned char payload[16];
    size_t report_size = hid_input_report_size(report_id);

    if (report_size == 0 || report_size + 1 > sizeof(payload)) {
        errno = EINVAL;
        return -1;
    }
    memset(payload, 0, sizeof(payload));
    payload[0] = 0xa1; /* DATA transaction, input report */
    payload[1] = (unsigned char)report_id;
    return send_hid_control_payload(fd, handle, remote_cid, payload,
        report_size + 1);
}

static ssize_t receive_hci_packet(int fd, unsigned char *buf, size_t buflen,
                                  int *incoming) {
    struct msghdr message;
    struct iovec iov;
    unsigned char control[64];
    struct cmsghdr *cmsg;
    ssize_t length;

    memset(&message, 0, sizeof(message));
    memset(control, 0, sizeof(control));
    iov.iov_base = buf;
    iov.iov_len = buflen;
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    if (incoming) *incoming = -1;

    length = recvmsg(fd, &message, 0);
    if (length < 0) return length;
    for (cmsg = CMSG_FIRSTHDR(&message); cmsg;
         cmsg = CMSG_NXTHDR(&message, cmsg)) {
        if (cmsg->cmsg_level == SOL_HCI &&
            cmsg->cmsg_type == HCI_CMSG_DIR &&
            cmsg->cmsg_len >= CMSG_LEN(sizeof(int))) {
            if (incoming) memcpy(incoming, CMSG_DATA(cmsg), sizeof(int));
            break;
        }
    }
    return length;
}

static void track_hid_control_channel(const unsigned char *packet,
                                      size_t length, int incoming,
                                      unsigned int *local_cid,
                                      unsigned int *remote_cid) {
    const unsigned char *data;
    size_t remaining;
    unsigned int cid;

    if (!packet || length < 9 || packet[0] != HCI_ACLDATA_PKT) return;
    cid = (unsigned int)packet[7] | ((unsigned int)packet[8] << 8);
    if (cid != L2CAP_SIGNALING_CID) return;
    data = packet + 9;
    remaining = length - 9;
    while (remaining >= 4) {
        unsigned int code = data[0];
        unsigned int command_len =
            (unsigned int)data[2] | ((unsigned int)data[3] << 8);
        const unsigned char *body = data + 4;
        if (command_len + 4 > remaining) break;
        if (code == L2CAP_CONN_REQUEST && command_len >= 4) {
            unsigned int psm =
                (unsigned int)body[0] | ((unsigned int)body[1] << 8);
            unsigned int source_cid =
                (unsigned int)body[2] | ((unsigned int)body[3] << 8);
            if (psm == HID_CONTROL_PSM) {
                if (incoming == 1) *remote_cid = source_cid;
                else if (incoming == 0) *local_cid = source_cid;
            }
        } else if (code == L2CAP_CONN_RESPONSE && command_len >= 8) {
            unsigned int destination_cid =
                (unsigned int)body[0] | ((unsigned int)body[1] << 8);
            unsigned int source_cid =
                (unsigned int)body[2] | ((unsigned int)body[3] << 8);
            unsigned int result =
                (unsigned int)body[4] | ((unsigned int)body[5] << 8);
            if (result == 0) {
                if (incoming == 1 && source_cid == *local_cid) {
                    *remote_cid = destination_cid;
                } else if (incoming == 0 && source_cid == *remote_cid) {
                    *local_cid = destination_cid;
                }
            }
        }
        data += command_len + 4;
        remaining -= command_len + 4;
    }
}

static int parse_event(const unsigned char *buf, ssize_t length,
                       unsigned int *event, const unsigned char **payload,
                       size_t *payload_len) {
    size_t pos = 0;
    unsigned int declared;

    if (!buf || length < 2) return 0;
    if (buf[0] == HCI_EVENT_PKT) pos = 1;
    if ((size_t)length < pos + 2) return 0;

    *event = buf[pos];
    declared = buf[pos + 1];
    pos += 2;
    if ((size_t)length < pos + declared) return 0;

    *payload = buf + pos;
    *payload_len = declared;
    return 1;
}

int main(int argc, char **argv) {
    const char *profile = argc > 1 ? argv[1] : "btkeyboard";
    int timeout_seconds = argc > 2 ? atoi(argv[2]) : DEFAULT_TIMEOUT_SECONDS;
    int trace_acl = argc > 3 && strcmp(argv[3], "--observe-acl") == 0;
    int inject_report_reply =
        argc > 3 && strcmp(argv[3], "--inject-get-report-reply") == 0;
    int hid_control_shim =
        argc > 3 && strcmp(argv[3], "--hid-control-shim") == 0;
    int hid_control_daemon =
        argc > 3 && strcmp(argv[3], "--hid-control-daemon") == 0;
    int observe_only = trace_acl ||
        inject_report_reply ||
        hid_control_shim ||
        hid_control_daemon ||
        (argc > 3 && strcmp(argv[3], "--observe") == 0);
    int direct_only = argc > 3 && strcmp(argv[3], "--direct-only") == 0;
    int enable_hid_control = hid_control_shim || hid_control_daemon;
    int use_pin_fifo = !observe_only && !direct_only;
    int allow_direct_reconnect = direct_only;
    int fd;
    struct sockaddr_hci address;
    struct hci_filter filter;
    struct pollfd poll_fd;
    time_t deadline;
    time_t paired_at = 0;
    time_t connected_at = 0;
    time_t next_reconnect_at = 0;
    int current_connected = 0;
    int reconnect_attempts = 0;
    int data_direction = 1;
    unsigned int local_control_cid = 0;
    unsigned int remote_control_cid = 0;
    char last_address[24] = "";

    /*
     * The WebGUI can start this helper while serving an HTTP request.  Do not
     * retain the accepted client socket (or any other parent descriptor) for
     * the lifetime of a pairing session or the persistent control daemon.
     */
    close_inherited_fds();
    if (!safe_profile(profile)) {
        fprintf(stderr, "unsupported Bluetooth profile: %s\n", profile);
        return 2;
    }
    if (timeout_seconds < 10) timeout_seconds = 10;
    if (timeout_seconds > MAX_TIMEOUT_SECONDS) timeout_seconds = MAX_TIMEOUT_SECONDS;

    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGCHLD, SIG_DFL);
    signal(SIGPIPE, SIG_IGN);

    fd = socket(AF_BLUETOOTH, SOCK_RAW, BTPROTO_HCI);
    if (fd < 0) {
        fprintf(stderr, "pair-agent HCI socket failed: %s\n", strerror(errno));
        return 1;
    }

    memset(&filter, 0, sizeof(filter));
    filter.type_mask =
        ((uint32_t)1U << HCI_EVENT_PKT) |
        ((uint32_t)1U << HCI_COMMAND_PKT);
    if (trace_acl || enable_hid_control) {
        filter.type_mask |= (uint32_t)1U << HCI_ACLDATA_PKT;
    }
    filter_event(&filter, EVT_CONN_COMPLETE);
    filter_event(&filter, EVT_CONN_REQUEST);
    filter_event(&filter, EVT_DISCONN_COMPLETE);
    filter_event(&filter, EVT_AUTH_COMPLETE);
    filter_event(&filter, EVT_LINK_KEY_NOTIFY);
    filter_event(&filter, EVT_CMD_COMPLETE);
    filter_event(&filter, EVT_CMD_STATUS);
    filter_event(&filter, EVT_USER_CONFIRM_REQUEST);
    filter_event(&filter, EVT_SIMPLE_PAIRING_COMPLETE);
    if (setsockopt(fd, SOL_HCI, HCI_FILTER, &filter, sizeof(filter)) != 0) {
        fprintf(stderr, "pair-agent HCI filter failed: %s\n", strerror(errno));
        close(fd);
        return 1;
    }
    if (setsockopt(fd, SOL_HCI, HCI_DATA_DIR, &data_direction,
            sizeof(data_direction)) != 0) {
        fprintf(stderr, "pair-agent HCI direction metadata unavailable: %s\n",
            strerror(errno));
    }

    memset(&address, 0, sizeof(address));
    address.hci_family = AF_BLUETOOTH;
    address.hci_dev = 0;
    address.hci_channel = HCI_CHANNEL_RAW;
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        fprintf(stderr, "pair-agent HCI bind failed: %s\n", strerror(errno));
        close(fd);
        return 1;
    }

    if (inject_report_reply) {
        unsigned int handle;
        unsigned int remote_cid;
        unsigned int report_id;

        if (argc < 7) {
            fprintf(stderr,
                "usage: %s PROFILE TIMEOUT --inject-get-report-reply HANDLE REMOTE_CID REPORT_ID\n",
                argv[0]);
            close(fd);
            return 2;
        }
        handle = (unsigned int)strtoul(argv[4], NULL, 0);
        remote_cid = (unsigned int)strtoul(argv[5], NULL, 0);
        report_id = (unsigned int)strtoul(argv[6], NULL, 0);
        if (send_hid_input_report_reply(fd, handle, remote_cid,
                report_id) != 0) {
            fprintf(stderr, "pair-agent GET_REPORT reply failed: %s\n",
                strerror(errno));
            close(fd);
            return 1;
        }
        printf("pair-agent GET_REPORT reply handle=0x%04x cid=0x%04x report=%u\n",
            handle, remote_cid, report_id);
        close(fd);
        return 0;
    }
    if (hid_control_daemon) {
        int loaded = load_all_link_keys();
        printf("pair-agent link-key-load-complete count=%d\n", loaded);
    }

    memset(&poll_fd, 0, sizeof(poll_fd));
    poll_fd.fd = fd;
    poll_fd.events = POLLIN;
    deadline = hid_control_daemon ? 0 : time(NULL) + timeout_seconds;
    printf("pair-agent start profile=%s timeout=%d mode=%s\n",
        profile, timeout_seconds,
        hid_control_daemon ? "hid-control-daemon" :
        (hid_control_shim ? "hid-control-shim" :
        (observe_only ? "observe" :
        (direct_only ? "direct-only" : "local"))));

    while (!stop_requested && (!deadline || time(NULL) < deadline)) {
        unsigned char buf[512];
        const unsigned char *payload;
        size_t payload_len;
        unsigned int event;
        ssize_t length;
        time_t now = time(NULL);
        int poll_rc;
        int incoming = -1;

        reap_children();
        if (!observe_only && paired_at && current_connected &&
            connected_at && now - connected_at >= 10) {
            printf("pair-agent complete\n");
            close(fd);
            return 0;
        }
        if (allow_direct_reconnect && paired_at && !current_connected &&
            last_address[0] &&
            now >= next_reconnect_at && reconnect_attempts < 12) {
            reconnect_attempts++;
            printf("pair-agent post-pair reconnect peer=%s trigger=timer attempt=%d\n",
                last_address, reconnect_attempts);
            if (direct_acl_connect(last_address) != 0) {
                fprintf(stderr,
                    "pair-agent post-pair reconnect failed: %s\n",
                    strerror(errno));
            } else {
                printf("pair-agent post-pair reconnect peer=%s result=authenticated\n",
                    last_address);
            }
            next_reconnect_at = now + 4;
        }
        poll_rc = poll(&poll_fd, 1, 1000);
        if (poll_rc < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "pair-agent HCI poll failed: %s\n", strerror(errno));
            close(fd);
            return 1;
        }
        if (poll_rc == 0) continue;
        if (!(poll_fd.revents & POLLIN)) {
            fprintf(stderr, "pair-agent HCI poll revents=0x%x\n", poll_fd.revents);
            close(fd);
            return 1;
        }

        length = receive_hci_packet(fd, buf, sizeof(buf), &incoming);
        if (length < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
            fprintf(stderr, "pair-agent HCI read failed: %s\n", strerror(errno));
            close(fd);
            return 1;
        }
        if (length >= 4 && buf[0] == HCI_COMMAND_PKT) {
            unsigned int opcode = (unsigned int)buf[1] |
                ((unsigned int)buf[2] << 8);
            if (!hid_control_daemon) {
                printf("pair-agent hci-command opcode=0x%04x plen=%u\n",
                    opcode, (unsigned int)buf[3]);
            }
            continue;
        }
        if (length >= 5 && buf[0] == HCI_ACLDATA_PKT) {
            unsigned int cid = 0;
            unsigned int l2cap_len = 0;
            track_hid_control_channel(buf, (size_t)length, incoming,
                &local_control_cid, &remote_control_cid);
            if (length >= 9) {
                cid = (unsigned int)buf[7] | ((unsigned int)buf[8] << 8);
                l2cap_len =
                    (unsigned int)buf[5] | ((unsigned int)buf[6] << 8);
            }
            if (enable_hid_control && incoming == 1 &&
                cid == local_control_cid && l2cap_len >= 2 &&
                (size_t)length >= 9 + l2cap_len &&
                (buf[9] >> 4) == HID_TRANS_GET_REPORT &&
                (buf[9] & 0x0f) == HID_REPORT_INPUT) {
                unsigned int handle =
                    ((unsigned int)buf[1] |
                    ((unsigned int)buf[2] << 8)) & 0x0fff;
                unsigned int report_id = buf[10];
                if (remote_control_cid &&
                    send_hid_input_report_reply(fd, handle,
                        remote_control_cid, report_id) == 0) {
                    printf("pair-agent HID GET_REPORT reply handle=0x%04x local=0x%04x remote=0x%04x report=0x%02x\n",
                        handle, local_control_cid, remote_control_cid,
                        report_id);
                } else {
                    fprintf(stderr,
                        "pair-agent HID GET_REPORT reply failed local=0x%04x remote=0x%04x report=0x%02x: %s\n",
                        local_control_cid, remote_control_cid, report_id,
                        remote_control_cid ? strerror(errno) :
                        "remote control CID unavailable");
                }
            }
            if (trace_acl) {
                size_t i;
                printf("pair-agent hci-acl dir=%s",
                    incoming == 1 ? "in" :
                    (incoming == 0 ? "out" : "unknown"));
                for (i = 0; i < (size_t)length && i < 128; i++) {
                    printf("%s%02X", i ? ":" : " ", buf[i]);
                }
                printf("\n");
            }
            continue;
        }
        if (!parse_event(buf, length, &event, &payload, &payload_len)) continue;

        if (event == EVT_CONN_REQUEST && payload_len >= 10) {
            char peer[24];
            unsigned int link_type = payload[9];
            format_addr(payload, peer, sizeof(peer));
            printf("pair-agent connection-request peer=%s linkType=%u\n", peer, link_type);
            if (link_type == 1) {
                snprintf(last_address, sizeof(last_address), "%s", peer);
            }
        } else if (event == EVT_USER_CONFIRM_REQUEST && payload_len >= 10) {
            char peer[24];
            char pin[16];
            uint32_t value;
            format_addr(payload, peer, sizeof(peer));
            snprintf(last_address, sizeof(last_address), "%s", peer);
            value = (uint32_t)payload[6] |
                ((uint32_t)payload[7] << 8) |
                ((uint32_t)payload[8] << 16) |
                ((uint32_t)payload[9] << 24);
            snprintf(pin, sizeof(pin), "%06lu", (unsigned long)value);
            printf("pair-agent confirmation-request peer=%s\n", peer);
            if (!observe_only) {
                if (use_pin_fifo && send_pin_fifo(pin) == 0) {
                    printf("pair-agent pin-fifo peer=%s result=submitted\n", peer);
                } else {
                    if (use_pin_fifo) {
                        fprintf(stderr,
                            "pair-agent pin-fifo peer=%s failed: %s; confirming through controller\n",
                            peer, strerror(errno));
                    }
                    if (confirm_pairing(fd, payload) == 0) {
                        printf("pair-agent controller-confirmation peer=%s result=submitted\n", peer);
                    } else {
                        fprintf(stderr,
                            "pair-agent controller-confirmation peer=%s failed: %s\n",
                            peer, strerror(errno));
                    }
                }
            }
        } else if (event == EVT_LINK_KEY_NOTIFY && payload_len >= 23) {
            char peer[24];
            char saved_path[256];
            format_addr(payload, peer, sizeof(peer));
            snprintf(last_address, sizeof(last_address), "%s", peer);
            printf("pair-agent link-key peer=%s type=%u\n",
                peer, payload[22]);
            if (!observe_only) {
                if (persist_link_key(peer, payload + 6, payload[22],
                        saved_path, sizeof(saved_path)) == 0) {
                    printf("pair-agent link-key-saved peer=%s path=%s\n",
                        peer, saved_path);
                } else {
                    fprintf(stderr,
                        "pair-agent link-key save peer=%s failed: %s\n",
                        peer, strerror(errno));
                }
            }
            paired_at = now;
            next_reconnect_at = now + 1;
        } else if (event == EVT_SIMPLE_PAIRING_COMPLETE && payload_len >= 7) {
            char peer[24];
            format_addr(payload + 1, peer, sizeof(peer));
            printf("pair-agent pairing-complete peer=%s status=%u\n", peer, payload[0]);
            if (payload[0] == 0) {
                paired_at = now;
                next_reconnect_at = now + 1;
            }
        } else if (event == EVT_AUTH_COMPLETE && payload_len >= 3) {
            printf("pair-agent authentication-complete status=%u\n", payload[0]);
        } else if (event == EVT_CMD_COMPLETE && payload_len >= 3) {
            unsigned int opcode = (unsigned int)payload[1] |
                ((unsigned int)payload[2] << 8);
            if (!hid_control_daemon) {
                printf("pair-agent command-complete opcode=0x%04x status=%u\n",
                    opcode, payload_len >= 4 ? payload[3] : 255);
            }
        } else if (event == EVT_CMD_STATUS && payload_len >= 4) {
            unsigned int opcode = (unsigned int)payload[2] |
                ((unsigned int)payload[3] << 8);
            if (!hid_control_daemon) {
                printf("pair-agent command-status opcode=0x%04x status=%u\n",
                    opcode, payload[0]);
            }
        } else if (event == EVT_CONN_COMPLETE && payload_len >= 11) {
            char peer[24];
            format_addr(payload + 3, peer, sizeof(peer));
            printf("pair-agent connection-complete peer=%s status=%u\n", peer, payload[0]);
            if (payload[0] == 0) {
                current_connected = 1;
                connected_at = now;
            } else {
                current_connected = 0;
                connected_at = 0;
                if (paired_at) next_reconnect_at = now + 1;
            }
        } else if (event == EVT_DISCONN_COMPLETE && payload_len >= 4) {
            printf("pair-agent disconnection status=%u reason=%u\n",
                payload[0], payload[3]);
            current_connected = 0;
            connected_at = 0;
            if (paired_at) next_reconnect_at = now + 1;
        }
    }

    close(fd);
    printf("pair-agent stop reason=%s\n", stop_requested ? "signal" : "timeout");
    return stop_requested ? 0 : 3;
}
