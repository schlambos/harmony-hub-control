/* Wake-on-LAN tests for codex_androidtv, with nothing sent on the network.
 *
 * This file includes payload/source/codex_androidtv.c whole, with socket(),
 * setsockopt(), sendto(), getifaddrs() and freeifaddrs() swapped for fakes. The
 * fakes hand send_wol() made-up interfaces and record every packet it tries to
 * send, so the tests can check where the magic packet goes: each interface's own
 * subnet broadcast (e.g. 192.168.1.255) as well as 255.255.255.255, and the
 * subnet one still when 255.255.255.255 has no route (the cloud blocker's egress
 * guard deletes the default route). Each subnet broadcast must go bound to its
 * own, running interface: with wired Ethernet and Wi-Fi switched off, both share
 * one broadcast address and an unbound send could leave by the dead radio. The last tests drive POST /cmd through
 * http_handle() to check when PowerOn sends Wake-on-LAN at all.
 *
 * Build and run with tools/androidtv/wol_test.sh (it needs BearSSL 0.6, as the
 * codex_androidtv build does; see docs/BUILD.md).
 *
 * MIT License, Copyright (c) 2026 Josh Lukens.
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
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------ fakes */

struct fake_if {
	const char *name;
	int family;          /* AF_INET or AF_INET6 */
	const char *addr;    /* NULL: no address at all (ifa_addr NULL) */
	const char *brd;     /* broadcast (or, without IFF_BROADCAST, the peer); NULL: none */
	unsigned flags;
};

#define MAX_FAKE_IFS 12
#define MAX_SENT 64

static struct fake_if fake_ifs[MAX_FAKE_IFS];
static int fake_nifs;
static int fake_getifaddrs_errno;   /* nonzero: getifaddrs() fails with it */
static int fake_socket_errno;       /* nonzero: socket() fails with it */
static int ifaddrs_lists_live;      /* lists handed out and not yet freed */
static int sockets_opened;

static struct {
	const char *dst;                /* "*": every destination */
	int err;
} fake_send_fail[4];
static int fake_nsend_fail;

struct sent {
	int fd;
	char dev[IFNAMSIZ];             /* the interface the socket was bound to ("": none) */
	int broadcast;                  /* SO_BROADCAST was on */
	char dst[INET_ADDRSTRLEN];
	int port;
	size_t len;
	unsigned char data[128];
	int ok;
};
static struct sent sent[MAX_SENT];
static int nsent;
#define MAX_FD 1024
static int fd_broadcast[MAX_FD];    /* per socket: SO_BROADCAST on */
static char fd_dev[MAX_FD][IFNAMSIZ]; /* per socket: SO_BINDTODEVICE */
static int fake_bind_errno;         /* nonzero: SO_BINDTODEVICE fails with it (not root) */

struct fake_node {                  /* one allocation per entry; ifa first so it frees as one */
	struct ifaddrs ifa;
	struct sockaddr_storage addr, brd;
	char name[IFNAMSIZ];
};

static void fill_sockaddr(struct sockaddr_storage *ss, int family, const char *text) {
	memset(ss, 0, sizeof *ss);
	if (family == AF_INET6) {
		struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)ss;
		s6->sin6_family = AF_INET6;
		if (inet_pton(AF_INET6, text, &s6->sin6_addr) != 1) { fprintf(stderr, "bad test address %s\n", text); exit(2); }
	} else {
		struct sockaddr_in *s4 = (struct sockaddr_in *)ss;
		s4->sin_family = AF_INET;
		if (inet_pton(AF_INET, text, &s4->sin_addr) != 1) { fprintf(stderr, "bad test address %s\n", text); exit(2); }
	}
}

int fake_getifaddrs(struct ifaddrs **out) {
	if (fake_getifaddrs_errno) { errno = fake_getifaddrs_errno; return -1; }
	struct ifaddrs *head = NULL, **tail = &head;
	for (int i = 0; i < fake_nifs; i++) {
		const struct fake_if *f = &fake_ifs[i];
		struct fake_node *n = calloc(1, sizeof *n);
		if (!n) abort();
		snprintf(n->name, sizeof n->name, "%s", f->name);
		n->ifa.ifa_name = n->name;
		n->ifa.ifa_flags = f->flags;
		if (f->addr) { fill_sockaddr(&n->addr, f->family, f->addr); n->ifa.ifa_addr = (struct sockaddr *)&n->addr; }
		if (f->brd) { fill_sockaddr(&n->brd, f->family, f->brd); n->ifa.ifa_broadaddr = (struct sockaddr *)&n->brd; }
		*tail = &n->ifa;
		tail = &n->ifa.ifa_next;
	}
	*out = head;
	ifaddrs_lists_live++;
	return 0;
}

void fake_freeifaddrs(struct ifaddrs *ifa) {
	while (ifa) {
		struct ifaddrs *next = ifa->ifa_next;
		free(ifa);
		ifa = next;
	}
	ifaddrs_lists_live--;
}

int fake_socket(int domain, int type, int protocol) {
	if (fake_socket_errno) { errno = fake_socket_errno; return -1; }
	int fd = socket(domain, type, protocol);   /* the real one: never used to send */
	if (fd >= 0) {
		sockets_opened++;
		if (fd < MAX_FD) { fd_broadcast[fd] = 0; fd_dev[fd][0] = 0; }
	}
	return fd;
}

int fake_setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
	if (fd < 0 || fd >= MAX_FD) return 0;
	if (level == SOL_SOCKET && name == SO_BROADCAST && len == sizeof(int) && *(const int *)val == 1) fd_broadcast[fd] = 1;
	if (level == SOL_SOCKET && name == SO_BINDTODEVICE) {
		if (fake_bind_errno) { errno = fake_bind_errno; return -1; }
		snprintf(fd_dev[fd], sizeof fd_dev[fd], "%.*s", (int)len, (const char *)val);
	}
	return 0;
}

ssize_t fake_sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *to, socklen_t tolen) {
	(void)flags;
	if (nsent >= MAX_SENT) { fprintf(stderr, "too many sends\n"); exit(2); }
	struct sent *s = &sent[nsent++];
	memset(s, 0, sizeof *s);
	s->fd = fd;
	if (fd >= 0 && fd < MAX_FD) {
		snprintf(s->dev, sizeof s->dev, "%s", fd_dev[fd]);
		s->broadcast = fd_broadcast[fd];
	}
	if (!to || tolen < sizeof(struct sockaddr_in) || to->sa_family != AF_INET) {
		snprintf(s->dst, sizeof s->dst, "?");
	} else {
		const struct sockaddr_in *sa = (const struct sockaddr_in *)to;
		inet_ntop(AF_INET, &sa->sin_addr, s->dst, sizeof s->dst);
		s->port = ntohs(sa->sin_port);
	}
	s->len = len;
	memcpy(s->data, buf, len < sizeof s->data ? len : sizeof s->data);
	for (int i = 0; i < fake_nsend_fail; i++)
		if (!strcmp(fake_send_fail[i].dst, "*") || !strcmp(fake_send_fail[i].dst, s->dst)) {
			errno = fake_send_fail[i].err;
			return -1;
		}
	s->ok = 1;
	return (ssize_t)len;
}

/* --------------------------------------------------- the code under test */

#define main androidtv_main
#define socket fake_socket
#define setsockopt fake_setsockopt
#define sendto fake_sendto
#define getifaddrs fake_getifaddrs
#define freeifaddrs fake_freeifaddrs
#include "../../payload/source/codex_androidtv.c"
#undef main
#undef socket
#undef setsockopt
#undef sendto
#undef getifaddrs
#undef freeifaddrs

/* ------------------------------------------------------------------ harness */

static int failures, checks;
static const char *current;

#define CHECK(cond, ...) do { \
	checks++; \
	if (!(cond)) { \
		failures++; \
		fprintf(stderr, "FAIL %s (line %d): ", current, __LINE__); \
		fprintf(stderr, __VA_ARGS__); \
		fputc('\n', stderr); \
	} \
} while (0)

static char logbuf[8192];
static FILE *logfile;

static void reset(void) {
	fake_nifs = 0;
	fake_getifaddrs_errno = 0;
	fake_socket_errno = 0;
	fake_nsend_fail = 0;
	ifaddrs_lists_live = 0;
	sockets_opened = 0;
	nsent = 0;
	fake_bind_errno = 0;
	memset(tvs, 0, sizeof tvs);
	if (logfile) fclose(logfile);
	logfile = tmpfile();
	if (!logfile) { perror("tmpfile"); exit(2); }
	logf = logfile;   /* codex_androidtv's own log goes here */
	logbuf[0] = 0;
}

static const char *log_text(void) {
	fflush(logfile);
	rewind(logfile);
	size_t n = fread(logbuf, 1, sizeof logbuf - 1, logfile);
	logbuf[n] = 0;
	fseek(logfile, 0, SEEK_END);
	return logbuf;
}

static void add_if(const char *name, int family, const char *addr, const char *brd, unsigned flags) {
	if (fake_nifs >= MAX_FAKE_IFS) { fprintf(stderr, "too many fake interfaces\n"); exit(2); }
	fake_ifs[fake_nifs++] = (struct fake_if){ name, family, addr, brd, flags };
}

static void fail_send(const char *dst, int err) {
	fake_send_fail[fake_nsend_fail].dst = dst;
	fake_send_fail[fake_nsend_fail].err = err;
	fake_nsend_fail++;
}

/* The hub as it usually is: Wi-Fi on a /24, plus loopback. */
static void hub_on_wifi(void) {
	add_if("lo", AF_INET, "127.0.0.1", NULL, IFF_UP | IFF_LOOPBACK | IFF_RUNNING);
	add_if("ath0", AF_INET, "192.168.1.50", "192.168.1.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING | IFF_MULTICAST);
}

static int count_to(const char *dst, int port, int only_ok) {
	int n = 0;
	for (int i = 0; i < nsent; i++)
		if (!strcmp(sent[i].dst, dst) && (port < 0 || sent[i].port == port) && (!only_ok || sent[i].ok)) n++;
	return n;
}

/* Sends to dst on a socket bound to dev ("" for unbound). */
static int count_on(const char *dst, const char *dev) {
	int n = 0;
	for (int i = 0; i < nsent; i++) n += !strcmp(sent[i].dst, dst) && !strcmp(sent[i].dev, dev);
	return n;
}

static int count_ok(void) {
	int n = 0;
	for (int i = 0; i < nsent; i++) n += sent[i].ok;
	return n;
}

/* Every send went to dst, or to one of the destinations in the NULL-terminated list. */
static int only_sent_to(const char *const *dsts) {
	for (int i = 0; i < nsent; i++) {
		int known = 0;
		for (const char *const *d = dsts; *d; d++) known |= !strcmp(sent[i].dst, *d);
		if (!known) return 0;
	}
	return 1;
}

/* A destination gets the usual set: ports 7 and 9, each twice. */
static void check_full_set(const char *dst) {
	CHECK(count_to(dst, 7, 0) == 2, "%s port 7: %d sends, expected 2", dst, count_to(dst, 7, 0));
	CHECK(count_to(dst, 9, 0) == 2, "%s port 9: %d sends, expected 2", dst, count_to(dst, 9, 0));
	CHECK(count_to(dst, -1, 0) == 4, "%s: %d sends, expected 4", dst, count_to(dst, -1, 0));
}

/* Every send had SO_BROADCAST; each subnet broadcast went bound to an interface
 * (unless binding is refused) and 255.255.255.255 unbound; every socket is closed. */
static void check_tidy(void) {
	CHECK(ifaddrs_lists_live == 0, "getifaddrs() list not freed (%d live)", ifaddrs_lists_live);
	for (int i = 0; i < nsent; i++) {
		CHECK(sent[i].broadcast, "send %d (to %s) without SO_BROADCAST", i, sent[i].dst);
		if (!strcmp(sent[i].dst, "255.255.255.255"))
			CHECK(sent[i].dev[0] == 0, "255.255.255.255 went bound to %s", sent[i].dev);
		else if (!fake_bind_errno)
			CHECK(sent[i].dev[0] != 0, "send %d to %s wasn't bound to an interface", i, sent[i].dst);
		CHECK(fcntl(sent[i].fd, F_GETFD) == -1, "socket %d left open", sent[i].fd);
	}
}

#define MAC "aa:bb:cc:01:02:03"

/* ------------------------------------------------------------------ send_wol */

static void test_subnet_broadcast_and_limited(void) {
	current = "subnet broadcast and 255.255.255.255";
	reset();
	hub_on_wifi();
	send_wol(MAC);
	check_full_set("192.168.1.255");
	check_full_set("255.255.255.255");
	CHECK(nsent == 8, "%d sends, expected 8", nsent);
	CHECK(count_to("127.255.255.255", -1, 0) == 0 && count_to("127.0.0.1", -1, 0) == 0, "sent on loopback");
	/* The subnet comes first: it's the one that works with the cloud blocker on. */
	CHECK(nsent > 0 && !strcmp(sent[0].dst, "192.168.1.255"), "first send went to %s", nsent ? sent[0].dst : "nothing");
	CHECK(count_on("192.168.1.255", "ath0") == 4, "%d subnet sends bound to ath0, expected 4", count_on("192.168.1.255", "ath0"));
	CHECK(strstr(log_text(), "sent Wake-on-LAN to " MAC " via 192.168.1.255 (ath0), 255.255.255.255\n") != NULL, "log: %s", log_text());
	check_tidy();
}

static void test_magic_packet(void) {
	current = "magic packet";
	reset();
	hub_on_wifi();
	send_wol("AA:bb:Cc:0d:E0:f9");   /* any case */
	const unsigned char mac[6] = { 0xaa, 0xbb, 0xcc, 0x0d, 0xe0, 0xf9 };
	CHECK(nsent == 8, "%d sends, expected 8", nsent);
	for (int i = 0; i < nsent; i++) {
		CHECK(sent[i].len == 102, "send %d is %zu bytes, expected 102", i, sent[i].len);
		int good = 1;
		for (int j = 0; j < 6; j++) good &= sent[i].data[j] == 0xff;
		for (int k = 0; k < 16; k++)
			for (int j = 0; j < 6; j++) good &= sent[i].data[6 + k * 6 + j] == mac[j];
		CHECK(good, "send %d (to %s:%d) is not 6 x FF then the MAC 16 times", i, sent[i].dst, sent[i].port);
	}
	check_tidy();
}

/* The bug #113 fixed: with the cloud blocker on there is no default route, so
 * 255.255.255.255 fails with ENETUNREACH. The subnet broadcast must still go. */
static void test_no_default_route(void) {
	current = "no default route (cloud blocker on)";
	reset();
	hub_on_wifi();
	fail_send("255.255.255.255", ENETUNREACH);
	send_wol(MAC);
	CHECK(count_to("192.168.1.255", -1, 1) == 4, "%d sends reached 192.168.1.255, expected 4", count_to("192.168.1.255", -1, 1));
	CHECK(count_to("255.255.255.255", -1, 1) == 0, "255.255.255.255 should have failed");
	const char *log = log_text();
	CHECK(strstr(log, "sent Wake-on-LAN to " MAC " via 192.168.1.255 (ath0)\n") != NULL, "log: %s", log);
	CHECK(strstr(log, "failed") == NULL, "logged a failure although the subnet broadcast went: %s", log);
	check_tidy();
}

/* The broadcast address is the interface's own, not the address with .255 on the end. */
static void test_other_prefix_lengths(void) {
	current = "the interface's own broadcast address";
	reset();
	add_if("ath0", AF_INET, "172.16.5.9", "172.16.255.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING);
	add_if("eth1", AF_INET, "10.1.2.3", "10.1.2.7", IFF_UP | IFF_BROADCAST | IFF_RUNNING);   /* a /29 */
	fail_send("255.255.255.255", ENETUNREACH);
	send_wol(MAC);
	check_full_set("172.16.255.255");
	check_full_set("10.1.2.7");
	CHECK(count_to("172.16.5.255", -1, 0) == 0 && count_to("10.1.2.255", -1, 0) == 0, "made up an x.x.x.255 address");
	CHECK(strstr(log_text(), "via 172.16.255.255 (ath0), 10.1.2.7 (eth1)\n") != NULL, "log: %s", log_text());
	check_tidy();
}

/* Wi-Fi and a USB Ethernet adapter both up: both subnets get it. */
static void test_two_interfaces(void) {
	current = "two interfaces";
	reset();
	hub_on_wifi();
	add_if("eth1", AF_INET, "192.168.20.7", "192.168.20.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING);
	send_wol(MAC);
	check_full_set("192.168.1.255");
	check_full_set("192.168.20.255");
	check_full_set("255.255.255.255");
	CHECK(nsent == 12, "%d sends, expected 12", nsent);
	CHECK(strstr(log_text(), "via 192.168.1.255 (ath0), 192.168.20.255 (eth1), 255.255.255.255\n") != NULL, "log: %s", log_text());
	check_tidy();
}

/* One interface's subnet broadcast failing doesn't stop the next one. */
static void test_one_interface_fails(void) {
	current = "one interface fails";
	reset();
	hub_on_wifi();
	add_if("eth1", AF_INET, "192.168.20.7", "192.168.20.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING);
	fail_send("192.168.1.255", ENETDOWN);
	send_wol(MAC);
	CHECK(count_to("192.168.20.255", -1, 1) == 4, "192.168.20.255 got %d, expected 4", count_to("192.168.20.255", -1, 1));
	CHECK(count_to("255.255.255.255", -1, 1) == 4, "255.255.255.255 got %d, expected 4", count_to("255.255.255.255", -1, 1));
	CHECK(strstr(log_text(), "via 192.168.20.255 (eth1), 255.255.255.255\n") != NULL, "a failed interface is listed: %s", log_text());
	check_tidy();
}

/* Wired Ethernet with Wi-Fi switched off: both on one subnet, so one broadcast
 * address. Wi-Fi is up but not running; the packet must go out the adapter,
 * bound to it (unbound, the kernel may pick Wi-Fi's broadcast route). */
static void test_wifi_off_and_a_cable_on_the_same_subnet(void) {
	current = "Wi-Fi off, cable on the same subnet";
	reset();
	add_if("lo", AF_INET, "127.0.0.1", NULL, IFF_UP | IFF_LOOPBACK | IFF_RUNNING);
	add_if("ath0", AF_INET, "192.168.1.50", "192.168.1.255", IFF_UP | IFF_BROADCAST | IFF_MULTICAST);
	add_if("eth2", AF_INET, "192.168.1.77", "192.168.1.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING | IFF_MULTICAST);
	fail_send("255.255.255.255", ENETUNREACH);
	send_wol(MAC);
	CHECK(count_on("192.168.1.255", "eth2") == 4, "%d sends bound to eth2, expected 4", count_on("192.168.1.255", "eth2"));
	CHECK(count_on("192.168.1.255", "ath0") == 0, "sent on the disconnected Wi-Fi");
	CHECK(count_on("192.168.1.255", "") == 0, "an unbound subnet broadcast (the kernel may pick Wi-Fi's route)");
	CHECK(strstr(log_text(), "sent Wake-on-LAN to " MAC " via 192.168.1.255 (eth2)\n") != NULL, "log: %s", log_text());
	check_tidy();
}

/* Both running on one subnet: one set through each. */
static void test_wifi_and_a_cable_both_running(void) {
	current = "Wi-Fi and cable both running";
	reset();
	hub_on_wifi();
	add_if("eth2", AF_INET, "192.168.1.77", "192.168.1.255", IFF_UP | IFF_BROADCAST | IFF_RUNNING);
	send_wol(MAC);
	CHECK(count_on("192.168.1.255", "ath0") == 4 && count_on("192.168.1.255", "eth2") == 4,
	      "ath0 %d, eth2 %d sends, expected 4 each", count_on("192.168.1.255", "ath0"), count_on("192.168.1.255", "eth2"));
	CHECK(strstr(log_text(), "via 192.168.1.255 (ath0), 192.168.1.255 (eth2), 255.255.255.255\n") != NULL, "log: %s", log_text());
	check_tidy();
}

/* Not root: binding is refused and the packet still goes, unbound. */
static void test_binding_refused(void) {
	current = "SO_BINDTODEVICE refused";
	reset();
	hub_on_wifi();
	fake_bind_errno = EPERM;
	send_wol(MAC);
	CHECK(count_on("192.168.1.255", "") == 4, "%d unbound subnet sends, expected 4", count_on("192.168.1.255", ""));
	check_tidy();
}

/* Interfaces with no usable broadcast address are passed over. */
static void test_skips_unusable_interfaces(void) {
	current = "unusable interfaces";
	reset();
	/* Each is running unless that's what it's about, so each is skipped for its own reason. */
	const unsigned r = IFF_RUNNING;
	add_if("lo", AF_INET, "127.0.0.1", "127.255.255.255", r | IFF_UP | IFF_LOOPBACK | IFF_BROADCAST);  /* odd, but skip it */
	add_if("eth0", AF_INET, "192.168.7.2", "192.168.7.255", r | IFF_BROADCAST);          /* down */
	add_if("ath1", AF_INET, "192.168.12.2", "192.168.12.255", IFF_UP | IFF_BROADCAST);  /* up, not running (Wi-Fi off) */
	add_if("tun0", AF_INET, "10.8.0.2", "10.8.0.1", r | IFF_UP | IFF_POINTOPOINT);        /* a peer, not a broadcast */
	add_if("ath0", AF_INET6, "fe80::1", "ff02::1", r | IFF_UP | IFF_BROADCAST);           /* IPv6 */
	add_if("noaddr", AF_INET, NULL, "192.168.8.255", r | IFF_UP | IFF_BROADCAST);         /* no address */
	add_if("nobrd", AF_INET, "192.168.9.2", NULL, r | IFF_UP | IFF_BROADCAST);           /* no broadcast address */
	add_if("zero", AF_INET, "192.168.10.2", "0.0.0.0", r | IFF_UP | IFF_BROADCAST);       /* broadcast 0.0.0.0 */
	add_if("all", AF_INET, "192.168.11.2", "255.255.255.255", r | IFF_UP | IFF_BROADCAST); /* not sent twice */
	add_if("ath0", AF_INET, "192.168.1.50", "192.168.1.255", r | IFF_UP | IFF_BROADCAST);  /* the real one, last */
	send_wol(MAC);
	const char *expected[] = { "192.168.1.255", "255.255.255.255", NULL };
	CHECK(only_sent_to(expected), "sent somewhere other than 192.168.1.255 and 255.255.255.255");
	check_full_set("192.168.1.255");
	check_full_set("255.255.255.255");
	CHECK(strstr(log_text(), "via 192.168.1.255 (ath0), 255.255.255.255\n") != NULL, "log: %s", log_text());
	check_tidy();
}

/* No interface list: 255.255.255.255 is still tried. */
static void test_getifaddrs_fails(void) {
	current = "getifaddrs() fails";
	reset();
	hub_on_wifi();
	fake_getifaddrs_errno = ENOMEM;
	send_wol(MAC);
	check_full_set("255.255.255.255");
	CHECK(nsent == 4, "%d sends, expected 4", nsent);
	CHECK(strstr(log_text(), "sent Wake-on-LAN to " MAC " via 255.255.255.255\n") != NULL, "log: %s", log_text());
	check_tidy();
}

static void test_nowhere_to_send(void) {
	current = "every send fails";
	reset();
	hub_on_wifi();
	fail_send("*", ENETUNREACH);
	send_wol(MAC);
	CHECK(count_ok() == 0, "a send succeeded");
	CHECK(nsent == 8, "%d tries, expected 8", nsent);
	char want[160];
	snprintf(want, sizeof want, "Wake-on-LAN to " MAC " failed: %s\n", strerror(ENETUNREACH));
	CHECK(strstr(log_text(), want) != NULL, "log: %s", log_text());
	CHECK(strstr(log_text(), "sent Wake-on-LAN") == NULL, "claimed success: %s", log_text());
	check_tidy();
}

static void test_no_interfaces_and_no_route(void) {
	current = "only loopback, no route";
	reset();
	add_if("lo", AF_INET, "127.0.0.1", NULL, IFF_UP | IFF_LOOPBACK);
	fail_send("255.255.255.255", ENETUNREACH);
	send_wol(MAC);
	CHECK(count_ok() == 0, "a send succeeded");
	CHECK(strstr(log_text(), "failed: ") != NULL, "no failure logged: %s", log_text());
	check_tidy();
}

static void test_bad_mac(void) {
	current = "malformed MAC";
	const char *bad[] = { "", "not-a-mac", "aa:bb:cc", "aa-bb-cc-dd-ee-ff", "zz:bb:cc:dd:ee:ff" };
	for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
		reset();
		hub_on_wifi();
		send_wol(bad[i]);
		CHECK(nsent == 0, "\"%s\": %d sends, expected none", bad[i], nsent);
		CHECK(sockets_opened == 0, "\"%s\": opened a socket", bad[i]);
		CHECK(ifaddrs_lists_live == 0, "\"%s\": interface list not freed", bad[i]);
	}
}

static void test_socket_fails(void) {
	current = "socket() fails";
	reset();
	hub_on_wifi();
	fake_socket_errno = EMFILE;
	send_wol(MAC);
	CHECK(nsent == 0, "%d sends without a socket", nsent);
	CHECK(ifaddrs_lists_live == 0, "interface list not freed");
}

/* With a dozen interfaces the log line is cut short, but every subnet still
 * gets the packet and the line stays within its buffer. */
static void test_many_interfaces(void) {
	current = "more interfaces than the log line holds";
	reset();
	static char addrs[MAX_FAKE_IFS][2][INET_ADDRSTRLEN];
	static char names[MAX_FAKE_IFS][IFNAMSIZ];
	for (int i = 0; i < MAX_FAKE_IFS; i++) {
		snprintf(names[i], sizeof names[i], "eth%d", i);
		snprintf(addrs[i][0], sizeof addrs[i][0], "192.168.%d.2", 100 + i);
		snprintf(addrs[i][1], sizeof addrs[i][1], "192.168.%d.255", 100 + i);
		add_if(names[i], AF_INET, addrs[i][0], addrs[i][1], IFF_UP | IFF_BROADCAST | IFF_RUNNING);
	}
	fail_send("255.255.255.255", ENETUNREACH);
	send_wol(MAC);
	for (int i = 0; i < MAX_FAKE_IFS; i++) check_full_set(addrs[i][1]);
	const char *log = log_text();
	const char *line = strstr(log, "sent Wake-on-LAN to ");
	CHECK(line != NULL, "log: %s", log);
	if (line) {
		const char *end = strchr(line, '\n');
		const char *via = strstr(line, " via ");
		CHECK(via && end && end - (via + 5) < 200, "the via list overran its buffer: %s", line);
	}
	check_tidy();
}

/* ------------------------------------------------- PowerOn through POST /cmd */

#define TV_ID "androidtv0123456789ab"

static struct tv *add_tv(const char *mac, int ready) {
	struct tv *t = &tvs[0];
	memset(t, 0, sizeof *t);
	t->used = 1;
	snprintf(t->id, sizeof t->id, "%s", TV_ID);
	snprintf(t->host, sizeof t->host, "192.168.1.60");
	snprintf(t->mac, sizeof t->mac, "%s", mac);
	snprintf(t->name, sizeof t->name, "Test TV");
	t->ready = ready;
	t->is_on = ready;
	t->backoff = 1000;
	return t;
}

/* POST /cmd as the engine sends it; returns the reply body. */
static const char *post_cmd(const char *command) {
	static char reply[1024];
	char body[256], req[512];
	snprintf(body, sizeof body, "{\"device\":\"%s\",\"command\":\"%s\"}", TV_ID, command);
	int n = snprintf(req, sizeof req, "POST /cmd HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",
	                 strlen(body), body);
	int sv[2];
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) { perror("socketpair"); exit(2); }
	if (write(sv[0], req, (size_t)n) != n) { perror("write"); exit(2); }
	http_handle(sv[1]);
	close(sv[1]);
	size_t got = 0;
	ssize_t r;
	while ((r = read(sv[0], reply + got, sizeof reply - 1 - got)) > 0) got += (size_t)r;
	close(sv[0]);
	reply[got] = 0;
	char *b = strstr(reply, "\r\n\r\n");
	return b ? b + 4 : reply;
}

static void test_power_on_wakes_an_unconnected_tv(void) {
	current = "PowerOn wakes a TV that isn't connected";
	reset();
	hub_on_wifi();
	fail_send("255.255.255.255", ENETUNREACH);   /* the usual case: cloud blocker on */
	struct tv *t = add_tv(MAC, 0);
	t->next_attempt = now_ms() + 60000;          /* a reconnect a minute away, after failures */
	t->backoff = 30000;
	const char *reply = post_cmd("PowerOn");
	CHECK(!strcmp(reply, "{\"ok\":true}"), "reply %s", reply);
	CHECK(count_to("192.168.1.255", -1, 1) == 4, "%d packets reached 192.168.1.255, expected 4", count_to("192.168.1.255", -1, 1));
	CHECK(t->last_wol > 0, "last_wol not recorded");
	CHECK(t->qcount == 1 && t->q[t->qhead].code == PSEUDO_POWER_ON, "PowerOn not queued for when the TV connects");
	CHECK(t->next_attempt == 0, "the reconnect wasn't brought forward (next attempt in %lld ms)", t->next_attempt - now_ms());
	CHECK(t->backoff == 1000, "the reconnect backoff wasn't reset (%d ms)", t->backoff);
	check_tidy();
}

static void test_power_on_rate_limit(void) {
	current = "PowerOn sends Wake-on-LAN at most every 3 s";
	reset();
	hub_on_wifi();
	struct tv *t = add_tv(MAC, 0);
	post_cmd("PowerOn");
	int first = nsent;
	CHECK(first == 8, "%d sends for the first PowerOn, expected 8", first);
	post_cmd("PowerOn");
	CHECK(nsent == first, "a second PowerOn at once sent %d more packets", nsent - first);
	t->last_wol = now_ms() - 3001;
	post_cmd("PowerOn");
	CHECK(nsent == 2 * first, "PowerOn after 3 s sent %d packets, expected %d", nsent - first, first);
	check_tidy();
}

static void test_no_wol_when_not_needed(void) {
	current = "no Wake-on-LAN when it can't or needn't";
	reset();
	hub_on_wifi();
	add_tv(MAC, 1);                      /* connected: the session turns it on */
	CHECK(!strcmp(post_cmd("PowerOn"), "{\"ok\":true}"), "connected TV: PowerOn refused");
	CHECK(nsent == 0, "connected TV: %d packets sent", nsent);

	reset();
	hub_on_wifi();
	add_tv("", 0);                       /* MAC never learned */
	CHECK(!strcmp(post_cmd("PowerOn"), "{\"ok\":true}"), "no MAC: PowerOn refused");
	CHECK(nsent == 0 && sockets_opened == 0, "no MAC: %d packets sent", nsent);

	const char *others[] = { "PowerOff", "PowerToggle", "VolumeUp", "InputHdmi1" };
	for (size_t i = 0; i < sizeof others / sizeof *others; i++) {
		reset();
		hub_on_wifi();
		add_tv(MAC, 0);
		post_cmd(others[i]);
		CHECK(nsent == 0, "%s sent %d Wake-on-LAN packets", others[i], nsent);
	}
}

int main(void) {
	signal(SIGPIPE, SIG_IGN);
	test_subnet_broadcast_and_limited();
	test_magic_packet();
	test_no_default_route();
	test_other_prefix_lengths();
	test_two_interfaces();
	test_one_interface_fails();
	test_wifi_off_and_a_cable_on_the_same_subnet();
	test_wifi_and_a_cable_both_running();
	test_binding_refused();
	test_skips_unusable_interfaces();
	test_getifaddrs_fails();
	test_nowhere_to_send();
	test_no_interfaces_and_no_route();
	test_bad_mac();
	test_socket_fails();
	test_many_interfaces();
	test_power_on_wakes_an_unconnected_tv();
	test_power_on_rate_limit();
	test_no_wol_when_not_needed();
	if (failures) {
		fprintf(stderr, "wol_test: %d of %d checks failed\n", failures, checks);
		return 1;
	}
	printf("wol_test: OK (%d checks)\n", checks);
	return 0;
}
