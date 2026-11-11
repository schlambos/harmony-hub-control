/*
 * codex_usbeth — USB host-mode and USB-Ethernet helper for Harmony Hub
 * (Linux 2.6.31-g89d565c, AR9344 MIPS32 big-endian).
 *
 * Subcommands:
 *   codex_usbeth phy-host
 *     Set bit 0 of the AR9344 usbctrlr1 register (phys 0x18116c84) so the
 *     EHCI controller reset sequence runs the Atheros USB PHY host reset.
 *     A sentinel read (0xdeadbeef / 0xffffffff) or a read that changes
 *     between two samples means the register is not accessible yet: the
 *     command then writes nothing and fails, so the service can retry it
 *     as a readiness probe instead of latching garbage into the PHY.
 *
 *   codex_usbeth register-ehci [--check]
 *     Register the stock kernel's dormant ar7240-ehci platform device
 *     (struct at 0x8023b808) by transiently pointing
 *     sys_call_table[__NR_sethostname] (phys 0x0000c990, stock value
 *     0x8002fb4c) at platform_device_register (0x801267cc), invoking
 *     syscall(__NR_sethostname, 0x8023b808, 0), and immediately restoring
 *     0x8002fb4c. Verifies the kernel release and slot value before and
 *     after; fails closed on any mismatch. Registration is NOT binding:
 *     when the device is already registered (the usual case — the kernel
 *     registers it at boot when a USB charger is detected) this command
 *     writes nothing, prints register_ehci=skipped_registered_unbound and
 *     returns 3; binding then only needs the ehci_hcd driver loaded (or
 *     one guarded re-probe, driven by usb_eth_service.sh). With --check,
 *     reports bound/slot state without writing to /dev/mem.
 *
 *   codex_usbeth net-apply <wired-if> <wifi-if> / net-remove <...>
 *     Keep replies to the wired address on the wired interface while two
 *     interfaces share one subnet (see docs/USB_ETHERNET.md): prefer a
 *     source rule (from <wired-ip> lookup table) when the kernel accepts
 *     RTM_NEWRULE, else demote the Wi-Fi connected route for the shared
 *     subnet to metric 20 in the main table so the wired connected route
 *     wins. net-remove undoes exactly that. No default route is ever
 *     added, so the cloud blocker's egress policy is untouched.
 *
 *   codex_usbeth eth-fix <ifname>
 *     Disable TX and RX hardware checksum offload on <ifname> via SIOCETHTOOL
 *     (ETHTOOL_STXCSUM / ETHTOOL_SRXCSUM = 0).
 *
 *   codex_usbeth status
 *     Emit key=value lines describing kernel compatibility, gadget module
 *     state, EHCI platform-driver binding, attached USB device VID:PID,
 *     the kernel driver that should bind it (VID:PID map, else CDC
 *     interface-class 02/06 ECM or 02/0d NCM), USB-backed network interface
 *     name, link carrier, and IPv4 address.
 */

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/fib_rules.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#endif

#define EXPECTED_KERNEL_RELEASE "2.6.31-g89d565c"

/* AR9344 USB PHY control register 1 (bit 0 selects host mode reset in ehci-hcd). */
#define USBCTRLR1_PHYS          0x18116c84UL
#define USBCTRLR1_HOST_BIT      0x00000001U

/* Kernel-build-specific addresses for Linux 2.6.31-g89d565c. */
#define SYSCALL_SLOT_PHYS       0x0000c990UL  /* sys_call_table[148] (sethostname) */
#define STOCK_SETHOSTNAME_ADDR  0x8002fb4cU
#define PLATFORM_DEV_REG_ADDR   0x801267ccU
#define AR7240_USB_DEV_KADDR    0x8023b808UL

#ifndef __NR_sethostname
#define __NR_sethostname        4074          /* MIPS o32: 4000 + 74 */
#endif

/* Linux ethtool ioctl ABI for checksum offload control. */
#ifndef SIOCETHTOOL
#define SIOCETHTOOL             0x8946
#endif
#define ETHTOOL_GRXCSUM         0x00000014U
#define ETHTOOL_SRXCSUM         0x00000015U
#define ETHTOOL_GTXCSUM         0x00000016U
#define ETHTOOL_STXCSUM         0x00000017U

struct ethtool_value {
    uint32_t cmd;
    uint32_t data;
};

/* ---- Pure logic (unit-tested on the host; no sysfs, no /dev/mem) ---- */

/* Inaccessible AR9344 register reads observed on this SoC: the boot-time
 * failure latched 0xdeadbeef, and an unclocked block reads back all-ones.
 * Neither is a legitimate usbctrlr1 value; both must be rejected before
 * any write. The one healthy value observed on the hub (0x84000085) is
 * evidence, not a mask: any other stable, non-sentinel value is accepted
 * and its unrelated bits are preserved verbatim. */
static int phy_value_is_sentinel(uint32_t v) {
    return v == 0xdeadbeefU || v == 0xffffffffU;
}

static uint32_t phy_host_value(uint32_t v) {
    return v | USBCTRLR1_HOST_BIT;
}

/* The write landed as intended only if every unrelated bit is preserved
 * and the host bit is set. This does not prove the PHY is usable; the
 * EHCI probe and USB enumeration that follow are the proof. */
static int phy_readback_ok(uint32_t before, uint32_t readback) {
    return readback == phy_host_value(before);
}

/* Controller/adapter states, kept distinct end to end (helper status,
 * service state file, web UI). */
struct usbeth_probe {
    int platform_registered;
    int ehci_bound;
    int usbcore_loaded;
    int usb_device_present;
    int usb_driver_known;
    int iface_present;
    int carrier;
    int has_ipv4;
};

static const char *usbeth_state_name(const struct usbeth_probe *p) {
    if (p->ehci_bound) {
        if (p->iface_present)
            return (p->carrier && p->has_ipv4) ? "operational" : "awaiting_carrier_dhcp";
        if (!p->usb_device_present) return "bus_ready";
        if (!p->usb_driver_known) return "adapter_unsupported";
        return "nic_not_bound";
    }
    if (p->platform_registered) return "platform_unbound";
    if (!p->usbcore_loaded) return "deps_unavailable";
    return "platform_absent";
}

static int parse_ipv4(const char *s, uint32_t *out_host_order) {
    unsigned a, b, c, d;
    char tail;
    if (!s || sscanf(s, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4) return -1;
    if (a > 255 || b > 255 || c > 255 || d > 255) return -1;
    *out_host_order = (a << 24) | (b << 16) | (c << 8) | d;
    return 0;
}

static uint32_t ipv4_mask(int prefix) {
    if (prefix <= 0) return 0U;
    if (prefix >= 32) return 0xffffffffU;
    return 0xffffffffU << (32 - prefix);
}

static int ipv4_same_subnet(uint32_t a, uint32_t b, int prefix) {
    uint32_t m = ipv4_mask(prefix);
    return (a & m) == (b & m);
}

/* Source-rule routing when the kernel accepts policy rules, otherwise the
 * owned main-table metric fallback. Chosen at runtime, never assumed. */
static const char *route_mode_for_policy(int policy_supported) {
    return policy_supported ? "policy" : "metric";
}

#define USBETH_ROUTE_TABLE   117
#define USBETH_RULE_PRIO     1000
#define USBETH_WIFI_METRIC   20

static int read_first_line(const char *path, char *buf, size_t buflen) {
    if (!buf || buflen == 0) return -1;
    buf[0] = '\0';
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, buflen - 1);
    close(fd);
    if (n <= 0) return -1;
    buf[n] = '\0';
    for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == '\r' || buf[i] == '\n') {
            buf[i] = '\0';
            break;
        }
    }
    return 0;
}

static int check_kernel_release(char *rel_out, size_t rel_len) {
    struct utsname u;
    if (uname(&u) != 0) {
        if (rel_out && rel_len > 0) rel_out[0] = '\0';
        return 0;
    }
    if (rel_out && rel_len > 0) {
        snprintf(rel_out, rel_len, "%s", u.release);
    }
    return strcmp(u.release, EXPECTED_KERNEL_RELEASE) == 0 ? 1 : 0;
}

static int is_ehci_bound(void) {
    struct stat st;
    if (stat("/sys/bus/platform/drivers/ar7240-ehci/ar7240-ehci.0", &st) == 0)
        return 1;
    if (stat("/sys/bus/usb/devices/usb1", &st) == 0)
        return 1;
    return 0;
}

/* Registered is not bound: the kernel registers ar7240-ehci.0 at boot
 * (charger detect), while binding waits for the ehci_hcd driver. The
 * service must never re-register a device that already exists. */
static int is_platform_registered(void) {
    struct stat st;
    return stat("/sys/devices/platform/ar7240-ehci.0", &st) == 0 ? 1 : 0;
}

static int are_gadget_modules_loaded(void) {
    FILE *fp = fopen("/proc/modules", "r");
    if (!fp) return 0;
    char line[256];
    int found = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, "gadgetfs ", 9) == 0 ||
            strncmp(line, "ath_udc ", 8) == 0 ||
            strncmp(line, "g_hid ", 6) == 0) {
            found = 1;
            break;
        }
    }
    fclose(fp);
    return found;
}

static int is_module_loaded(const char *modname) {
    FILE *fp = fopen("/proc/modules", "r");
    if (!fp) return 0;
    size_t len = strlen(modname);
    char line[256];
    int found = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, modname, len) == 0 && line[len] == ' ') {
            found = 1;
            break;
        }
    }
    fclose(fp);
    return found;
}

static int cmd_phy_host(void) {
    char rel[64];
    if (!check_kernel_release(rel, sizeof(rel))) {
        fprintf(stderr, "codex_usbeth phy-host: unsupported kernel '%s' (expected '%s')\n",
                rel, EXPECTED_KERNEL_RELEASE);
        return 1;
    }
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) {
        fprintf(stderr, "codex_usbeth phy-host: open /dev/mem: %s\n", strerror(errno));
        return 1;
    }
    long page_sz = sysconf(_SC_PAGESIZE);
    if (page_sz <= 0) page_sz = 4096;
    off_t page_base = (off_t)(USBCTRLR1_PHYS & ~((unsigned long)page_sz - 1UL));
    size_t page_off = (size_t)(USBCTRLR1_PHYS - (unsigned long)page_base);

    void *map = mmap(NULL, (size_t)page_sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, page_base);
    if (map == MAP_FAILED) {
        fprintf(stderr, "codex_usbeth phy-host: mmap 0x%08lx: %s\n",
                USBCTRLR1_PHYS, strerror(errno));
        close(fd);
        return 1;
    }
    volatile uint32_t *reg = (volatile uint32_t *)((char *)map + page_off);
    uint32_t before = *reg;
    if (phy_value_is_sentinel(before)) {
        printf("usbctrlr1 before=0x%08x phy_host=failed reason=sentinel_read\n", before);
        fprintf(stderr, "codex_usbeth phy-host: usbctrlr1 read 0x%08x is a sentinel; not writing\n", before);
        munmap(map, (size_t)page_sz);
        close(fd);
        return 1;
    }
    uint32_t again = *reg;
    if (again != before) {
        printf("usbctrlr1 before=0x%08x phy_host=failed reason=unstable_read second=0x%08x\n", before, again);
        fprintf(stderr, "codex_usbeth phy-host: usbctrlr1 read changed 0x%08x -> 0x%08x; not writing\n", before, again);
        munmap(map, (size_t)page_sz);
        close(fd);
        return 1;
    }
    uint32_t after = phy_host_value(before);
    *reg = after;
    uint32_t readback = *reg;
    munmap(map, (size_t)page_sz);
    close(fd);

    if (!phy_readback_ok(before, readback)) {
        printf("usbctrlr1 before=0x%08x after=0x%08x phy_host=failed reason=readback_mismatch\n", before, readback);
        fprintf(stderr, "codex_usbeth phy-host: readback 0x%08x != expected 0x%08x\n", readback, after);
        return 1;
    }
    printf("usbctrlr1 before=0x%08x after=0x%08x phy_host=ok\n", before, readback);
    return 0;
}

static int cmd_register_ehci(int check_only) {
    char rel[64];
    int k_ok = check_kernel_release(rel, sizeof(rel));
    int bound = is_ehci_bound();

    if (check_only) {
        int fd = open("/dev/mem", O_RDONLY | O_SYNC);
        uint32_t slot_val = 0;
        int slot_ok = 0;
        if (fd >= 0) {
            long page_sz = sysconf(_SC_PAGESIZE);
            if (page_sz <= 0) page_sz = 4096;
            off_t page_base = (off_t)(SYSCALL_SLOT_PHYS & ~((unsigned long)page_sz - 1UL));
            size_t page_off = (size_t)(SYSCALL_SLOT_PHYS - (unsigned long)page_base);
            void *map = mmap(NULL, (size_t)page_sz, PROT_READ, MAP_SHARED, fd, page_base);
            if (map != MAP_FAILED) {
                volatile const uint32_t *slot =
                    (volatile const uint32_t *)((const char *)map + page_off);
                slot_val = *slot;
                slot_ok = (slot_val == STOCK_SETHOSTNAME_ADDR);
                munmap(map, (size_t)page_sz);
            }
            close(fd);
        }
        printf("kernel=%s kernel_ok=%d ehci_bound=%d slot=0x%08x slot_ok=%d\n",
               rel[0] ? rel : "unknown", k_ok, bound, slot_val, slot_ok);
        printf("platform_registered=%d usbcore_loaded=%d ehci_loaded=%d\n",
               is_platform_registered(), is_module_loaded("usbcore"),
               is_module_loaded("ehci_hcd"));
        return (k_ok && (bound || slot_ok)) ? 0 : 1;
    }

    if (!k_ok) {
        fprintf(stderr, "codex_usbeth register-ehci: unsupported kernel '%s' (expected '%s')\n",
                rel, EXPECTED_KERNEL_RELEASE);
        return 1;
    }
    if (bound) {
        printf("ehci_bound=1 (already bound)\n");
        return 0;
    }
    if (is_platform_registered()) {
        /* Already registered: platform_device_register on the same struct
         * is the duplicate-registration warning in the boot log. Binding
         * is the driver core's job once ehci_hcd is loaded; the service
         * handles that path. Never re-register. */
        printf("platform_registered=1 ehci_bound=0 register_ehci=skipped_registered_unbound\n");
        return 3;
    }

    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) {
        fprintf(stderr, "codex_usbeth register-ehci: open /dev/mem: %s\n", strerror(errno));
        return 1;
    }
    long page_sz = sysconf(_SC_PAGESIZE);
    if (page_sz <= 0) page_sz = 4096;
    off_t page_base = (off_t)(SYSCALL_SLOT_PHYS & ~((unsigned long)page_sz - 1UL));
    size_t page_off = (size_t)(SYSCALL_SLOT_PHYS - (unsigned long)page_base);

    void *map = mmap(NULL, (size_t)page_sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, page_base);
    if (map == MAP_FAILED) {
        fprintf(stderr, "codex_usbeth register-ehci: mmap 0x%08lx: %s\n",
                SYSCALL_SLOT_PHYS, strerror(errno));
        close(fd);
        return 1;
    }

    volatile uint32_t *slot = (volatile uint32_t *)((char *)map + page_off);
    uint32_t orig = *slot;
    if (orig != STOCK_SETHOSTNAME_ADDR) {
        fprintf(stderr,
                "codex_usbeth register-ehci: abort: slot 0x%08lx holds 0x%08x (expected 0x%08x)\n",
                SYSCALL_SLOT_PHYS, orig, STOCK_SETHOSTNAME_ADDR);
        munmap(map, (size_t)page_sz);
        close(fd);
        return 1;
    }

    *slot = PLATFORM_DEV_REG_ADDR;
    __sync_synchronize();
    long call_rc = syscall(__NR_sethostname, (void *)AR7240_USB_DEV_KADDR, 0);
    int call_err = errno;
    *slot = orig;
    __sync_synchronize();
    uint32_t restored = *slot;

    munmap(map, (size_t)page_sz);
    close(fd);

    if (restored != STOCK_SETHOSTNAME_ADDR) {
        fprintf(stderr,
                "codex_usbeth register-ehci: critical: slot restore readback 0x%08x != 0x%08x\n",
                restored, STOCK_SETHOSTNAME_ADDR);
        return 1;
    }

    int now_bound = is_ehci_bound();
    printf("register_ehci call_rc=%ld errno=%d restored=0x%08x platform_registered=%d ehci_bound=%d\n",
           call_rc, (call_rc < 0) ? call_err : 0, restored,
           is_platform_registered(), now_bound);
    return now_bound ? 0 : 1;
}

static int cmd_eth_fix(const char *ifname) {
    if (!ifname || !ifname[0] || strlen(ifname) >= IFNAMSIZ) {
        fprintf(stderr, "usage: codex_usbeth eth-fix <ifname>\n");
        return 2;
    }
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        fprintf(stderr, "codex_usbeth eth-fix: socket: %s\n", strerror(errno));
        return 1;
    }
    struct ifreq ifr;
    struct ethtool_value eval;

    memset(&ifr, 0, sizeof(ifr));
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
    eval.cmd = ETHTOOL_STXCSUM;
    eval.data = 0;
    ifr.ifr_data = (char *)&eval;
    int tx_rc = ioctl(sock, SIOCETHTOOL, &ifr);
    int tx_err = errno;

    memset(&ifr, 0, sizeof(ifr));
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
    eval.cmd = ETHTOOL_SRXCSUM;
    eval.data = 0;
    ifr.ifr_data = (char *)&eval;
    int rx_rc = ioctl(sock, SIOCETHTOOL, &ifr);
    int rx_err = errno;

    close(sock);
    printf("ifname=%s tx_csum_off=%d rx_csum_off=%d\n",
           ifname, tx_rc == 0 ? 1 : 0, rx_rc == 0 ? 1 : 0);
    if (tx_rc != 0 && tx_err != EOPNOTSUPP) {
        fprintf(stderr, "codex_usbeth eth-fix: ETHTOOL_STXCSUM on %s: %s\n",
                ifname, strerror(tx_err));
        return 1;
    }
    (void)rx_err;
    return 0;
}

struct usbeth_id {
    const char *vid;
    const char *pid;
    const char *driver;
};

/* VID:PID fast path. CDC devices additionally match by interface class below,
 * so an unlisted CDC-ECM/NCM adapter does not need an entry in this table. */
static const struct usbeth_id usbeth_ids[] = {
    { "0bda", "8152", "r8152" }, { "0bda", "8153", "r8152" },
    { "04e8", "a101", "r8152" },
    /* Linux 2.6.31 asix.ko: AX88172/88772/88772A/88178 and clones. */
    { "077b", "2226", "asix" }, { "0846", "1040", "asix" },
    { "2001", "1a00", "asix" }, { "0b95", "1720", "asix" },
    { "07b8", "420a", "asix" }, { "08dd", "90ff", "asix" },
    { "0557", "2009", "asix" }, { "0411", "003d", "asix" },
    { "0411", "006e", "asix" }, { "6189", "182d", "asix" },
    { "07aa", "0017", "asix" }, { "1189", "0893", "asix" },
    { "1631", "6200", "asix" }, { "04f1", "3008", "asix" },
    { "0b95", "7720", "asix" }, { "0b95", "1780", "asix" },
    { "13b1", "0018", "asix" }, { "1557", "7720", "asix" },
    { "07d1", "3c05", "asix" }, { "2001", "3c05", "asix" },
    { "1737", "0039", "asix" }, { "04bb", "0930", "asix" },
    { "050d", "5055", "asix" }, { "05ac", "1402", "asix" },
    { "0b95", "772a", "asix" }, { "14ea", "ab11", "asix" },
    { "0db0", "a877", "asix" },
    /* Linux v3.14 ax88179_178a.ko (AX88179/AX88178A). */
    { "0b95", "1790", "ax88179_178a" }, { "0b95", "178a", "ax88179_178a" },
    { "2001", "4a00", "ax88179_178a" }, { "0df6", "0072", "ax88179_178a" },
    { "04e8", "a100", "ax88179_178a" }, { "17ef", "304b", "ax88179_178a" },
};

static const char *driver_for_vid_pid(const char *vid, const char *pid) {
    size_t i;
    for (i = 0; i < sizeof(usbeth_ids) / sizeof(usbeth_ids[0]); i++) {
        if (strcmp(vid, usbeth_ids[i].vid) == 0 && strcmp(pid, usbeth_ids[i].pid) == 0)
            return usbeth_ids[i].driver;
    }
    return NULL;
}

/* Match CDC by the Communications interface class (02), subclass 06 (ECM)
 * or 0d (NCM), protocol 00. Check both device-level descriptors (rare for
 * Ethernet) and every interface node, including composite devices. */
static const char *cdc_driver_for_descriptors(const char *dir, const char *prefix) {
    char path[256], cls[16], sub[16], proto[16];
    const char *ncm = NULL;
    snprintf(path, sizeof(path), "%s/%s/bInterfaceClass", dir, prefix);
    if (read_first_line(path, cls, sizeof(cls)) != 0) {
        snprintf(path, sizeof(path), "%s/%s/bDeviceClass", dir, prefix);
        if (read_first_line(path, cls, sizeof(cls)) != 0) return NULL;
        snprintf(path, sizeof(path), "%s/%s/bDeviceSubClass", dir, prefix);
        if (read_first_line(path, sub, sizeof(sub)) != 0) return NULL;
        snprintf(path, sizeof(path), "%s/%s/bDeviceProtocol", dir, prefix);
        if (read_first_line(path, proto, sizeof(proto)) != 0) return NULL;
    } else {
        snprintf(path, sizeof(path), "%s/%s/bInterfaceSubClass", dir, prefix);
        if (read_first_line(path, sub, sizeof(sub)) != 0) return NULL;
        snprintf(path, sizeof(path), "%s/%s/bInterfaceProtocol", dir, prefix);
        if (read_first_line(path, proto, sizeof(proto)) != 0) return NULL;
    }
    if (strcmp(cls, "02") != 0 || strcmp(proto, "00") != 0) return NULL;
    if (strcmp(sub, "06") == 0) return "cdc_ether";
    if (strcmp(sub, "0d") == 0) ncm = "cdc_ncm";
    return ncm;
}

static const char *cdc_driver_for_device(const char *devname) {
    const char *driver;
    char prefix[96];
    DIR *d;
    struct dirent *de;

    driver = cdc_driver_for_descriptors("/sys/bus/usb/devices", devname);
    /* Device-level class 02 is unusual; otherwise inspect interface nodes. */
    if (driver) return driver;
    snprintf(prefix, sizeof(prefix), "%s:", devname);
    d = opendir("/sys/bus/usb/devices");
    if (!d) return NULL;
    while ((de = readdir(d)) != NULL) {
        if (strncmp(de->d_name, prefix, strlen(prefix)) != 0) continue;
        driver = cdc_driver_for_descriptors("/sys/bus/usb/devices", de->d_name);
        if (driver && strcmp(driver, "cdc_ether") == 0) {
            closedir(d);
            return driver; /* ECM is the preferred generic path. */
        }
        if (driver) {
            /* Keep looking: a composite device may expose both ECM and NCM. */
            closedir(d);
            return driver;
        }
    }
    closedir(d);
    return NULL;
}

static void find_usb_device(char *vid_pid, size_t vp_len, char *product, size_t prod_len,
                            char *driver_name, size_t driver_len) {
    char fallback_vp[32] = "", fallback_prod[64] = "";
    char class_vp[32] = "", class_prod[64] = "", class_driver[32] = "";
    DIR *d;
    struct dirent *de;

    vid_pid[0] = '\0';
    product[0] = '\0';
    driver_name[0] = '\0';
    d = opendir("/sys/bus/usb/devices");
    if (!d) return;

    while ((de = readdir(d)) != NULL) {
        char p_vid[160], p_pid[160], p_prod[160], p_class[160];
        char vid[32], pid[32], bclass[32], prod[64];
        const char *driver;
        if (de->d_name[0] == '.' || strchr(de->d_name, ':') != NULL) continue;
        snprintf(p_vid, sizeof(p_vid), "/sys/bus/usb/devices/%s/idVendor", de->d_name);
        snprintf(p_pid, sizeof(p_pid), "/sys/bus/usb/devices/%s/idProduct", de->d_name);
        if (read_first_line(p_vid, vid, sizeof(vid)) != 0 ||
            read_first_line(p_pid, pid, sizeof(pid)) != 0 || !vid[0] || !pid[0]) continue;
        if (strcmp(vid, "1d6b") == 0) continue; /* Linux root hub */
        snprintf(p_class, sizeof(p_class), "/sys/bus/usb/devices/%s/bDeviceClass", de->d_name);
        if (read_first_line(p_class, bclass, sizeof(bclass)) == 0 && strcmp(bclass, "09") == 0)
            continue; /* external USB hub */
        snprintf(p_prod, sizeof(p_prod), "/sys/bus/usb/devices/%s/product", de->d_name);
        if (read_first_line(p_prod, prod, sizeof(prod)) != 0) prod[0] = '\0';
        for (char *c = prod; *c; c++) {
            if (*c == '\n' || *c == '\r' || *c == '"') *c = ' ';
        }
        driver = driver_for_vid_pid(vid, pid);
        if (driver) {
            snprintf(vid_pid, vp_len, "%s:%s", vid, pid);
            snprintf(product, prod_len, "%s", prod);
            snprintf(driver_name, driver_len, "%s", driver);
            closedir(d);
            return;
        }
        driver = cdc_driver_for_device(de->d_name);
        if (driver && !class_vp[0]) {
            snprintf(class_vp, sizeof(class_vp), "%s:%s", vid, pid);
            snprintf(class_prod, sizeof(class_prod), "%s", prod);
            snprintf(class_driver, sizeof(class_driver), "%s", driver);
        }
        if (!fallback_vp[0]) {
            snprintf(fallback_vp, sizeof(fallback_vp), "%s:%s", vid, pid);
            snprintf(fallback_prod, sizeof(fallback_prod), "%s", prod);
        }
    }
    closedir(d);
    if (class_vp[0]) {
        snprintf(vid_pid, vp_len, "%s", class_vp);
        snprintf(product, prod_len, "%s", class_prod);
        snprintf(driver_name, driver_len, "%s", class_driver);
    } else if (fallback_vp[0]) {
        snprintf(vid_pid, vp_len, "%s", fallback_vp);
        snprintf(product, prod_len, "%s", fallback_prod);
    }
}

static int is_usb_net_iface(const char *name) {
    if (!name || !name[0] || name[0] == '.') return 0;
    if (strcmp(name, "lo") == 0 || strcmp(name, "ath0") == 0 ||
        strcmp(name, "wifi0") == 0 || strcmp(name, "eth0") == 0 ||
        strcmp(name, "eth1") == 0) {
        return 0;
    }
    char link_path[256], target[256];
    snprintf(link_path, sizeof(link_path), "/sys/class/net/%s/device", name);
    ssize_t n = readlink(link_path, target, sizeof(target) - 1);
    if (n > 0) {
        target[n] = '\0';
        if (strstr(target, "usb") != NULL || strstr(target, "ar7240-ehci") != NULL)
            return 1;
    }
    if (strncmp(name, "usb", 3) == 0 || strncmp(name, "eth", 3) == 0)
        return 1;
    return 0;
}

static void find_usb_net_iface(char *ifname, size_t if_len, int *carrier, char *ipv4, size_t ip_len) {
    ifname[0] = '\0';
    *carrier = 0;
    ipv4[0] = '\0';

    DIR *d = opendir("/sys/class/net");
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (!is_usb_net_iface(de->d_name)) continue;
        snprintf(ifname, if_len, "%s", de->d_name);
        break;
    }
    closedir(d);
    if (!ifname[0]) return;

    char cpath[256], cbuf[32];
    snprintf(cpath, sizeof(cpath), "/sys/class/net/%s/carrier", ifname);
    if (read_first_line(cpath, cbuf, sizeof(cbuf)) == 0 && cbuf[0] == '1') {
        *carrier = 1;
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock >= 0) {
        struct ifreq ifr;
        memset(&ifr, 0, sizeof(ifr));
        snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
        if (ioctl(sock, SIOCGIFADDR, &ifr) == 0) {
            struct sockaddr_in *sin = (struct sockaddr_in *)&ifr.ifr_addr;
            const char *s = inet_ntoa(sin->sin_addr);
            if (s) snprintf(ipv4, ip_len, "%s", s);
        }
        close(sock);
    }
}

static int read_conf_enabled(void) {
    FILE *fp = fopen("/data/codex/usb_eth.conf", "r");
    if (!fp) return 0;
    char line[128];
    int enabled = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, "ENABLED=1", 9) == 0 || strcmp(line, "1\n") == 0 || strcmp(line, "1") == 0) {
            enabled = 1;
            break;
        }
    }
    fclose(fp);
    return enabled;
}


/* ---- Wired-path routing (Linux rtnetlink; see docs/USB_ETHERNET.md) ---- */
#ifdef __linux__

struct nl_req {
    struct nlmsghdr hdr;
    char buf[512];
};

static int nl_send_recv(const struct nl_req *req, char *resp, size_t resp_len,
                        int dump_type) {
    int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
    if (fd < 0) return -errno;
    if (send(fd, req, req->hdr.nlmsg_len, 0) < 0) {
        int e = errno;
        close(fd);
        return -e;
    }
    int result = -EPROTO;
    for (;;) {
        ssize_t n = recv(fd, resp, resp_len, 0);
        if (n <= 0) { result = (n < 0) ? -errno : -EPROTO; break; }
        struct nlmsghdr *h = (struct nlmsghdr *)resp;
        int done = 0;
        for (; NLMSG_OK(h, (unsigned)n); h = NLMSG_NEXT(h, n)) {
            if (h->nlmsg_type == NLMSG_DONE) { result = 0; done = 1; break; }
            if (h->nlmsg_type == NLMSG_ERROR) {
                struct nlmsgerr *err = (struct nlmsgerr *)NLMSG_DATA(h);
                result = err->error; /* 0 = ACK success, else -errno */
                done = 1;
                break;
            }
            if (dump_type >= 0 && (int)h->nlmsg_type == dump_type) {
                result = 1; /* saw at least one dumped object */
                if (!(h->nlmsg_flags & NLM_F_MULTI)) { done = 1; }
                continue;
            }
            if (!(h->nlmsg_flags & NLM_F_MULTI)) { result = 0; done = 1; }
        }
        if (done) break;
    }
    close(fd);
    return result;
}

static void nl_addattr(struct nl_req *req, unsigned short type,
                       const void *data, unsigned short len) {
    struct rtattr *a = (struct rtattr *)((char *)req + NLMSG_ALIGN(req->hdr.nlmsg_len));
    a->rta_type = type;
    a->rta_len = RTA_LENGTH(len);
    if (len) memcpy(RTA_DATA(a), data, len);
    req->hdr.nlmsg_len = NLMSG_ALIGN(req->hdr.nlmsg_len) + RTA_LENGTH(len);
}

/* Probed, never assumed: kernels without CONFIG_FIB_RULES answer
 * EOPNOTSUPP here. This hub's kallsyms carries no fib_rules symbols, so
 * expect 0 there and 1 only where source rules really exist. */
static int rule_policy_supported(void) {
    struct nl_req req;
    char resp[4096];
    memset(&req, 0, sizeof(req));
    req.hdr.nlmsg_len = NLMSG_LENGTH(sizeof(struct fib_rule_hdr));
    req.hdr.nlmsg_type = RTM_GETRULE;
    req.hdr.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
    struct fib_rule_hdr *frh = (struct fib_rule_hdr *)NLMSG_DATA(&req.hdr);
    frh->family = AF_INET;
    int rc = nl_send_recv(&req, resp, sizeof(resp), RTM_NEWRULE);
    return rc > 0 ? 1 : 0;
}

static int iface_ipv4_prefix(const char *ifname, uint32_t *ip_ho, int *prefix) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
    if (ioctl(fd, SIOCGIFADDR, &ifr) != 0) { close(fd); return -1; }
    *ip_ho = ntohl(((struct sockaddr_in *)&ifr.ifr_addr)->sin_addr.s_addr);
    if (ioctl(fd, SIOCGIFNETMASK, &ifr) != 0) { close(fd); return -1; }
    uint32_t mask = ntohl(((struct sockaddr_in *)&ifr.ifr_netmask)->sin_addr.s_addr);
    int n = 0;
    while (mask & 0x80000000U) { n++; mask <<= 1; }
    *prefix = n;
    close(fd);
    return 0;
}

struct route_entry {
    uint32_t dst;
    int prefix;
    int oif;
    uint32_t metric;
    int scope;
};

/* Dump main-table routes into entries; returns the count. */
static int dump_routes(struct route_entry *entries, int max_entries) {
    struct nl_req req;
    char resp[8192];
    memset(&req, 0, sizeof(req));
    req.hdr.nlmsg_len = NLMSG_LENGTH(sizeof(struct rtmsg));
    req.hdr.nlmsg_type = RTM_GETROUTE;
    req.hdr.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
    struct rtmsg *rtm = (struct rtmsg *)NLMSG_DATA(&req.hdr);
    rtm->rtm_family = AF_INET;
    rtm->rtm_table = RT_TABLE_MAIN;
    int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
    if (fd < 0) return -1;
    if (send(fd, &req, req.hdr.nlmsg_len, 0) < 0) { close(fd); return -1; }
    int count = 0;
    int done = 0;
    while (!done) {
        ssize_t n = recv(fd, resp, sizeof(resp), 0);
        if (n <= 0) break;
        struct nlmsghdr *h = (struct nlmsghdr *)resp;
        for (; NLMSG_OK(h, (unsigned)n); h = NLMSG_NEXT(h, n)) {
            if (h->nlmsg_type == NLMSG_DONE) { done = 1; break; }
            if (h->nlmsg_type == NLMSG_ERROR) { done = 1; break; }
            if (h->nlmsg_type != RTM_NEWROUTE) continue;
            struct rtmsg *r = (struct rtmsg *)NLMSG_DATA(h);
            if (r->rtm_table != RT_TABLE_MAIN) continue;
            if (count >= max_entries) { done = 1; break; }
            struct route_entry *e = &entries[count];
            memset(e, 0, sizeof(*e));
            e->prefix = r->rtm_dst_len;
            e->scope = r->rtm_scope;
            e->oif = -1;
            struct rtattr *a = RTM_RTA(r);
            int alen = (int)RTM_PAYLOAD(h);
            for (; RTA_OK(a, alen); a = RTA_NEXT(a, alen)) {
                if (a->rta_type == RTA_DST) e->dst = ntohl(*(uint32_t *)RTA_DATA(a));
                else if (a->rta_type == RTA_OIF) e->oif = *(int *)RTA_DATA(a);
                else if (a->rta_type == RTA_PRIORITY) e->metric = *(uint32_t *)RTA_DATA(a);
            }
            count++;
        }
    }
    close(fd);
    return count;
}

/* Metric of the first main-table route to dst/prefix via oif, or -1. */
static int find_route_metric(uint32_t dst_ho, int prefix, int oif) {
    struct route_entry entries[32];
    int n = dump_routes(entries, 32);
    int i;
    for (i = 0; i < n; i++) {
        if (entries[i].prefix == prefix && entries[i].oif == oif &&
            entries[i].dst == (dst_ho & ipv4_mask(prefix)))
            return (int)entries[i].metric;
    }
    return -1;
}

/* create: 0 deletes; 1 adds, failing if a route with the same prefix and
 * metric exists (NLM_F_EXCL: on 2.6.31 that includes one on another
 * interface); 2 adds next to such a route, ahead of it, so it's the one
 * lookups pick. */
static int route_change(int create, unsigned char table, uint32_t dst_ho,
                        int prefix, int oif, int has_prefsrc, uint32_t src_ho,
                        int metric, int scope) {
    struct nl_req req;
    char resp[1024];
    memset(&req, 0, sizeof(req));
    req.hdr.nlmsg_len = NLMSG_LENGTH(sizeof(struct rtmsg));
    req.hdr.nlmsg_type = create ? RTM_NEWROUTE : RTM_DELROUTE;
    req.hdr.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK |
        (create == 2 ? NLM_F_CREATE : create ? (NLM_F_CREATE | NLM_F_EXCL) : 0);
    struct rtmsg *rtm = (struct rtmsg *)NLMSG_DATA(&req.hdr);
    rtm->rtm_family = AF_INET;
    rtm->rtm_dst_len = (unsigned char)prefix;
    rtm->rtm_table = table;
    /* Deletes must wildcard the protocol: the kernel's own connected
     * routes carry RTPROT_KERNEL, and fib delete matches protocol. */
    rtm->rtm_protocol = create ? RTPROT_STATIC : RTPROT_UNSPEC;
    rtm->rtm_scope = (unsigned char)scope;
    rtm->rtm_type = RTN_UNICAST;
    uint32_t be;
    if (prefix > 0) { be = htonl(dst_ho & ipv4_mask(prefix)); nl_addattr(&req, RTA_DST, &be, 4); }
    if (oif >= 0) nl_addattr(&req, RTA_OIF, &oif, 4);
    if (has_prefsrc) { be = htonl(src_ho); nl_addattr(&req, RTA_PREFSRC, &be, 4); }
    if (metric >= 0) { uint32_t m = (uint32_t)metric; nl_addattr(&req, RTA_PRIORITY, &m, 4); }
    return nl_send_recv(&req, resp, sizeof(resp), -1);
}

static int rule_change(int create, uint32_t src_ho) {
    struct nl_req req;
    char resp[1024];
    memset(&req, 0, sizeof(req));
    req.hdr.nlmsg_len = NLMSG_LENGTH(sizeof(struct fib_rule_hdr));
    req.hdr.nlmsg_type = create ? RTM_NEWRULE : RTM_DELRULE;
    req.hdr.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK |
        (create ? (NLM_F_CREATE | NLM_F_EXCL) : 0);
    struct fib_rule_hdr *frh = (struct fib_rule_hdr *)NLMSG_DATA(&req.hdr);
    frh->family = AF_INET;
    frh->src_len = 32;
    frh->table = USBETH_ROUTE_TABLE;
    frh->action = FR_ACT_TO_TBL;
    uint32_t be = htonl(src_ho);
    nl_addattr(&req, FRA_SRC, &be, 4);
    uint32_t prio = USBETH_RULE_PRIO;
    nl_addattr(&req, FRA_PRIORITY, &prio, 4);
    return nl_send_recv(&req, resp, sizeof(resp), -1);
}

static int cmd_net_apply(const char *wired, const char *wifi) {
    if (!wired || !wifi || strlen(wired) >= IFNAMSIZ || strlen(wifi) >= IFNAMSIZ) {
        fprintf(stderr, "usage: codex_usbeth net-apply <wired-if> <wifi-if>\n");
        return 2;
    }
    uint32_t wip, fip;
    int wprefix, fprefix;
    if (iface_ipv4_prefix(wired, &wip, &wprefix) != 0) {
        printf("route_mode=none reason=wired_no_ipv4\n");
        return 1;
    }
    printf("wired_ip=%u.%u.%u.%u wired_prefix=%d\n",
           (wip >> 24) & 255, (wip >> 16) & 255, (wip >> 8) & 255, wip & 255, wprefix);
    if (iface_ipv4_prefix(wifi, &fip, &fprefix) != 0 ||
        fprefix != wprefix || !ipv4_same_subnet(wip, fip, wprefix)) {
        /* Different subnets route by destination prefix already; there is
         * no shared-subnet ambiguity to fix. */
        printf("route_mode=none reason=wifi_not_same_subnet\n");
        return 0;
    }
    int wif = (int)if_nametoindex(wired);
    int fif = (int)if_nametoindex(wifi);
    if (wif <= 0 || fif <= 0) {
        printf("route_mode=none reason=ifindex_failed\n");
        return 1;
    }
    uint32_t subnet = wip & ipv4_mask(wprefix);
    int policy = rule_policy_supported();
    printf("policy_supported=%d\n", policy);
    if (policy) {
        int rc1 = route_change(1, USBETH_ROUTE_TABLE, subnet, wprefix, wif, 1, wip, -1, RT_SCOPE_LINK);
        int rc2 = rule_change(1, wip);
        if ((rc1 == 0 || rc1 == -EEXIST) && (rc2 == 0 || rc2 == -EEXIST)) {
            printf("route_mode=%s\n", route_mode_for_policy(1));
            return 0;
        }
        printf("route_mode=none reason=policy_apply_failed rc=%d,%d\n", rc1, rc2);
        return 1;
    }
    /* Metric fallback (this hub's kernel): the wired connected route is
     * already metric 0; demote only the Wi-Fi connected route for the same
     * subnet so destination lookups prefer the wire. Every Wi-Fi alias
     * for the subnet is deleted by its exact dumped scope (fib delete
     * matches scope on 2.6.31) and replaced by a single metric-20 alias.
     * Restored by net-remove; nothing else in the main table is touched. */
    struct route_entry entries[32];
    int n = dump_routes(entries, 32);
    int i, wm = -1, fm = -1, have_good_wifi = 0, have_wifi = 0;
    for (i = 0; i < n; i++) {
        if (entries[i].prefix != wprefix || entries[i].dst != subnet) continue;
        if (entries[i].oif == wif && wm < 0) wm = (int)entries[i].metric;
        if (entries[i].oif == fif) {
            have_wifi = 1;
            if (fm < 0) fm = (int)entries[i].metric;
            if ((int)entries[i].metric == USBETH_WIFI_METRIC &&
                entries[i].scope == RT_SCOPE_LINK)
                have_good_wifi = 1;
        }
    }
    if (wm < 0) {
        printf("route_mode=none reason=wired_route_missing\n");
        return 1;
    }
    if (!have_wifi) {
        printf("route_mode=none reason=wifi_route_missing\n");
        return 1;
    }
    if (have_good_wifi && fm == USBETH_WIFI_METRIC) {
        printf("route_mode=%s wifi_metric_old=%d (already applied)\n",
               route_mode_for_policy(0), USBETH_WIFI_METRIC);
        return 0;
    }
    for (i = 0; i < n; i++) {
        if (entries[i].prefix != wprefix || entries[i].dst != subnet ||
            entries[i].oif != fif)
            continue;
        if ((int)entries[i].metric == USBETH_WIFI_METRIC &&
            entries[i].scope == RT_SCOPE_LINK)
            continue; /* the alias we want to keep */
        int rd = route_change(0, RT_TABLE_MAIN, subnet, wprefix, fif, 0, 0,
                              (int)entries[i].metric, entries[i].scope);
        if (rd != 0 && rd != -ESRCH) {
            printf("route_mode=none reason=wifi_route_change_failed rc=%d\n", rd);
            return 1;
        }
    }
    if (!have_good_wifi) {
        int ra = route_change(1, RT_TABLE_MAIN, subnet, wprefix, fif, 0, 0,
                              USBETH_WIFI_METRIC, RT_SCOPE_LINK);
        if (ra != 0 && ra != -EEXIST) {
            printf("route_mode=none reason=wifi_route_change_failed rc=%d\n", ra);
            return 1;
        }
    }
    /* The demotion counts only if no preferred Wi-Fi alias survives. */
    if (find_route_metric(subnet, wprefix, fif) != USBETH_WIFI_METRIC) {
        printf("route_mode=none reason=wifi_route_still_preferred\n");
        return 1;
    }
    printf("route_mode=%s wifi_metric_old=%d\n", route_mode_for_policy(0), fm);
    return 0;
}

static int cmd_net_remove(const char *wired, const char *wifi) {
    if (!wired || !wifi || strlen(wired) >= IFNAMSIZ || strlen(wifi) >= IFNAMSIZ) {
        fprintf(stderr, "usage: codex_usbeth net-remove <wired-if> <wifi-if>\n");
        return 2;
    }
    uint32_t wip, fip;
    int wprefix, fprefix;
    /* Table/rule cleanup needs only the wired address; a missing address
     * (interface already down) still allows the Wi-Fi metric restore.
     * Only where policy routing exists, the only case net-apply adds them:
     * a kernel without CONFIG_IP_MULTIPLE_TABLES (this hub's) maps every
     * table id to main, so the table delete would match the wired
     * interface's own connected route (same subnet, oif and prefsrc, any
     * metric) and remove it. */
    if (rule_policy_supported() && iface_ipv4_prefix(wired, &wip, &wprefix) == 0) {
        rule_change(0, wip);
        int wif = (int)if_nametoindex(wired);
        if (wif > 0)
            route_change(0, USBETH_ROUTE_TABLE, wip & ipv4_mask(wprefix),
                         wprefix, wif, 1, wip, -1, RT_SCOPE_LINK);
    }
    if (iface_ipv4_prefix(wifi, &fip, &fprefix) == 0) {
        int fif = (int)if_nametoindex(wifi);
        if (fif > 0) {
            uint32_t subnet = fip & ipv4_mask(fprefix);
            /* Delete every demoted Wi-Fi alias by exact scope; re-add the
             * plain metric-0 connected route only if none is present. */
            struct route_entry entries[32];
            int n = dump_routes(entries, 32);
            int i, have_zero = 0;
            for (i = 0; i < n; i++) {
                if (entries[i].prefix == fprefix && entries[i].dst == subnet &&
                    entries[i].oif == fif && entries[i].metric == 0)
                    have_zero = 1;
            }
            for (i = 0; i < n; i++) {
                if (entries[i].prefix != fprefix || entries[i].dst != subnet ||
                    entries[i].oif != fif ||
                    (int)entries[i].metric != USBETH_WIFI_METRIC)
                    continue;
                route_change(0, RT_TABLE_MAIN, subnet, fprefix, fif, 0, 0,
                             USBETH_WIFI_METRIC, entries[i].scope);
            }
            /* The wired interface's own metric-0 route for the same subnet
             * is still there: add Wi-Fi's beside it, ahead of it, so local
             * traffic goes back to Wi-Fi (an exclusive add would fail). */
            if (!have_zero)
                route_change(2, RT_TABLE_MAIN, subnet, fprefix, fif, 0, 0, 0,
                             RT_SCOPE_LINK);
        }
    }
    printf("net_removed=1\n");
    return 0;
}

#else /* !__linux__ */
static int cmd_net_apply(const char *wired, const char *wifi) {
    (void)wired; (void)wifi;
    printf("route_mode=none reason=unsupported_platform\n");
    return 4;
}
static int cmd_net_remove(const char *wired, const char *wifi) {
    (void)wired; (void)wifi;
    printf("net_removed=1\n");
    return 0;
}
#endif

static int cmd_status(void) {
    char rel[64];
    int k_ok = check_kernel_release(rel, sizeof(rel));
    int enabled = read_conf_enabled();
    int gadget = are_gadget_modules_loaded();
    int bound = is_ehci_bound();
    char vid_pid[32], product[64], driver[32], ifname[32], ipv4[32];
    int carrier = 0;
    int driver_loaded;

    find_usb_device(vid_pid, sizeof(vid_pid), product, sizeof(product),
                    driver, sizeof(driver));
    find_usb_net_iface(ifname, sizeof(ifname), &carrier, ipv4, sizeof(ipv4));

    /* driver_loaded tracks the detected adapter's driver when one is known;
     * otherwise it reports whether any supported USB-Ethernet driver is up. */
    if (driver[0]) {
        driver_loaded = is_module_loaded(driver);
    } else {
        driver_loaded = is_module_loaded("r8152") || is_module_loaded("asix") ||
                        is_module_loaded("cdc_ether") || is_module_loaded("cdc_ncm") ||
                        is_module_loaded("ax88179_178a");
    }

    struct usbeth_probe probe;
    probe.platform_registered = is_platform_registered();
    probe.ehci_bound = bound;
    probe.usbcore_loaded = is_module_loaded("usbcore");
    probe.usb_device_present = vid_pid[0] ? 1 : 0;
    probe.usb_driver_known = driver[0] ? 1 : 0;
    probe.iface_present = ifname[0] ? 1 : 0;
    probe.carrier = carrier;
    probe.has_ipv4 = ipv4[0] ? 1 : 0;

    printf("kernel=%s\n", rel[0] ? rel : "unknown");
    printf("kernel_compatible=%d\n", k_ok);
    printf("enabled=%d\n", enabled);
    printf("gadget_loaded=%d\n", gadget);
    printf("ehci_bound=%d\n", bound);
    printf("platform_registered=%d\n", probe.platform_registered);
    printf("usbcore_loaded=%d\n", probe.usbcore_loaded);
    printf("ehci_loaded=%d\n", is_module_loaded("ehci_hcd"));
    printf("state=%s\n", usbeth_state_name(&probe));
    printf("driver_loaded=%d\n", driver_loaded);
    printf("usb_device=%s\n", vid_pid);
    printf("usb_driver=%s\n", driver);
    printf("usb_product=%s\n", product);
    printf("ifname=%s\n", ifname);
    printf("carrier=%d\n", carrier);
    printf("ipv4=%s\n", ipv4);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "usage: codex_usbeth <phy-host | register-ehci [--check] | eth-fix <ifname> | net-apply <wired-if> <wifi-if> | net-remove <wired-if> <wifi-if> | status>\n");
        return 2;
    }
    if (strcmp(argv[1], "phy-host") == 0) {
        return cmd_phy_host();
    }
    if (strcmp(argv[1], "register-ehci") == 0) {
        int check_only = (argc >= 3 && strcmp(argv[2], "--check") == 0);
        return cmd_register_ehci(check_only);
    }
    if (strcmp(argv[1], "eth-fix") == 0) {
        return cmd_eth_fix(argc >= 3 ? argv[2] : NULL);
    }
    if (strcmp(argv[1], "net-apply") == 0) {
        return cmd_net_apply(argc >= 3 ? argv[2] : NULL, argc >= 4 ? argv[3] : NULL);
    }
    if (strcmp(argv[1], "net-remove") == 0) {
        return cmd_net_remove(argc >= 3 ? argv[2] : NULL, argc >= 4 ? argv[3] : NULL);
    }
    if (strcmp(argv[1], "status") == 0) {
        return cmd_status();
    }
    fprintf(stderr, "codex_usbeth: unknown subcommand '%s'\n", argv[1]);
    return 2;
}
