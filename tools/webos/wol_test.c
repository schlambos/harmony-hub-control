/* Unit tests for codex_webos: Wake-on-LAN interface binding, MAC validation,
 * pointer socketPath SSRF guard, and discrete PowerOn honesty.
 *
 * Includes payload/source/codex_webos.c with network syscalls replaced by fakes,
 * so zero packets ever hit the real network.
 *
 * Run via: sh tools/webos/wol_test.sh
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

struct fake_if {
	const char *name;
	int family;
	const char *addr;
	const char *brd;
	unsigned flags;
};

#define MAX_FAKE_IFS 8
#define MAX_SENT 64

static struct fake_if fake_ifs[MAX_FAKE_IFS];
static int fake_nifs;
static int fail_global_broadcast;

struct sent_pkt {
	char dev[IFNAMSIZ];
	int broadcast;
	char dst[INET_ADDRSTRLEN];
	int port;
	size_t len;
	unsigned char data[128];
	int ok;
};
static struct sent_pkt sent[MAX_SENT];
static int nsent;

struct fake_sock {
	int open;
	int broadcast;
	char dev[IFNAMSIZ];
};
static struct fake_sock socks[32];
#define FAKE_FD_BASE 500

static int fake_socket(int dom, int type, int proto) {
	(void)dom; (void)type; (void)proto;
	for (int i = 0; i < 32; i++) {
		if (!socks[i].open) {
			memset(&socks[i], 0, sizeof socks[i]);
			socks[i].open = 1;
			return FAKE_FD_BASE + i;
		}
	}
	errno = EMFILE;
	return -1;
}

static int fake_close(int fd) {
	if (fd >= FAKE_FD_BASE && fd < FAKE_FD_BASE + 32) {
		socks[fd - FAKE_FD_BASE].open = 0;
		return 0;
	}
	return close(fd);
}

static int fake_setsockopt(int fd, int level, int opt, const void *val, socklen_t len) {
	if (fd < FAKE_FD_BASE || fd >= FAKE_FD_BASE + 32) return 0;
	struct fake_sock *s = &socks[fd - FAKE_FD_BASE];
	if (level == SOL_SOCKET && opt == SO_BROADCAST && len >= (socklen_t)sizeof(int)) {
		s->broadcast = *(const int *)val;
	}
#ifdef SO_BINDTODEVICE
	if (level == SOL_SOCKET && opt == SO_BINDTODEVICE && val && len > 0) {
		snprintf(s->dev, sizeof s->dev, "%.*s", (int)len, (const char *)val);
	}
#endif
	return 0;
}

static ssize_t fake_sendto(int fd, const void *buf, size_t len, int flags,
                           const struct sockaddr *addr, socklen_t alen) {
	(void)flags; (void)alen;
	if (fd < FAKE_FD_BASE || fd >= FAKE_FD_BASE + 32) { errno = EBADF; return -1; }
	struct fake_sock *s = &socks[fd - FAKE_FD_BASE];
	const struct sockaddr_in *sa = (const struct sockaddr_in *)addr;
	char dst[INET_ADDRSTRLEN] = "";
	inet_ntop(AF_INET, &sa->sin_addr, dst, sizeof dst);
	int fail = fail_global_broadcast && !strcmp(dst, "255.255.255.255");
	if (nsent < MAX_SENT) {
		struct sent_pkt *p = &sent[nsent++];
		memset(p, 0, sizeof *p);
		snprintf(p->dev, sizeof p->dev, "%s", s->dev);
		p->broadcast = s->broadcast;
		snprintf(p->dst, sizeof p->dst, "%s", dst);
		p->port = ntohs(sa->sin_port);
		p->len = len;
		if (len <= sizeof p->data) memcpy(p->data, buf, len);
		p->ok = !fail;
	}
	if (fail) { errno = ENETUNREACH; return -1; }
	return (ssize_t)len;
}

static int fake_getifaddrs(struct ifaddrs **out) {
	struct ifaddrs *head = NULL, **tail = &head;
	for (int i = 0; i < fake_nifs; i++) {
		struct ifaddrs *a = calloc(1, sizeof *a);
		a->ifa_name = strdup(fake_ifs[i].name);
		a->ifa_flags = fake_ifs[i].flags;
		if (fake_ifs[i].addr) {
			struct sockaddr_in *sa = calloc(1, sizeof *sa);
			sa->sin_family = (sa_family_t)fake_ifs[i].family;
			inet_pton(AF_INET, fake_ifs[i].addr, &sa->sin_addr);
			a->ifa_addr = (struct sockaddr *)sa;
		}
		if (fake_ifs[i].brd) {
			struct sockaddr_in *ba = calloc(1, sizeof *ba);
			ba->sin_family = (sa_family_t)fake_ifs[i].family;
			inet_pton(AF_INET, fake_ifs[i].brd, &ba->sin_addr);
			a->ifa_broadaddr = (struct sockaddr *)ba;
		}
		*tail = a;
		tail = &a->ifa_next;
	}
	*out = head;
	return 0;
}

static void fake_freeifaddrs(struct ifaddrs *a) {
	while (a) {
		struct ifaddrs *n = a->ifa_next;
		free(a->ifa_name);
		free(a->ifa_addr);
		free(a->ifa_broadaddr);
		free(a);
		a = n;
	}
}

#define socket fake_socket
#define close fake_close
#define setsockopt fake_setsockopt
#define sendto fake_sendto
#define getifaddrs fake_getifaddrs
#define freeifaddrs fake_freeifaddrs
#define main webos_daemon_main
#include "../../payload/source/codex_webos.c"
#undef main
#undef socket
#undef close
#undef setsockopt
#undef sendto
#undef getifaddrs
#undef freeifaddrs

static int fails;
#define CHECK(cond, msg) do { \
	if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); fails++; } \
	else { printf("ok: %s\n", msg); } \
} while (0)

static int is_magic_packet(const unsigned char *buf, size_t len, const unsigned char mac[6]) {
	if (len != 102) return 0;
	for (int i = 0; i < 6; i++) if (buf[i] != 0xff) return 0;
	for (int i = 0; i < 16; i++)
		if (memcmp(buf + 6 + i * 6, mac, 6) != 0) return 0;
	return 1;
}

int main(void) {
	logf = fopen("/dev/null", "w");

	/* 1. MAC normalization & validation */
	char norm[18];
	CHECK(normalize_mac("aa:bb:cc:11:22:33", norm) == 0 && !strcmp(norm, "AA:BB:CC:11:22:33"), "colon MAC");
	CHECK(normalize_mac("aa-bb-cc-11-22-33", norm) == 0 && !strcmp(norm, "AA:BB:CC:11:22:33"), "dash MAC");
	CHECK(normalize_mac("aabbcc112233", norm) == 0 && !strcmp(norm, "AA:BB:CC:11:22:33"), "bare hex MAC");
	CHECK(normalize_mac("", norm) == 0 && norm[0] == 0, "empty MAC allowed (optional)");
	CHECK(normalize_mac("00:00:00:00:00:00", norm) < 0, "all-zero MAC rejected");
	CHECK(normalize_mac("FF:FF:FF:FF:FF:FF", norm) < 0, "broadcast MAC rejected");
	CHECK(normalize_mac("AA:BB-CC:11:22:33", norm) < 0, "mixed separators rejected");
	CHECK(normalize_mac("GG:BB:CC:11:22:33", norm) < 0, "non-hex MAC rejected");

	/* 2. Pointer socketPath SSRF guard */
	int use_tls = 0, port = 0;
	char path[128];
	CHECK(parse_pointer_url("wss://192.168.1.40:3001/resources/abc/netinput.pointer.sock",
	                        "192.168.1.40", &use_tls, &port, path, sizeof path) == 0 &&
	      use_tls == 1 && port == 3001 && !strcmp(path, "/resources/abc/netinput.pointer.sock"),
	      "valid wss pointer URL");
	CHECK(parse_pointer_url("ws://192.168.1.40:3000/resources/abc/netinput.pointer.sock",
	                        "192.168.1.40", &use_tls, &port, path, sizeof path) == 0 &&
	      use_tls == 0 && port == 3000,
	      "valid ws pointer URL");
	CHECK(parse_pointer_url("wss://127.0.0.1:3001/resources/abc/netinput.pointer.sock",
	                        "192.168.1.40", &use_tls, &port, path, sizeof path) < 0,
	      "rejects SSRF pointer URL to 127.0.0.1");
	CHECK(parse_pointer_url("ws://192.168.1.99:3000/resources/abc/netinput.pointer.sock",
	                        "192.168.1.40", &use_tls, &port, path, sizeof path) < 0,
	      "rejects pointer URL to different LAN IP");
	CHECK(parse_pointer_url("http://192.168.1.40:3000/foo",
	                        "192.168.1.40", &use_tls, &port, path, sizeof path) < 0,
	      "rejects non-WebSocket scheme");

	/* 3. Wake-on-LAN subnet broadcast with cloud blocker (ENETUNREACH on 255.255.255.255) */
	fake_nifs = 3;
	fake_ifs[0] = (struct fake_if){ "lo", AF_INET, "127.0.0.1", "127.255.255.255", IFF_UP | IFF_RUNNING | IFF_LOOPBACK };
	fake_ifs[1] = (struct fake_if){ "eth0", AF_INET, "192.168.1.10", "192.168.1.255", IFF_UP | IFF_RUNNING | IFF_BROADCAST };
	fake_ifs[2] = (struct fake_if){ "wlan0", AF_INET, "192.168.1.11", "192.168.1.255", IFF_UP | IFF_BROADCAST }; /* not running */
	fail_global_broadcast = 1;
	nsent = 0;

	int ok = send_wol("AA:BB:CC:11:22:33");
	CHECK(ok == 1, "send_wol succeeds via subnet broadcast when default route is absent");
	const unsigned char want_mac[6] = { 0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33 };
	int subnet_ok = 0, loopback_seen = 0, down_seen = 0;
	for (int i = 0; i < nsent; i++) {
		if (!strcmp(sent[i].dst, "192.168.1.255") && sent[i].ok) {
			CHECK(sent[i].broadcast == 1, "SO_BROADCAST set on subnet packet");
			CHECK(is_magic_packet(sent[i].data, sent[i].len, want_mac), "valid 102-byte magic packet");
			subnet_ok++;
		}
		if (!strcmp(sent[i].dst, "127.255.255.255")) loopback_seen = 1;
		if (!strcmp(sent[i].dev, "wlan0")) down_seen = 1;
	}
	CHECK(subnet_ok == 4, "sent 4 subnet broadcast packets (ports 7 & 9 x2)");
	CHECK(!loopback_seen, "skipped loopback interface");
	CHECK(!down_seen, "skipped non-running wlan0 interface");

	/* 4. Discrete PowerOn honesty: refuses without MAC, sends WoL with MAC */
	struct tv t;
	memset(&t, 0, sizeof t);
	t.used = 1;
	snprintf(t.id, sizeof t.id, "webos12345678");
	snprintf(t.name, sizeof t.name, "Living Room LG");
	char err[160] = "";
	nsent = 0;
	CHECK(tv_execute_cmd(&t, "PowerOn", err, sizeof err) < 0 && strstr(err, "MAC") != NULL,
	      "PowerOn refused cleanly when MAC is missing");
	CHECK(nsent == 0, "no WoL packet sent when MAC is missing");

	snprintf(t.mac, sizeof t.mac, "AA:BB:CC:11:22:33");
	err[0] = 0;
	CHECK(tv_execute_cmd(&t, "PowerOn", err, sizeof err) == 0, "PowerOn succeeds via WoL when MAC is configured");
	CHECK(nsent > 0, "WoL packet transmitted for configured TV MAC");

	if (fails) {
		fprintf(stderr, "webos wol_test: %d failure(s)\n", fails);
		return 1;
	}
	printf("webos wol_test: ALL CHECKS PASSED\n");
	return 0;
}
