/*
 * codex_usbeth — USB host-mode and USB-Ethernet helper for Harmony Hub
 * (Linux 2.6.31-g89d565c, AR9344 MIPS32 big-endian).
 *
 * Subcommands:
 *   codex_usbeth phy-host
 *     Set bit 0 of the AR9344 usbctrlr1 register (phys 0x18116c84) so the
 *     EHCI controller reset sequence runs the Atheros USB PHY host reset.
 *
 *   codex_usbeth register-ehci [--check]
 *     Bind the stock kernel's dormant ar7240-ehci platform device (struct at
 *     0x8023b808) by transiently pointing sys_call_table[__NR_sethostname]
 *     (phys 0x0000c990, stock value 0x8002fb4c) at platform_device_register
 *     (0x801267cc), invoking syscall(__NR_sethostname, 0x8023b808, 0), and
 *     immediately restoring 0x8002fb4c. Verifies the kernel release and slot
 *     value before and after; fails closed on any mismatch. With --check,
 *     reports bound/slot state without writing to /dev/mem.
 *
 *   codex_usbeth eth-fix <ifname>
 *     Disable TX and RX hardware checksum offload on <ifname> via SIOCETHTOOL
 *     (ETHTOOL_STXCSUM / ETHTOOL_SRXCSUM = 0).
 *
 *   codex_usbeth status
 *     Emit key=value lines describing kernel compatibility, gadget module
 *     state, EHCI platform-driver binding, attached USB device VID:PID,
 *     USB-backed network interface name, link carrier, and IPv4 address.
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
    uint32_t after = before | USBCTRLR1_HOST_BIT;
    *reg = after;
    uint32_t readback = *reg;
    munmap(map, (size_t)page_sz);
    close(fd);

    printf("usbctrlr1 before=0x%08x after=0x%08x\n", before, readback);
    return (readback & USBCTRLR1_HOST_BIT) ? 0 : 1;
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
    printf("register_ehci call_rc=%ld errno=%d restored=0x%08x ehci_bound=%d\n",
           call_rc, (call_rc < 0) ? call_err : 0, restored, now_bound);
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

static void find_usb_device(char *vid_pid, size_t vp_len, char *product, size_t prod_len) {
    vid_pid[0] = '\0';
    product[0] = '\0';
    DIR *d = opendir("/sys/bus/usb/devices");
    if (!d) return;

    char fallback_vp[32] = "";
    char fallback_prod[64] = "";
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        if (strchr(de->d_name, ':') != NULL) continue; /* interface node */
        char p_vid[160], p_pid[160], p_prod[160], p_class[160];
        char vid[32], pid[32], bclass[32];
        snprintf(p_vid, sizeof(p_vid), "/sys/bus/usb/devices/%s/idVendor", de->d_name);
        snprintf(p_pid, sizeof(p_pid), "/sys/bus/usb/devices/%s/idProduct", de->d_name);
        if (read_first_line(p_vid, vid, sizeof(vid)) != 0 ||
            read_first_line(p_pid, pid, sizeof(pid)) != 0 ||
            !vid[0] || !pid[0]) {
            continue;
        }
        /* Skip Linux root hub (1d6b:*) and USB hub class devices (bDeviceClass 09). */
        if (strcmp(vid, "1d6b") == 0) continue;
        snprintf(p_class, sizeof(p_class), "/sys/bus/usb/devices/%s/bDeviceClass", de->d_name);
        if (read_first_line(p_class, bclass, sizeof(bclass)) == 0 && strcmp(bclass, "09") == 0) {
            continue;
        }
        char prod[64];
        snprintf(p_prod, sizeof(p_prod), "/sys/bus/usb/devices/%s/product", de->d_name);
        if (read_first_line(p_prod, prod, sizeof(prod)) != 0) prod[0] = '\0';
        for (char *c = prod; *c; c++) {
            if (*c == '\n' || *c == '\r' || *c == '"') *c = ' ';
        }
        /* Prefer known supported Ethernet VID:PIDs if multiple USB devices exist on a hub. */
        if ((strcmp(vid, "0bda") == 0 && (strcmp(pid, "8152") == 0 || strcmp(pid, "8153") == 0)) ||
            (strcmp(vid, "04e8") == 0 && strcmp(pid, "a101") == 0)) {
            snprintf(vid_pid, vp_len, "%s:%s", vid, pid);
            snprintf(product, prod_len, "%s", prod);
            closedir(d);
            return;
        }
        if (!fallback_vp[0]) {
            snprintf(fallback_vp, sizeof(fallback_vp), "%s:%s", vid, pid);
            snprintf(fallback_prod, sizeof(fallback_prod), "%s", prod);
        }
    }
    closedir(d);
    if (fallback_vp[0]) {
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

static int cmd_status(void) {
    char rel[64];
    int k_ok = check_kernel_release(rel, sizeof(rel));
    int enabled = read_conf_enabled();
    int gadget = are_gadget_modules_loaded();
    int bound = is_ehci_bound();
    int r8152_loaded = is_module_loaded("r8152");
    char vid_pid[32], product[64], ifname[32], ipv4[32];
    int carrier = 0;

    find_usb_device(vid_pid, sizeof(vid_pid), product, sizeof(product));
    find_usb_net_iface(ifname, sizeof(ifname), &carrier, ipv4, sizeof(ipv4));

    printf("kernel=%s\n", rel[0] ? rel : "unknown");
    printf("kernel_compatible=%d\n", k_ok);
    printf("enabled=%d\n", enabled);
    printf("gadget_loaded=%d\n", gadget);
    printf("ehci_bound=%d\n", bound);
    printf("driver_loaded=%d\n", r8152_loaded);
    printf("usb_device=%s\n", vid_pid);
    printf("usb_product=%s\n", product);
    printf("ifname=%s\n", ifname);
    printf("carrier=%d\n", carrier);
    printf("ipv4=%s\n", ipv4);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "usage: codex_usbeth <phy-host | register-ehci [--check] | eth-fix <ifname> | status>\n");
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
    if (strcmp(argv[1], "status") == 0) {
        return cmd_status();
    }
    fprintf(stderr, "codex_usbeth: unknown subcommand '%s'\n", argv[1]);
    return 2;
}
