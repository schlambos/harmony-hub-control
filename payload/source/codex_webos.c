/*
 * codex_webos — Native LG webOS TV network control for Melodious.
 *
 * Speaks LG webOS SSAP over WebSocket (wss://<tv>:3001 with BearSSL TLS 1.2
 * and self-signed cert support, with automatic fallback to ws://<tv>:3000 for
 * older webOS firmware, or explicit wss/ws mode per TV), plus the pointer-input
 * WebSocket (com.webos.service.networkinput/getPointerInputSocket) for remote
 * navigation keys and Wake-on-LAN for PowerOn.
 *
 * Transport choice:
 *   Modern LG webOS TVs (webOS 6 / 2022+) require wss://<tv>:3001 with a
 *   self-signed certificate and refuse/redirect ws://<tv>:3000. Older webOS
 *   TVs (webOS 3-5) serve ws://<tv>:3000. Defaulting to "auto" (try wss:3001,
 *   fall back to ws:3000, remember what worked) while allowing explicit "wss"
 *   or "ws" covers all generations over one BearSSL + RFC 6455 client.
 *
 * Security:
 *   - Listens on 127.0.0.1 only (default port 8096). codex_webui proxies
 *     authenticated, same-origin /api/webos/... requests to it; the Harmony
 *     engine posts {"device":"<tv id>","command":"<Name>"} to /cmd.
 *   - Pairing client-keys are persisted ONLY in <dir>/tvs.tsv (mode 0600,
 *     atomic write-and-rename). They are NEVER logged, printed, or returned in
 *     any HTTP response or error message (masked as paired: true|false).
 *   - Wake-on-LAN is restricted strictly to the configured TV MAC address.
 *   - Pointer socketPath URLs are validated to match the TV's own IPv4 host.
 *
 * TLS is BearSSL (third_party/bearssl-0.6). No other third-party dependencies.
 * MIT License, Copyright (c) 2026 Melodious contributors.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
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

#include "bearssl.h"

#define VERSION "1.0.0"
#define MAX_TVS 8
#define MAX_INPUTS 16
#define MAX_APPS 64
#define TV_ID_PREFIX "webos"
#define TV_ID_MAX 24
#define CLIENT_KEY_MAX 128
#define ENGINE_PORT 8096
#define DEFAULT_WS_PORT 3000
#define DEFAULT_WSS_PORT 3001
#define LOG_CAP (64 * 1024)
#define WS_RX_INIT 16384
#define WS_RX_MAX (128 * 1024)
/* Receive buffer cap: one maximal frame plus the partial frame/TLS record after it. */
#define WS_RX_BUF_MAX (WS_RX_MAX * 2)
#define WS_TX_MAX 16384
#define WS_PING_MS 20000
#define WS_QUIET_MS 50000
#define PAIR_CONNECT_TIMEOUT_MS 10000
#define PAIR_PROMPT_TIMEOUT_MS 60000
#define WOL_WAKE_WINDOW_MS 25000
#define WOL_REPEAT_MS 4000

/* ================================================================== options, log */

static const char *opt_dir = "/data/codex/webos";
static const char *opt_listen = "127.0.0.1";
static int opt_port = ENGINE_PORT;
static int opt_ws_port = DEFAULT_WS_PORT;
static int opt_wss_port = DEFAULT_WSS_PORT;
static const char *opt_log = NULL;
static int opt_verbose = 0;
static FILE *logf;

static void logmsg(const char *fmt, ...) {
	if (!logf) logf = stderr;
	if (opt_log && logf != stderr && ftell(logf) > LOG_CAP) {
		FILE *f = freopen(opt_log, "w", logf);
		if (!f) logf = stderr;
	}
	struct timeval tv;
	gettimeofday(&tv, NULL);
	struct tm tm;
	gmtime_r(&tv.tv_sec, &tm);
	fprintf(logf, "%04d-%02d-%02d %02d:%02d:%02d codex_webos: ", tm.tm_year + 1900, tm.tm_mon + 1,
	        tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
	va_list ap;
	va_start(ap, fmt);
	vfprintf(logf, fmt, ap);
	va_end(ap);
	fputc('\n', logf);
	fflush(logf);
}
#define DBG(...) do { if (opt_verbose) logmsg(__VA_ARGS__); } while (0)

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void path_in_dir(char *out, size_t cap, const char *name) {
	snprintf(out, cap, "%s/%s", opt_dir, name);
}

static unsigned char *read_file(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	unsigned char *buf = NULL;
	size_t cap = 0, n = 0;
	for (;;) {
		if (n == cap) {
			cap = cap ? cap * 2 : 2048;
			unsigned char *nb = realloc(buf, cap);
			if (!nb) { free(buf); fclose(f); return NULL; }
			buf = nb;
		}
		size_t r = fread(buf + n, 1, cap - n, f);
		if (r == 0) break;
		n += r;
	}
	fclose(f);
	*len = n;
	return buf;
}

static int write_file_atomic(const char *path, const void *data, size_t len, mode_t mode) {
	char tmp[320];
	snprintf(tmp, sizeof tmp, "%s.codex-new", path);
	int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, mode);
	if (fd < 0) return -1;
	const unsigned char *p = data;
	while (len) {
		ssize_t w = write(fd, p, len);
		if (w <= 0) { close(fd); unlink(tmp); return -1; }
		p += w;
		len -= (size_t)w;
	}
	fsync(fd);
	close(fd);
	if (rename(tmp, path) < 0) { unlink(tmp); return -1; }
	return 0;
}

static void secure_zero(void *p, size_t n) {
	volatile unsigned char *v = p;
	while (n--) *v++ = 0;
}

/* ================================================================== random, base64, hex */

static br_hmac_drbg_context global_rng;
static int rng_ready = 0;

static void rng_init(void) {
	if (rng_ready) return;
	br_hmac_drbg_init(&global_rng, &br_sha256_vtable, NULL, 0);
	br_prng_seeder seeder = br_prng_seeder_system(NULL);
	if (!seeder || !seeder(&global_rng.vtable)) {
		unsigned char seed[32];
		int fd = open("/dev/urandom", O_RDONLY);
		if (fd >= 0) {
			(void)!read(fd, seed, sizeof seed);
			close(fd);
			br_hmac_drbg_update(&global_rng, seed, sizeof seed);
		}
	}
	struct timeval tv;
	gettimeofday(&tv, NULL);
	pid_t pid = getpid();
	br_hmac_drbg_update(&global_rng, &tv, sizeof tv);
	br_hmac_drbg_update(&global_rng, &pid, sizeof pid);
	rng_ready = 1;
}

static void random_bytes(unsigned char *out, size_t len) {
	rng_init();
	br_hmac_drbg_generate(&global_rng, out, len);
}

static void hex_encode(char *out, const unsigned char *in, size_t len) {
	static const char hx[] = "0123456789abcdef";
	for (size_t i = 0; i < len; i++) {
		out[2 * i] = hx[in[i] >> 4];
		out[2 * i + 1] = hx[in[i] & 15];
	}
	out[2 * len] = 0;
}

static size_t b64_encode(char *out, const unsigned char *in, size_t len) {
	static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t o = 0;
	for (size_t i = 0; i < len; i += 3) {
		unsigned v = (unsigned)in[i] << 16;
		if (i + 1 < len) v |= (unsigned)in[i + 1] << 8;
		if (i + 2 < len) v |= (unsigned)in[i + 2];
		out[o++] = T[(v >> 18) & 63];
		out[o++] = T[(v >> 12) & 63];
		out[o++] = (i + 1 < len) ? T[(v >> 6) & 63] : '=';
		out[o++] = (i + 2 < len) ? T[v & 63] : '=';
	}
	out[o] = 0;
	return o;
}

/* ================================================================== validation helpers */

static int valid_ipv4(const char *s) {
	if (!s || !*s || strlen(s) > 15) return 0;
	struct in_addr a;
	return inet_pton(AF_INET, s, &a) == 1;
}

static int valid_tv_id(const char *id) {
	size_t n = id ? strlen(id) : 0;
	if (n < 9 || n > TV_ID_MAX - 1 || strncmp(id, TV_ID_PREFIX, 5) != 0) return 0;
	for (size_t i = 5; i < n; i++)
		if (!isxdigit((unsigned char)id[i]) || isupper((unsigned char)id[i])) return 0;
	return 1;
}

static int hex_nibble(int c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/* Parse AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, or AABBCCDDEEFF into canonical
 * uppercase AA:BB:CC:DD:EE:FF. Rejects all-00 and all-FF. */
static int normalize_mac(const char *in, char out[18]) {
	if (!in) return -1;
	while (*in == ' ' || *in == '\t') in++;
	size_t len = strlen(in);
	while (len && (in[len - 1] == ' ' || in[len - 1] == '\t')) len--;
	if (len == 0) { out[0] = 0; return 0; }
	unsigned char b[6];
	char sep = 0;
	if (len == 17) {
		sep = in[2];
		if (sep != ':' && sep != '-') return -1;
		for (int i = 0; i < 6; i++) {
			int hi = hex_nibble((unsigned char)in[i * 3]);
			int lo = hex_nibble((unsigned char)in[i * 3 + 1]);
			if (hi < 0 || lo < 0) return -1;
			if (i < 5 && in[i * 3 + 2] != sep) return -1;
			b[i] = (unsigned char)((hi << 4) | lo);
		}
	} else if (len == 12) {
		for (int i = 0; i < 6; i++) {
			int hi = hex_nibble((unsigned char)in[i * 2]);
			int lo = hex_nibble((unsigned char)in[i * 2 + 1]);
			if (hi < 0 || lo < 0) return -1;
			b[i] = (unsigned char)((hi << 4) | lo);
		}
	} else {
		return -1;
	}
	int all0 = 1, allff = 1;
	for (int i = 0; i < 6; i++) {
		if (b[i] != 0x00) all0 = 0;
		if (b[i] != 0xff) allff = 0;
	}
	if (all0 || allff) return -1;
	snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", b[0], b[1], b[2], b[3], b[4], b[5]);
	return 0;
}

static void sanitize_name(char *s) {
	for (; *s; s++)
		if ((unsigned char)*s < 0x20 || *s == 0x7f || *s == '"' || *s == '\\') *s = ' ';
}

static int valid_client_key(const char *k) {
	if (!k || !*k) return 0;
	size_t n = strlen(k);
	if (n < 4 || n >= CLIENT_KEY_MAX) return 0;
	for (size_t i = 0; i < n; i++)
		if ((unsigned char)k[i] <= 0x20 || (unsigned char)k[i] >= 0x7f || k[i] == '"' || k[i] == '\\')
			return 0;
	return 1;
}

/* ================================================================== lightweight JSON scanner */

static const char *j_skip_ws(const char *p, const char *end) {
	while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
	return p;
}

static const char *j_skip_str(const char *p, const char *end) {
	if (p >= end || *p != '"') return p;
	p++;
	while (p < end) {
		if (*p == '\\' && p + 1 < end) { p += 2; continue; }
		if (*p == '"') return p + 1;
		p++;
	}
	return end;
}

static const char *j_skip_val(const char *p, const char *end) {
	p = j_skip_ws(p, end);
	if (p >= end) return end;
	if (*p == '"') return j_skip_str(p, end);
	if (*p == '{' || *p == '[') {
		int depth = 0;
		while (p < end) {
			if (*p == '"') { p = j_skip_str(p, end); continue; }
			if (*p == '{' || *p == '[') depth++;
			else if (*p == '}' || *p == ']') { if (--depth <= 0) return p + 1; }
			p++;
		}
		return end;
	}
	while (p < end && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n')
		p++;
	return p;
}

static int j_decode_str(const char *p, const char *end, char *out, size_t cap) {
	p = j_skip_ws(p, end);
	if (p >= end || *p != '"') return -1;
	p++;
	size_t o = 0;
	while (p < end && *p != '"') {
		char ch = *p++;
		if (ch == '\\' && p < end) {
			char esc = *p++;
			switch (esc) {
			case '"': ch = '"'; break;
			case '\\': ch = '\\'; break;
			case '/': ch = '/'; break;
			case 'n': ch = '\n'; break;
			case 'r': ch = '\r'; break;
			case 't': ch = '\t'; break;
			case 'u':
				if (p + 4 <= end) {
					unsigned v = 0;
					int ok = 1;
					for (int i = 0; i < 4; i++) {
						int h = hex_nibble((unsigned char)p[i]);
						if (h < 0) ok = 0;
						else v = (v << 4) | (unsigned)h;
					}
					p += 4;
					ch = (ok && v >= 0x20 && v < 0x7f) ? (char)v : ' ';
				} else ch = ' ';
				break;
			default: ch = esc; break;
			}
		}
		if (o + 1 < cap) out[o++] = ch;
	}
	if (cap) out[o] = 0;
	return (p < end && *p == '"') ? 0 : -1;
}

/* Find a direct key inside a JSON object slice [obj, end). Returns value start or NULL. */
static const char *j_obj_find(const char *obj, const char *end, const char *key, const char **val_end_out) {
	const char *p = j_skip_ws(obj, end);
	if (p >= end || *p != '{') return NULL;
	p++;
	while (p < end) {
		p = j_skip_ws(p, end);
		if (p >= end || *p == '}') return NULL;
		if (*p == ',') { p++; continue; }
		if (*p != '"') return NULL;
		char kbuf[64];
		if (j_decode_str(p, end, kbuf, sizeof kbuf) < 0) return NULL;
		p = j_skip_str(p, end);
		p = j_skip_ws(p, end);
		if (p >= end || *p != ':') return NULL;
		p = j_skip_ws(p + 1, end);
		const char *ve = j_skip_val(p, end);
		if (!strcmp(kbuf, key)) {
			if (val_end_out) *val_end_out = ve;
			return p;
		}
		p = ve;
	}
	return NULL;
}

static int j_obj_str(const char *obj, const char *end, const char *key, char *out, size_t cap) {
	const char *ve = NULL;
	const char *v = j_obj_find(obj, end, key, &ve);
	if (!v) return -1;
	return j_decode_str(v, ve, out, cap);
}

static int j_obj_bool(const char *obj, const char *end, const char *key, int *out) {
	const char *ve = NULL;
	const char *v = j_obj_find(obj, end, key, &ve);
	if (!v) return -1;
	if (ve - v == 4 && !memcmp(v, "true", 4)) { *out = 1; return 0; }
	if (ve - v == 5 && !memcmp(v, "false", 5)) { *out = 0; return 0; }
	return -1;
}

static int j_obj_int(const char *obj, const char *end, const char *key, int *out) {
	const char *ve = NULL;
	const char *v = j_obj_find(obj, end, key, &ve);
	if (!v || v >= ve) return -1;
	char buf[32];
	size_t n = (size_t)(ve - v);
	if (n >= sizeof buf) return -1;
	memcpy(buf, v, n);
	buf[n] = 0;
	char *e = NULL;
	long val = strtol(buf, &e, 10);
	if (e == buf || *e != 0) return -1;
	*out = (int)val;
	return 0;
}

/* ================================================================== BearSSL X.509 (self-signed RSA/EC) */

/* Accepts a TV's self-signed TLS certificate (RSA or ECDSA) for wss://:3001.
 * LG webOS TVs present self-signed certs that regenerate across firmware updates;
 * application-layer authentication uses the paired client-key. */
struct any_x509 {
	const br_x509_class *vtable;
	int index;
	br_x509_decoder_context dc;
	br_x509_pkey pkey;
	unsigned char n[512], e[8];
	unsigned char q[256];
};

static void any_start_chain(const br_x509_class **ctx, const char *server_name) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	(void)server_name;
	c->index = 0;
	memset(&c->pkey, 0, sizeof c->pkey);
}
static void any_start_cert(const br_x509_class **ctx, uint32_t length) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	(void)length;
	if (c->index == 0) br_x509_decoder_init(&c->dc, NULL, NULL);
}
static void any_append(const br_x509_class **ctx, const unsigned char *buf, size_t len) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	if (c->index == 0) br_x509_decoder_push(&c->dc, buf, len);
}
static void any_end_cert(const br_x509_class **ctx) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	c->index++;
}
static unsigned any_end_chain(const br_x509_class **ctx) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	const br_x509_pkey *pk = br_x509_decoder_get_pkey(&c->dc);
	if (!pk) return BR_ERR_X509_UNSUPPORTED;
	if (pk->key_type == BR_KEYTYPE_RSA) {
		if (pk->key.rsa.nlen > sizeof c->n || pk->key.rsa.elen > sizeof c->e)
			return BR_ERR_X509_UNSUPPORTED;
		memcpy(c->n, pk->key.rsa.n, pk->key.rsa.nlen);
		memcpy(c->e, pk->key.rsa.e, pk->key.rsa.elen);
		c->pkey.key_type = BR_KEYTYPE_RSA;
		c->pkey.key.rsa.n = c->n;
		c->pkey.key.rsa.nlen = pk->key.rsa.nlen;
		c->pkey.key.rsa.e = c->e;
		c->pkey.key.rsa.elen = pk->key.rsa.elen;
		return 0;
	}
	if (pk->key_type == BR_KEYTYPE_EC) {
		if (pk->key.ec.qlen > sizeof c->q)
			return BR_ERR_X509_UNSUPPORTED;
		memcpy(c->q, pk->key.ec.q, pk->key.ec.qlen);
		c->pkey.key_type = BR_KEYTYPE_EC;
		c->pkey.key.ec.curve = pk->key.ec.curve;
		c->pkey.key.ec.q = c->q;
		c->pkey.key.ec.qlen = pk->key.ec.qlen;
		return 0;
	}
	return BR_ERR_X509_UNSUPPORTED;
}
static const br_x509_pkey *any_get_pkey(const br_x509_class *const *ctx, unsigned *usages) {
	struct any_x509 *c = (struct any_x509 *)ctx;
	if (usages) *usages = BR_KEYTYPE_KEYX | BR_KEYTYPE_SIGN;
	return &c->pkey;
}
static const br_x509_class any_x509_vtable = {
	sizeof(struct any_x509), any_start_chain, any_start_cert, any_append,
	any_end_cert, any_end_chain, any_get_pkey
};

static void ssl_profile(br_ssl_client_context *c) {
	static const uint16_t suites[] = {
		BR_TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		BR_TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		BR_TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
		BR_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		BR_TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		BR_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		BR_TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256,
		BR_TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		BR_TLS_RSA_WITH_AES_128_GCM_SHA256,
		BR_TLS_RSA_WITH_AES_256_GCM_SHA384,
		BR_TLS_RSA_WITH_AES_128_CBC_SHA256,
		BR_TLS_RSA_WITH_AES_128_CBC_SHA,
	};
	br_ssl_client_zero(c);
	br_ssl_engine_set_versions(&c->eng, BR_TLS12, BR_TLS12);
	br_ssl_engine_set_suites(&c->eng, suites, sizeof suites / sizeof suites[0]);
	br_ssl_engine_set_default_ec(&c->eng);
	br_ssl_client_set_default_rsapub(c);
	br_ssl_engine_set_default_rsavrfy(&c->eng);
	br_ssl_engine_set_default_ecdsa(&c->eng);
	br_ssl_engine_set_hash(&c->eng, br_sha256_ID, &br_sha256_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha384_ID, &br_sha384_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha512_ID, &br_sha512_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha1_ID, &br_sha1_vtable);
	br_ssl_engine_set_prf_sha256(&c->eng, &br_tls12_sha256_prf);
	br_ssl_engine_set_prf_sha384(&c->eng, &br_tls12_sha384_prf);
	br_ssl_engine_set_default_aes_gcm(&c->eng);
	br_ssl_engine_set_default_aes_cbc(&c->eng);
	br_ssl_engine_set_default_chapol(&c->eng);
}

/* ================================================================== WebSocket client (ws & wss) */

struct ws_conn {
	int fd;
	int use_tls;
	int connecting;
	int transport_up;
	int ws_up;
	long long started, last_rx, last_ping;
	br_ssl_client_context cc;
	struct any_x509 x509;
	unsigned char iobuf[BR_SSL_BUFSIZE_BIDI];
	char expected_accept[32];
	unsigned char tx[WS_TX_MAX];
	size_t txn;
	unsigned char *rx;
	size_t rxn, rxcap;
	unsigned char *frag;
	size_t fragn, fragcap;
	int frag_op;
	uint64_t skip; /* bytes still to discard from an oversized frame */
	char error[128];
};

typedef void (*ws_text_cb)(void *owner, const char *text, size_t len);
typedef void (*ws_up_cb)(void *owner);

static void ws_close(struct ws_conn *c, const char *why) {
	if (!c) return;
	if (c->fd >= 0) close(c->fd);
	c->fd = -1;
	c->connecting = c->transport_up = c->ws_up = 0;
	c->txn = c->rxn = c->fragn = 0;
	c->frag_op = 0;
	c->skip = 0;
	free(c->rx); c->rx = NULL; c->rxcap = 0;
	free(c->frag); c->frag = NULL; c->fragcap = 0;
	snprintf(c->error, sizeof c->error, "%s", why ? why : "");
}

static int ws_tx_append(struct ws_conn *c, const void *data, size_t len) {
	if (!c || c->fd < 0 || c->txn + len > sizeof c->tx) return -1;
	memcpy(c->tx + c->txn, data, len);
	c->txn += len;
	return 0;
}

static int ws_send_frame(struct ws_conn *c, unsigned char opcode, const void *payload, size_t len) {
	if (!c || !c->ws_up || c->fd < 0) return -1;
	unsigned char hdr[14];
	size_t hn = 0;
	hdr[hn++] = (unsigned char)(0x80 | (opcode & 0x0f));
	if (len < 126) {
		hdr[hn++] = (unsigned char)(0x80 | len);
	} else if (len < 65536) {
		hdr[hn++] = 0x80 | 126;
		hdr[hn++] = (unsigned char)(len >> 8);
		hdr[hn++] = (unsigned char)(len & 0xff);
	} else {
		return -1;
	}
	unsigned char mask[4];
	random_bytes(mask, sizeof mask);
	memcpy(hdr + hn, mask, 4);
	hn += 4;
	if (c->txn + hn + len > sizeof c->tx) return -1;
	memcpy(c->tx + c->txn, hdr, hn);
	const unsigned char *src = payload;
	unsigned char *dst = c->tx + c->txn + hn;
	for (size_t i = 0; i < len; i++) dst[i] = src[i] ^ mask[i & 3];
	c->txn += hn + len;
	return 0;
}

static int ws_send_text(struct ws_conn *c, const char *text, size_t len) {
	return ws_send_frame(c, 0x1, text, len);
}

static int ws_open(struct ws_conn *c, const char *host, int port, const char *path, int use_tls) {
	ws_close(c, "");
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_port = htons((uint16_t)port);
	if (inet_pton(AF_INET, host, &sa.sin_addr) != 1) { ws_close(c, "invalid IPv4 address"); return -1; }
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) { ws_close(c, "socket failed"); return -1; }
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	int one = 1;
	setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
	setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);
	if (connect(fd, (struct sockaddr *)&sa, sizeof sa) < 0 && errno != EINPROGRESS) {
		char why[96];
		snprintf(why, sizeof why, "connect: %s", strerror(errno));
		close(fd);
		ws_close(c, why);
		return -1;
	}
	c->rx = malloc(WS_RX_INIT);
	if (!c->rx) { close(fd); ws_close(c, "out of memory"); return -1; }
	c->rxcap = WS_RX_INIT;
	c->rxn = 0;
	c->skip = 0;
	c->fd = fd;
	c->use_tls = use_tls;
	c->connecting = 1;
	c->transport_up = 0;
	c->ws_up = 0;
	c->started = c->last_rx = c->last_ping = now_ms();

	/* Compute RFC 6455 Sec-WebSocket-Key and expected Sec-WebSocket-Accept. */
	unsigned char nonce[16];
	char key_b64[32], concat[80];
	unsigned char sha1[20];
	random_bytes(nonce, sizeof nonce);
	b64_encode(key_b64, nonce, sizeof nonce);
	snprintf(concat, sizeof concat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key_b64);
	br_sha1_context s1;
	br_sha1_init(&s1);
	br_sha1_update(&s1, concat, strlen(concat));
	br_sha1_out(&s1, sha1);
	b64_encode(c->expected_accept, sha1, sizeof sha1);

	char req[512];
	int rlen = snprintf(req, sizeof req,
	                    "GET %s HTTP/1.1\r\n"
	                    "Host: %s:%d\r\n"
	                    "Upgrade: websocket\r\n"
	                    "Connection: Upgrade\r\n"
	                    "Sec-WebSocket-Key: %s\r\n"
	                    "Sec-WebSocket-Version: 13\r\n\r\n",
	                    path && path[0] ? path : "/", host, port, key_b64);
	if (rlen <= 0 || (size_t)rlen >= sizeof req || ws_tx_append(c, req, (size_t)rlen) < 0) {
		ws_close(c, "upgrade request too large");
		return -1;
	}

	if (use_tls) {
		ssl_profile(&c->cc);
		memset(&c->x509, 0, sizeof c->x509);
		c->x509.vtable = &any_x509_vtable;
		br_ssl_engine_set_x509(&c->cc.eng, &c->x509.vtable);
		br_ssl_engine_set_buffer(&c->cc.eng, c->iobuf, sizeof c->iobuf, 1);
		if (!br_ssl_client_reset(&c->cc, NULL, 0)) {
			ws_close(c, "TLS reset failed");
			return -1;
		}
	}
	return 0;
}

static int ws_rx_ensure(struct ws_conn *c, size_t extra) {
	if (c->rxn + extra <= c->rxcap) return 0;
	size_t ncap = c->rxcap ? c->rxcap * 2 : WS_RX_INIT;
	while (ncap < c->rxn + extra) ncap *= 2;
	if (ncap > WS_RX_BUF_MAX) return -1;
	unsigned char *nb = realloc(c->rx, ncap);
	if (!nb) return -1;
	c->rx = nb;
	c->rxcap = ncap;
	return 0;
}

static int ws_process_rx(struct ws_conn *c, ws_up_cb on_up, ws_text_cb on_text, void *owner) {
	if (!c->ws_up) {
		/* Find end of HTTP 101 upgrade response headers. */
		unsigned char *he = NULL;
		for (size_t i = 0; i + 4 <= c->rxn; i++) {
			if (c->rx[i] == '\r' && c->rx[i + 1] == '\n' && c->rx[i + 2] == '\r' && c->rx[i + 3] == '\n') {
				he = c->rx + i;
				break;
			}
		}
		if (!he) {
			if (c->rxn > 4096) { ws_close(c, "oversized WebSocket upgrade response"); return -1; }
			return 0;
		}
		size_t hlen = (size_t)(he - c->rx);
		char *hdrs = malloc(hlen + 1);
		if (!hdrs) { ws_close(c, "out of memory"); return -1; }
		memcpy(hdrs, c->rx, hlen);
		hdrs[hlen] = 0;
		int status_ok = (strncmp(hdrs, "HTTP/1.", 7) == 0 && strstr(hdrs, " 101 ") != NULL);
		int accept_ok = 0;
		char *acc = strcasestr(hdrs, "\r\nSec-WebSocket-Accept:");
		if (acc) {
			acc += 23;
			while (*acc == ' ' || *acc == '\t') acc++;
			char *eol = strstr(acc, "\r\n");
			size_t alen = eol ? (size_t)(eol - acc) : strlen(acc);
			while (alen && (acc[alen - 1] == ' ' || acc[alen - 1] == '\t')) alen--;
			if (alen == strlen(c->expected_accept) && !memcmp(acc, c->expected_accept, alen))
				accept_ok = 1;
		}
		free(hdrs);
		if (!status_ok || !accept_ok) {
			ws_close(c, status_ok ? "WebSocket accept mismatch" : "WebSocket upgrade refused");
			return -1;
		}
		size_t used = hlen + 4;
		memmove(c->rx, c->rx + used, c->rxn - used);
		c->rxn -= used;
		c->ws_up = 1;
		c->last_ping = now_ms();
		if (on_up) {
			on_up(owner);
			if (c->fd < 0) return -1;
		}
	}

	/* Parse complete RFC 6455 frames. */
	for (;;) {
		if (c->skip) {
			size_t drop = (uint64_t)c->rxn < c->skip ? c->rxn : (size_t)c->skip;
			memmove(c->rx, c->rx + drop, c->rxn - drop);
			c->rxn -= drop;
			c->skip -= drop;
			if (c->skip) return 0;
		}
		if (c->rxn < 2) return 0;
		unsigned char b0 = c->rx[0], b1 = c->rx[1];
		int fin = (b0 & 0x80) != 0;
		int opcode = b0 & 0x0f;
		int masked = (b1 & 0x80) != 0;
		uint64_t plen = b1 & 0x7f;
		size_t hlen = 2;
		if (plen == 126) {
			if (c->rxn < 4) return 0;
			plen = ((uint64_t)c->rx[2] << 8) | c->rx[3];
			hlen = 4;
		} else if (plen == 127) {
			if (c->rxn < 10) return 0;
			plen = 0;
			for (int i = 0; i < 8; i++) plen = (plen << 8) | c->rx[2 + i];
			hlen = 10;
		}
		if (masked) hlen += 4;
		if (plen > WS_RX_MAX) {
			/* Too big to buffer: discard it as it streams in and keep the
			 * session (one large reply must not cause a reconnect loop). A
			 * fragmented message it belongs to is dropped as a whole. */
			logmsg("dropped an oversized WebSocket frame (%llu bytes)", (unsigned long long)plen);
			if (opcode == 0x0 || (opcode == 0x1 && !fin)) { c->fragn = 0; c->frag_op = 0; }
			c->skip = (uint64_t)hlen + plen;
			continue;
		}
		if (c->rxn < hlen + (size_t)plen) return 0;

		unsigned char *payload = malloc((size_t)plen + 1);
		if (!payload) { ws_close(c, "out of memory"); return -1; }
		if (plen) memcpy(payload, c->rx + hlen, (size_t)plen);
		if (masked) {
			const unsigned char *mk = c->rx + hlen - 4;
			for (size_t i = 0; i < (size_t)plen; i++) payload[i] ^= mk[i & 3];
		}
		payload[plen] = 0;
		size_t total = hlen + (size_t)plen;
		memmove(c->rx, c->rx + total, c->rxn - total);
		c->rxn -= total;

		if (opcode == 0x8) { /* Close */
			free(payload);
			ws_close(c, "closed by the TV");
			return -1;
		} else if (opcode == 0x9) { /* Ping -> Pong */
			ws_send_frame(c, 0xA, payload, (size_t)plen);
			free(payload);
		} else if (opcode == 0xA) { /* Pong */
			free(payload);
		} else if (opcode == 0x1 || opcode == 0x0) {
			if (opcode == 0x1 && fin && c->fragn == 0) {
				if (on_text) on_text(owner, (const char *)payload, (size_t)plen);
				free(payload);
				if (c->fd < 0) return -1;
			} else {
				if (opcode == 0x1) { c->fragn = 0; c->frag_op = 0x1; }
				if (c->frag_op == 0x1) {
					if (c->fragn + (size_t)plen + 1 > WS_RX_MAX) {
						/* Drop the whole message; later fragments are ignored. */
						logmsg("dropped an oversized fragmented WebSocket message");
						free(payload);
						c->fragn = 0;
						c->frag_op = 0;
						continue;
					}
					if (c->fragn + (size_t)plen + 1 > c->fragcap) {
						size_t nc = c->fragcap ? c->fragcap * 2 : 16384;
						while (nc < c->fragn + (size_t)plen + 1) nc *= 2;
						unsigned char *nf = realloc(c->frag, nc);
						if (!nf) { free(payload); ws_close(c, "out of memory"); return -1; }
						c->frag = nf;
						c->fragcap = nc;
					}
					if (plen) memcpy(c->frag + c->fragn, payload, (size_t)plen);
					c->fragn += (size_t)plen;
					c->frag[c->fragn] = 0;
					free(payload);
					if (fin) {
						char *msg = malloc(c->fragn + 1);
						size_t mlen = c->fragn;
						c->fragn = 0;
						c->frag_op = 0;
						if (msg) {
							memcpy(msg, c->frag, mlen + 1);
							if (on_text) on_text(owner, msg, mlen);
							free(msg);
							if (c->fd < 0) return -1;
						}
					}
				} else {
					free(payload);
				}
			}
		} else {
			free(payload);
		}
	}
}

static int ws_pump(struct ws_conn *c, ws_up_cb on_up, ws_text_cb on_text, void *owner) {
	if (!c || c->fd < 0) return -1;
	if (c->connecting) {
		int err = 0;
		socklen_t el = sizeof err;
		struct pollfd p = { .fd = c->fd, .events = POLLOUT };
		if (poll(&p, 1, 0) != 1) return 0;
		getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &err, &el);
		if (err) {
			char why[96];
			snprintf(why, sizeof why, "connect: %s", strerror(err));
			ws_close(c, why);
			return -1;
		}
		c->connecting = 0;
		if (!c->use_tls) c->transport_up = 1;
	}

	if (!c->use_tls) {
		for (int guard = 0; guard < 64; guard++) {
			int did = 0;
			if (c->txn) {
				ssize_t w = send(c->fd, c->tx, c->txn, MSG_NOSIGNAL);
				if (w > 0) {
					memmove(c->tx, c->tx + w, c->txn - (size_t)w);
					c->txn -= (size_t)w;
					did = 1;
				} else if (w < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
					ws_close(c, "send failed");
					return -1;
				}
			}
			unsigned char tmp[4096];
			ssize_t r = recv(c->fd, tmp, sizeof tmp, 0);
			if (r > 0) {
				if (ws_rx_ensure(c, (size_t)r) < 0) { ws_close(c, "receive buffer overflow"); return -1; }
				memcpy(c->rx + c->rxn, tmp, (size_t)r);
				c->rxn += (size_t)r;
				c->last_rx = now_ms();
				if (ws_process_rx(c, on_up, on_text, owner) < 0) return -1;
				did = 1;
			} else if (r == 0) {
				ws_close(c, "closed by the TV");
				return -1;
			} else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
				ws_close(c, "receive failed");
				return -1;
			}
			if (!did) break;
		}
		return 0;
	}

	/* BearSSL TLS path */
	br_ssl_engine_context *eng = &c->cc.eng;
	for (int guard = 0; guard < 256; guard++) {
		unsigned st = br_ssl_engine_current_state(eng);
		if (st & BR_SSL_CLOSED) {
			int e = br_ssl_engine_last_error(eng);
			char why[96];
			snprintf(why, sizeof why, e ? "TLS error %d" : "closed by the TV", e);
			ws_close(c, why);
			return -1;
		}
		if (!c->transport_up && (st & BR_SSL_SENDAPP)) c->transport_up = 1;
		if (st & BR_SSL_SENDREC) {
			size_t len;
			unsigned char *buf = br_ssl_engine_sendrec_buf(eng, &len);
			ssize_t w = send(c->fd, buf, len, MSG_NOSIGNAL);
			if (w > 0) { br_ssl_engine_sendrec_ack(eng, (size_t)w); continue; }
			if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
			ws_close(c, "send failed");
			return -1;
		}
		if (st & BR_SSL_RECVAPP) {
			size_t len;
			unsigned char *buf = br_ssl_engine_recvapp_buf(eng, &len);
			if (ws_rx_ensure(c, len) < 0) { ws_close(c, "receive buffer overflow"); return -1; }
			memcpy(c->rx + c->rxn, buf, len);
			c->rxn += len;
			br_ssl_engine_recvapp_ack(eng, len);
			c->last_rx = now_ms();
			if (ws_process_rx(c, on_up, on_text, owner) < 0) return -1;
			continue;
		}
		if (c->transport_up && (st & BR_SSL_SENDAPP) && c->txn) {
			size_t len;
			unsigned char *buf = br_ssl_engine_sendapp_buf(eng, &len);
			if (len > c->txn) len = c->txn;
			memcpy(buf, c->tx, len);
			memmove(c->tx, c->tx + len, c->txn - len);
			c->txn -= len;
			br_ssl_engine_sendapp_ack(eng, len);
			br_ssl_engine_flush(eng, 0);
			continue;
		}
		if (st & BR_SSL_RECVREC) {
			size_t len;
			unsigned char *buf = br_ssl_engine_recvrec_buf(eng, &len);
			ssize_t r = recv(c->fd, buf, len, 0);
			if (r > 0) { br_ssl_engine_recvrec_ack(eng, (size_t)r); c->last_rx = now_ms(); continue; }
			if (r == 0) { ws_close(c, "closed by the TV"); return -1; }
			if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
			ws_close(c, "receive failed");
			return -1;
		}
		return 0;
	}
	return 0;
}

static short ws_events(const struct ws_conn *c) {
	if (!c || c->fd < 0) return 0;
	if (c->connecting) return POLLOUT;
	short ev = POLLIN;
	if (!c->use_tls) {
		if (c->txn) ev |= POLLOUT;
		return ev;
	}
	unsigned st = br_ssl_engine_current_state(&c->cc.eng);
	if (st & BR_SSL_SENDREC) ev |= POLLOUT;
	if (c->txn && (st & BR_SSL_SENDAPP)) ev |= POLLOUT;
	return ev;
}

/* ================================================================== Wake-on-LAN */

static void arp_lookup(const char *host, char *mac, size_t cap) {
	FILE *f = fopen("/proc/net/arp", "r");
	if (!f) return;
	char line[256];
	while (fgets(line, sizeof line, f)) {
		char ip[32], hw[32], norm[18];
		if (sscanf(line, "%31s %*s %*s %31s", ip, hw) == 2 && !strcmp(ip, host) &&
		    normalize_mac(hw, norm) == 0 && norm[0]) {
			snprintf(mac, cap, "%s", norm);
			break;
		}
	}
	fclose(f);
}

static int wol_sendto(int fd, const unsigned char *pkt, size_t len, struct in_addr dst) {
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_addr = dst;
	int sent = 0;
	for (int port = 7; port <= 9; port += 2) {
		sa.sin_port = htons((uint16_t)port);
		for (int k = 0; k < 2; k++)
			if (sendto(fd, pkt, len, 0, (struct sockaddr *)&sa, sizeof sa) == (ssize_t)len) sent = 1;
	}
	return sent;
}

static int wol_send_on(const char *ifname, const unsigned char *pkt, size_t len, struct in_addr dst) {
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0) return 0;
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
#ifdef SO_BINDTODEVICE
	setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, ifname, (socklen_t)strlen(ifname) + 1);
#else
	(void)ifname;
#endif
	int sent = wol_sendto(fd, pkt, len, dst);
	close(fd);
	return sent;
}

static int send_wol(const char *mac) {
	char norm[18];
	if (normalize_mac(mac, norm) < 0 || !norm[0]) return 0;
	unsigned m[6];
	if (sscanf(norm, "%x:%x:%x:%x:%x:%x", &m[0], &m[1], &m[2], &m[3], &m[4], &m[5]) != 6) return 0;
	unsigned char pkt[102];
	memset(pkt, 0xff, 6);
	for (int i = 0; i < 16; i++)
		for (int j = 0; j < 6; j++)
			pkt[6 + i * 6 + j] = (unsigned char)m[j];
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0) return 0;
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
	char via[200] = "";
	size_t used = 0;
	struct ifaddrs *ifs = NULL;
	if (getifaddrs(&ifs) == 0) {
		for (struct ifaddrs *a = ifs; a; a = a->ifa_next) {
			if (!a->ifa_name || !a->ifa_addr || a->ifa_addr->sa_family != AF_INET || !a->ifa_broadaddr) continue;
			if (!(a->ifa_flags & IFF_UP) || !(a->ifa_flags & IFF_RUNNING) || !(a->ifa_flags & IFF_BROADCAST) ||
			    (a->ifa_flags & IFF_LOOPBACK)) continue;
			struct in_addr b = ((struct sockaddr_in *)a->ifa_broadaddr)->sin_addr;
			if (b.s_addr == htonl(INADDR_BROADCAST) || b.s_addr == 0) continue;
			if (wol_send_on(a->ifa_name, pkt, sizeof pkt, b) && used + 40 < sizeof via)
				used += (size_t)snprintf(via + used, sizeof via - used, "%s%s (%.15s)",
				                         used ? ", " : "", inet_ntoa(b), a->ifa_name);
		}
		freeifaddrs(ifs);
	}
	struct in_addr all = { htonl(INADDR_BROADCAST) };
	int global = wol_sendto(fd, pkt, sizeof pkt, all);
	int err = errno;
	close(fd);
	if (used || global) {
		logmsg("sent Wake-on-LAN to %s via %s%s%s", norm, via, used && global ? ", " : "",
		       global ? "255.255.255.255" : "");
		return 1;
	}
	logmsg("Wake-on-LAN to %s failed: %s", norm, strerror(err));
	return 0;
}

/* ================================================================== SSAP register payload */

static const char REGISTER_MANIFEST[] =
	"{\"manifestVersion\":1,\"appVersion\":\"1.1\","
	"\"signed\":{\"created\":\"20140509\",\"appId\":\"com.lge.test\",\"vendorId\":\"com.lge\","
	"\"localizedAppNames\":{\"\":\"Melodious\"},\"localizedVendorNames\":{\"\":\"Melodious\"},"
	"\"permissions\":[\"TEST_SECURE\",\"CONTROL_INPUT_TEXT\",\"CONTROL_MOUSE_AND_KEYBOARD\","
	"\"READ_INSTALLED_APPS\",\"READ_LGE_SDX\",\"READ_NOTIFICATIONS\",\"SEARCH\",\"WRITE_SETTINGS\","
	"\"WRITE_NOTIFICATION_ALERT\",\"CONTROL_POWER\",\"READ_CURRENT_CHANNEL\",\"READ_RUNNING_APPS\","
	"\"READ_UPDATE_INFO\",\"UPDATE_FROM_REMOTE_APP\",\"READ_LGE_TV_INPUT_EVENTS\",\"READ_TV_CURRENT_TIME\"]},"
	"\"permissions\":[\"LAUNCH\",\"LAUNCH_WEBAPP\",\"APP_TO_APP\",\"CLOSE\",\"TEST_OPEN\",\"TEST_PROTECTED\","
	"\"CONTROL_AUDIO\",\"CONTROL_DISPLAY\",\"CONTROL_INPUT_JOYSTICK\",\"CONTROL_INPUT_MEDIA_RECORDING\","
	"\"CONTROL_INPUT_MEDIA_PLAYBACK\",\"CONTROL_INPUT_TV\",\"CONTROL_POWER\",\"READ_APP_STATUS\","
	"\"READ_CURRENT_CHANNEL\",\"READ_INPUT_DEVICE_LIST\",\"READ_NETWORK_STATE\",\"READ_RUNNING_APPS\","
	"\"READ_TV_CHANNEL_LIST\",\"WRITE_NOTIFICATION_TOAST\",\"READ_POWER_STATE\",\"READ_COUNTRY_INFO\","
	"\"READ_INSTALLED_APPS\",\"CONTROL_INPUT_TEXT\",\"CONTROL_MOUSE_AND_KEYBOARD\"]}";

static int ssap_send_register(struct ws_conn *c, const char *req_id, const char *client_key, int force_pairing) {
	char buf[2048];
	int n;
	if (client_key && client_key[0] && !force_pairing) {
		n = snprintf(buf, sizeof buf,
		             "{\"type\":\"register\",\"id\":\"%s\",\"payload\":{\"forcePairing\":false,"
		             "\"pairingType\":\"PROMPT\",\"client-key\":\"%s\",\"manifest\":%s}}",
		             req_id, client_key, REGISTER_MANIFEST);
	} else {
		n = snprintf(buf, sizeof buf,
		             "{\"type\":\"register\",\"id\":\"%s\",\"payload\":{\"forcePairing\":%s,"
		             "\"pairingType\":\"PROMPT\",\"manifest\":%s}}",
		             req_id, force_pairing ? "true" : "false", REGISTER_MANIFEST);
	}
	if (n <= 0 || (size_t)n >= sizeof buf) return -1;
	return ws_send_text(c, buf, (size_t)n);
}

static int ssap_send(struct ws_conn *c, const char *type, const char *req_id, const char *uri,
                     const char *payload_json) {
	char buf[1024];
	int n;
	if (payload_json && payload_json[0]) {
		n = snprintf(buf, sizeof buf,
		             "{\"id\":\"%s\",\"type\":\"%s\",\"uri\":\"%s\",\"payload\":%s}",
		             req_id, type, uri, payload_json);
	} else {
		n = snprintf(buf, sizeof buf,
		             "{\"id\":\"%s\",\"type\":\"%s\",\"uri\":\"%s\"}",
		             req_id, type, uri);
	}
	if (n <= 0 || (size_t)n >= sizeof buf) return -1;
	return ws_send_text(c, buf, (size_t)n);
}

static int ssap_send_request(struct ws_conn *c, const char *req_id, const char *uri, const char *payload_json) {
	return ssap_send(c, "request", req_id, uri, payload_json);
}

/* ================================================================== TV state & persistence */

enum { PROTO_AUTO = 0, PROTO_WSS = 1, PROTO_WS = 2 };
static const char *PROTO_NAMES[] = { "auto", "wss", "ws" };

static int proto_from_str(const char *s) {
	if (!s || !*s || !strcmp(s, "auto")) return PROTO_AUTO;
	if (!strcmp(s, "wss")) return PROTO_WSS;
	if (!strcmp(s, "ws")) return PROTO_WS;
	return -1;
}

struct webos_input {
	char id[32];    /* stable port id, e.g. HDMI_1 */
	char label[64]; /* display label */
};

struct webos_app {
	char id[96];
	char title[64];
	char cmd[64];   /* canonical command name: "App <title>" */
};

struct tv {
	int used;
	char id[TV_ID_MAX];
	char host[16];
	char mac[18];
	int proto;       /* PROTO_AUTO / PROTO_WSS / PROTO_WS */
	int prefer_ws;   /* in PROTO_AUTO: 0 = try wss first, 1 = try ws first */
	int ws_port, wss_port;
	char name[65];
	char client_key[CLIENT_KEY_MAX]; /* NEVER logged or exposed in HTTP replies */

	struct ws_conn *c;
	struct ws_conn *ptr;
	int registered;
	int ptr_ready;
	int volume;
	int muted;
	int media_playing;
	char active_input[32];
	char last_err[128];

	struct webos_input inputs[MAX_INPUTS];
	int ninputs;
	struct webos_app apps[MAX_APPS];
	int napps;

	/* Newer TVs keep the session open in standby (Quick Start+), so the
	 * socket alone can't tell on from off; the power-state subscription can. */
	int standby;

	unsigned seq;
	char req_vol[24], req_inputs[24], req_apps[24], req_ptr[24], req_pwr[24], req_off[24];

	long long next_attempt, last_wol, waking_until;
	int backoff;
	unsigned long cmds, connects;
};

static struct tv tvs[MAX_TVS];

static struct tv *tv_by_id(const char *id) {
	for (int i = 0; i < MAX_TVS; i++)
		if (tvs[i].used && !strcmp(tvs[i].id, id)) return &tvs[i];
	return NULL;
}

static struct tv *tv_by_host(const char *host) {
	for (int i = 0; i < MAX_TVS; i++)
		if (tvs[i].used && !strcmp(tvs[i].host, host)) return &tvs[i];
	return NULL;
}

static int tv_count(void) {
	int n = 0;
	for (int i = 0; i < MAX_TVS; i++) n += tvs[i].used;
	return n;
}

static void make_tv_id(char out[TV_ID_MAX]) {
	for (int tries = 0; tries < 32; tries++) {
		unsigned char r[4];
		random_bytes(r, sizeof r);
		char hx[9];
		hex_encode(hx, r, 4);
		snprintf(out, TV_ID_MAX, "%s%s", TV_ID_PREFIX, hx);
		if (!tv_by_id(out)) return;
	}
}

static int tvs_save(void) {
	mkdir(opt_dir, 0700);
	char path[320];
	path_in_dir(path, sizeof path, "tvs.tsv");
	char buf[MAX_TVS * 384];
	size_t n = 0;
	for (int i = 0; i < MAX_TVS; i++) {
		struct tv *t = &tvs[i];
		if (!t->used) continue;
		n += (size_t)snprintf(buf + n, sizeof buf - n, "%s\t%s\t%s\t%s\t%s\t%s\n",
		                      t->id, t->host,
		                      t->mac[0] ? t->mac : "-",
		                      PROTO_NAMES[t->proto],
		                      t->name[0] ? t->name : "LG webOS TV",
		                      t->client_key[0] ? t->client_key : "-");
	}
	int rc = write_file_atomic(path, buf, n, 0600);
	secure_zero(buf, sizeof buf);
	return rc;
}

static void tvs_load(void) {
	char path[320];
	path_in_dir(path, sizeof path, "tvs.tsv");
	size_t len = 0;
	char *text = (char *)read_file(path, &len);
	if (!text) return;
	text = realloc(text, len + 1);
	if (!text) return;
	text[len] = 0;
	char *save = NULL;
	for (char *line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
		char *f[6] = {0};
		int nf = 0;
		for (char *p = line; nf < 6; ) {
			f[nf++] = p;
			char *tab = strchr(p, '\t');
			if (!tab) break;
			*tab = 0;
			p = tab + 1;
		}
		if (nf < 6) continue;
		if (!valid_tv_id(f[0]) || !valid_ipv4(f[1])) continue;
		struct tv *t = NULL;
		for (int i = 0; i < MAX_TVS && !t; i++) if (!tvs[i].used) t = &tvs[i];
		if (!t) break;
		memset(t, 0, sizeof *t);
		snprintf(t->id, sizeof t->id, "%s", f[0]);
		snprintf(t->host, sizeof t->host, "%s", f[1]);
		if (strcmp(f[2], "-") != 0) normalize_mac(f[2], t->mac);
		int p = proto_from_str(f[3]);
		t->proto = p >= 0 ? p : PROTO_AUTO;
		snprintf(t->name, sizeof t->name, "%s", f[4]);
		sanitize_name(t->name);
		if (strcmp(f[5], "-") != 0 && valid_client_key(f[5]))
			snprintf(t->client_key, sizeof t->client_key, "%s", f[5]);
		t->ws_port = opt_ws_port;
		t->wss_port = opt_wss_port;
		t->used = 1;
		t->backoff = 1000;
		t->volume = -1;
		logmsg("loaded TV %s (%s) at %s (paired=%s)", t->id, t->name, t->host,
		       t->client_key[0] ? "yes" : "no");
	}
	secure_zero(text, len);
	free(text);
}

/* ================================================================== App/Input command formatting */

/* Mirror ha-melodious/devices.py _prefixed_command_name("App", title, taken) */
static void format_app_cmd(const char *title, char out[64], const struct tv *t, int existing_count) {
	char clean[48];
	size_t o = 0;
	int last_space = 1;
	for (const char *p = title; *p && o < 38; p++) {
		unsigned char ch = (unsigned char)*p;
		int ok = isalnum(ch) || ch == '_' || ch == '.' || ch == '+' || ch == '-';
		if (ok) { clean[o++] = (char)ch; last_space = 0; }
		else if (ch == ' ' && !last_space) { clean[o++] = ' '; last_space = 1; }
	}
	while (o > 0 && clean[o - 1] == ' ') o--;
	clean[o] = 0;
	if (!clean[0]) snprintf(clean, sizeof clean, "App");

	char base[48];
	snprintf(base, sizeof base, "App %s", clean);
	snprintf(out, 64, "%s", base);
	int suffix = 2;
	for (;;) {
		int dup = 0;
		for (int i = 0; i < existing_count; i++) {
			if (!strcasecmp(t->apps[i].cmd, out)) { dup = 1; break; }
		}
		if (!dup) break;
		snprintf(out, 64, "%.40s %d", base, suffix++);
	}
}

/* Parse socketPath like "wss://192.168.1.40:3001/resources/abc/netinput.pointer.sock"
 * Strictly verify that host matches expected_host to prevent SSRF. */
static int parse_pointer_url(const char *url, const char *expected_host,
                             int *use_tls, int *port, char *path, size_t path_cap) {
	const char *p = url;
	if (!strncmp(p, "wss://", 6)) { *use_tls = 1; p += 6; }
	else if (!strncmp(p, "ws://", 5)) { *use_tls = 0; p += 5; }
	else return -1;

	const char *slash = strchr(p, '/');
	if (!slash) return -1;
	const char *colon = memchr(p, ':', (size_t)(slash - p));
	char host[32];
	size_t hlen = colon ? (size_t)(colon - p) : (size_t)(slash - p);
	if (hlen == 0 || hlen >= sizeof host) return -1;
	memcpy(host, p, hlen);
	host[hlen] = 0;
	if (strcmp(host, expected_host) != 0) return -1;

	if (colon) {
		char *end = NULL;
		long prt = strtol(colon + 1, &end, 10);
		if (end != slash || prt < 1 || prt > 65535) return -1;
		*port = (int)prt;
	} else {
		*port = *use_tls ? DEFAULT_WSS_PORT : DEFAULT_WS_PORT;
	}
	if (strlen(slash) >= path_cap) return -1;
	snprintf(path, path_cap, "%s", slash);
	return 0;
}

/* ================================================================== TV connection & SSAP handlers */

static void tv_next_req(struct tv *t, const char *prefix, char out[24]) {
	snprintf(out, 24, "%s_%u", prefix, ++t->seq);
}

static void tv_request_metadata(struct tv *t) {
	if (!t->c || !t->registered) return;
	tv_next_req(t, "vol", t->req_vol);
	ssap_send_request(t->c, t->req_vol, "ssap://audio/getVolume", NULL);
	tv_next_req(t, "inp", t->req_inputs);
	ssap_send_request(t->c, t->req_inputs, "ssap://tv/getExternalInputList", NULL);
	tv_next_req(t, "app", t->req_apps);
	/* Launch points are the home-screen apps (~28 KB on webOS 24); listApps
	 * also returns every hidden system app and outgrows WS_RX_MAX (170 KB). */
	ssap_send_request(t->c, t->req_apps, "ssap://com.webos.applicationManager/listLaunchPoints", NULL);
	if (!t->ptr || t->ptr->fd < 0) {
		tv_next_req(t, "ptr", t->req_ptr);
		ssap_send_request(t->c, t->req_ptr, "ssap://com.webos.service.networkinput/getPointerInputSocket", NULL);
	}
}

static void tv_ptr_up(void *owner) {
	struct tv *t = owner;
	t->ptr_ready = 1;
	logmsg("TV %s: pointer input socket ready", t->id);
}

static void tv_ptr_text(void *owner, const char *text, size_t len) {
	(void)owner; (void)text; (void)len;
}

static void tv_open_pointer(struct tv *t, const char *socket_path) {
	int use_tls = 0, port = 0;
	char path[256];
	if (parse_pointer_url(socket_path, t->host, &use_tls, &port, path, sizeof path) < 0) {
		logmsg("TV %s: rejected pointer socketPath (host mismatch or invalid URL)", t->id);
		return;
	}
	if (!t->ptr) {
		t->ptr = calloc(1, sizeof *t->ptr);
		if (!t->ptr) return;
		t->ptr->fd = -1;
	}
	t->ptr_ready = 0;
	if (ws_open(t->ptr, t->host, port, path, use_tls) < 0) {
		logmsg("TV %s: pointer socket open failed: %s", t->id, t->ptr->error);
	}
}

static void tv_parse_inputs(struct tv *t, const char *payload, const char *pend) {
	const char *de = NULL;
	const char *devs = j_obj_find(payload, pend, "devices", &de);
	if (!devs) return;
	const char *p = j_skip_ws(devs, de);
	if (p >= de || *p != '[') return;
	p++;
	t->ninputs = 0;
	while (p < de && t->ninputs < MAX_INPUTS) {
		p = j_skip_ws(p, de);
		if (p >= de || *p == ']') break;
		if (*p == ',') { p++; continue; }
		const char *el_end = j_skip_val(p, de);
		if (*p == '{') {
			char id[32] = "", label[64] = "";
			if (j_obj_str(p, el_end, "id", id, sizeof id) == 0 && !strncmp(id, "HDMI_", 5)) {
				j_obj_str(p, el_end, "label", label, sizeof label);
				sanitize_name(label);
				if (!label[0]) snprintf(label, sizeof label, "HDMI %s", id + 5);
				/* Deduplicate by stable port id */
				int dup = 0;
				for (int i = 0; i < t->ninputs; i++)
					if (!strcmp(t->inputs[i].id, id)) { dup = 1; break; }
				if (!dup) {
					snprintf(t->inputs[t->ninputs].id, sizeof t->inputs[0].id, "%s", id);
					snprintf(t->inputs[t->ninputs].label, sizeof t->inputs[0].label, "%s", label);
					t->ninputs++;
				}
			}
		}
		p = el_end;
	}
	DBG("TV %s: discovered %d HDMI input(s)", t->id, t->ninputs);
}

static void tv_parse_apps(struct tv *t, const char *payload, const char *pend) {
	const char *ae = NULL;
	const char *apps = j_obj_find(payload, pend, "apps", &ae);
	if (!apps) apps = j_obj_find(payload, pend, "launchPoints", &ae);
	if (!apps) return;
	const char *p = j_skip_ws(apps, ae);
	if (p >= ae || *p != '[') return;
	p++;
	t->napps = 0;
	while (p < ae && t->napps < MAX_APPS) {
		p = j_skip_ws(p, ae);
		if (p >= ae || *p == ']') break;
		if (*p == ',') { p++; continue; }
		const char *el_end = j_skip_val(p, ae);
		if (*p == '{') {
			char id[96] = "", title[64] = "";
			int visible = 1, sysapp = 0;
			j_obj_bool(p, el_end, "visible", &visible);
			j_obj_bool(p, el_end, "systemApp", &sysapp);
			if (visible && !sysapp &&
			    j_obj_str(p, el_end, "id", id, sizeof id) == 0 && id[0] &&
			    strncmp(id, "com.webos.app.hdmi", 18) != 0 &&
			    j_obj_str(p, el_end, "title", title, sizeof title) == 0 && title[0]) {
				sanitize_name(title);
				int dup = 0;
				for (int i = 0; i < t->napps; i++)
					if (!strcmp(t->apps[i].id, id)) { dup = 1; break; }
				if (!dup) {
					snprintf(t->apps[t->napps].id, sizeof t->apps[0].id, "%s", id);
					snprintf(t->apps[t->napps].title, sizeof t->apps[0].title, "%s", title);
					format_app_cmd(title, t->apps[t->napps].cmd, t, t->napps);
					t->napps++;
				}
			}
		}
		p = el_end;
	}
	DBG("TV %s: discovered %d app(s)", t->id, t->napps);
}

/* getPowerState: "Active", "Screen Off" and "Screen Saver" are on; "Active
 * Standby", "Suspend" and "Power Off" (or a pending request for one) are off. */
static void tv_parse_power(struct tv *t, const char *payload, const char *pend) {
	char state[48] = "", processing[64] = "";
	if (j_obj_str(payload, pend, "state", state, sizeof state) < 0 || !state[0]) return;
	j_obj_str(payload, pend, "processing", processing, sizeof processing);
	int off = !strcmp(state, "Active Standby") || !strcmp(state, "Suspend") ||
	          !strcmp(state, "Power Off") || strstr(processing, "Power Off") ||
	          strstr(processing, "Suspend") || strstr(processing, "Active Standby");
	if (off != t->standby) logmsg("TV %s: power state %s%s%s", t->id, state,
	                              processing[0] ? ", " : "", processing);
	t->standby = off;
	if (!off) t->waking_until = 0;
}

static void tv_ws_up(void *owner) {
	struct tv *t = owner;
	DBG("TV %s: WebSocket up (%s), sending register", t->id, t->c->use_tls ? "wss" : "ws");
	ssap_send_register(t->c, "register_0", t->client_key, 0);
}

static void tv_ws_text(void *owner, const char *text, size_t len) {
	struct tv *t = owner;
	const char *end = text + len;
	char type[32] = "", id[32] = "";
	j_obj_str(text, end, "type", type, sizeof type);
	j_obj_str(text, end, "id", id, sizeof id);
	const char *pend = NULL;
	const char *payload = j_obj_find(text, end, "payload", &pend);

	if (!strcmp(type, "registered")) {
		if (payload) {
			char key[CLIENT_KEY_MAX] = "";
			if (j_obj_str(payload, pend, "client-key", key, sizeof key) == 0 && valid_client_key(key)) {
				if (strcmp(t->client_key, key) != 0) {
					snprintf(t->client_key, sizeof t->client_key, "%s", key);
					tvs_save();
				}
				secure_zero(key, sizeof key);
			}
		}
		if (!t->registered) {
			logmsg("TV %s (%s): connected and registered via %s", t->id, t->name,
			       t->c->use_tls ? "wss" : "ws");
		}
		t->registered = 1;
		t->standby = 0;
		t->backoff = 1000;
		t->waking_until = 0;
		t->last_err[0] = 0;
		if (t->proto == PROTO_AUTO) t->prefer_ws = t->c->use_tls ? 0 : 1;
		tv_next_req(t, "pwr", t->req_pwr);
		ssap_send(t->c, "subscribe", t->req_pwr, "ssap://com.webos.service.tvpower/power/getPowerState", NULL);
		tv_request_metadata(t);
		return;
	}

	if (!strcmp(type, "error")) {
		char err[96] = "";
		j_obj_str(text, end, "error", err, sizeof err);
		if (!strcmp(id, "register_0")) {
			logmsg("TV %s: registration rejected (%s)", t->id, err[0] ? err : "error");
			snprintf(t->last_err, sizeof t->last_err, "TV rejected stored pairing; pair again");
			ws_close(t->c, t->last_err);
			t->registered = 0;
			t->next_attempt = now_ms() + 30000;
		} else if (t->req_off[0] && !strcmp(id, t->req_off)) {
			logmsg("TV %s: PowerOff refused (%s)", t->id, err[0] ? err : "error");
			t->standby = 0;
		} else {
			DBG("TV %s: SSAP error on %s: %s", t->id, id, err);
		}
		return;
	}

	if (!strcmp(type, "response") && payload) {
		if (!strcmp(id, t->req_pwr)) {
			tv_parse_power(t, payload, pend);
		} else if (!strcmp(id, t->req_vol)) {
			const char *vse = NULL;
			const char *vs = j_obj_find(payload, pend, "volumeStatus", &vse);
			int v = -1, m = -1;
			if (vs) {
				j_obj_int(vs, vse, "volume", &v);
				j_obj_bool(vs, vse, "muteStatus", &m);
			}
			if (v < 0) j_obj_int(payload, pend, "volume", &v);
			if (m < 0) j_obj_bool(payload, pend, "muted", &m);
			if (v >= 0) t->volume = v;
			if (m >= 0) t->muted = m;
		} else if (!strcmp(id, t->req_inputs)) {
			tv_parse_inputs(t, payload, pend);
		} else if (!strcmp(id, t->req_apps)) {
			tv_parse_apps(t, payload, pend);
		} else if (!strcmp(id, t->req_ptr)) {
			char sp[256] = "";
			if (j_obj_str(payload, pend, "socketPath", sp, sizeof sp) == 0 && sp[0]) {
				tv_open_pointer(t, sp);
			}
		}
	}
}

static void tv_lost(struct tv *t, const char *why) {
	int was_tls = t->c ? t->c->use_tls : 0;
	int was_reg = t->registered;
	if (t->c && t->c->fd >= 0) ws_close(t->c, why);
	if (t->ptr && t->ptr->fd >= 0) ws_close(t->ptr, "control lost");
	t->registered = 0;
	t->ptr_ready = 0;
	snprintf(t->last_err, sizeof t->last_err, "%s", why ? why : "disconnected");
	if (was_reg) logmsg("TV %s: disconnected (%s)", t->id, t->last_err);

	/* In AUTO mode, if we never reached registered state, immediately flip
	 * between wss:3001 and ws:3000 before backing off. */
	if (t->proto == PROTO_AUTO && !was_reg) {
		if (!was_tls) {
			t->prefer_ws = 0;
			t->next_attempt = now_ms() + t->backoff;
			t->backoff = t->backoff < 30000 ? t->backoff * 2 : 30000;
		} else {
			t->prefer_ws = 1;
			t->next_attempt = now_ms() + 100;
		}
	} else {
		t->next_attempt = now_ms() + t->backoff;
		t->backoff = t->backoff < 30000 ? t->backoff * 2 : 30000;
	}
}

static void tv_connect(struct tv *t) {
	if (!t->used || !t->client_key[0]) return;
	if (!t->c) {
		t->c = calloc(1, sizeof *t->c);
		if (!t->c) return;
		t->c->fd = -1;
	}
	t->registered = 0;
	int use_tls = (t->proto == PROTO_WSS) ? 1 : (t->proto == PROTO_WS) ? 0 : !t->prefer_ws;
	int port = use_tls ? (t->wss_port > 0 ? t->wss_port : opt_wss_port)
	                   : (t->ws_port > 0 ? t->ws_port : opt_ws_port);
	t->next_attempt = now_ms() + t->backoff;
	if (ws_open(t->c, t->host, port, "/", use_tls) < 0) {
		tv_lost(t, t->c->error);
		return;
	}
	t->connects++;
	if (!t->mac[0]) {
		arp_lookup(t->host, t->mac, sizeof t->mac);
		if (t->mac[0]) tvs_save();
	}
}

/* ================================================================== Pairing state machine */

enum { P_IDLE, P_CONNECTING, P_PROMPT, P_PAIRED, P_DENIED, P_FAILED };
static const char *PSTATE[] = { "idle", "connecting", "prompt", "paired", "denied", "failed" };

static struct {
	int state;
	char tv_id[TV_ID_MAX];
	char host[16];
	char mac[18];
	char name[65];
	int proto;
	int tried_fallback;
	int ws_port, wss_port;
	char error[160];
	long long started;
	struct ws_conn *c;
} pair;

static void pair_fail(int state, const char *why) {
	if (pair.c) ws_close(pair.c, why);
	pair.state = state;
	snprintf(pair.error, sizeof pair.error, "%s", why ? why : "pairing failed");
	logmsg("pairing with %s (%s): %s", pair.host, PSTATE[state], pair.error);
}

static void pair_ws_up(void *owner) {
	(void)owner;
	DBG("pairing with %s: WebSocket up (%s), sending register", pair.host, pair.c->use_tls ? "wss" : "ws");
	ssap_send_register(pair.c, "pair_0", NULL, 1);
}

static void pair_ws_text(void *owner, const char *text, size_t len) {
	(void)owner;
	const char *end = text + len;
	char type[32] = "";
	j_obj_str(text, end, "type", type, sizeof type);
	const char *pend = NULL;
	const char *payload = j_obj_find(text, end, "payload", &pend);

	if (!strcmp(type, "response") && payload) {
		char ptype[32] = "";
		j_obj_str(payload, pend, "pairingType", ptype, sizeof ptype);
		if (!strcmp(ptype, "PROMPT")) {
			pair.state = P_PROMPT;
			pair.started = now_ms();
			logmsg("pairing with %s: waiting for user to accept prompt on TV", pair.host);
		}
		return;
	}

	if (!strcmp(type, "error")) {
		char err[96] = "", etxt[96] = "";
		j_obj_str(text, end, "error", err, sizeof err);
		if (payload) j_obj_str(payload, pend, "errorText", etxt, sizeof etxt);
		if (strstr(err, "403") || strcasestr(err, "reject") || strcasestr(err, "cancel") ||
		    strcasestr(etxt, "reject") || strcasestr(etxt, "cancel")) {
			pair_fail(P_DENIED, "Pairing was declined on the TV. Try again and choose Accept on the TV.");
		} else {
			char msg[160];
			snprintf(msg, sizeof msg, "The TV refused pairing (%s).", etxt[0] ? etxt : err[0] ? err : "error");
			pair_fail(P_FAILED, msg);
		}
		return;
	}

	if (!strcmp(type, "registered") && payload) {
		char key[CLIENT_KEY_MAX] = "";
		if (j_obj_str(payload, pend, "client-key", key, sizeof key) < 0 || !valid_client_key(key)) {
			pair_fail(P_FAILED, "The TV completed pairing without returning a valid client key.");
			return;
		}
		struct tv *t = pair.tv_id[0] ? tv_by_id(pair.tv_id) : tv_by_host(pair.host);
		if (!t) {
			for (int i = 0; i < MAX_TVS && !t; i++)
				if (!tvs[i].used) t = &tvs[i];
		}
		if (!t) {
			secure_zero(key, sizeof key);
			pair_fail(P_FAILED, "Already paired with the maximum number of webOS TVs (8).");
			return;
		}
		int existed = t->used;
		if (!existed) {
			memset(t, 0, sizeof *t);
			make_tv_id(t->id);
			t->backoff = 1000;
			t->volume = -1;
		}
		snprintf(t->host, sizeof t->host, "%s", pair.host);
		if (pair.mac[0]) snprintf(t->mac, sizeof t->mac, "%s", pair.mac);
		else if (!t->mac[0]) arp_lookup(t->host, t->mac, sizeof t->mac);
		snprintf(t->name, sizeof t->name, "%s", pair.name[0] ? pair.name : (t->name[0] ? t->name : "LG webOS TV"));
		sanitize_name(t->name);
		t->proto = pair.proto;
		t->prefer_ws = pair.c->use_tls ? 0 : 1;
		t->ws_port = pair.ws_port > 0 ? pair.ws_port : opt_ws_port;
		t->wss_port = pair.wss_port > 0 ? pair.wss_port : opt_wss_port;
		snprintf(t->client_key, sizeof t->client_key, "%s", key);
		secure_zero(key, sizeof key);
		t->used = 1;
		if (tvs_save() < 0) {
			pair_fail(P_FAILED, "Could not save paired TV configuration on the hub.");
			return;
		}
		if (t->c && t->c->fd >= 0) ws_close(t->c, "re-paired");
		if (t->ptr && t->ptr->fd >= 0) ws_close(t->ptr, "re-paired");
		t->registered = 0;
		t->ptr_ready = 0;
		t->backoff = 1000;
		t->next_attempt = 0;
		snprintf(pair.tv_id, sizeof pair.tv_id, "%s", t->id);
		pair.state = P_PAIRED;
		pair.error[0] = 0;
		ws_close(pair.c, "paired");
		logmsg("paired TV %s (%s) at %s via %s (key stored)", t->id, t->name, t->host,
		       t->prefer_ws ? "ws" : "wss");
	}
}

static void pair_begin_connect(int use_tls) {
	if (!pair.c) {
		pair.c = calloc(1, sizeof *pair.c);
		if (!pair.c) { pair_fail(P_FAILED, "out of memory"); return; }
		pair.c->fd = -1;
	}
	int port = use_tls ? (pair.wss_port > 0 ? pair.wss_port : opt_wss_port)
	                   : (pair.ws_port > 0 ? pair.ws_port : opt_ws_port);
	pair.state = P_CONNECTING;
	pair.started = now_ms();
	if (ws_open(pair.c, pair.host, port, "/", use_tls) < 0) {
		if (pair.proto == PROTO_AUTO && use_tls && !pair.tried_fallback) {
			pair.tried_fallback = 1;
			pair_begin_connect(0);
			return;
		}
		char why[160];
		snprintf(why, sizeof why, "Could not reach the TV at %s (%s). Is it powered on and on the LAN?",
		         pair.host, pair.c->error);
		pair_fail(P_FAILED, why);
	}
}

/* ================================================================== Command dispatch */

static const struct { const char *cmd; const char *btn; } POINTER_KEYS[] = {
	{"DirectionUp", "UP"},
	{"DirectionDown", "DOWN"},
	{"DirectionLeft", "LEFT"},
	{"DirectionRight", "RIGHT"},
	{"Select", "ENTER"},
	{"Back", "BACK"},
	{"Return", "BACK"},
	{"Home", "HOME"},
	{"Exit", "EXIT"},
	{"Menu", "MENU"},
	{"Info", "INFO"},
	{"Guide", "GUIDE"},
	{"ChannelUp", "CHANNELUP"},
	{"ChannelDown", "CHANNELDOWN"},
	{"Red", "RED"},
	{"Green", "GREEN"},
	{"Yellow", "YELLOW"},
	{"Blue", "BLUE"},
	{"Dash", "DASH"},
	{"Record", "RECORD"},
	{"0", "0"}, {"1", "1"}, {"2", "2"}, {"3", "3"}, {"4", "4"},
	{"5", "5"}, {"6", "6"}, {"7", "7"}, {"8", "8"}, {"9", "9"},
	{"Number0", "0"}, {"Number1", "1"}, {"Number2", "2"}, {"Number3", "3"}, {"Number4", "4"},
	{"Number5", "5"}, {"Number6", "6"}, {"Number7", "7"}, {"Number8", "8"}, {"Number9", "9"},
	{NULL, NULL}
};

static const char *pointer_key_for(const char *cmd) {
	for (size_t i = 0; POINTER_KEYS[i].cmd; i++)
		if (!strcasecmp(POINTER_KEYS[i].cmd, cmd)) return POINTER_KEYS[i].btn;
	return NULL;
}

static int send_pointer_button(struct tv *t, const char *btn, char *err, size_t errlen) {
	if (!t->ptr || !t->ptr_ready || t->ptr->fd < 0) {
		if (t->c && t->registered) {
			tv_next_req(t, "ptr", t->req_ptr);
			ssap_send_request(t->c, t->req_ptr,
			                  "ssap://com.webos.service.networkinput/getPointerInputSocket", NULL);
		}
		snprintf(err, errlen, "Pointer input socket is not connected on %s.", t->name);
		return -1;
	}
	char frame[128];
	int n = snprintf(frame, sizeof frame, "type:button\nname:%s\n\n", btn);
	if (n <= 0 || (size_t)n >= sizeof frame || ws_send_text(t->ptr, frame, (size_t)n) < 0) {
		snprintf(err, errlen, "Failed to send remote key %s.", btn);
		return -1;
	}
	t->cmds++;
	DBG("TV %s: pointer button %s", t->id, btn);
	return 0;
}

/* Parse "Input HDMI 1", "InputHdmi1", or "input:HDMI_1" -> "HDMI_1" */
static int parse_input_id(const char *cmd, char out[32]) {
	int n = 0;
	if (!strncasecmp(cmd, "input:", 6)) {
		const char *id = cmd + 6;
		if (!strncmp(id, "HDMI_", 5) && isdigit((unsigned char)id[5])) {
			n = atoi(id + 5);
			if (n >= 1 && n <= 16) { snprintf(out, 32, "HDMI_%d", n); return 1; }
		}
		return 0;
	}
	if (!strncasecmp(cmd, "Input HDMI ", 11) && isdigit((unsigned char)cmd[11])) {
		n = atoi(cmd + 11);
		if (n >= 1 && n <= 16) { snprintf(out, 32, "HDMI_%d", n); return 1; }
	}
	if (!strncasecmp(cmd, "InputHdmi", 9) && isdigit((unsigned char)cmd[9])) {
		n = atoi(cmd + 9);
		if (n >= 1 && n <= 16) { snprintf(out, 32, "HDMI_%d", n); return 1; }
	}
	return 0;
}

/* Execute one command immediately on a TV. Returns 0 on success, -1 with err set on failure. */
static int tv_execute_cmd(struct tv *t, const char *cmd, char *err, size_t errlen) {
	if (!t) { snprintf(err, errlen, "Unknown webOS TV."); return -1; }
	if (!cmd || !*cmd) { snprintf(err, errlen, "Command is required."); return -1; }

	/* PowerOn: Wake-on-LAN only (no fake SSAP PowerOn). */
	if (!strcasecmp(cmd, "PowerOn")) {
		if (t->registered && t->c && t->c->fd >= 0 && !t->standby) {
			DBG("TV %s: PowerOn while already on", t->id);
			return 0;
		}
		if (!t->mac[0]) {
			snprintf(err, errlen, "No MAC address configured for Wake-on-LAN on %s.", t->name);
			return -1;
		}
		long long now = now_ms();
		send_wol(t->mac);
		t->last_wol = now;
		t->waking_until = now + WOL_WAKE_WINDOW_MS;
		t->backoff = 1000;
		t->next_attempt = now + 500;
		t->cmds++;
		return 0;
	}

	/* PowerToggle when disconnected or in standby: wake via WoL if MAC is configured. */
	if (!strcasecmp(cmd, "PowerToggle") && (!t->registered || !t->c || t->c->fd < 0 || t->standby)) {
		if (!t->mac[0]) {
			snprintf(err, errlen, "TV %s is not connected and has no MAC address for Wake-on-LAN.", t->name);
			return -1;
		}
		long long now = now_ms();
		send_wol(t->mac);
		t->last_wol = now;
		t->waking_until = now + WOL_WAKE_WINDOW_MS;
		t->backoff = 1000;
		t->next_attempt = now + 500;
		t->cmds++;
		return 0;
	}

	if (!t->client_key[0]) {
		snprintf(err, errlen, "TV %s is not paired yet. Pair it first.", t->name);
		return -1;
	}
	if (!t->registered || !t->c || t->c->fd < 0) {
		/* Trigger a reconnect soon, but do NOT pretend the command succeeded. */
		long long now = now_ms();
		if (t->next_attempt > now + 1000) { t->backoff = 1000; t->next_attempt = now; }
		snprintf(err, errlen, "TV %s is not connected (unreachable or turned off).", t->name);
		return -1;
	}
	if (t->standby) {
		if (!strcasecmp(cmd, "PowerOff")) return 0; /* already off */
		snprintf(err, errlen, "TV %s is off (standby). Power On wakes it.", t->name);
		return -1;
	}

	char req_id[24];
	tv_next_req(t, "cmd", req_id);

	if (!strcasecmp(cmd, "PowerOff")) {
		if (ssap_send_request(t->c, req_id, "ssap://system/turnOff", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue PowerOff.");
			return -1;
		}
		/* Assume off until the power-state subscription says otherwise. */
		snprintf(t->req_off, sizeof t->req_off, "%s", req_id);
		t->standby = 1;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "PowerToggle")) {
		if (t->ptr && t->ptr_ready && t->ptr->fd >= 0) {
			return send_pointer_button(t, "POWER", err, errlen);
		}
		if (ssap_send_request(t->c, req_id, "ssap://system/turnOff", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue PowerOff.");
			return -1;
		}
		snprintf(t->req_off, sizeof t->req_off, "%s", req_id);
		t->standby = 1;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "VolumeUp")) {
		if (ssap_send_request(t->c, req_id, "ssap://audio/volumeUp", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue VolumeUp.");
			return -1;
		}
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "VolumeDown")) {
		if (ssap_send_request(t->c, req_id, "ssap://audio/volumeDown", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue VolumeDown.");
			return -1;
		}
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "Mute")) {
		int next_mute = !t->muted;
		char body[32];
		snprintf(body, sizeof body, "{\"mute\":%s}", next_mute ? "true" : "false");
		if (ssap_send_request(t->c, req_id, "ssap://audio/setMute", body) < 0) {
			snprintf(err, errlen, "Failed to queue Mute.");
			return -1;
		}
		t->muted = next_mute;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "Play")) {
		if (ssap_send_request(t->c, req_id, "ssap://media.controls/play", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue Play.");
			return -1;
		}
		t->media_playing = 1;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "Pause")) {
		if (ssap_send_request(t->c, req_id, "ssap://media.controls/pause", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue Pause.");
			return -1;
		}
		t->media_playing = 0;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "PlayPause")) {
		const char *uri = t->media_playing ? "ssap://media.controls/pause" : "ssap://media.controls/play";
		if (ssap_send_request(t->c, req_id, uri, NULL) < 0) {
			snprintf(err, errlen, "Failed to queue PlayPause.");
			return -1;
		}
		t->media_playing = !t->media_playing;
		t->cmds++;
		return 0;
	}
	if (!strcasecmp(cmd, "Stop")) {
		if (ssap_send_request(t->c, req_id, "ssap://media.controls/stop", NULL) < 0) {
			snprintf(err, errlen, "Failed to queue Stop.");
			return -1;
		}
		t->media_playing = 0;
		t->cmds++;
		return 0;
	}

	/* HDMI inputs by stable port ID (HDMI_1..HDMI_N) */
	char input_id[32];
	if (parse_input_id(cmd, input_id)) {
		char body[64];
		snprintf(body, sizeof body, "{\"inputId\":\"%s\"}", input_id);
		if (ssap_send_request(t->c, req_id, "ssap://tv/switchInput", body) < 0) {
			snprintf(err, errlen, "Failed to queue input switch.");
			return -1;
		}
		snprintf(t->active_input, sizeof t->active_input, "%s", input_id);
		t->cmds++;
		return 0;
	}

	/* App launch: "app:<appId>" or "App <Title>" */
	if (!strncasecmp(cmd, "app:", 4) && cmd[4]) {
		const char *aid = cmd + 4;
		for (const char *p = aid; *p; p++) {
			if ((unsigned char)*p <= 0x20 || (unsigned char)*p >= 0x7f || *p == '"' || *p == '\\') {
				snprintf(err, errlen, "Invalid app id.");
				return -1;
			}
		}
		char body[160];
		snprintf(body, sizeof body, "{\"id\":\"%s\"}", aid);
		if (ssap_send_request(t->c, req_id, "ssap://com.webos.applicationManager/launch", body) < 0) {
			snprintf(err, errlen, "Failed to queue app launch.");
			return -1;
		}
		t->cmds++;
		return 0;
	}
	if (!strncasecmp(cmd, "App ", 4)) {
		for (int i = 0; i < t->napps; i++) {
			if (!strcasecmp(t->apps[i].cmd, cmd) || !strcasecmp(t->apps[i].title, cmd + 4)) {
				char body[160];
				snprintf(body, sizeof body, "{\"id\":\"%s\"}", t->apps[i].id);
				if (ssap_send_request(t->c, req_id, "ssap://com.webos.applicationManager/launch", body) < 0) {
					snprintf(err, errlen, "Failed to queue app launch.");
					return -1;
				}
				t->cmds++;
				return 0;
			}
		}
		snprintf(err, errlen, "Unknown app command '%s' on %s (refresh apps while TV is on).", cmd, t->name);
		return -1;
	}

	/* Pointer-socket remote navigation keys */
	const char *btn = pointer_key_for(cmd);
	if (btn) {
		return send_pointer_button(t, btn, err, errlen);
	}

	snprintf(err, errlen, "Unknown webOS command: %s", cmd);
	return -1;
}

/* ================================================================== HTTP local server */

struct sbuf { char *b; size_t n, cap; };

static void sb_init(struct sbuf *s, size_t cap) {
	s->b = malloc(cap);
	s->n = 0;
	s->cap = s->b ? cap : 0;
	if (s->b) s->b[0] = 0;
}

static void sb_free(struct sbuf *s) {
	free(s->b);
	s->b = NULL;
	s->n = s->cap = 0;
}

static void sb(struct sbuf *s, const char *fmt, ...) {
	if (!s->b || s->n + 1 >= s->cap) return;
	va_list ap;
	va_start(ap, fmt);
	int w = vsnprintf(s->b + s->n, s->cap - s->n, fmt, ap);
	va_end(ap);
	if (w > 0) {
		s->n = s->n + (size_t)w < s->cap ? s->n + (size_t)w : s->cap - 1;
	}
}

static void sb_str(struct sbuf *s, const char *v) {
	sb(s, "\"");
	for (const char *p = v ? v : ""; *p; p++) {
		if (*p == '"' || *p == '\\') sb(s, "\\%c", *p);
		else if ((unsigned char)*p < 0x20) sb(s, " ");
		else sb(s, "%c", *p);
	}
	sb(s, "\"");
}

static void http_reply(int fd, const char *body) {
	char hdr[192];
	size_t blen = strlen(body);
	int n = snprintf(hdr, sizeof hdr,
	                 "HTTP/1.0 200 OK\r\n"
	                 "Content-Type: application/json\r\n"
	                 "Cache-Control: no-store\r\n"
	                 "Content-Length: %u\r\n"
	                 "Connection: close\r\n\r\n",
	                 (unsigned)blen);
	(void)!write(fd, hdr, (size_t)n);
	(void)!write(fd, body, blen);
}

static void sb_tv(struct sbuf *s, const struct tv *t) {
	sb(s, "{\"id\":\"%s\",\"name\":", t->id);
	sb_str(s, t->name);
	/* A TV in standby keeps its session but is reported as not connected. */
	sb(s, ",\"host\":\"%s\",\"mac\":\"%s\",\"proto\":\"%s\",\"paired\":%s,\"connected\":%s,"
	      "\"standby\":%s,\"pointerReady\":%s,\"volume\":%d,\"muted\":%s,\"activeInput\":",
	   t->host, t->mac, PROTO_NAMES[t->proto],
	   t->client_key[0] ? "true" : "false",
	   t->registered && !t->standby ? "true" : "false",
	   t->registered && t->standby ? "true" : "false",
	   t->ptr_ready ? "true" : "false",
	   t->volume, t->muted ? "true" : "false");
	sb_str(s, t->active_input);
	sb(s, ",\"cmdsSent\":%lu,\"connects\":%lu,\"error\":", t->cmds, t->connects);
	sb_str(s, !t->registered ? t->last_err : t->standby ? "TV is in standby" : "");
	sb(s, ",\"inputs\":[");
	for (int i = 0; i < t->ninputs; i++) {
		sb(s, "%s{\"id\":", i ? "," : "");
		sb_str(s, t->inputs[i].id);
		sb(s, ",\"label\":");
		sb_str(s, t->inputs[i].label);
		sb(s, "}");
	}
	sb(s, "],\"apps\":[");
	for (int i = 0; i < t->napps; i++) {
		sb(s, "%s{\"id\":", i ? "," : "");
		sb_str(s, t->apps[i].id);
		sb(s, ",\"title\":");
		sb_str(s, t->apps[i].title);
		sb(s, ",\"command\":");
		sb_str(s, t->apps[i].cmd);
		sb(s, "}");
	}
	sb(s, "]}");
}

static void status_json(struct sbuf *s) {
	sb(s, "{\"ok\":true,\"version\":\"%s\",\"tvs\":[", VERSION);
	int first = 1;
	for (int i = 0; i < MAX_TVS; i++) {
		if (!tvs[i].used) continue;
		if (!first) sb(s, ",");
		sb_tv(s, &tvs[i]);
		first = 0;
	}
	sb(s, "]}");
}

static void pair_json(struct sbuf *s) {
	struct tv *t = pair.tv_id[0] ? tv_by_id(pair.tv_id) : NULL;
	sb(s, "{\"ok\":true,\"state\":\"%s\",\"tvId\":\"%s\",\"host\":\"%s\",\"name\":",
	   PSTATE[pair.state], pair.tv_id, pair.host);
	sb_str(s, pair.name);
	sb(s, ",\"paired\":%s,\"error\":", (t && t->client_key[0]) ? "true" : "false");
	sb_str(s, pair.error);
	sb(s, "}");
}

static void http_handle(int fd) {
	char req[16384];
	size_t n = 0;
	long long deadline = now_ms() + 300;
	for (;;) {
		struct pollfd p = { .fd = fd, .events = POLLIN };
		long long left = deadline - now_ms();
		if (left <= 0 || poll(&p, 1, (int)left) != 1) break;
		ssize_t r = read(fd, req + n, sizeof req - 1 - n);
		if (r <= 0) break;
		n += (size_t)r;
		req[n] = 0;
		char *he = strstr(req, "\r\n\r\n");
		if (he) {
			char *cl = strcasestr(req, "\r\nContent-Length:");
			size_t want = cl ? (size_t)strtoul(cl + 17, NULL, 10) : 0;
			if ((size_t)(req + n - (he + 4)) >= want) break;
		}
		if (n >= sizeof req - 1) break;
	}
	req[n] = 0;
	char method[8] = "", path[256] = "";
	sscanf(req, "%7s %255s", method, path);
	char *body = strstr(req, "\r\n\r\n");
	body = body ? body + 4 : req + n;
	const char *bend = req + n;

	char *cl = strcasestr(req, "\r\nContent-Length:");
	if (cl && cl < body && (size_t)(bend - body) < (size_t)strtoul(cl + 17, NULL, 10)) {
		http_reply(fd, "{\"ok\":false,\"error\":\"The request arrived incomplete.\"}");
		return;
	}

	struct sbuf s;
	sb_init(&s, 32768);
	if (!s.b) { http_reply(fd, "{\"ok\":false,\"error\":\"out of memory\"}"); return; }

	if (!strcmp(path, "/status")) {
		status_json(&s);
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/cmd") && !strcmp(method, "POST")) {
		char dev[TV_ID_MAX] = "", cmd[128] = "", err[160] = "";
		j_obj_str(body, bend, "device", dev, sizeof dev);
		j_obj_str(body, bend, "command", cmd, sizeof cmd);
		struct tv *t = tv_by_id(dev);
		if (tv_execute_cmd(t, cmd, err, sizeof err) == 0) {
			sb(&s, "{\"ok\":true}");
		} else {
			sb(&s, "{\"ok\":false,\"error\":");
			sb_str(&s, err);
			sb(&s, "}");
		}
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/pair/start") && !strcmp(method, "POST")) {
		char id[TV_ID_MAX] = "", host[32] = "", mac[32] = "", name[65] = "", proto_s[16] = "";
		int ws_p = 0, wss_p = 0;
		j_obj_str(body, bend, "id", id, sizeof id);
		j_obj_str(body, bend, "host", host, sizeof host);
		j_obj_str(body, bend, "mac", mac, sizeof mac);
		j_obj_str(body, bend, "name", name, sizeof name);
		j_obj_str(body, bend, "proto", proto_s, sizeof proto_s);
		j_obj_int(body, bend, "wsPort", &ws_p);
		j_obj_int(body, bend, "wssPort", &wss_p);

		struct tv *existing = id[0] ? tv_by_id(id) : NULL;
		if (existing && !host[0]) snprintf(host, sizeof host, "%s", existing->host);
		if (existing && !name[0]) snprintf(name, sizeof name, "%s", existing->name);
		if (existing && !mac[0]) snprintf(mac, sizeof mac, "%s", existing->mac);

		if (!valid_ipv4(host)) {
			http_reply(fd, "{\"ok\":false,\"error\":\"Enter the TV's IPv4 address, such as 192.168.1.40.\"}");
			sb_free(&s);
			return;
		}
		char norm_mac[18] = "";
		if (mac[0] && normalize_mac(mac, norm_mac) < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"MAC address must be 6 hex bytes, such as AA:BB:CC:11:22:33.\"}");
			sb_free(&s);
			return;
		}
		int proto = proto_from_str(proto_s);
		if (proto < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"proto must be auto, wss, or ws.\"}");
			sb_free(&s);
			return;
		}
		if (!existing && !tv_by_host(host) && tv_count() >= MAX_TVS) {
			http_reply(fd, "{\"ok\":false,\"error\":\"This hub already has 8 webOS TVs.\"}");
			sb_free(&s);
			return;
		}

		if (pair.c && pair.c->fd >= 0) ws_close(pair.c, "restarted");
		memset(pair.error, 0, sizeof pair.error);
		snprintf(pair.tv_id, sizeof pair.tv_id, "%s", existing ? existing->id : "");
		snprintf(pair.host, sizeof pair.host, "%s", host);
		snprintf(pair.mac, sizeof pair.mac, "%s", norm_mac);
		snprintf(pair.name, sizeof pair.name, "%s", name[0] ? name : "LG webOS TV");
		sanitize_name(pair.name);
		pair.proto = proto;
		pair.tried_fallback = 0;
		pair.ws_port = (ws_p > 0 && ws_p <= 65535) ? ws_p : 0;
		pair.wss_port = (wss_p > 0 && wss_p <= 65535) ? wss_p : 0;
		pair_begin_connect(proto != PROTO_WS);
		pair_json(&s);
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/pair/status")) {
		pair_json(&s);
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/pair/cancel") && !strcmp(method, "POST")) {
		if (pair.c && pair.c->fd >= 0) ws_close(pair.c, "cancelled");
		pair.state = P_IDLE;
		pair.error[0] = 0;
		pair_json(&s);
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/save") && !strcmp(method, "POST")) {
		/* Add or update a TV's host, MAC, name, or transport without wiping its client-key. */
		char id[TV_ID_MAX] = "", host[32] = "", mac[32] = "", name[65] = "", proto_s[16] = "";
		int has_mac = 0, has_proto = 0, ws_p = 0, wss_p = 0;
		j_obj_str(body, bend, "id", id, sizeof id);
		j_obj_str(body, bend, "host", host, sizeof host);
		if (j_obj_find(body, bend, "mac", NULL)) { has_mac = 1; j_obj_str(body, bend, "mac", mac, sizeof mac); }
		j_obj_str(body, bend, "name", name, sizeof name);
		if (j_obj_find(body, bend, "proto", NULL)) { has_proto = 1; j_obj_str(body, bend, "proto", proto_s, sizeof proto_s); }
		j_obj_int(body, bend, "wsPort", &ws_p);
		j_obj_int(body, bend, "wssPort", &wss_p);

		if (id[0] && !valid_tv_id(id)) {
			http_reply(fd, "{\"ok\":false,\"error\":\"Invalid webOS TV id.\"}");
			sb_free(&s);
			return;
		}
		if (!valid_ipv4(host)) {
			http_reply(fd, "{\"ok\":false,\"error\":\"Enter the TV's IPv4 address, such as 192.168.1.40.\"}");
			sb_free(&s);
			return;
		}
		char norm_mac[18] = "";
		if (has_mac && mac[0] && normalize_mac(mac, norm_mac) < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"MAC address must be 6 hex bytes, such as AA:BB:CC:11:22:33.\"}");
			sb_free(&s);
			return;
		}
		int proto = has_proto ? proto_from_str(proto_s) : PROTO_AUTO;
		if (proto < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"proto must be auto, wss, or ws.\"}");
			sb_free(&s);
			return;
		}

		struct tv *t = id[0] ? tv_by_id(id) : NULL;
		int existed = (t != NULL);
		if (!t) {
			for (int i = 0; i < MAX_TVS && !t; i++)
				if (!tvs[i].used) t = &tvs[i];
		}
		if (!t) {
			http_reply(fd, "{\"ok\":false,\"error\":\"This hub already has 8 webOS TVs.\"}");
			sb_free(&s);
			return;
		}
		int host_changed = existed && strcmp(t->host, host) != 0;
		if (!existed) {
			memset(t, 0, sizeof *t);
			if (id[0]) snprintf(t->id, sizeof t->id, "%s", id);
			else make_tv_id(t->id);
			t->backoff = 1000;
			t->volume = -1;
			t->ws_port = opt_ws_port;
			t->wss_port = opt_wss_port;
		}
		snprintf(t->host, sizeof t->host, "%s", host);
		if (has_mac) snprintf(t->mac, sizeof t->mac, "%s", norm_mac);
		if (name[0]) { snprintf(t->name, sizeof t->name, "%s", name); sanitize_name(t->name); }
		else if (!t->name[0]) snprintf(t->name, sizeof t->name, "LG webOS TV");
		if (has_proto || !existed) t->proto = proto;
		if (ws_p > 0 && ws_p <= 65535) t->ws_port = ws_p;
		if (wss_p > 0 && wss_p <= 65535) t->wss_port = wss_p;
		t->used = 1;
		if (tvs_save() < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"Could not save TV configuration on the hub.\"}");
			sb_free(&s);
			return;
		}
		if (host_changed && t->c && t->c->fd >= 0) {
			ws_close(t->c, "host changed");
			if (t->ptr && t->ptr->fd >= 0) ws_close(t->ptr, "host changed");
			t->registered = t->ptr_ready = 0;
			t->backoff = 1000;
			t->next_attempt = 0;
		}
		sb(&s, "{\"ok\":true,\"tv\":");
		sb_tv(&s, t);
		sb(&s, "}");
		http_reply(fd, s.b);
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/refresh") && !strcmp(method, "POST")) {
		char id[TV_ID_MAX] = "";
		j_obj_str(body, bend, "id", id, sizeof id);
		struct tv *t = tv_by_id(id);
		if (!t) {
			http_reply(fd, "{\"ok\":false,\"error\":\"No such webOS TV.\"}");
		} else if (!t->registered || !t->c || t->c->fd < 0) {
			http_reply(fd, "{\"ok\":false,\"error\":\"The TV is not connected. Turn it on first.\"}");
		} else {
			tv_request_metadata(t);
			sb(&s, "{\"ok\":true,\"tv\":");
			sb_tv(&s, t);
			sb(&s, "}");
			http_reply(fd, s.b);
		}
		sb_free(&s);
		return;
	}

	if (!strcmp(path, "/forget") && !strcmp(method, "POST")) {
		char id[TV_ID_MAX] = "";
		j_obj_str(body, bend, "id", id, sizeof id);
		struct tv *t = tv_by_id(id);
		if (t) {
			if (t->c) { ws_close(t->c, "forgotten"); free(t->c); }
			if (t->ptr) { ws_close(t->ptr, "forgotten"); free(t->ptr); }
			logmsg("forgot TV %s (%s)", t->id, t->name);
			secure_zero(t, sizeof *t);
			tvs_save();
		}
		http_reply(fd, t ? "{\"ok\":true}" : "{\"ok\":true,\"note\":\"no such TV\"}");
		sb_free(&s);
		return;
	}

	http_reply(fd, "{\"ok\":false,\"error\":\"unknown request\"}");
	sb_free(&s);
}

static int http_listen(void) {
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return -1;
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_port = htons((uint16_t)opt_port);
	inet_pton(AF_INET, opt_listen, &sa.sin_addr);
	if (bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, 16) < 0) {
		logmsg("cannot listen on %s:%d: %s", opt_listen, opt_port, strerror(errno));
		close(fd);
		return -1;
	}
	return fd;
}

/* ================================================================== main loop */

static void usage(void) {
	fprintf(stderr,
	        "codex_webos %s\n"
	        "usage: codex_webos [--dir /data/codex/webos] [--listen 127.0.0.1] [--port %d]\n"
	        "                   [--ws-port %d] [--wss-port %d] [--log /var/volatile/codex-webos.log] [-v]\n",
	        VERSION, ENGINE_PORT, DEFAULT_WS_PORT, DEFAULT_WSS_PORT);
}

int main(int argc, char **argv) {
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		if (!strcmp(a, "-v")) { opt_verbose = 1; continue; }
		if (!strcmp(a, "--version")) { printf("codex_webos %s\n", VERSION); return 0; }
		if (!v) { usage(); return 2; }
		if (!strcmp(a, "--dir")) opt_dir = v;
		else if (!strcmp(a, "--listen")) opt_listen = v;
		else if (!strcmp(a, "--port")) opt_port = atoi(v);
		else if (!strcmp(a, "--ws-port")) opt_ws_port = atoi(v);
		else if (!strcmp(a, "--wss-port")) opt_wss_port = atoi(v);
		else if (!strcmp(a, "--log")) opt_log = v;
		else { usage(); return 2; }
		i++;
	}
	if (opt_log) {
		logf = fopen(opt_log, "a");
		if (!logf) logf = stderr;
	}
	signal(SIGPIPE, SIG_IGN);
	rng_init();
	int lfd = http_listen();
	if (lfd < 0) return 1;
	tvs_load();
	logmsg("listening on %s:%d (ws=%d, wss=%d, %d TV(s))",
	       opt_listen, opt_port, opt_ws_port, opt_wss_port, tv_count());

	for (;;) {
		long long now = now_ms();

		/* Maintain one connection (+ optional pointer socket) per paired TV. */
		for (int i = 0; i < MAX_TVS; i++) {
			struct tv *t = &tvs[i];
			if (!t->used) continue;

			/* Repeat WoL while waking an unreachable TV. */
			if (t->waking_until && (!t->registered || t->standby) && t->mac[0]) {
				if (now >= t->waking_until) {
					t->waking_until = 0;
				} else if (now - t->last_wol >= WOL_REPEAT_MS) {
					send_wol(t->mac);
					t->last_wol = now;
				}
			}

			if (t->client_key[0] && (!t->c || t->c->fd < 0) && now >= t->next_attempt) {
				tv_connect(t);
			}
			if (t->c && t->c->fd >= 0) {
				if (t->c->ws_up && now - t->c->last_ping >= WS_PING_MS) {
					ws_send_frame(t->c, 0x9, "ping", 4);
					t->c->last_ping = now;
				}
				if (now - t->c->last_rx >= WS_QUIET_MS) {
					tv_lost(t, "TV stopped responding");
				} else if (!t->registered && now - t->c->started >= PAIR_CONNECT_TIMEOUT_MS) {
					tv_lost(t, "connect/register timed out");
				}
			}
		}

		/* Pairing timeout handling */
		if (pair.state == P_CONNECTING || pair.state == P_PROMPT) {
			long long limit = (pair.state == P_PROMPT) ? PAIR_PROMPT_TIMEOUT_MS : PAIR_CONNECT_TIMEOUT_MS;
			if (now - pair.started >= limit) {
				if (pair.state == P_CONNECTING && pair.proto == PROTO_AUTO &&
				    pair.c && pair.c->use_tls && !pair.tried_fallback) {
					pair.tried_fallback = 1;
					pair_begin_connect(0);
				} else {
					pair_fail(P_FAILED, pair.state == P_PROMPT
					                    ? "Timed out waiting for Accept on the TV."
					                    : "Timed out connecting to the TV.");
				}
			}
		}

		/* Build pollfd array: HTTP listener + pairing + 2*MAX_TVS sockets. */
		struct pollfd pfds[2 + MAX_TVS * 2];
		int idx_pair = -1;
		int idx_tv[MAX_TVS], idx_ptr[MAX_TVS];
		int nfds = 0;

		pfds[nfds].fd = lfd;
		pfds[nfds].events = POLLIN;
		nfds++;

		if (pair.c && pair.c->fd >= 0) {
			idx_pair = nfds;
			pfds[nfds].fd = pair.c->fd;
			pfds[nfds].events = ws_events(pair.c);
			nfds++;
		}
		for (int i = 0; i < MAX_TVS; i++) {
			idx_tv[i] = idx_ptr[i] = -1;
			struct tv *t = &tvs[i];
			if (!t->used) continue;
			if (t->c && t->c->fd >= 0) {
				idx_tv[i] = nfds;
				pfds[nfds].fd = t->c->fd;
				pfds[nfds].events = ws_events(t->c);
				nfds++;
			}
			if (t->ptr && t->ptr->fd >= 0) {
				idx_ptr[i] = nfds;
				pfds[nfds].fd = t->ptr->fd;
				pfds[nfds].events = ws_events(t->ptr);
				nfds++;
			}
		}

		int pr = poll(pfds, (nfds_t)nfds, 200);
		if (pr < 0) {
			if (errno == EINTR) continue;
			break;
		}

		if (pfds[0].revents & POLLIN) {
			int cfd = accept(lfd, NULL, NULL);
			if (cfd >= 0) {
				fcntl(cfd, F_SETFD, FD_CLOEXEC);
				http_handle(cfd);
				close(cfd);
			}
		}

		if (idx_pair >= 0 && pfds[idx_pair].revents) {
			if (ws_pump(pair.c, pair_ws_up, pair_ws_text, NULL) < 0 &&
			    (pair.state == P_CONNECTING || pair.state == P_PROMPT)) {
				if (pair.state == P_CONNECTING && pair.proto == PROTO_AUTO &&
				    pair.c->use_tls && !pair.tried_fallback) {
					pair.tried_fallback = 1;
					pair_begin_connect(0);
				} else {
					pair_fail(P_FAILED, pair.c->error[0] ? pair.c->error : "connection closed");
				}
			}
		}

		for (int i = 0; i < MAX_TVS; i++) {
			struct tv *t = &tvs[i];
			if (!t->used) continue;
			if (t->c && t->c->fd >= 0 && (idx_tv[i] < 0 || pfds[idx_tv[i]].revents || t->c->txn)) {
				if (ws_pump(t->c, tv_ws_up, tv_ws_text, t) < 0) {
					tv_lost(t, t->c->error[0] ? t->c->error : "connection closed");
				}
			}
			if (t->ptr && t->ptr->fd >= 0 && (idx_ptr[i] < 0 || pfds[idx_ptr[i]].revents || t->ptr->txn)) {
				if (ws_pump(t->ptr, tv_ptr_up, tv_ptr_text, t) < 0) {
					DBG("TV %s: pointer socket closed (%s)", t->id, t->ptr->error);
					t->ptr_ready = 0;
				}
			}
		}
	}
	close(lfd);
	return 0;
}
