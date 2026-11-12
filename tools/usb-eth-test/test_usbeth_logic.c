/* Host unit tests for codex_usbeth's pure logic. The helper's hub-only
 * paths (/dev/mem, netlink, sysfs) are not exercised here; what is proven
 * is the decision logic the service relies on: PHY read validation, the
 * controller/adapter state classifier, IPv4 helpers, and route-mode
 * selection. Run via tools/usb-eth-test/run_tests.sh. */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define main codex_usbeth_real_main
#include "../../payload/source/codex_usbeth.c"
#undef main

static int failures = 0;
#define CHECK(cond) do { \
    if (!(cond)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } \
} while (0)

static struct usbeth_probe probe(int reg, int bound, int core, const char *dev,
                                 const char *drv, const char *iface, int carrier,
                                 const char *ip) {
    struct usbeth_probe p;
    p.platform_registered = reg;
    p.ehci_bound = bound;
    p.usbcore_loaded = core;
    p.usb_device_present = dev && dev[0];
    p.usb_driver_known = drv && drv[0];
    p.iface_present = iface && iface[0];
    p.carrier = carrier;
    p.has_ipv4 = ip && ip[0];
    return p;
}

int main(void) {
    /* Fix 2: sentinel PHY reads are rejected before any write; the one
     * observed healthy value (0x84000085) is accepted but not required,
     * and unrelated bits are preserved exactly. */
    CHECK(phy_value_is_sentinel(0xdeadbeefU));
    CHECK(phy_value_is_sentinel(0xffffffffU));
    CHECK(!phy_value_is_sentinel(0x84000085U));
    CHECK(!phy_value_is_sentinel(0x00000000U));
    CHECK(!phy_value_is_sentinel(0x12345678U));
    CHECK(phy_host_value(0x84000084U) == 0x84000085U);
    CHECK(phy_readback_ok(0x84000084U, 0x84000085U));
    CHECK(phy_readback_ok(0x84000085U, 0x84000085U));
    CHECK(!phy_readback_ok(0x84000084U, 0x84000084U)); /* host bit lost */
    CHECK(!phy_readback_ok(0x84000084U, 0xdeadbeefU)); /* garbage readback */
    CHECK(!phy_readback_ok(0x00000000U, 0xfffffffeU)); /* unrelated bits flipped */

    /* Fix 1: every state the task names is distinct, and registration is
     * never conflated with binding. */
    struct usbeth_probe p;
    p = probe(0, 0, 0, "", "", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "deps_unavailable") == 0);
    p = probe(0, 0, 1, "", "", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "platform_absent") == 0);
    p = probe(1, 0, 1, "", "", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "platform_unbound") == 0);
    p = probe(1, 1, 1, "", "", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "bus_ready") == 0);
    p = probe(1, 1, 1, "0bda:8153", "", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "adapter_unsupported") == 0);
    p = probe(1, 1, 1, "0bda:8153", "r8152", "", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "nic_not_bound") == 0);
    p = probe(1, 1, 1, "0bda:8153", "r8152", "eth2", 0, "");
    CHECK(strcmp(usbeth_state_name(&p), "awaiting_carrier_dhcp") == 0);
    p = probe(1, 1, 1, "0bda:8153", "r8152", "eth2", 1, "");
    CHECK(strcmp(usbeth_state_name(&p), "awaiting_carrier_dhcp") == 0);
    p = probe(1, 1, 1, "0bda:8153", "r8152", "eth2", 1, "192.168.0.234");
    CHECK(strcmp(usbeth_state_name(&p), "operational") == 0);

    /* Driver map: the AX88772B/C (e.g. TRENDnet TU2-ET100 v3) uses asix.ko. */
    CHECK(driver_for_vid_pid("0b95", "772b") != NULL && strcmp(driver_for_vid_pid("0b95", "772b"), "asix") == 0);
    CHECK(strcmp(driver_for_vid_pid("0b95", "772a"), "asix") == 0);
    CHECK(driver_for_vid_pid("0b95", "772c") == NULL);

    /* IPv4 helpers behind net-apply. */
    uint32_t ip;
    CHECK(parse_ipv4("192.168.0.234", &ip) == 0 && ip == 0xc0a800eaU);
    CHECK(parse_ipv4("192.168.0.256", &ip) != 0);
    CHECK(parse_ipv4("192.168.0", &ip) != 0);
    CHECK(parse_ipv4("192.168.0.1x", &ip) != 0);
    CHECK(parse_ipv4("", &ip) != 0);
    CHECK(ipv4_mask(24) == 0xffffff00U);
    CHECK(ipv4_mask(0) == 0U);
    CHECK(ipv4_mask(32) == 0xffffffffU);
    uint32_t a = 0, b = 0;
    CHECK(parse_ipv4("192.168.0.123", &a) == 0 && parse_ipv4("192.168.0.234", &b) == 0);
    CHECK(ipv4_same_subnet(a, b, 24));
    CHECK(parse_ipv4("192.168.1.123", &b) == 0);
    CHECK(!ipv4_same_subnet(a, b, 24));
    CHECK(ipv4_same_subnet(a, b, 16));

    /* Fix 3: the route mechanism is probed at runtime, never assumed. */
    CHECK(strcmp(route_mode_for_policy(1), "policy") == 0);
    CHECK(strcmp(route_mode_for_policy(0), "metric") == 0);

    if (failures) {
        printf("usbeth logic: %d failure(s)\n", failures);
        return 1;
    }
    printf("usbeth logic: all checks passed\n");
    return 0;
}
