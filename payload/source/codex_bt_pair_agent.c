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
#include <sys/time.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
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

/*
 * BlueZ installs these helpers under /usr/sbin on the hub firmware, while
 * some images expose them under /usr/bin.  Resolve the first executable at
 * runtime instead of baking in one directory.
 */
static const char *const hciconfig_clients[] = {
    "/usr/sbin/hciconfig",
    "/usr/bin/hciconfig",
    NULL
};
static const char *const hcitool_clients[] = {
    "/usr/sbin/hcitool",
    "/usr/bin/hcitool",
    NULL
};
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

/*
 * BlueZ 4's bluetoothd serves the local SDP database on this unix socket.
 * Logitech's HAL registers the HID record through it with libbluetooth.
 * The PDU ids below are BlueZ 4 lib/sdp.h; 0x75..0x80 are the local-only
 * register/update/remove requests.
 */
#ifndef SDP_LOCAL_SOCKET_PATH
#define SDP_LOCAL_SOCKET_PATH "/var/run/sdp"
#endif
#define BT_PROFILE_FILE "/data/codex/bthid_profile"
#define SDP_ERROR_RSP 0x01
#define SDP_SVC_SEARCH_ATTR_REQ 0x06
#define SDP_SVC_SEARCH_ATTR_RSP 0x07
#define SDP_SVC_UPDATE_REQ 0x77
#define SDP_SVC_UPDATE_RSP 0x78
#define SDP_SVC_REMOVE_REQ 0x79
#define SDP_SVC_REMOVE_RSP 0x80
#define SDP_ATTR_RECORD_HANDLE 0x0000
#define SDP_ATTR_HID_DESCRIPTOR_LIST 0x0206
#define SDP_UUID_HID 0x1124
#define SDP_UUID_ATT 0x0007
#define SDP_UUID_L2CAP 0x0100
#define SDP_ATTR_SERVICE_CLASS_ID_LIST 0x0001
#define SDP_ATTR_PROTOCOL_DESCRIPTOR_LIST 0x0004
#define SDP_MAX_RESPONSE 8192
#define SDP_IO_TIMEOUT_MS 700
#define SDP_CHECK_INTERVAL_SECONDS 30
#define SDP_BACKOFF_SECONDS 300
#define HID_USAGE_PAGE_GENERIC_DEVICE 0x06
#define HID_USAGE_BATTERY_STRENGTH 0x20
#define HID_MAX_BLOCKS 32

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

static const char *resolve_client(const char *const *candidates) {
    size_t i;
    for (i = 0; candidates[i] != NULL; i++) {
        if (access(candidates[i], X_OK) == 0) return candidates[i];
    }
    return NULL;
}

/*
 * Run a hub Bluetooth helper without a shell.  On failure, write a
 * human-readable reason that distinguishes "could not execute" from "ran and
 * returned non-zero", so the log does not collapse both into EIO.
 */
static int run_client(const char *const *candidates, const char *name,
                      const char *arg1, const char *arg2, const char *arg3,
                      char *reason, size_t reason_len) {
    const char *path;
    pid_t pid;
    int status;

    path = resolve_client(candidates);
    if (!path) {
        snprintf(reason, reason_len,
            "exec %s: not found (tried /usr/sbin and /usr/bin)", name);
        errno = ENOENT;
        return -1;
    }
    pid = fork();
    if (pid < 0) {
        snprintf(reason, reason_len, "fork %s: %s", name, strerror(errno));
        return -1;
    }
    if (pid == 0) {
        execl(path, name, arg1, arg2, arg3, (char *)NULL);
        _exit(127);
    }
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            snprintf(reason, reason_len, "wait %s: %s", name, strerror(errno));
            return -1;
        }
    }
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        if (code == 0) return 0;
        if (code == 127) {
            snprintf(reason, reason_len,
                "exec %s: failed (child exit 127, path=%s)", name, path);
            errno = ENOENT;
            return -1;
        }
        snprintf(reason, reason_len, "%s exit status=%d", name, code);
        errno = EIO;
        return -1;
    }
    if (WIFSIGNALED(status)) {
        snprintf(reason, reason_len, "%s killed by signal %d",
            name, WTERMSIG(status));
        errno = EIO;
        return -1;
    }
    snprintf(reason, reason_len, "%s ended abnormally", name);
    errno = EIO;
    return -1;
}

static int load_link_key(const char *peer) {
    char reason[192];

    if (run_client(hciconfig_clients, "hciconfig", "hci0", "putkey", peer,
            reason, sizeof(reason)) == 0) {
        return 0;
    }
    fprintf(stderr, "pair-agent link-key-load peer=%s failed: %s\n",
        peer, reason);
    return -1;
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
        }
    }
    fclose(input);
    return loaded;
}

static int run_hcitool(const char *action, const char *peer) {
    char reason[192];

    if (run_client(hcitool_clients, "hcitool", action, peer, NULL,
            reason, sizeof(reason)) == 0) {
        return 0;
    }
    fprintf(stderr, "pair-agent hcitool %s peer=%s failed: %s\n",
        action, peer, reason);
    return -1;
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

/*
 * HID descriptor edits in the published SDP record.
 *
 * The btkeyboard descriptor that Logitech's HAL publishes in the SDP
 * HIDDescriptorList (attribute 0x0206) has a top-level collection whose
 * only input is Generic Device Controls / Battery Strength (report 0xAC).
 * Linux hid-input on the host turns that into a power supply, and Android
 * polls it with GET_REPORT.  HAL answers on the control channel with a
 * truncated one-byte DATA reply before the daemon's complete reply below.
 * Some hosts (an Amlogic Android 14 box) then time the request out and
 * retry forever without registering the keyboard.
 *
 * Removing that collection from the published record means the host never
 * creates the battery and never asks.  Hosts cache the descriptor when they
 * bond, so a host that bonded earlier must forget the keyboard and pair
 * again.  The GET_REPORT reply stays as a fallback.
 *
 * HID_STRIP_KEYBOARD_ONLY is a manual diagnostic: it keeps only the
 * keyboard, consumer control and system control collections, to find out
 * whether a host problem follows one of the others (mouse, vendor).
 */
#define HID_STRIP_BATTERY 1
#define HID_STRIP_KEYBOARD_ONLY 2

#define HID_APP(page, usage) (((uint32_t)(page) << 16) | (uint32_t)(usage))

struct hid_block {
    size_t start;
    size_t end;
    int closed;
    int seen_collection;
    int application;
    uint32_t app_usage;         /* usage of the top-level collection */
    int battery;
    int keyboard_usages;        /* page 0x07 usages inside the collection */
    int consumer_usages;        /* page 0x0C usages inside the collection */
    int report_id;              /* -1 until the block sets one */
    int mixed_report_ids;
    int output_or_feature;
    unsigned int inputs;
    unsigned int report_id_items;
    unsigned int globals_set;       /* one bit per global item tag */
    unsigned int globals_pre_local; /* set before the first local/main item */
    unsigned int globals_pre_io;    /* set before the first Input/Output/Feature */
    int seen_local_or_main;
    int seen_io;
};

struct hid_scan {
    struct hid_block blocks[HID_MAX_BLOCKS];
    unsigned int report_id_items[256];
    size_t count;
};

static int hid_short_item(const unsigned char *d, size_t len, size_t pos,
                          unsigned int *type, unsigned int *tag,
                          uint32_t *value, size_t *item_len) {
    unsigned int prefix;
    size_t size, i;
    uint32_t v = 0;

    if (pos >= len) return -1;
    prefix = d[pos];
    if (prefix == 0xfe) return -1; /* long items: not expected here */
    size = prefix & 3;
    if (size == 3) size = 4;
    if (size > len - pos - 1) return -1;
    for (i = 0; i < size; i++) v |= (uint32_t)d[pos + 1 + i] << (8 * i);
    *type = (prefix >> 2) & 3;
    *tag = prefix >> 4;
    *value = v;
    *item_len = 1 + size;
    return 0;
}

/*
 * Splits a report descriptor into top-level collections ("blocks"), each
 * with the global and local items in front of it.  Returns 0, or -1 if the
 * descriptor uses something this parser does not model (long items,
 * Push/Pop, unbalanced collections).
 */
static int hid_scan_blocks(const unsigned char *d, size_t len,
                           struct hid_scan *scan) {
    struct hid_block *b = NULL;
    uint32_t usage_page = 0, last_usage = 0;
    size_t pos = 0;
    int depth = 0;

    memset(scan, 0, sizeof(*scan));
    while (pos < len) {
        unsigned int type, tag;
        uint32_t value;
        size_t item_len;

        if (hid_short_item(d, len, pos, &type, &tag, &value, &item_len) != 0) {
            return -1;
        }
        if (!b) {
            if (scan->count >= HID_MAX_BLOCKS) return -1;
            b = &scan->blocks[scan->count++];
            b->start = pos;
            b->report_id = -1;
        }
        if (type == 1) { /* global */
            if (tag >= 0x0a) return -1; /* Push, Pop, reserved */
            b->globals_set |= 1U << tag;
            if (!b->seen_local_or_main) b->globals_pre_local |= 1U << tag;
            if (!b->seen_io) b->globals_pre_io |= 1U << tag;
            if (tag == 0x00) usage_page = value;
            if (tag == 0x08) {
                if (value == 0 || value > 0xff) return -1;
                scan->report_id_items[value]++;
                b->report_id_items++;
                if (b->report_id < 0) b->report_id = (int)value;
                else if (b->report_id != (int)value) b->mixed_report_ids = 1;
            }
        } else if (type == 2) { /* local */
            uint32_t page = item_len == 5 ? value >> 16 : usage_page;
            uint32_t usage = item_len == 5 ? value & 0xffff : value;
            b->seen_local_or_main = 1;
            if (tag <= 0x02) { /* Usage, Usage Minimum, Usage Maximum */
                if (tag == 0x00) last_usage = HID_APP(page, usage);
                if (b->seen_collection) {
                    if (page == 0x07) b->keyboard_usages = 1;
                    if (page == 0x0c) b->consumer_usages = 1;
                }
            }
            if (tag == 0x00 && page == HID_USAGE_PAGE_GENERIC_DEVICE &&
                usage == HID_USAGE_BATTERY_STRENGTH) {
                b->battery = 1;
            }
        } else if (type == 0) { /* main */
            b->seen_local_or_main = 1;
            if (tag == 0x0a) { /* Collection */
                if (depth == 0 && !b->seen_collection) {
                    b->seen_collection = 1;
                    b->application = value == 0x01;
                    b->app_usage = last_usage;
                }
                depth++;
            } else if (tag == 0x0c) { /* End Collection */
                if (depth == 0) return -1;
                depth--;
                if (depth == 0) {
                    b->end = pos + item_len;
                    b->closed = 1;
                    b = NULL;
                }
            } else if (tag == 0x08) { /* Input */
                b->seen_io = 1;
                b->inputs++;
            } else if (tag == 0x09 || tag == 0x0b) { /* Output, Feature */
                b->seen_io = 1;
                b->output_or_feature = 1;
            } else {
                return -1;
            }
        } else {
            return -1;
        }
        /* Local items apply to the next main item only. */
        if (type == 0) last_usage = 0;
        pos += item_len;
    }
    if (depth != 0) return -1;
    if (b) b->end = len;
    return 0;
}

static int hid_block_is_keyboard_side(const struct hid_block *b) {
    return b->application &&
        (((b->app_usage == HID_APP(0x01, 0x06) ||
           b->app_usage == HID_APP(0x01, 0x07)) && b->keyboard_usages) ||
         (b->app_usage == HID_APP(0x0c, 0x01) && b->consumer_usages) ||
         b->app_usage == HID_APP(0x01, 0x80));
}

static int hid_block_policy_removes(const struct hid_block *b, int policy) {
    if (policy == HID_STRIP_KEYBOARD_ONLY) return !hid_block_is_keyboard_side(b);
    /* A collection that exists only to report battery strength. */
    return b->application && b->battery && !b->output_or_feature &&
        b->inputs > 0;
}

/*
 * Can block i be cut without changing how the rest parses?  It needs one
 * report ID of its own, and global items persist into the next collection,
 * so the next one must set again every global the block changed: the
 * usage page before its first usage, the rest before its first field.
 */
static int hid_block_cut_safe(const struct hid_scan *scan, size_t i) {
    const struct hid_block *c = &scan->blocks[i];

    if (!c->closed || c->report_id < 0 || c->mixed_report_ids ||
        scan->report_id_items[c->report_id] != c->report_id_items) {
        return 0;
    }
    if (i + 1 < scan->count) {
        const struct hid_block *n = &scan->blocks[i + 1];
        if ((c->globals_set & 1U) && !(n->globals_pre_local & 1U)) return 0;
        if ((c->globals_set & ~1U) & ~n->globals_pre_io) return 0;
    }
    return 1;
}

/*
 * Finds the first collection the policy removes and that can be cut
 * safely.  Returns 1 and the byte range [start, end), 0 if there is none,
 * -1 if the descriptor cannot be parsed.  At least one keyboard-side
 * collection always stays.
 */
static int hid_find_strip_block(const unsigned char *d, size_t len,
                                int policy, size_t *out_start,
                                size_t *out_end, unsigned int *out_report_id) {
    static struct hid_scan scan;
    size_t i, kept = 0;

    if (hid_scan_blocks(d, len, &scan) != 0) return -1;
    for (i = 0; i < scan.count; i++) {
        if (hid_block_is_keyboard_side(&scan.blocks[i])) kept++;
    }
    if (kept == 0) return 0;
    for (i = 0; i < scan.count; i++) {
        const struct hid_block *c = &scan.blocks[i];
        if (!hid_block_policy_removes(c, policy) ||
            !hid_block_cut_safe(&scan, i)) {
            continue;
        }
        *out_start = c->start;
        *out_end = c->end;
        *out_report_id = (unsigned int)c->report_id;
        return 1;
    }
    return 0;
}

/* Prints the descriptor's collections and what each policy would do. */
static void hid_print_blocks(const unsigned char *d, size_t len) {
    static struct hid_scan scan;
    size_t i;

    if (hid_scan_blocks(d, len, &scan) != 0) {
        printf("pair-agent sdp-hid descriptor-unparsed len=%u\n",
            (unsigned int)len);
        return;
    }
    for (i = 0; i < scan.count; i++) {
        const struct hid_block *b = &scan.blocks[i];
        int safe = hid_block_cut_safe(&scan, i);
        printf("pair-agent sdp-hid collection=%u offset=%u bytes=%u usage=%04lx:%04lx report=0x%02x%s battery-policy=%s keyboard-only=%s\n",
            (unsigned int)i, (unsigned int)b->start,
            (unsigned int)(b->end - b->start),
            (unsigned long)(b->app_usage >> 16),
            (unsigned long)(b->app_usage & 0xffff),
            b->report_id < 0 ? 0 : (unsigned int)b->report_id,
            b->mixed_report_ids ? "+mixed" : "",
            hid_block_policy_removes(b, HID_STRIP_BATTERY) ?
                (safe ? "remove" : "unsafe") : "keep",
            hid_block_policy_removes(b, HID_STRIP_KEYBOARD_ONLY) ?
                (safe ? "remove" : "unsafe") : "keep");
    }
}

/* SDP data element header: type, size index, header length, data length. */
static int sdp_element(const unsigned char *p, size_t avail,
                       unsigned int *type, size_t *header_len,
                       size_t *data_len) {
    static const size_t fixed[5] = {1, 2, 4, 8, 16};
    unsigned int t, s;
    size_t h = 1, n;

    if (avail < 1) return -1;
    t = p[0] >> 3;
    s = p[0] & 7;
    switch (t) {
    case 0: /* nil */
        if (s != 0) return -1;
        n = 0;
        break;
    case 1: case 2: case 3: case 5: /* uint, int, UUID, bool */
        if (s > 4) return -1;
        n = fixed[s];
        break;
    case 4: case 6: case 7: case 8: /* text, sequence, alternative, URL */
        if (s == 5) {
            if (avail < 2) return -1;
            n = p[1];
            h = 2;
        } else if (s == 6) {
            if (avail < 3) return -1;
            n = ((size_t)p[1] << 8) | p[2];
            h = 3;
        } else if (s == 7) {
            if (avail < 5) return -1;
            n = ((size_t)p[1] << 24) | ((size_t)p[2] << 16) |
                ((size_t)p[3] << 8) | p[4];
            h = 5;
        } else {
            return -1;
        }
        break;
    default:
        return -1;
    }
    if (n > avail - h) return -1;
    *type = t;
    *header_len = h;
    *data_len = n;
    return 0;
}

/* Shrinks a variable-length element's length field in place. */
static void sdp_element_shrink(unsigned char *p, size_t removed) {
    unsigned int s = p[0] & 7;
    size_t n;

    if (s == 5) {
        p[1] = (unsigned char)(p[1] - removed);
    } else if (s == 6) {
        n = (((size_t)p[1] << 8) | p[2]) - removed;
        p[1] = (unsigned char)(n >> 8);
        p[2] = (unsigned char)n;
    } else if (s == 7) {
        n = (((size_t)p[1] << 24) | ((size_t)p[2] << 16) |
            ((size_t)p[3] << 8) | p[4]) - removed;
        p[1] = (unsigned char)(n >> 24);
        p[2] = (unsigned char)(n >> 16);
        p[3] = (unsigned char)(n >> 8);
        p[4] = (unsigned char)n;
    }
}

struct sdp_strip_result {
    uint32_t handle;
    int have_handle;
    unsigned int collections;   /* collections removed */
    char report_ids[64];        /* their report IDs, "0xac,0x02" */
    size_t removed;             /* bytes removed */
    int descriptors;
};

/*
 * rec is one service record: a sequence of (uint16 attribute id, value)
 * pairs, as a ServiceSearchAttributeResponse returns it and as
 * SDP_SVC_UPDATE_REQ takes it.  Removes the collections the policy picks
 * from the HIDDescriptorList.  Returns 1 if any were removed, 0 if there
 * are none, -1 if the record is malformed, -2 if a descriptor cannot be
 * parsed.  verbose prints each descriptor's collections first.
 */
static int sdp_record_strip_hid(unsigned char *rec, size_t *rec_len,
                                int policy, int verbose,
                                struct sdp_strip_result *result) {
    unsigned int type;
    size_t header, body, pos, end;
    int unparsed = 0;

    memset(result, 0, sizeof(*result));
    if (sdp_element(rec, *rec_len, &type, &header, &body) != 0 || type != 6) {
        return -1;
    }
    pos = header;
    end = header + body;
    while (pos < end) {
        unsigned int id_type, value_type, attr_id;
        size_t id_header, id_len, value_pos, value_header, value_len;

        if (sdp_element(rec + pos, end - pos, &id_type, &id_header,
                &id_len) != 0 || id_type != 1 || id_len != 2) {
            return -1;
        }
        attr_id = ((unsigned int)rec[pos + id_header] << 8) |
            rec[pos + id_header + 1];
        value_pos = pos + id_header + id_len;
        if (sdp_element(rec + value_pos, end - value_pos, &value_type,
                &value_header, &value_len) != 0) {
            return -1;
        }
        if (attr_id == SDP_ATTR_RECORD_HANDLE && value_type == 1 &&
            value_len == 4) {
            const unsigned char *h = rec + value_pos + value_header;
            result->handle = ((uint32_t)h[0] << 24) | ((uint32_t)h[1] << 16) |
                ((uint32_t)h[2] << 8) | h[3];
            result->have_handle = 1;
        } else if (attr_id == SDP_ATTR_HID_DESCRIPTOR_LIST &&
                   value_type == 6) {
            size_t list_pos = value_pos + value_header;
            size_t list_end = list_pos + value_len;
            while (list_pos < list_end) {
                unsigned int class_type;
                size_t class_header, class_len, item_pos, item_end;

                if (sdp_element(rec + list_pos, list_end - list_pos,
                        &class_type, &class_header, &class_len) != 0) {
                    return -1;
                }
                item_pos = list_pos + class_header;
                item_end = item_pos + class_len;
                while (class_type == 6 && item_pos < item_end) {
                    unsigned int item_type;
                    size_t item_header, item_len;

                    if (sdp_element(rec + item_pos, item_end - item_pos,
                            &item_type, &item_header, &item_len) != 0) {
                        return -1;
                    }
                    if (item_type == 4) {
                        unsigned char *desc = rec + item_pos + item_header;
                        size_t cut_start, cut_end, removed;
                        unsigned int report_id;
                        int found;

                        result->descriptors++;
                        if (verbose) hid_print_blocks(desc, item_len);
                        while ((found = hid_find_strip_block(desc, item_len,
                                policy, &cut_start, &cut_end,
                                &report_id)) > 0) {
                            size_t used = strlen(result->report_ids);
                            if (!result->have_handle) return -1;
                            removed = cut_end - cut_start;
                            memmove(desc + cut_start, desc + cut_end,
                                *rec_len - (size_t)(desc + cut_end - rec));
                            *rec_len -= removed;
                            item_len -= removed;
                            item_end -= removed;
                            list_end -= removed;
                            end -= removed;
                            sdp_element_shrink(rec + item_pos, removed);
                            sdp_element_shrink(rec + list_pos, removed);
                            sdp_element_shrink(rec + value_pos, removed);
                            sdp_element_shrink(rec, removed);
                            value_len -= removed;
                            result->collections++;
                            result->removed += removed;
                            snprintf(result->report_ids + used,
                                sizeof(result->report_ids) - used,
                                "%s0x%02x", used ? "," : "", report_id);
                        }
                        if (found < 0) unparsed = 1;
                    }
                    item_pos += item_header + item_len;
                }
                list_pos = item_end;
            }
        }
        pos = value_pos + value_header + value_len;
    }
    if (result->collections) return 1;
    return unparsed ? -2 : 0;
}

static void print_hex(const char *label, const unsigned char *p, size_t len) {
    size_t i;
    printf("%s", label);
    for (i = 0; i < len; i++) printf("%s%02X", i ? " " : "", p[i]);
    printf("\n");
}

static int sdp_local_open(char *err, size_t errlen) {
    struct sockaddr_un address;
    struct timeval timeout;
    int fd;

    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        snprintf(err, errlen, "socket: %s", strerror(errno));
        return -1;
    }
    timeout.tv_sec = SDP_IO_TIMEOUT_MS / 1000;
    timeout.tv_usec = (SDP_IO_TIMEOUT_MS % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    snprintf(address.sun_path, sizeof(address.sun_path), "%s",
        SDP_LOCAL_SOCKET_PATH);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        snprintf(err, errlen, "connect %s: %s", SDP_LOCAL_SOCKET_PATH,
            strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

static int sdp_read_exact(int fd, unsigned char *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t got = read(fd, buf + done, len - done);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) {
            if (got == 0) errno = ECONNRESET;
            return -1;
        }
        done += (size_t)got;
    }
    return 0;
}

/*
 * One request/response.  bluetoothd's sdpd peeks the 5-byte header and then
 * expects the whole PDU from a single recv(), dropping the session on a
 * short read, so the request goes out in one write.
 */
static int sdp_transact(int fd, unsigned int pdu_id,
                        const unsigned char *params, size_t params_len,
                        unsigned int *rsp_pdu, unsigned char *rsp,
                        size_t rsp_cap, size_t *rsp_len,
                        char *err, size_t errlen) {
    static unsigned char request[5 + SDP_MAX_RESPONSE];
    static unsigned int transaction;
    unsigned char header[5];
    unsigned int rsp_tid;
    size_t plen;
    ssize_t written;

    if (params_len > SDP_MAX_RESPONSE) {
        snprintf(err, errlen, "request too large");
        return -1;
    }
    transaction = (transaction + 1) & 0xffff;
    request[0] = (unsigned char)pdu_id;
    request[1] = (unsigned char)(transaction >> 8);
    request[2] = (unsigned char)transaction;
    request[3] = (unsigned char)(params_len >> 8);
    request[4] = (unsigned char)params_len;
    memcpy(request + 5, params, params_len);
    do {
        written = send(fd, request, 5 + params_len, MSG_NOSIGNAL);
    } while (written < 0 && errno == EINTR);
    if (written != (ssize_t)(5 + params_len)) {
        snprintf(err, errlen, "write: %s",
            written < 0 ? strerror(errno) : "short write");
        return -1;
    }
    if (sdp_read_exact(fd, header, sizeof(header)) != 0) {
        snprintf(err, errlen, "read: %s", strerror(errno));
        return -1;
    }
    rsp_tid = ((unsigned int)header[1] << 8) | header[2];
    plen = ((size_t)header[3] << 8) | header[4];
    if (rsp_tid != transaction || plen > rsp_cap) {
        snprintf(err, errlen, "bad response tid=0x%04x len=%u",
            rsp_tid, (unsigned int)plen);
        return -1;
    }
    if (sdp_read_exact(fd, rsp, plen) != 0) {
        snprintf(err, errlen, "read: %s", strerror(errno));
        return -1;
    }
    *rsp_pdu = header[0];
    *rsp_len = plen;
    return 0;
}

/* All records matching uuid16, every attribute, following continuations. */
static int sdp_fetch_records(int fd, unsigned int uuid16, unsigned char *out,
                             size_t out_cap, size_t *out_len,
                             char *err, size_t errlen) {
    static unsigned char rsp[SDP_MAX_RESPONSE];
    unsigned char request[64];
    unsigned char cont[17];
    size_t cont_len = 1, total = 0;
    int rounds;

    cont[0] = 0;
    for (rounds = 0; rounds < 32; rounds++) {
        size_t n = 0, rsp_len, chunk;
        unsigned int rsp_pdu;

        request[n++] = 0x35; request[n++] = 0x03; /* pattern: one UUID16 */
        request[n++] = 0x19;
        request[n++] = (unsigned char)(uuid16 >> 8);
        request[n++] = (unsigned char)uuid16;
        request[n++] = 0xff; request[n++] = 0xf0; /* max attribute bytes */
        request[n++] = 0x35; request[n++] = 0x05; /* range 0x0000-0xffff */
        request[n++] = 0x0a;
        request[n++] = 0x00; request[n++] = 0x00;
        request[n++] = 0xff; request[n++] = 0xff;
        memcpy(request + n, cont, cont_len);
        n += cont_len;
        if (sdp_transact(fd, SDP_SVC_SEARCH_ATTR_REQ, request, n, &rsp_pdu,
                rsp, sizeof(rsp), &rsp_len, err, errlen) != 0) {
            return -1;
        }
        if (rsp_pdu == SDP_ERROR_RSP) {
            snprintf(err, errlen, "search error 0x%04x",
                rsp_len >= 2 ? ((unsigned int)rsp[0] << 8) | rsp[1] : 0xffff);
            return -1;
        }
        if (rsp_pdu != SDP_SVC_SEARCH_ATTR_RSP || rsp_len < 3) {
            snprintf(err, errlen, "unexpected search response 0x%02x",
                rsp_pdu);
            return -1;
        }
        chunk = ((size_t)rsp[0] << 8) | rsp[1];
        if (chunk + 3 > rsp_len || rsp[2 + chunk] > 16 ||
            chunk + 3 + rsp[2 + chunk] != rsp_len) {
            snprintf(err, errlen, "malformed search response");
            return -1;
        }
        if (chunk > out_cap - total) {
            snprintf(err, errlen, "records exceed %u bytes",
                (unsigned int)out_cap);
            return -1;
        }
        memcpy(out + total, rsp + 2, chunk);
        total += chunk;
        cont_len = 1 + rsp[2 + chunk];
        memcpy(cont, rsp + 2 + chunk, cont_len);
        if (cont_len == 1) {
            *out_len = total;
            return 0;
        }
    }
    snprintf(err, errlen, "too many continuation rounds");
    return -1;
}

static int sdp_update_record(int fd, uint32_t handle,
                             const unsigned char *rec, size_t rec_len,
                             char *err, size_t errlen) {
    static unsigned char request[SDP_MAX_RESPONSE];
    unsigned char rsp[64];
    size_t rsp_len;
    unsigned int rsp_pdu, status;

    if (rec_len + 4 > sizeof(request)) {
        snprintf(err, errlen, "record too large");
        return -1;
    }
    request[0] = (unsigned char)(handle >> 24);
    request[1] = (unsigned char)(handle >> 16);
    request[2] = (unsigned char)(handle >> 8);
    request[3] = (unsigned char)handle;
    memcpy(request + 4, rec, rec_len);
    if (sdp_transact(fd, SDP_SVC_UPDATE_REQ, request, rec_len + 4, &rsp_pdu,
            rsp, sizeof(rsp), &rsp_len, err, errlen) != 0) {
        return -1;
    }
    status = rsp_len >= 2 ? ((unsigned int)rsp[0] << 8) | rsp[1] : 0xffff;
    if (rsp_pdu != SDP_SVC_UPDATE_RSP || status != 0) {
        snprintf(err, errlen, "update refused pdu=0x%02x status=0x%04x",
            rsp_pdu, status);
        return -1;
    }
    return 0;
}

#define SDP_STRIP_APPLY 1
#define SDP_STRIP_VERBOSE 2

/*
 * Checks every HID record in the local SDP database and, with
 * SDP_STRIP_APPLY, rewrites the ones that carry collections the policy
 * removes.  Returns the number of records stripped (or, without APPLY,
 * that would be), or -1 with a reason in err.
 */
static int sdp_strip_hid(int policy, int flags, char *err, size_t errlen) {
    static unsigned char lists[SDP_MAX_RESPONSE];
    static unsigned char rec[SDP_MAX_RESPONSE];
    size_t lists_len = 0, header, body, pos, end;
    unsigned int type;
    int fd, changed = 0, records = 0;

    err[0] = 0;
    fd = sdp_local_open(err, errlen);
    if (fd < 0) return -1;
    if (sdp_fetch_records(fd, SDP_UUID_HID, lists, sizeof(lists),
            &lists_len, err, errlen) != 0) {
        close(fd);
        return -1;
    }
    if (sdp_element(lists, lists_len, &type, &header, &body) != 0 ||
        type != 6) {
        snprintf(err, errlen, "malformed attribute lists");
        close(fd);
        return -1;
    }
    pos = header;
    end = header + body;
    while (pos < end) {
        struct sdp_strip_result result;
        size_t rec_header, rec_body, rec_len;
        int stripped;

        if (sdp_element(lists + pos, end - pos, &type, &rec_header,
                &rec_body) != 0 || type != 6) {
            snprintf(err, errlen, "malformed record");
            close(fd);
            return -1;
        }
        rec_len = rec_header + rec_body;
        memcpy(rec, lists + pos, rec_len);
        pos += rec_len;
        records++;
        if (flags & SDP_STRIP_VERBOSE) {
            print_hex("pair-agent sdp-hid record-hex ", rec, rec_len);
        }
        stripped = sdp_record_strip_hid(rec, &rec_len, policy,
            flags & SDP_STRIP_VERBOSE, &result);
        if (flags & SDP_STRIP_VERBOSE) {
            printf("pair-agent sdp-hid record=%d handle=0x%08lx descriptors=%d result=%s\n",
                records, (unsigned long)result.handle, result.descriptors,
                stripped > 0 ? (policy == HID_STRIP_BATTERY ?
                    "battery-collection" : "removable-collections") :
                (stripped == 0 ? "clean" :
                (stripped == -2 ? "descriptor-unparsed" : "malformed")));
        }
        if (stripped == -1) {
            snprintf(err, errlen, "malformed HID record %d", records);
            close(fd);
            return -1;
        }
        if (stripped <= 0) continue;
        if (flags & SDP_STRIP_VERBOSE) {
            printf("pair-agent sdp-hid would-remove report=%s collections=%u bytes=%u\n",
                result.report_ids, result.collections,
                (unsigned int)result.removed);
            print_hex("pair-agent sdp-hid patched-hex ", rec, rec_len);
        }
        if (flags & SDP_STRIP_APPLY) {
            if (sdp_update_record(fd, result.handle, rec, rec_len,
                    err, errlen) != 0) {
                close(fd);
                return -1;
            }
            printf("pair-agent sdp-hid %s handle=0x%08lx report=%s bytes=%u\n",
                policy == HID_STRIP_BATTERY ? "battery-report-removed" :
                "collections-removed",
                (unsigned long)result.handle, result.report_ids,
                (unsigned int)result.removed);
        }
        changed++;
    }
    close(fd);
    if (records == 0) {
        snprintf(err, errlen, "no HID record registered");
    }
    return changed;
}

/*
 * GATT over BR/EDR.
 *
 * bluetoothd's attribute server publishes SDP records for its GATT
 * services over BR/EDR (ATT on PSM 0x1F).  An Android 14 box (Homatics Box
 * R 4K Plus) runs GATT discovery against them once a Google service
 * connects GATT to the newly paired keyboard.  Its Bluetooth main thread
 * then spins and never sends the first ATT request, which freezes every
 * Bluetooth device on the box until it reboots.  Hiding these records is a
 * manual experiment: it removes them from SDP only (LE GATT and the ATT
 * listener are untouched) until bluetoothd restarts.
 */
struct sdp_att_record {
    uint32_t handle;
    int have_handle;
    unsigned int service_uuid16;    /* 0 if none or not 16-bit */
    char service[40];               /* first service class, as text */
    int has_att;
    unsigned int att_start;
    unsigned int att_end;
};

/* Reads a UUID element into text and, if 16-bit, a number. */
static void sdp_uuid_text(const unsigned char *p, size_t len, char *out,
                          size_t outlen, unsigned int *uuid16) {
    size_t i, used = 0;
    *uuid16 = len == 2 ? ((unsigned int)p[0] << 8) | p[1] : 0;
    out[0] = 0;
    for (i = 0; i < len && used + 3 < outlen; i++) {
        used += (size_t)snprintf(out + used, outlen - used, "%02x", p[i]);
    }
}

/*
 * Finds the first UUID in the service class list and an ATT element (UUID
 * 0x0007 followed by two uint16 handles) in the protocol descriptor list.
 */
static int sdp_record_att_info(const unsigned char *rec, size_t rec_len,
                               struct sdp_att_record *info) {
    unsigned int type;
    size_t header, body, pos, end;

    memset(info, 0, sizeof(*info));
    if (sdp_element(rec, rec_len, &type, &header, &body) != 0 || type != 6) {
        return -1;
    }
    pos = header;
    end = header + body;
    while (pos < end) {
        unsigned int id_type, value_type, attr_id;
        size_t id_header, id_len, value_pos, value_header, value_len;

        if (sdp_element(rec + pos, end - pos, &id_type, &id_header,
                &id_len) != 0 || id_type != 1 || id_len != 2) {
            return -1;
        }
        attr_id = ((unsigned int)rec[pos + id_header] << 8) |
            rec[pos + id_header + 1];
        value_pos = pos + id_header + id_len;
        if (sdp_element(rec + value_pos, end - value_pos, &value_type,
                &value_header, &value_len) != 0) {
            return -1;
        }
        if (attr_id == SDP_ATTR_RECORD_HANDLE && value_type == 1 &&
            value_len == 4) {
            const unsigned char *h = rec + value_pos + value_header;
            info->handle = ((uint32_t)h[0] << 24) | ((uint32_t)h[1] << 16) |
                ((uint32_t)h[2] << 8) | h[3];
            info->have_handle = 1;
        } else if (attr_id == SDP_ATTR_SERVICE_CLASS_ID_LIST &&
                   value_type == 6 && value_len > 0) {
            unsigned int t;
            size_t h, n;
            const unsigned char *first = rec + value_pos + value_header;
            if (sdp_element(first, value_len, &t, &h, &n) == 0 && t == 3) {
                sdp_uuid_text(first + h, n, info->service,
                    sizeof(info->service), &info->service_uuid16);
            }
        } else if (attr_id == SDP_ATTR_PROTOCOL_DESCRIPTOR_LIST &&
                   value_type == 6) {
            size_t lpos = value_pos + value_header;
            size_t lend = lpos + value_len;
            while (lpos < lend) {
                unsigned int t, ut, ht;
                size_t h, n, ipos, uh, un, hh, hn;

                if (sdp_element(rec + lpos, lend - lpos, &t, &h, &n) != 0) {
                    return -1;
                }
                ipos = lpos + h;
                if (t == 6 && n > 0 &&
                    sdp_element(rec + ipos, n, &ut, &uh, &un) == 0 &&
                    ut == 3 && un == 2 &&
                    (((unsigned int)rec[ipos + uh] << 8) |
                        rec[ipos + uh + 1]) == SDP_UUID_ATT) {
                    size_t ppos = ipos + uh + un;
                    size_t pend = ipos + n;
                    info->has_att = 1;
                    if (ppos < pend &&
                        sdp_element(rec + ppos, pend - ppos, &ht, &hh,
                            &hn) == 0 && ht == 1 && hn == 2) {
                        info->att_start = ((unsigned int)rec[ppos + hh] << 8) |
                            rec[ppos + hh + 1];
                        ppos += hh + hn;
                        if (ppos < pend &&
                            sdp_element(rec + ppos, pend - ppos, &ht, &hh,
                                &hn) == 0 && ht == 1 && hn == 2) {
                            info->att_end =
                                ((unsigned int)rec[ppos + hh] << 8) |
                                rec[ppos + hh + 1];
                        }
                    }
                }
                lpos += h + n;
            }
        }
        pos = value_pos + value_header + value_len;
    }
    return 0;
}

static int sdp_remove_record(int fd, uint32_t handle, char *err,
                             size_t errlen) {
    unsigned char request[4], rsp[64];
    size_t rsp_len;
    unsigned int rsp_pdu, status;

    request[0] = (unsigned char)(handle >> 24);
    request[1] = (unsigned char)(handle >> 16);
    request[2] = (unsigned char)(handle >> 8);
    request[3] = (unsigned char)handle;
    if (sdp_transact(fd, SDP_SVC_REMOVE_REQ, request, sizeof(request),
            &rsp_pdu, rsp, sizeof(rsp), &rsp_len, err, errlen) != 0) {
        return -1;
    }
    status = rsp_len >= 2 ? ((unsigned int)rsp[0] << 8) | rsp[1] : 0xffff;
    if (rsp_pdu != SDP_SVC_REMOVE_RSP || status != 0) {
        snprintf(err, errlen, "remove refused pdu=0x%02x status=0x%04x",
            rsp_pdu, status);
        return -1;
    }
    return 0;
}

/*
 * Lists every record an ATT (UUID 0x0007) search returns, as a remote GATT
 * client sees it.  With apply, removes those that carry an ATT protocol
 * element, except HID records.  Returns the number of such records, or -1.
 */
static int sdp_att_records(int apply, char *err, size_t errlen) {
    static unsigned char lists[SDP_MAX_RESPONSE];
    size_t lists_len = 0, header, body, pos, end;
    unsigned int type;
    int fd, matched = 0, records = 0;

    err[0] = 0;
    fd = sdp_local_open(err, errlen);
    if (fd < 0) return -1;
    if (sdp_fetch_records(fd, SDP_UUID_ATT, lists, sizeof(lists),
            &lists_len, err, errlen) != 0 ||
        sdp_element(lists, lists_len, &type, &header, &body) != 0 ||
        type != 6) {
        if (!err[0]) snprintf(err, errlen, "malformed attribute lists");
        close(fd);
        return -1;
    }
    pos = header;
    end = header + body;
    while (pos < end) {
        struct sdp_att_record info;
        size_t rec_header, rec_body;
        const char *action = "keep";

        if (sdp_element(lists + pos, end - pos, &type, &rec_header,
                &rec_body) != 0 || type != 6 ||
            sdp_record_att_info(lists + pos, rec_header + rec_body,
                &info) != 0) {
            snprintf(err, errlen, "malformed record");
            close(fd);
            return -1;
        }
        pos += rec_header + rec_body;
        records++;
        if (info.has_att && info.service_uuid16 != SDP_UUID_HID &&
            info.have_handle) {
            matched++;
            action = apply ? "removed" : "would-remove";
            if (apply && sdp_remove_record(fd, info.handle, err,
                    errlen) != 0) {
                close(fd);
                return -1;
            }
        }
        if (info.has_att) {
            printf("pair-agent sdp-att record handle=0x%08lx service=%s att=0x%04x-0x%04x %s\n",
                (unsigned long)info.handle,
                info.service[0] ? info.service : "?",
                info.att_start, info.att_end, action);
        } else {
            printf("pair-agent sdp-att record handle=0x%08lx service=%s att=none %s\n",
                (unsigned long)info.handle,
                info.service[0] ? info.service : "?", action);
        }
    }
    close(fd);
    printf("pair-agent sdp-att records=%d gatt-records=%d\n", records,
        matched);
    return matched;
}

/* The profile the WebGUI last selected; it defaults to btkeyboard too. */
static void read_saved_profile(char *out, size_t outlen) {
    char raw[64];
    const char *value = raw;
    FILE *input;

    snprintf(out, outlen, "btkeyboard");
    input = fopen(BT_PROFILE_FILE, "r");
    if (!input) return;
    if (fgets(raw, sizeof(raw), input)) {
        raw[strcspn(raw, "\r\n")] = 0;
        if (strncmp(raw, "type=", 5) == 0) value = raw + 5;
        if (safe_profile(value)) snprintf(out, outlen, "%s", value);
    }
    fclose(input);
}

/*
 * Periodic check from the daemon and the pairing helper.  HAL registers
 * the record again whenever it (re)starts the HID profile, so this keeps
 * looking.  Only the plain btkeyboard profile is touched.  Logs changes of
 * state, not every check, because the log lives in RAM.
 */
struct sdp_watch {
    time_t next_check;
    int consecutive_patches;
    char last_state[160];
};

static void sdp_watch_check(struct sdp_watch *watch, const char *profile,
                            time_t now) {
    char state[160], err[128];
    int rc, interval = SDP_CHECK_INTERVAL_SECONDS;

    if (strcmp(profile, "btkeyboard") != 0) {
        snprintf(state, sizeof(state), "skip profile=%s", profile);
        watch->consecutive_patches = 0;
    } else {
        rc = sdp_strip_hid(HID_STRIP_BATTERY, SDP_STRIP_APPLY, err,
            sizeof(err));
        if (rc < 0) {
            snprintf(state, sizeof(state), "error %s", err);
        } else if (rc == 0) {
            snprintf(state, sizeof(state), "%s",
                err[0] ? "no-hid-record" : "clean");
            watch->consecutive_patches = 0;
        } else {
            snprintf(state, sizeof(state), "patched");
            /*
             * If the record keeps coming back, the update is not taking
             * effect; stop rewriting it so often.
             */
            if (++watch->consecutive_patches >= 3) {
                interval = SDP_BACKOFF_SECONDS;
                snprintf(state, sizeof(state), "patched-repeatedly");
            }
        }
    }
    if (strcmp(state, watch->last_state) != 0 &&
        strcmp(state, "patched") != 0) {
        printf("pair-agent sdp-hid state=%s\n", state);
    }
    snprintf(watch->last_state, sizeof(watch->last_state), "%s", state);
    watch->next_check = now + interval;
}

static int hex_value(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/*
 * Offline: read one record as hex on stdin (separators ignored), print the
 * result.  Lets a captured record be checked on a PC, and drives the
 * host-side test.
 */
static int sdp_filter_stdin(int policy) {
    static unsigned char rec[SDP_MAX_RESPONSE];
    struct sdp_strip_result result;
    size_t len = 0;
    int c, high = -1, rc;

    while ((c = getchar()) != EOF) {
        int v = hex_value(c);
        if (v < 0) continue;
        if (high < 0) {
            high = v;
            continue;
        }
        if (len >= sizeof(rec)) {
            fprintf(stderr, "record too large\n");
            return 1;
        }
        rec[len++] = (unsigned char)((high << 4) | v);
        high = -1;
    }
    if (high >= 0) {
        fprintf(stderr, "odd number of hex digits\n");
        return 1;
    }
    rc = sdp_record_strip_hid(rec, &len, policy, 0, &result);
    if (rc == -1) {
        printf("malformed\n");
        return 1;
    }
    if (rc == -2) {
        printf("descriptor-unparsed\n");
        return 0;
    }
    if (rc == 0) {
        printf("clean\n");
        return 0;
    }
    printf("removed handle=0x%08lx report=%s bytes=%u\n",
        (unsigned long)result.handle, result.report_ids,
        (unsigned int)result.removed);
    print_hex("", rec, len);
    return 0;
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
    const char *sdp_mode = argc > 3 && strncmp(argv[3], "--sdp-", 6) == 0 ?
        argv[3] : NULL;
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
    struct sdp_watch sdp_watch;
    int watch_sdp = hid_control_daemon || use_pin_fifo;

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
    memset(&sdp_watch, 0, sizeof(sdp_watch));

    if (sdp_mode) {
        char err[128];
        int rc;

        if (strcmp(sdp_mode, "--sdp-hid-filter") == 0) {
            return sdp_filter_stdin(argc > 4 &&
                strcmp(argv[4], "keyboard-only") == 0 ?
                HID_STRIP_KEYBOARD_ONLY : HID_STRIP_BATTERY);
        }
        if (strcmp(sdp_mode, "--sdp-att-check") == 0 ||
            strcmp(sdp_mode, "--sdp-att-hide") == 0) {
            int apply = strcmp(sdp_mode, "--sdp-att-hide") == 0;
            if (apply && strcmp(profile, "btkeyboard") != 0) {
                fprintf(stderr,
                    "pair-agent sdp-att only used with the btkeyboard profile\n");
                return 2;
            }
            if (sdp_att_records(apply, err, sizeof(err)) < 0) {
                fprintf(stderr, "pair-agent sdp-att failed: %s\n", err);
                return 1;
            }
            return 0;
        }
        if (strcmp(sdp_mode, "--sdp-hid-check") == 0) {
            rc = sdp_strip_hid(HID_STRIP_BATTERY, SDP_STRIP_VERBOSE,
                err, sizeof(err));
        } else if (strcmp(sdp_mode, "--sdp-hid-strip-battery") == 0 ||
                   strcmp(sdp_mode, "--sdp-hid-keyboard-only") == 0) {
            if (strcmp(profile, "btkeyboard") != 0) {
                fprintf(stderr,
                    "pair-agent sdp-hid only the btkeyboard profile is patched\n");
                return 2;
            }
            rc = sdp_strip_hid(
                strcmp(sdp_mode, "--sdp-hid-keyboard-only") == 0 ?
                HID_STRIP_KEYBOARD_ONLY : HID_STRIP_BATTERY,
                SDP_STRIP_APPLY | SDP_STRIP_VERBOSE, err, sizeof(err));
        } else {
            fprintf(stderr, "unknown mode: %s\n", sdp_mode);
            return 2;
        }
        if (rc < 0) {
            fprintf(stderr, "pair-agent sdp-hid failed: %s\n", err);
            return 1;
        }
        printf("pair-agent sdp-hid records-%s=%d%s\n",
            strcmp(sdp_mode, "--sdp-hid-keyboard-only") == 0 ?
            "trimmed-to-keyboard" : "with-battery-collection",
            rc, err[0] ? " (no HID record registered)" : "");
        return 0;
    }
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
        if (watch_sdp && now >= sdp_watch.next_check) {
            char saved_profile[64];
            if (hid_control_daemon) {
                read_saved_profile(saved_profile, sizeof(saved_profile));
            } else {
                snprintf(saved_profile, sizeof(saved_profile), "%s", profile);
            }
            sdp_watch_check(&sdp_watch, saved_profile, now);
        }
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
            /* Recheck before the host can query SDP on this link. */
            sdp_watch.next_check = 0;
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
            /* Hub-initiated links never raise a connection request. */
            sdp_watch.next_check = 0;
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
