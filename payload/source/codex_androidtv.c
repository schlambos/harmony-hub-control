/*
 * codex_androidtv — Android TV / Google TV network control for Melodious.
 *
 * Copyright (c) 2026 Josh Lukens. MIT License (see LICENSE, section 2 terms; this file is
 * contributed under the MIT License).
 *
 * The Harmony engine sends plain HTTP for IP devices (TransportType 64). Android and
 * Google TVs take keys only over the Android TV Remote protocol v2: TLS with a paired
 * client certificate, varint-length-delimited protobuf, one long-lived connection with
 * pings. This daemon keeps that connection for every paired TV and turns the engine's
 * local HTTP requests into keys. It also pairs new TVs (the "polo" protocol on port
 * 6467), finds them with mDNS and wakes them with Wake-on-LAN.
 *
 * It listens on 127.0.0.1 only. codex_webui proxies the /api/androidtv/ routes to it; the engine posts
 * {"device":"<tv id>","command":"<Name>"} to /cmd (see codexactivity CommitAndroidTvDevices).
 * Engine rules it follows (docs/HOME_ASSISTANT.md): always answer 200, answer at once
 * (the engine drops queued IP commands older than 500 ms), act after answering.
 *
 * Files in --dir (default /data/codex/androidtv):
 *   client.key.der  client.crt.der   the hub's own identity (RSA-2048, made on first use)
 *   tvs.tsv                          one paired TV per line: id host mac btaddr name
 *   tv-<id>.crt.der                  each TV's certificate; its public key is pinned
 *
 * TLS is BearSSL (third_party/bearssl-0.6). See docs/ANDROID_TV.md.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
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

#include "bearssl.h"

#define VERSION "1.0.0"
#define MAX_TVS 8
/* A TV id is TV_ID_PREFIX plus 8 hex digits of SHA-256 over its certificate. */
#define TV_ID_PREFIX "androidtv"
#define TV_ID_MAX 24
#define ENGINE_PORT 8095
#define REMOTE_PORT 6466
#define PAIR_PORT 6467
#define LOG_CAP (64 * 1024)

/* ================================================================== options, log */

static const char *opt_dir = "/data/codex/androidtv";
static const char *opt_listen = "127.0.0.1";
static int opt_port = ENGINE_PORT;
static const char *opt_log = NULL;
static const char *opt_client_name = "Melodious (Harmony Hub)";
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
	fprintf(logf, "%04d-%02d-%02d %02d:%02d:%02d codex_androidtv: ", tm.tm_year + 1900, tm.tm_mon + 1,
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

/* Write next to the target, then rename: a power cut never leaves half a file. */
static int write_file_atomic(const char *path, const void *data, size_t len, mode_t mode) {
	char tmp[256];
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

static void hex_encode(char *out, const unsigned char *in, size_t len) {
	static const char hx[] = "0123456789abcdef";
	for (size_t i = 0; i < len; i++) { out[2 * i] = hx[in[i] >> 4]; out[2 * i + 1] = hx[in[i] & 15]; }
	out[2 * len] = 0;
}

/* ================================================================== protobuf */

struct pbuf { unsigned char b[640]; size_t n; };

static void pb_varint(struct pbuf *p, uint64_t v) {
	while (v >= 0x80 && p->n < sizeof p->b) { p->b[p->n++] = (unsigned char)(v | 0x80); v >>= 7; }
	if (p->n < sizeof p->b) p->b[p->n++] = (unsigned char)v;
}
static void pb_tag(struct pbuf *p, unsigned field, unsigned wt) { pb_varint(p, ((uint64_t)field << 3) | wt); }
static void pb_uint(struct pbuf *p, unsigned field, uint64_t v) { pb_tag(p, field, 0); pb_varint(p, v); }
static void pb_bytes(struct pbuf *p, unsigned field, const void *d, size_t len) {
	pb_tag(p, field, 2);
	pb_varint(p, len);
	if (p->n + len <= sizeof p->b) { memcpy(p->b + p->n, d, len); p->n += len; }
}
static void pb_str(struct pbuf *p, unsigned field, const char *s) { pb_bytes(p, field, s, strlen(s)); }
static void pb_sub(struct pbuf *p, unsigned field, const struct pbuf *sub) { pb_bytes(p, field, sub->b, sub->n); }

struct pfield { unsigned num, wt; uint64_t v; const unsigned char *d; size_t len; };

static int pb_read_varint(const unsigned char **pp, const unsigned char *end, uint64_t *out) {
	uint64_t v = 0;
	int shift = 0;
	while (*pp < end && shift < 64) {
		unsigned char c = *(*pp)++;
		v |= (uint64_t)(c & 0x7f) << shift;
		if (!(c & 0x80)) { *out = v; return 0; }
		shift += 7;
	}
	return -1;
}

static int pb_next(const unsigned char **pp, const unsigned char *end, struct pfield *f) {
	if (*pp >= end) return 0;
	uint64_t key;
	if (pb_read_varint(pp, end, &key)) return -1;
	f->num = (unsigned)(key >> 3);
	f->wt = (unsigned)(key & 7);
	f->v = 0; f->d = NULL; f->len = 0;
	switch (f->wt) {
	case 0: if (pb_read_varint(pp, end, &f->v)) return -1; break;
	case 1: if (end - *pp < 8) return -1; *pp += 8; break;
	case 5: if (end - *pp < 4) return -1; *pp += 4; break;
	case 2: {
		uint64_t l;
		if (pb_read_varint(pp, end, &l) || (uint64_t)(end - *pp) < l) return -1;
		f->d = *pp; f->len = (size_t)l; *pp += l; break;
	}
	default: return -1;
	}
	return 1;
}

static uint64_t pb_get_uint(const unsigned char *d, size_t len, unsigned field) {
	const unsigned char *p = d, *end = d + len;
	struct pfield f;
	while (pb_next(&p, end, &f) == 1)
		if (f.num == field && f.wt == 0) return f.v;
	return 0;
}

/* ================================================================== identity */

static struct {
	int ready;
	pid_t keygen_pid;
	br_x509_certificate chain[1];
	br_skey_decoder_context skey;   /* the private key points into this */
	const br_rsa_private_key *sk;
	unsigned char n[512], e[8];      /* client public key, for the pairing secret */
	size_t nlen, elen;
} ident;

/* --- DER builder ---------------------------------------------------- */

struct der { unsigned char *b; size_t n, cap; };

static void der_raw(struct der *d, const void *p, size_t len) {
	if (d->n + len > d->cap) {
		size_t cap = d->cap ? d->cap : 1024;
		while (cap < d->n + len) cap *= 2;
		unsigned char *nb = realloc(d->b, cap);
		if (!nb) return;
		d->b = nb;
		d->cap = cap;
	}
	memcpy(d->b + d->n, p, len);
	d->n += len;
}

static void der_tlv(struct der *d, unsigned char tag, const void *content, size_t len) {
	unsigned char hdr[6];
	size_t h = 0;
	hdr[h++] = tag;
	if (len < 0x80) hdr[h++] = (unsigned char)len;
	else if (len < 0x100) { hdr[h++] = 0x81; hdr[h++] = (unsigned char)len; }
	else if (len < 0x10000) { hdr[h++] = 0x82; hdr[h++] = (unsigned char)(len >> 8); hdr[h++] = (unsigned char)len; }
	else { hdr[h++] = 0x83; hdr[h++] = (unsigned char)(len >> 16); hdr[h++] = (unsigned char)(len >> 8); hdr[h++] = (unsigned char)len; }
	der_raw(d, hdr, h);
	der_raw(d, content, len);
}

static void der_wrap(struct der *d, unsigned char tag, struct der *inner) {
	der_tlv(d, tag, inner->b, inner->n);
	free(inner->b);
	memset(inner, 0, sizeof *inner);
}

static void der_uint(struct der *d, const unsigned char *v, size_t len) {
	while (len > 1 && v[0] == 0) { v++; len--; }
	unsigned char tmp[520];
	size_t n = 0;
	if (v[0] & 0x80) tmp[n++] = 0;
	memcpy(tmp + n, v, len);
	der_tlv(d, 0x02, tmp, n + len);
}

static void der_small(struct der *d, unsigned v) {
	unsigned char b[4] = { (unsigned char)(v >> 24), (unsigned char)(v >> 16), (unsigned char)(v >> 8), (unsigned char)v };
	der_uint(d, b, 4);
}

static const unsigned char OID_RSA[] = { 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01 };
static const unsigned char OID_SHA256_RSA[] = { 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b };
static const unsigned char OID_CN[] = { 0x55, 0x04, 0x03 };
static const unsigned char OID_BASIC[] = { 0x55, 0x1d, 0x13 };
static const unsigned char OID_SAN[] = { 0x55, 0x1d, 0x11 };

static void der_algid(struct der *d, const unsigned char *oid, size_t len) {
	struct der in = {0};
	der_tlv(&in, 0x06, oid, len);
	der_tlv(&in, 0x05, NULL, 0);
	der_wrap(d, 0x30, &in);
}

static void der_name(struct der *d, const char *cn) {
	struct der attr = {0}, set = {0}, seq = {0};
	der_tlv(&attr, 0x06, OID_CN, sizeof OID_CN);
	der_tlv(&attr, 0x0c, cn, strlen(cn));
	der_wrap(&set, 0x30, &attr);
	der_wrap(&seq, 0x31, &set);
	der_wrap(d, 0x30, &seq);
}

/* Child process: make an RSA-2048 key and a self-signed certificate (like the
 * androidtvremote2 library's: CN, basicConstraints CA, a DNS SAN), write both. */
static int keygen_child(void) {
	setpriority(PRIO_PROCESS, 0, 10);
	br_hmac_drbg_context rng;
	br_hmac_drbg_init(&rng, &br_sha256_vtable, NULL, 0);
	br_prng_seeder seeder = br_prng_seeder_system(NULL);
	if (!seeder || !seeder(&rng.vtable)) { logmsg("no system entropy source"); return 1; }
	struct timeval tv;
	gettimeofday(&tv, NULL);
	br_hmac_drbg_update(&rng, &tv, sizeof tv);

	static unsigned char kpriv[BR_RSA_KBUF_PRIV_SIZE(2048)], kpub[BR_RSA_KBUF_PUB_SIZE(2048)];
	br_rsa_private_key sk;
	br_rsa_public_key pk;
	long long t0 = now_ms();
	if (!br_rsa_keygen_get_default()(&rng.vtable, &sk, kpriv, &pk, kpub, 2048, 65537)) {
		logmsg("RSA key generation failed");
		return 1;
	}
	static unsigned char dbuf[256];
	size_t dlen = br_rsa_compute_privexp_get_default()(dbuf, &sk, 65537);
	if (!dlen) { logmsg("could not compute the private exponent"); return 1; }
	logmsg("made the hub's RSA-2048 key in %lld ms", now_ms() - t0);

	/* RSAPrivateKey (PKCS#1) */
	struct der in = {0}, key = {0};
	der_small(&in, 0);
	der_uint(&in, pk.n, pk.nlen);
	der_uint(&in, pk.e, pk.elen);
	der_uint(&in, dbuf, dlen);
	der_uint(&in, sk.p, sk.plen);
	der_uint(&in, sk.q, sk.qlen);
	der_uint(&in, sk.dp, sk.dplen);
	der_uint(&in, sk.dq, sk.dqlen);
	der_uint(&in, sk.iq, sk.iqlen);
	der_wrap(&key, 0x30, &in);

	/* TBSCertificate */
	char cn[64];
	char hostname[40] = "melodious";
	snprintf(cn, sizeof cn, "%s", hostname);
	unsigned char serial[8];
	rng.vtable->generate(&rng.vtable, serial, sizeof serial);
	serial[0] &= 0x7f;
	serial[0] |= 0x01;
	struct der tbs = {0}, t = {0}, ver = {0}, val = {0}, spki = {0}, rsapub = {0}, bits = {0};
	der_small(&ver, 2);
	der_wrap(&t, 0xa0, &ver);
	der_uint(&t, serial, sizeof serial);
	der_algid(&t, OID_SHA256_RSA, sizeof OID_SHA256_RSA);
	der_name(&t, cn);
	der_tlv(&val, 0x17, "260101000000Z", 13);
	der_tlv(&val, 0x18, "20560101000000Z", 15);
	der_wrap(&t, 0x30, &val);
	der_name(&t, cn);
	der_uint(&rsapub, pk.n, pk.nlen);
	der_uint(&rsapub, pk.e, pk.elen);
	struct der rsaseq = {0};
	der_wrap(&rsaseq, 0x30, &rsapub);
	unsigned char zero = 0;
	der_raw(&bits, &zero, 1);
	der_raw(&bits, rsaseq.b, rsaseq.n);
	free(rsaseq.b);
	der_algid(&spki, OID_RSA, sizeof OID_RSA);
	der_wrap(&spki, 0x03, &bits);
	der_wrap(&t, 0x30, &spki);
	/* extensions: basicConstraints CA:TRUE pathlen 0, subjectAltName DNS:<cn> */
	struct der exts = {0}, e1 = {0}, e1v = {0}, e1o = {0}, e2 = {0}, e2v = {0}, e2o = {0}, all = {0}, wrap3 = {0};
	unsigned char yes = 0xff;
	der_tlv(&e1v, 0x01, &yes, 1);
	der_small(&e1v, 0);
	der_wrap(&e1o, 0x30, &e1v);
	der_tlv(&e1, 0x06, OID_BASIC, sizeof OID_BASIC);
	der_wrap(&e1, 0x04, &e1o);
	der_wrap(&exts, 0x30, &e1);
	der_tlv(&e2v, 0x82, cn, strlen(cn));
	der_wrap(&e2o, 0x30, &e2v);
	der_tlv(&e2, 0x06, OID_SAN, sizeof OID_SAN);
	der_wrap(&e2, 0x04, &e2o);
	der_wrap(&exts, 0x30, &e2);
	der_wrap(&all, 0x30, &exts);
	der_wrap(&wrap3, 0xa3, &all);
	der_raw(&t, wrap3.b, wrap3.n);
	free(wrap3.b);
	der_wrap(&tbs, 0x30, &t);

	unsigned char hash[32], sig[256];
	br_sha256_context sh;
	br_sha256_init(&sh);
	br_sha256_update(&sh, tbs.b, tbs.n);
	br_sha256_out(&sh, hash);
	if (!br_rsa_pkcs1_sign_get_default()(BR_HASH_OID_SHA256, hash, sizeof hash, &sk, sig)) {
		logmsg("could not sign the hub's certificate");
		return 1;
	}
	struct der cert = {0}, c = {0}, sbits = {0};
	der_raw(&c, tbs.b, tbs.n);
	der_algid(&c, OID_SHA256_RSA, sizeof OID_SHA256_RSA);
	der_raw(&sbits, &zero, 1);
	der_raw(&sbits, sig, (pk.nlen + 0));
	der_wrap(&c, 0x03, &sbits);
	der_wrap(&cert, 0x30, &c);

	char kpath[256], cpath[256];
	path_in_dir(kpath, sizeof kpath, "client.key.der");
	path_in_dir(cpath, sizeof cpath, "client.crt.der");
	if (write_file_atomic(kpath, key.b, key.n, 0600) < 0 || write_file_atomic(cpath, cert.b, cert.n, 0600) < 0) {
		logmsg("could not write the hub's identity to %s: %s", opt_dir, strerror(errno));
		return 1;
	}
	return 0;
}

static int identity_load(void) {
	char kpath[256], cpath[256];
	path_in_dir(kpath, sizeof kpath, "client.key.der");
	path_in_dir(cpath, sizeof cpath, "client.crt.der");
	size_t klen, clen;
	unsigned char *k = read_file(kpath, &klen);
	unsigned char *c = read_file(cpath, &clen);
	if (!k || !c) { free(k); free(c); return -1; }
	br_skey_decoder_init(&ident.skey);
	br_skey_decoder_push(&ident.skey, k, klen);
	if (br_skey_decoder_last_error(&ident.skey) || br_skey_decoder_key_type(&ident.skey) != BR_KEYTYPE_RSA) {
		logmsg("%s is not an RSA key", kpath);
		free(k); free(c);
		return -1;
	}
	ident.sk = br_skey_decoder_get_rsa(&ident.skey);
	br_x509_decoder_context dc;
	br_x509_decoder_init(&dc, NULL, NULL);
	br_x509_decoder_push(&dc, c, clen);
	const br_x509_pkey *pk = br_x509_decoder_get_pkey(&dc);
	if (!pk || pk->key_type != BR_KEYTYPE_RSA || pk->key.rsa.nlen > sizeof ident.n || pk->key.rsa.elen > sizeof ident.e) {
		logmsg("%s is not an RSA certificate", cpath);
		free(k); free(c);
		return -1;
	}
	memcpy(ident.n, pk->key.rsa.n, pk->key.rsa.nlen);
	ident.nlen = pk->key.rsa.nlen;
	memcpy(ident.e, pk->key.rsa.e, pk->key.rsa.elen);
	ident.elen = pk->key.rsa.elen;
	ident.chain[0].data = c;
	ident.chain[0].data_len = clen;
	/* k stays allocated for the life of the process (the decoder copied it, but small) */
	ident.ready = 1;
	logmsg("hub identity loaded");
	return 0;
}

static void identity_ensure(void) {
	if (ident.ready || ident.keygen_pid > 0) return;
	if (identity_load() == 0) return;
	mkdir(opt_dir, 0700);
	logmsg("making the hub's identity (one RSA-2048 key, first use only)");
	pid_t pid = fork();
	if (pid == 0) _exit(keygen_child());
	if (pid < 0) { logmsg("fork: %s", strerror(errno)); return; }
	ident.keygen_pid = pid;
}

static void identity_poll(void) {
	if (ident.keygen_pid <= 0) return;
	int status;
	pid_t r = waitpid(ident.keygen_pid, &status, WNOHANG);
	if (r == 0) return;
	ident.keygen_pid = 0;
	if (r > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0) identity_load();
	else logmsg("making the hub's identity failed");
}

/* ================================================================== TLS connections */

/* Accepts any server certificate and keeps its DER and RSA key: used only while
 * pairing, where the code typed from the TV's screen authenticates both ends. */
struct capture_x509 {
	const br_x509_class *vtable;
	int index;
	br_x509_decoder_context dc;
	unsigned char der[2048];
	size_t der_len;
	int overflow;
	br_x509_pkey pkey;
	unsigned char n[512], e[8];
};

static void cap_start_chain(const br_x509_class **ctx, const char *server_name) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	(void)server_name;
	c->index = 0;
	c->der_len = 0;
	c->overflow = 0;
}
static void cap_start_cert(const br_x509_class **ctx, uint32_t length) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	(void)length;
	if (c->index == 0) br_x509_decoder_init(&c->dc, NULL, NULL);
}
static void cap_append(const br_x509_class **ctx, const unsigned char *buf, size_t len) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	if (c->index != 0) return;
	br_x509_decoder_push(&c->dc, buf, len);
	if (c->der_len + len <= sizeof c->der) { memcpy(c->der + c->der_len, buf, len); c->der_len += len; }
	else c->overflow = 1;
}
static void cap_end_cert(const br_x509_class **ctx) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	c->index++;
}
static unsigned cap_end_chain(const br_x509_class **ctx) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	const br_x509_pkey *pk = br_x509_decoder_get_pkey(&c->dc);
	if (c->overflow || !pk || pk->key_type != BR_KEYTYPE_RSA || pk->key.rsa.nlen > sizeof c->n || pk->key.rsa.elen > sizeof c->e)
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
static const br_x509_pkey *cap_get_pkey(const br_x509_class *const *ctx, unsigned *usages) {
	struct capture_x509 *c = (struct capture_x509 *)ctx;
	if (usages) *usages = BR_KEYTYPE_KEYX | BR_KEYTYPE_SIGN;
	return &c->pkey;
}
static const br_x509_class capture_vtable = {
	sizeof(struct capture_x509), cap_start_chain, cap_start_cert, cap_append, cap_end_cert, cap_end_chain, cap_get_pkey
};

struct conn {
	int fd;
	int connecting;           /* TCP connect in progress */
	int tls_up;
	long long started, last_rx;
	br_ssl_client_context cc;
	br_x509_knownkey_context known;
	struct capture_x509 cap;
	unsigned char iobuf[BR_SSL_BUFSIZE_BIDI];
	unsigned char out[2048];
	size_t outn;
	unsigned char rx[8192];
	size_t rxn;
	char error[96];
};

static void ssl_profile(br_ssl_client_context *c) {
	static const uint16_t suites[] = {
		BR_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		BR_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		BR_TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
	};
	br_ssl_client_zero(c);
	br_ssl_engine_set_versions(&c->eng, BR_TLS12, BR_TLS12);
	br_ssl_engine_set_suites(&c->eng, suites, sizeof suites / sizeof suites[0]);
	br_ssl_engine_set_default_ec(&c->eng);
	br_ssl_client_set_default_rsapub(c);
	br_ssl_engine_set_default_rsavrfy(&c->eng);
	br_ssl_engine_set_hash(&c->eng, br_sha256_ID, &br_sha256_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha384_ID, &br_sha384_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha512_ID, &br_sha512_vtable);
	br_ssl_engine_set_hash(&c->eng, br_sha1_ID, &br_sha1_vtable);
	br_ssl_engine_set_prf_sha256(&c->eng, &br_tls12_sha256_prf);
	br_ssl_engine_set_prf_sha384(&c->eng, &br_tls12_sha384_prf);
	br_ssl_engine_set_default_aes_gcm(&c->eng);
	br_ssl_engine_set_default_chapol(&c->eng);
}

static void conn_close(struct conn *c, const char *why) {
	if (c->fd >= 0) close(c->fd);
	c->fd = -1;
	c->connecting = c->tls_up = 0;
	c->outn = c->rxn = 0;
	snprintf(c->error, sizeof c->error, "%s", why ? why : "");
}

/* Start a non-blocking TCP connect and a TLS client. pinned: the TV's public key, or
 * NULL to capture whatever certificate it shows (pairing). */
static int conn_open(struct conn *c, const char *host, int port, const br_rsa_public_key *pinned) {
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_port = htons((uint16_t)port);
	if (inet_pton(AF_INET, host, &sa.sin_addr) != 1) { conn_close(c, "bad address"); return -1; }
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) { conn_close(c, "socket failed"); return -1; }
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	int one = 1;
	setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
	setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);
	if (connect(fd, (struct sockaddr *)&sa, sizeof sa) < 0 && errno != EINPROGRESS) {
		char why[64];
		snprintf(why, sizeof why, "connect: %s", strerror(errno));
		close(fd);
		conn_close(c, why);
		return -1;
	}
	c->fd = fd;
	c->connecting = 1;
	c->tls_up = 0;
	c->outn = c->rxn = 0;
	c->started = c->last_rx = now_ms();
	c->error[0] = 0;
	ssl_profile(&c->cc);
	if (pinned) {
		br_x509_knownkey_init_rsa(&c->known, pinned, BR_KEYTYPE_KEYX | BR_KEYTYPE_SIGN);
		br_ssl_engine_set_x509(&c->cc.eng, &c->known.vtable);
	} else {
		memset(&c->cap, 0, sizeof c->cap);
		c->cap.vtable = &capture_vtable;
		br_ssl_engine_set_x509(&c->cc.eng, &c->cap.vtable);
	}
	br_ssl_client_set_single_rsa(&c->cc, ident.chain, 1, ident.sk, br_rsa_pkcs1_sign_get_default());
	br_ssl_engine_set_buffer(&c->cc.eng, c->iobuf, sizeof c->iobuf, 1);
	if (!br_ssl_client_reset(&c->cc, NULL, 0)) { conn_close(c, "TLS reset failed"); return -1; }
	return 0;
}

static int conn_queue(struct conn *c, const struct pbuf *msg) {
	unsigned char hdr[10];
	size_t hn = 0;
	uint64_t v = msg->n;
	while (v >= 0x80) { hdr[hn++] = (unsigned char)(v | 0x80); v >>= 7; }
	hdr[hn++] = (unsigned char)v;
	if (c->outn + hn + msg->n > sizeof c->out) return -1;
	memcpy(c->out + c->outn, hdr, hn);
	memcpy(c->out + c->outn + hn, msg->b, msg->n);
	c->outn += hn + msg->n;
	return 0;
}

/* Move bytes between the socket and BearSSL until neither can progress. Calls
 * on_message for every complete varint-delimited message. Returns -1 when closed. */
typedef void (*msg_handler)(void *owner, const unsigned char *d, size_t len);

static int conn_pump(struct conn *c, msg_handler on_message, void *owner) {
	if (c->fd < 0) return -1;
	if (c->connecting) {
		int err = 0;
		socklen_t el = sizeof err;
		struct pollfd p = { .fd = c->fd, .events = POLLOUT };
		if (poll(&p, 1, 0) != 1) return 0;
		getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &err, &el);
		if (err) {
			char why[64];
			snprintf(why, sizeof why, "connect: %s", strerror(err));
			conn_close(c, why);
			return -1;
		}
		c->connecting = 0;
	}
	br_ssl_engine_context *eng = &c->cc.eng;
	for (int guard = 0; guard < 256; guard++) {
		unsigned st = br_ssl_engine_current_state(eng);
		if (st & BR_SSL_CLOSED) {
			int e = br_ssl_engine_last_error(eng);
			char why[64];
			snprintf(why, sizeof why, e ? "TLS error %d" : "closed by the TV", e);
			conn_close(c, why);
			return -1;
		}
		if (!c->tls_up && (st & BR_SSL_SENDAPP)) c->tls_up = 1;
		if (st & BR_SSL_SENDREC) {
			size_t len;
			unsigned char *buf = br_ssl_engine_sendrec_buf(eng, &len);
			ssize_t w = send(c->fd, buf, len, MSG_NOSIGNAL);
			if (w > 0) { br_ssl_engine_sendrec_ack(eng, (size_t)w); continue; }
			if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
			conn_close(c, "send failed");
			return -1;
		}
		if (st & BR_SSL_RECVAPP) {
			size_t len;
			unsigned char *buf = br_ssl_engine_recvapp_buf(eng, &len);
			size_t room = sizeof c->rx - c->rxn;
			if (len > room) len = room;
			memcpy(c->rx + c->rxn, buf, len);
			c->rxn += len;
			br_ssl_engine_recvapp_ack(eng, len);
			c->last_rx = now_ms();
			for (;;) {
				const unsigned char *p = c->rx, *end = c->rx + c->rxn;
				uint64_t mlen;
				if (pb_read_varint(&p, end, &mlen)) break;
				if (mlen > sizeof c->rx - 10) { conn_close(c, "oversized message"); return -1; }
				if ((uint64_t)(end - p) < mlen) break;
				size_t used = (size_t)(p - c->rx) + (size_t)mlen;
				unsigned char msg[8192];
				memcpy(msg, p, (size_t)mlen);
				memmove(c->rx, c->rx + used, c->rxn - used);
				c->rxn -= used;
				on_message(owner, msg, (size_t)mlen);
				if (c->fd < 0) return -1;
			}
			continue;
		}
		if (c->tls_up && (st & BR_SSL_SENDAPP) && c->outn) {
			size_t len;
			unsigned char *buf = br_ssl_engine_sendapp_buf(eng, &len);
			if (len > c->outn) len = c->outn;
			memcpy(buf, c->out, len);
			memmove(c->out, c->out + len, c->outn - len);
			c->outn -= len;
			br_ssl_engine_sendapp_ack(eng, len);
			br_ssl_engine_flush(eng, 0);
			continue;
		}
		if (st & BR_SSL_RECVREC) {
			size_t len;
			unsigned char *buf = br_ssl_engine_recvrec_buf(eng, &len);
			ssize_t r = recv(c->fd, buf, len, 0);
			if (r > 0) { br_ssl_engine_recvrec_ack(eng, (size_t)r); c->last_rx = now_ms(); continue; }
			if (r == 0) { conn_close(c, "closed by the TV"); return -1; }
			if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
			conn_close(c, "receive failed");
			return -1;
		}
		return 0;
	}
	return 0;
}

static short conn_events(const struct conn *c) {
	if (c->fd < 0) return 0;
	if (c->connecting) return POLLOUT;
	short ev = POLLIN;
	unsigned st = br_ssl_engine_current_state(&c->cc.eng);
	if (st & BR_SSL_SENDREC) ev |= POLLOUT;
	/* Queued output BearSSL can take now: wake at once instead of after the poll
	 * timeout. The pump consumes it, so this doesn't spin. */
	if (c->outn && (st & BR_SSL_SENDAPP)) ev |= POLLOUT;
	return ev;
}

/* ================================================================== paired TVs */

enum { F_PING = 1, F_KEY = 2, F_POWER = 32, F_VOLUME = 64, F_APPLINK = 512 };
#define PSEUDO_POWER_ON 1001
#define PSEUDO_POWER_OFF 1002

struct cmd { int code; int dir; char link[200]; long long at; };
#define QLEN 12

struct tv {
	int used;
	char id[TV_ID_MAX], host[16], mac[18], bt[18], name[65];
	unsigned char *certder;
	size_t certlen;
	br_x509_decoder_context dc;     /* pinned key points into this */
	br_rsa_public_key pk;
	struct conn *c;
	int ready, is_on, vol, vol_max, muted;
	int state_known;                /* remote_start seen on this connection */
	unsigned features;
	long long next_attempt, unreachable_since, last_rediscover, last_wol;
	int backoff;
	unsigned long keys, connects;
	struct cmd q[QLEN];
	int qhead, qcount;
};

static struct tv tvs[MAX_TVS];

static struct tv *tv_by_id(const char *id) {
	for (int i = 0; i < MAX_TVS; i++)
		if (tvs[i].used && !strcmp(tvs[i].id, id)) return &tvs[i];
	return NULL;
}

static int tv_count(void) {
	int n = 0;
	for (int i = 0; i < MAX_TVS; i++) n += tvs[i].used;
	return n;
}

static int tv_set_cert(struct tv *t, unsigned char *der, size_t len) {
	br_x509_decoder_init(&t->dc, NULL, NULL);
	br_x509_decoder_push(&t->dc, der, len);
	const br_x509_pkey *pk = br_x509_decoder_get_pkey(&t->dc);
	if (!pk || pk->key_type != BR_KEYTYPE_RSA) return -1;
	free(t->certder);
	t->certder = der;
	t->certlen = len;
	t->pk = pk->key.rsa;
	return 0;
}

static void sanitize(char *s) {
	for (; *s; s++) if (*s == '\t' || *s == '\n' || *s == '\r' || *s == '"' || *s == '\\') *s = ' ';
}

static int tvs_save(void) {
	char path[256], buf[MAX_TVS * 200];
	size_t n = 0;
	for (int i = 0; i < MAX_TVS; i++) {
		struct tv *t = &tvs[i];
		if (!t->used) continue;
		n += (size_t)snprintf(buf + n, sizeof buf - n, "%s\t%s\t%s\t%s\t%s\n", t->id, t->host,
		                      t->mac[0] ? t->mac : "-", t->bt[0] ? t->bt : "-", t->name);
	}
	path_in_dir(path, sizeof path, "tvs.tsv");
	return write_file_atomic(path, buf, n, 0600);
}

static void tvs_load(void) {
	char path[256];
	path_in_dir(path, sizeof path, "tvs.tsv");
	size_t len;
	char *text = (char *)read_file(path, &len);
	if (!text) return;
	text = realloc(text, len + 1);
	text[len] = 0;
	char *save = NULL;
	for (char *line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
		char *f[5] = {0};
		int nf = 0;
		char *s2 = NULL;
		for (char *tok = strtok_r(line, "\t", &s2); tok && nf < 5; tok = strtok_r(NULL, "\t", &s2)) f[nf++] = tok;
		if (nf < 5) continue;
		struct tv *t = NULL;
		for (int i = 0; i < MAX_TVS && !t; i++) if (!tvs[i].used) t = &tvs[i];
		if (!t) break;
		memset(t, 0, sizeof *t);
		snprintf(t->id, sizeof t->id, "%s", f[0]);
		snprintf(t->host, sizeof t->host, "%s", f[1]);
		snprintf(t->mac, sizeof t->mac, "%s", strcmp(f[2], "-") ? f[2] : "");
		snprintf(t->bt, sizeof t->bt, "%s", strcmp(f[3], "-") ? f[3] : "");
		snprintf(t->name, sizeof t->name, "%s", f[4]);
		char cpath[256], cname[40];
		snprintf(cname, sizeof cname, "tv-%s.crt.der", t->id);
		path_in_dir(cpath, sizeof cpath, cname);
		size_t clen;
		unsigned char *der = read_file(cpath, &clen);
		if (!der || tv_set_cert(t, der, clen) < 0) { logmsg("TV %s: certificate missing or unreadable", t->id); free(der); continue; }
		t->used = 1;
		t->backoff = 1000;
		t->vol = -1;
		logmsg("TV %s (%s) at %s", t->id, t->name, t->host);
	}
	free(text);
}

/* The TV's MAC, for Wake-on-LAN, from the kernel's ARP table. */
static void arp_lookup(const char *host, char *mac, size_t cap) {
	FILE *f = fopen("/proc/net/arp", "r");
	if (!f) return;
	char line[256];
	while (fgets(line, sizeof line, f)) {
		char ip[32], hw[32];
		if (sscanf(line, "%31s %*s %*s %31s", ip, hw) == 2 && !strcmp(ip, host) && strcmp(hw, "00:00:00:00:00:00"))
			snprintf(mac, cap, "%s", hw);
	}
	fclose(f);
}

static void send_wol(const char *mac) {
	unsigned m[6];
	if (sscanf(mac, "%x:%x:%x:%x:%x:%x", &m[0], &m[1], &m[2], &m[3], &m[4], &m[5]) != 6) return;
	unsigned char pkt[102];
	memset(pkt, 0xff, 6);
	for (int i = 0; i < 16; i++) for (int j = 0; j < 6; j++) pkt[6 + i * 6 + j] = (unsigned char)m[j];
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0) return;
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_addr.s_addr = htonl(INADDR_BROADCAST);
	for (int port = 7; port <= 9; port += 2) {
		sa.sin_port = htons((uint16_t)port);
		for (int k = 0; k < 2; k++) sendto(fd, pkt, sizeof pkt, 0, (struct sockaddr *)&sa, sizeof sa);
	}
	close(fd);
	logmsg("sent Wake-on-LAN to %s", mac);
}

static void tv_lost(struct tv *t, const char *why) {
	if (t->c && t->c->fd >= 0) conn_close(t->c, why);
	if (t->ready || t->c) logmsg("TV %s: %s", t->id, why);
	t->ready = 0;
	t->state_known = 0;
	t->next_attempt = now_ms() + t->backoff;
	t->backoff = t->backoff < 30000 ? t->backoff * 2 : 30000;
	if (!t->unreachable_since) t->unreachable_since = now_ms();
}

static void tv_on_message(void *owner, const unsigned char *d, size_t len) {
	struct tv *t = owner;
	const unsigned char *p = d, *end = d + len;
	struct pfield f;
	while (pb_next(&p, end, &f) == 1) {
		if (f.wt != 2) continue;
		struct pbuf out = { .n = 0 }, sub = { .n = 0 }, info = { .n = 0 };
		switch (f.num) {
		case 1: { /* remote_configure */
			unsigned supported = (unsigned)pb_get_uint(f.d, f.len, 1);
			t->features = (F_PING | F_KEY | F_POWER | F_VOLUME | F_APPLINK) & supported;
			pb_uint(&info, 3, 1);
			pb_str(&info, 4, "1");
			pb_str(&info, 5, "atvremote");
			pb_str(&info, 6, VERSION);
			pb_uint(&sub, 1, t->features);
			pb_sub(&sub, 2, &info);
			pb_sub(&out, 1, &sub);
			conn_queue(t->c, &out);
			break;
		}
		case 2: /* remote_set_active */
			pb_uint(&sub, 1, t->features);
			pb_sub(&out, 2, &sub);
			conn_queue(t->c, &out);
			if (!t->ready) logmsg("TV %s: connected", t->id);
			t->ready = 1;
			t->backoff = 1000;
			t->unreachable_since = 0;
			break;
		case 8: /* remote_ping_request */
			pb_uint(&sub, 1, pb_get_uint(f.d, f.len, 1));
			pb_sub(&out, 9, &sub);
			conn_queue(t->c, &out);
			break;
		case 40: { /* remote_start */
			int on = (int)pb_get_uint(f.d, f.len, 1);
			if (on != t->is_on) logmsg("TV %s is %s", t->id, on ? "on" : "in standby");
			t->is_on = on;
			t->state_known = 1;
			t->ready = 1;
			break;
		}
		case 50: /* remote_set_volume_level */
			t->vol_max = (int)pb_get_uint(f.d, f.len, 6);
			t->vol = (int)pb_get_uint(f.d, f.len, 7);
			t->muted = (int)pb_get_uint(f.d, f.len, 8);
			break;
		case 3:
			logmsg("TV %s reported an error", t->id);
			break;
		default:
			DBG("TV %s: unhandled field %u", t->id, f.num);
		}
	}
}

static void tv_connect(struct tv *t) {
	if (!ident.ready) return;
	if (!t->c) {
		t->c = calloc(1, sizeof *t->c);
		if (!t->c) return;
		t->c->fd = -1;
	}
	t->ready = 0;
	t->state_known = 0;
	t->next_attempt = now_ms() + t->backoff;
	if (conn_open(t->c, t->host, REMOTE_PORT, &t->pk) < 0) {
		tv_lost(t, t->c->error);
		return;
	}
	t->connects++;
	if (!t->mac[0]) {
		arp_lookup(t->host, t->mac, sizeof t->mac);
		if (t->mac[0]) tvs_save();
	}
}

static void tv_enqueue(struct tv *t, const struct cmd *c) {
	if (t->qcount == QLEN) { t->qhead = (t->qhead + 1) % QLEN; t->qcount--; }
	t->q[(t->qhead + t->qcount) % QLEN] = *c;
	t->qcount++;
}

/* Send what is queued once the session is up. PowerOn/PowerOff are discrete for the
 * Harmony engine but many TVs ignore KEYCODE_WAKEUP/SLEEP, so they send KEYCODE_POWER
 * only when the TV reports the other state. */
static void tv_flush(struct tv *t) {
	long long now = now_ms();
	while (t->qcount) {
		struct cmd *c = &t->q[t->qhead];
		int limit = c->code == PSEUDO_POWER_ON ? 20000 : 8000;
		if (now - c->at > limit) {
			logmsg("TV %s: dropped a command that waited %lld ms", t->id, now - c->at);
		} else {
			if (!t->ready || !t->c || !t->c->tls_up) return;
			struct pbuf out = { .n = 0 }, sub = { .n = 0 };
			int code = c->code;
			if (code == PSEUDO_POWER_ON || code == PSEUDO_POWER_OFF) {
				/* remote_set_active carries no power state: wait for remote_start,
				 * or a stale is_on could toggle the TV the wrong way. */
				if (!t->state_known) return;
				int want_on = code == PSEUDO_POWER_ON;
				if (t->is_on == want_on) {
					DBG("TV %s: already %s", t->id, want_on ? "on" : "off");
					code = 0;
				} else {
					code = 26;
					t->is_on = want_on; /* remote_start corrects this */
				}
			}
			if (c->link[0]) {
				pb_str(&sub, 1, c->link);
				pb_sub(&out, 90, &sub);
			} else if (code) {
				pb_uint(&sub, 1, (uint64_t)code);
				pb_uint(&sub, 2, (uint64_t)c->dir);
				pb_sub(&out, 10, &sub);
			}
			if (out.n) {
				if (conn_queue(t->c, &out) < 0) return;
				t->keys++;
				DBG("TV %s: key %d", t->id, code);
			}
		}
		t->qhead = (t->qhead + 1) % QLEN;
		t->qcount--;
	}
}

/* ================================================================== key names */

struct keyname { const char *name; int code; };
static const struct keyname KEYS[] = {
	{"PowerOn", PSEUDO_POWER_ON}, {"PowerOff", PSEUDO_POWER_OFF}, {"PowerToggle", 26},
	{"Home", 3}, {"Back", 4}, {"Return", 4},
	{"DirectionUp", 19}, {"DirectionDown", 20}, {"DirectionLeft", 21}, {"DirectionRight", 22},
	{"Select", 23}, {"VolumeUp", 24}, {"VolumeDown", 25}, {"Mute", 164},
	{"ChannelUp", 166}, {"ChannelDown", 167}, {"PrevChannel", 229},
	{"Menu", 82}, {"Settings", 176}, {"Info", 165}, {"Guide", 172}, {"Search", 84}, {"Assistant", 219},
	{"Play", 126}, {"Pause", 127}, {"PlayPause", 85}, {"Stop", 86},
	{"FastForward", 90}, {"Rewind", 89}, {"SkipForward", 87}, {"SkipBack", 88}, {"Record", 130},
	{"InputHdmi1", 243}, {"InputHdmi2", 244}, {"InputHdmi3", 245}, {"InputHdmi4", 246},
	{"InputNext", 178}, {"Captions", 175},
	{"Red", 183}, {"Green", 184}, {"Yellow", 185}, {"Blue", 186},
	{"Number0", 7}, {"Number1", 8}, {"Number2", 9}, {"Number3", 10}, {"Number4", 11},
	{"Number5", 12}, {"Number6", 13}, {"Number7", 14}, {"Number8", 15}, {"Number9", 16},
	{NULL, 0}
};

static int key_lookup(const char *name) {
	if (!name || !*name) return -1;
	if (!strncasecmp(name, "key:", 4)) {
		char *end;
		long v = strtol(name + 4, &end, 10);
		return (*end == 0 && v > 0 && v < 1000) ? (int)v : -1;
	}
	for (const struct keyname *k = KEYS; k->name; k++)
		if (!strcasecmp(k->name, name)) return k->code;
	return -1;
}

/* ================================================================== mDNS discovery */

#define MAX_FOUND 16
struct found { char name[65], host[16], bt[18]; int port; long long seen; };
static struct {
	int fd;
	long long until, started;
	struct found f[MAX_FOUND];
	int n;
} mdns = { .fd = -1 };

/* Read a DNS name (with compression) into out as dotted text. Returns bytes used. */
static int dns_name(const unsigned char *msg, size_t len, size_t off, char *out, size_t cap) {
	size_t o = 0, pos = off;
	int used = -1, jumps = 0;
	while (pos < len) {
		unsigned l = msg[pos];
		if (l == 0) { if (used < 0) used = (int)(pos + 1 - off); break; }
		if ((l & 0xc0) == 0xc0) {
			if (pos + 1 >= len || ++jumps > 16) return -1;
			if (used < 0) used = (int)(pos + 2 - off);
			pos = ((l & 0x3f) << 8) | msg[pos + 1];
			continue;
		}
		pos++;
		if (pos + l > len) return -1;
		if (o && o < cap - 1) out[o++] = '.';
		for (unsigned i = 0; i < l && o < cap - 1; i++) out[o++] = (char)msg[pos + i];
		pos += l;
	}
	out[o < cap ? o : cap - 1] = 0;
	return used;
}

static const char ANDROIDTV_SERVICE[] = "_androidtvremote2._tcp.local";

static void mdns_query(void) {
	unsigned char q[64];
	size_t n = 0;
	memset(q, 0, 12);
	q[5] = 1; /* one question */
	n = 12;
	const char *labels[] = { "_androidtvremote2", "_tcp", "local" };
	for (int i = 0; i < 3; i++) { size_t l = strlen(labels[i]); q[n++] = (unsigned char)l; memcpy(q + n, labels[i], l); n += l; }
	q[n++] = 0;
	q[n++] = 0; q[n++] = 12;     /* PTR */
	q[n++] = 0x80; q[n++] = 1;   /* IN, unicast response requested */
	struct sockaddr_in sa;
	memset(&sa, 0, sizeof sa);
	sa.sin_family = AF_INET;
	sa.sin_port = htons(5353);
	inet_pton(AF_INET, "224.0.0.251", &sa.sin_addr);
	sendto(mdns.fd, q, n, 0, (struct sockaddr *)&sa, sizeof sa);
}

static void mdns_start(int ms) {
	long long now = now_ms();
	if (mdns.fd < 0) {
		mdns.fd = socket(AF_INET, SOCK_DGRAM, 0);
		if (mdns.fd < 0) return;
		fcntl(mdns.fd, F_SETFD, FD_CLOEXEC);
		int one = 1;
		setsockopt(mdns.fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
		struct sockaddr_in sa;
		memset(&sa, 0, sizeof sa);
		sa.sin_family = AF_INET;
		sa.sin_port = htons(5353);
		if (bind(mdns.fd, (struct sockaddr *)&sa, sizeof sa) < 0) {
			sa.sin_port = 0; /* someone owns 5353: unicast replies still reach us */
			bind(mdns.fd, (struct sockaddr *)&sa, sizeof sa);
		}
		struct ip_mreq mr;
		inet_pton(AF_INET, "224.0.0.251", &mr.imr_multiaddr);
		mr.imr_interface.s_addr = htonl(INADDR_ANY);
		setsockopt(mdns.fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mr, sizeof mr);
		unsigned char ttl = 255;
		setsockopt(mdns.fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);
		mdns.started = now;
	}
	if (mdns.until < now + ms) mdns.until = now + ms;
	mdns_query();
}

static void mdns_stop(void) {
	if (mdns.fd >= 0) close(mdns.fd);
	mdns.fd = -1;
}

static struct found *found_slot(const char *name) {
	for (int i = 0; i < mdns.n; i++) if (!strcmp(mdns.f[i].name, name)) return &mdns.f[i];
	if (mdns.n == MAX_FOUND) return NULL;
	struct found *f = &mdns.f[mdns.n++];
	memset(f, 0, sizeof *f);
	snprintf(f->name, sizeof f->name, "%s", name);
	return f;
}

static void tv_rehost(struct tv *t, const char *host);

static void mdns_read(void) {
	unsigned char msg[1500];
	ssize_t len = recv(mdns.fd, msg, sizeof msg, 0);
	if (len < 12) return;
	unsigned qd = (msg[4] << 8) | msg[5];
	unsigned rr = ((msg[6] << 8) | msg[7]) + ((msg[8] << 8) | msg[9]) + ((msg[10] << 8) | msg[11]);
	if (!(msg[2] & 0x80)) return; /* a query, not a response */
	size_t pos = 12;
	char name[256];
	for (unsigned i = 0; i < qd; i++) {
		int u = dns_name(msg, (size_t)len, pos, name, sizeof name);
		if (u < 0) return;
		pos += (size_t)u + 4;
	}
	/* first pass collects SRV targets and A records; names are matched afterwards */
	struct { char target[256]; char inst[256]; int port; } srv[8];
	struct { char host[256]; char ip[16]; } arec[8];
	struct { char inst[256]; char bt[18]; } txt[8];
	int ns = 0, na = 0, nt = 0;
	char ptr_inst[8][256];
	int np = 0;
	for (unsigned i = 0; i < rr && pos < (size_t)len; i++) {
		int u = dns_name(msg, (size_t)len, pos, name, sizeof name);
		if (u < 0) return;
		pos += (size_t)u;
		if (pos + 10 > (size_t)len) return;
		unsigned type = (msg[pos] << 8) | msg[pos + 1];
		unsigned rdlen = (msg[pos + 8] << 8) | msg[pos + 9];
		size_t rd = pos + 10;
		pos = rd + rdlen;
		if (pos > (size_t)len) return;
		if (type == 12 && !strcasecmp(name, ANDROIDTV_SERVICE) && np < 8) {
			if (dns_name(msg, (size_t)len, rd, ptr_inst[np], sizeof ptr_inst[np]) > 0) np++;
		} else if (type == 33 && rdlen > 6 && ns < 8) {
			srv[ns].port = (msg[rd + 4] << 8) | msg[rd + 5];
			snprintf(srv[ns].inst, sizeof srv[ns].inst, "%s", name);
			if (dns_name(msg, (size_t)len, rd + 6, srv[ns].target, sizeof srv[ns].target) > 0) ns++;
		} else if (type == 1 && rdlen == 4 && na < 8) {
			snprintf(arec[na].host, sizeof arec[na].host, "%s", name);
			inet_ntop(AF_INET, msg + rd, arec[na].ip, sizeof arec[na].ip);
			na++;
		} else if (type == 16 && nt < 8) {
			snprintf(txt[nt].inst, sizeof txt[nt].inst, "%s", name);
			txt[nt].bt[0] = 0;
			for (size_t k = rd; k < rd + rdlen;) {
				unsigned l = msg[k++];
				if (k + l > rd + rdlen) break;
				if (l > 3 && !strncasecmp((const char *)msg + k, "bt=", 3)) {
					size_t bl = l - 3 < 17 ? l - 3 : 17;
					memcpy(txt[nt].bt, msg + k + 3, bl);
					txt[nt].bt[bl] = 0;
				}
				k += l;
			}
			nt++;
		}
	}
	/* an instance is named in a PTR, or carries an SRV for our service */
	for (int i = 0; i < ns; i++) {
		size_t il = strlen(srv[i].inst), sl = strlen(ANDROIDTV_SERVICE);
		if (il <= sl + 1 || strcasecmp(srv[i].inst + il - sl, ANDROIDTV_SERVICE)) continue;
		char inst[65];
		size_t cut = il - sl - 1;
		if (cut > 64) cut = 64;
		memcpy(inst, srv[i].inst, cut);
		inst[cut] = 0;
		struct found *f = found_slot(inst);
		if (!f) continue;
		f->port = srv[i].port;
		f->seen = now_ms();
		for (int a = 0; a < na; a++) if (!strcasecmp(arec[a].host, srv[i].target)) snprintf(f->host, sizeof f->host, "%s", arec[a].ip);
		for (int x = 0; x < nt; x++) if (!strcasecmp(txt[x].inst, srv[i].inst) && txt[x].bt[0]) snprintf(f->bt, sizeof f->bt, "%s", txt[x].bt);
		/* a paired TV that moved: follow it by its Bluetooth address */
		for (int k = 0; k < MAX_TVS; k++) {
			struct tv *t = &tvs[k];
			if (t->used && f->bt[0] && f->host[0] && !strcasecmp(t->bt, f->bt) && strcmp(t->host, f->host)) tv_rehost(t, f->host);
		}
	}
	(void)np;
}

/* ================================================================== pairing */

enum { P_IDLE, P_PREPARING, P_CONNECTING, P_CODE, P_CHECKING, P_PAIRED, P_FAILED };
static const char *PSTATE[] = { "idle", "preparing", "connecting", "code", "checking", "paired", "failed" };

static struct {
	int state;
	char host[16], name[65], error[160], tv_id[TV_ID_MAX];
	long long started, checking_since;
	struct conn *c;
} pair;

static void pair_fail(const char *why) {
	if (pair.c) conn_close(pair.c, why);
	pair.state = P_FAILED;
	snprintf(pair.error, sizeof pair.error, "%s", why);
	logmsg("pairing with %s failed: %s", pair.host, why);
}

static void polo_send(int field, const struct pbuf *body) {
	struct pbuf out = { .n = 0 };
	pb_uint(&out, 1, 2);       /* protocol_version */
	pb_uint(&out, 2, 200);     /* status OK */
	pb_sub(&out, (unsigned)field, body);
	conn_queue(pair.c, &out);
}

static void pair_on_message(void *owner, const unsigned char *d, size_t len) {
	(void)owner;
	uint64_t status = pb_get_uint(d, len, 2);
	if (status && status != 200) {
		pair_fail(status == 402 ? "The TV refused the code. Start again to get a new code." : "The TV stopped the pairing.");
		return;
	}
	const unsigned char *p = d, *end = d + len;
	struct pfield f;
	while (pb_next(&p, end, &f) == 1) {
		if (f.wt != 2) continue;
		struct pbuf body = { .n = 0 }, enc = { .n = 0 };
		switch (f.num) {
		case 11: /* pairing_request_ack → options: we type a 6-symbol hex code */
			pb_uint(&enc, 1, 3);
			pb_uint(&enc, 2, 6);
			pb_sub(&body, 1, &enc);
			pb_uint(&body, 3, 1);
			polo_send(20, &body);
			break;
		case 20: /* options → configuration */
			pb_uint(&enc, 1, 3);
			pb_uint(&enc, 2, 6);
			pb_sub(&body, 1, &enc);
			pb_uint(&body, 2, 1);
			polo_send(30, &body);
			break;
		case 31: /* configuration_ack: the TV shows the code */
			if (pair.state != P_CONNECTING) break;
			pair.state = P_CODE;
			logmsg("pairing with %s: the TV shows a code", pair.host);
			break;
		case 41: { /* secret_ack: paired */
			/* Only after we sent the secret: the pairing connection accepts any
			 * certificate, so an early ack must not skip the code check. */
			if (pair.state != P_CHECKING) {
				pair_fail("The TV answered out of order. Start again.");
				return;
			}
			unsigned char h[32];
			br_sha256_context sh;
			br_sha256_init(&sh);
			br_sha256_update(&sh, pair.c->cap.der, pair.c->cap.der_len);
			br_sha256_out(&sh, h);
			char id[TV_ID_MAX];
			snprintf(id, sizeof id, "%s", TV_ID_PREFIX);
			hex_encode(id + sizeof TV_ID_PREFIX - 1, h, 4);
			struct tv *t = tv_by_id(id);
			if (!t) for (int i = 0; i < MAX_TVS && !t; i++) if (!tvs[i].used) t = &tvs[i];
			if (!t) { pair_fail("Already paired with the most TVs this hub keeps (8)."); return; }
			int existed = t->used;
			if (!existed) { memset(t, 0, sizeof *t); t->backoff = 1000; t->vol = -1; }
			snprintf(t->id, sizeof t->id, "%s", id);
			snprintf(t->host, sizeof t->host, "%s", pair.host);
			snprintf(t->name, sizeof t->name, "%s", pair.name[0] ? pair.name : "Android TV");
			sanitize(t->name);
			/* the TV's certificate names its Bluetooth address: CN=atvremote/<bt> */
			const char *bt = memmem(pair.c->cap.der, pair.c->cap.der_len, "atvremote/", 10);
			if (bt && (size_t)(bt + 27 - (const char *)pair.c->cap.der) <= pair.c->cap.der_len) {
				memcpy(t->bt, bt + 10, 17);
				t->bt[17] = 0;
			}
			arp_lookup(t->host, t->mac, sizeof t->mac);
			unsigned char *der = malloc(pair.c->cap.der_len);
			if (!der) { pair_fail("out of memory"); return; }
			memcpy(der, pair.c->cap.der, pair.c->cap.der_len);
			char cpath[256], cname[40];
			snprintf(cname, sizeof cname, "tv-%s.crt.der", t->id);
			path_in_dir(cpath, sizeof cpath, cname);
			if (write_file_atomic(cpath, der, pair.c->cap.der_len, 0600) < 0 || tv_set_cert(t, der, pair.c->cap.der_len) < 0) {
				free(der);
				pair_fail("could not save the TV's certificate");
				return;
			}
			t->used = 1;
			if (tvs_save() < 0) { pair_fail("could not save the paired TV"); return; }
			if (t->c && t->c->fd >= 0) conn_close(t->c, "re-paired");
			t->next_attempt = 0;
			snprintf(pair.tv_id, sizeof pair.tv_id, "%s", t->id);
			pair.state = P_PAIRED;
			conn_close(pair.c, "paired");
			logmsg("paired TV %s (%s) at %s%s", t->id, t->name, t->host, existed ? " again" : "");
			return;
		}
		default:
			DBG("pairing: unhandled field %u", f.num);
		}
	}
}

static void pair_begin_connect(void) {
	if (!pair.c) {
		pair.c = calloc(1, sizeof *pair.c);
		if (!pair.c) { pair_fail("out of memory"); return; }
		pair.c->fd = -1;
	}
	if (conn_open(pair.c, pair.host, PAIR_PORT, NULL) < 0) {
		char why[160];
		snprintf(why, sizeof why, "Could not reach the TV at %s (%s). Is it on and on this network?", pair.host, pair.c->error);
		pair_fail(why);
		return;
	}
	pair.state = P_CONNECTING;
	struct pbuf body = { .n = 0 };
	pb_str(&body, 1, "atvremote");
	pb_str(&body, 2, opt_client_name);
	polo_send(10, &body);
}

static void pair_start(const char *host, const char *name) {
	if (pair.c && pair.c->fd >= 0) conn_close(pair.c, "restarted");
	memset(pair.error, 0, sizeof pair.error);
	pair.tv_id[0] = 0;
	snprintf(pair.host, sizeof pair.host, "%s", host);
	snprintf(pair.name, sizeof pair.name, "%s", name ? name : "");
	sanitize(pair.name);
	pair.started = now_ms();
	identity_ensure();
	if (!ident.ready) { pair.state = P_PREPARING; return; }
	pair_begin_connect();
}

/* Returns an error message, or NULL when the secret was sent. */
static const char *pair_finish(const char *code) {
	if (pair.state != P_CODE) return "The TV isn't waiting for a code. Start again.";
	char c[7];
	size_t n = 0;
	for (const char *s = code; *s && n < 7; s++) {
		if (*s == ' ' || *s == '-') continue;
		c[n++] = *s;
	}
	if (n != 6) return "The code has 6 characters.";
	c[6] = 0;
	unsigned char b[3];
	for (int i = 0; i < 3; i++) {
		char h[3] = { c[2 * i], c[2 * i + 1], 0 };
		char *end;
		long v = strtol(h, &end, 16);
		if (*end) return "The code uses only 0-9 and A-F.";
		b[i] = (unsigned char)v;
	}
	const unsigned char *cn = ident.n, *sn = pair.c->cap.pkey.key.rsa.n;
	size_t cnl = ident.nlen, snl = pair.c->cap.pkey.key.rsa.nlen;
	const unsigned char *ce = ident.e, *se = pair.c->cap.pkey.key.rsa.e;
	size_t cel = ident.elen, sel = pair.c->cap.pkey.key.rsa.elen;
	while (cnl > 1 && *cn == 0) { cn++; cnl--; }
	while (snl > 1 && *sn == 0) { sn++; snl--; }
	while (cel > 1 && *ce == 0) { ce++; cel--; }
	while (sel > 1 && *se == 0) { se++; sel--; }
	unsigned char h[32];
	br_sha256_context sh;
	br_sha256_init(&sh);
	br_sha256_update(&sh, cn, cnl);
	br_sha256_update(&sh, ce, cel);
	br_sha256_update(&sh, sn, snl);
	br_sha256_update(&sh, se, sel);
	br_sha256_update(&sh, b + 1, 2);
	br_sha256_out(&sh, h);
	if (h[0] != b[0]) return "That code doesn't match. Check the code on the TV and try again.";
	struct pbuf body = { .n = 0 };
	pb_bytes(&body, 1, h, sizeof h);
	polo_send(40, &body);
	pair.state = P_CHECKING;
	pair.checking_since = now_ms();
	return NULL;
}

/* ================================================================== TV host changes */

static void tv_rehost(struct tv *t, const char *host) {
	logmsg("TV %s moved from %s to %s", t->id, t->host, host);
	snprintf(t->host, sizeof t->host, "%s", host);
	t->mac[0] = 0;
	tvs_save();
	if (t->c && t->c->fd >= 0) conn_close(t->c, "moved");
	t->ready = 0;
	t->state_known = 0;
	t->backoff = 1000;
	t->next_attempt = 0;
}

/* ================================================================== HTTP */

static void url_decode(char *s) {
	char *o = s;
	for (; *s; s++) {
		if (*s == '%' && s[1] && s[2]) { char h[3] = { s[1], s[2], 0 }; *o++ = (char)strtol(h, NULL, 16); s += 2; }
		else if (*s == '+') *o++ = ' ';
		else *o++ = *s;
	}
	*o = 0;
}

/* Value of "key":"..." in a small JSON object (no escapes beyond \" are expected). */
static int json_str(const char *body, const char *key, char *out, size_t cap) {
	char pat[48];
	snprintf(pat, sizeof pat, "\"%s\"", key);
	const char *k = strstr(body, pat);
	if (!k) return -1;
	k += strlen(pat);
	while (*k == ' ' || *k == ':') k++;
	if (*k != '"') return -1;
	k++;
	size_t i = 0;
	while (*k && *k != '"' && i < cap - 1) {
		if (*k == '\\' && k[1]) k++;
		out[i++] = *k++;
	}
	out[i] = 0;
	return 0;
}

struct sbuf { char b[4096]; size_t n; };
static void sb(struct sbuf *s, const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int w = vsnprintf(s->b + s->n, sizeof s->b - s->n, fmt, ap);
	va_end(ap);
	if (w > 0) s->n = s->n + (size_t)w < sizeof s->b ? s->n + (size_t)w : sizeof s->b - 1;
}
static void sb_str(struct sbuf *s, const char *v) {
	sb(s, "\"");
	for (; *v; v++) {
		if (*v == '"' || *v == '\\') sb(s, "\\%c", *v);
		else if ((unsigned char)*v < 0x20) sb(s, " ");
		else sb(s, "%c", *v);
	}
	sb(s, "\"");
}

static void http_reply(int fd, const char *body) {
	char hdr[160];
	int n = snprintf(hdr, sizeof hdr, "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
	                 "Content-Length: %u\r\nConnection: close\r\n\r\n", (unsigned)strlen(body));
	(void)!write(fd, hdr, (size_t)n);
	(void)!write(fd, body, strlen(body));
}

static void status_json(struct sbuf *s) {
	sb(s, "{\"ok\":true,\"version\":\"%s\",\"identity\":%s,\"tvs\":[", VERSION,
	   ident.ready ? "\"ready\"" : ident.keygen_pid > 0 ? "\"preparing\"" : "\"none\"");
	int first = 1;
	for (int i = 0; i < MAX_TVS; i++) {
		struct tv *t = &tvs[i];
		if (!t->used) continue;
		sb(s, "%s{\"id\":\"%s\",\"name\":", first ? "" : ",", t->id);
		sb_str(s, t->name);
		sb(s, ",\"host\":\"%s\",\"mac\":\"%s\",\"connected\":%s,\"on\":%s,\"volume\":%d,\"volumeMax\":%d,\"muted\":%s,"
		   "\"keysSent\":%lu,\"connects\":%lu,\"error\":", t->host, t->mac, t->ready ? "true" : "false",
		   t->ready && t->is_on ? "true" : "false", t->vol, t->vol_max, t->muted ? "true" : "false", t->keys, t->connects);
		sb_str(s, t->ready || !t->c ? "" : t->c->error);
		sb(s, "}");
		first = 0;
	}
	sb(s, "]}");
}

static void pair_json(struct sbuf *s) {
	sb(s, "{\"ok\":true,\"state\":\"%s\",\"host\":\"%s\",\"name\":", PSTATE[pair.state], pair.host);
	sb_str(s, pair.name);
	sb(s, ",\"error\":");
	sb_str(s, pair.error);
	sb(s, ",\"tvId\":\"%s\"}", pair.tv_id);
}

static int valid_ipv4(const char *s) {
	struct in_addr a;
	return inet_pton(AF_INET, s, &a) == 1;
}

static void http_handle(int fd) {
	char req[3072];
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
	char method[8] = "", path[512] = "";
	sscanf(req, "%7s %511s", method, path);
	char *body = strstr(req, "\r\n\r\n");
	body = body ? body + 4 : req + n;
	struct sbuf s = { .n = 0 };

	if (!strcmp(path, "/cmd")) {
		/* The engine: {"device":"<tv id>","command":"<Name>"}. Always 200, at once. */
		char dev[TV_ID_MAX] = "", name[220] = "";
		json_str(body, "device", dev, sizeof dev);
		json_str(body, "command", name, sizeof name);
		struct tv *t = tv_by_id(dev);
		struct cmd c = { .dir = 3, .at = now_ms() };
		int ok = 0;
		if (t && !strncasecmp(name, "app:", 4)) {
			snprintf(c.link, sizeof c.link, "%s", name + 4);
			ok = 1;
		} else if (t) {
			char base[220];
			snprintf(base, sizeof base, "%s", name);
			char *colon = strchr(base, ':');   /* Name:start / Name:end for long presses */
			if (colon && strncasecmp(base, "key:", 4)) {
				*colon = 0;
				c.dir = !strcasecmp(colon + 1, "start") ? 1 : !strcasecmp(colon + 1, "end") ? 2 : 3;
			}
			c.code = key_lookup(base);
			ok = c.code > 0;
		}
		sb(&s, "{\"ok\":%s}", ok ? "true" : "false");
		http_reply(fd, s.b);
		if (!ok) { logmsg("engine sent an unknown device or command: %s %s", dev, name); return; }
		tv_enqueue(t, &c);
		if (c.code == PSEUDO_POWER_ON && !t->ready && t->mac[0] && now_ms() - t->last_wol > 3000) {
			send_wol(t->mac);
			t->last_wol = now_ms();
		}
		if (!t->ready && (!t->c || t->c->fd < 0)) { t->backoff = 1000; t->next_attempt = 0; }
		return;
	}
	if (!strncmp(path, "/status", 7)) { status_json(&s); http_reply(fd, s.b); return; }
	if (!strncmp(path, "/discover", 9)) {
		mdns_start(2500);
		sb(&s, "{\"ok\":true,\"searching\":true,\"found\":[");
		for (int i = 0; i < mdns.n; i++) {
			struct found *f = &mdns.f[i];
			if (!f->host[0]) continue;
			const char *paired = "";
			for (int k = 0; k < MAX_TVS; k++)
				if (tvs[k].used && ((f->bt[0] && !strcasecmp(tvs[k].bt, f->bt)) || !strcmp(tvs[k].host, f->host))) paired = tvs[k].id;
			sb(&s, "%s{\"name\":", s.b[s.n - 1] == '[' ? "" : ",");
			sb_str(&s, f->name);
			sb(&s, ",\"host\":\"%s\",\"paired\":\"%s\"}", f->host, paired);
		}
		sb(&s, "]}");
		http_reply(fd, s.b);
		return;
	}
	if (!strcmp(path, "/pair/start")) {
		char host[40] = "", name[80] = "";
		json_str(body, "host", host, sizeof host);
		json_str(body, "name", name, sizeof name);
		if (!valid_ipv4(host)) { http_reply(fd, "{\"ok\":false,\"error\":\"Enter the TV's IPv4 address, such as 192.168.1.40.\"}"); return; }
		if (tv_count() >= MAX_TVS && !tv_by_id(host)) {
			int known = 0;
			for (int k = 0; k < MAX_TVS; k++) known |= tvs[k].used && !strcmp(tvs[k].host, host);
			if (!known) { http_reply(fd, "{\"ok\":false,\"error\":\"This hub already has 8 network TVs.\"}"); return; }
		}
		pair_start(host, name);
		pair_json(&s);
		http_reply(fd, s.b);
		return;
	}
	if (!strncmp(path, "/pair/status", 12)) { pair_json(&s); http_reply(fd, s.b); return; }
	if (!strcmp(path, "/pair/finish")) {
		char code[24] = "";
		json_str(body, "code", code, sizeof code);
		const char *err = pair_finish(code);
		if (err) { sb(&s, "{\"ok\":false,\"error\":"); sb_str(&s, err); sb(&s, "}"); }
		else pair_json(&s);
		http_reply(fd, s.b);
		return;
	}
	if (!strcmp(path, "/pair/cancel")) {
		if (pair.c && pair.c->fd >= 0) conn_close(pair.c, "cancelled");
		pair.state = P_IDLE;
		pair_json(&s);
		http_reply(fd, s.b);
		return;
	}
	if (!strcmp(path, "/forget")) {
		char id[TV_ID_MAX] = "";
		json_str(body, "id", id, sizeof id);
		struct tv *t = tv_by_id(id);
		if (t) {
			if (t->c) { conn_close(t->c, "forgotten"); free(t->c); }
			char cpath[256], cname[40];
			snprintf(cname, sizeof cname, "tv-%s.crt.der", t->id);
			path_in_dir(cpath, sizeof cpath, cname);
			unlink(cpath);
			free(t->certder);
			logmsg("forgot TV %s (%s)", t->id, t->name);
			memset(t, 0, sizeof *t);
			tvs_save();
		}
		http_reply(fd, t ? "{\"ok\":true}" : "{\"ok\":true,\"note\":\"no such TV\"}");
		return;
	}
	if (!strcmp(path, "/rename")) {
		char id[TV_ID_MAX] = "", name[80] = "";
		json_str(body, "id", id, sizeof id);
		json_str(body, "name", name, sizeof name);
		struct tv *t = tv_by_id(id);
		if (t && name[0]) { snprintf(t->name, sizeof t->name, "%s", name); sanitize(t->name); tvs_save(); }
		http_reply(fd, "{\"ok\":true}");
		return;
	}
	if (!strncmp(path, "/key", 4)) {
		/* manual test: /key?device=<id>&name=<Name> */
		char *d = strstr(path, "device="), *k = strstr(path, "name=");
		char dev[TV_ID_MAX] = "", name[64] = "";
		if (d) { sscanf(d + 7, "%23[^&]", dev); }
		if (k) { sscanf(k + 5, "%63[^&]", name); url_decode(name); }
		struct tv *t = tv_by_id(dev);
		struct cmd c = { .dir = 3, .at = now_ms(), .code = key_lookup(name) };
		if (t && c.code > 0) { tv_enqueue(t, &c); if (!t->ready) t->next_attempt = 0; }
		http_reply(fd, t && c.code > 0 ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"unknown TV or key\"}");
		return;
	}
	http_reply(fd, "{\"ok\":false,\"error\":\"unknown request\"}");
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
	fprintf(stderr, "codex_androidtv %s\nusage: codex_androidtv [--dir /data/codex/androidtv] [--listen 127.0.0.1] [--port %d]\n"
	        "                 [--log /var/volatile/codex-androidtv.log] [--client-name NAME] [-v]\n", VERSION, ENGINE_PORT);
}

int main(int argc, char **argv) {
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		if (!strcmp(a, "-v")) { opt_verbose = 1; continue; }
		if (!strcmp(a, "--version")) { printf("codex_androidtv %s\n", VERSION); return 0; }
		if (!v) { usage(); return 2; }
		if (!strcmp(a, "--dir")) opt_dir = v;
		else if (!strcmp(a, "--listen")) opt_listen = v;
		else if (!strcmp(a, "--port")) opt_port = atoi(v);
		else if (!strcmp(a, "--log")) opt_log = v;
		else if (!strcmp(a, "--client-name")) opt_client_name = v;
		else { usage(); return 2; }
		i++;
	}
	if (opt_log) {
		logf = fopen(opt_log, "a");
		if (!logf) logf = stderr;
	}
	signal(SIGPIPE, SIG_IGN);
	int lfd = http_listen();
	if (lfd < 0) return 1;
	mkdir(opt_dir, 0700);
	identity_load();
	/* Make the identity now, in the background (about 25 s on a hub), so it is ready
	 * before the first pairing. */
	if (!ident.ready) identity_ensure();
	tvs_load();
	logmsg("version %s listening on %s:%d, %d paired TV(s)", VERSION, opt_listen, opt_port, tv_count());

	for (;;) {
		long long now = now_ms();
		identity_poll();
		if (pair.state == P_PREPARING && ident.ready) pair_begin_connect();
		if (pair.state == P_PREPARING && !ident.ready && ident.keygen_pid <= 0) identity_ensure();
		if (pair.state == P_CONNECTING && now - pair.started > 30000)
			pair_fail("The TV didn't answer. Is it on?");
		if (pair.state == P_CHECKING && now - pair.checking_since > 15000)
			pair_fail("The TV didn't confirm the code. Start again.");
		if (pair.state == P_CODE && now - pair.started > 300000) pair_fail("The code expired. Start again.");
		if (mdns.fd >= 0 && now > mdns.until && now - mdns.started > 30000) mdns_stop();

		for (int i = 0; i < MAX_TVS; i++) {
			struct tv *t = &tvs[i];
			if (!t->used) continue;
			int open = t->c && t->c->fd >= 0;
			if (!open && now >= t->next_attempt) tv_connect(t);
			open = t->c && t->c->fd >= 0;
			if (open && t->c->connecting && now - t->c->started > 3000) tv_lost(t, "the TV didn't answer");
			else if (open && !t->c->connecting && now - t->c->last_rx > 20000) tv_lost(t, "no traffic from the TV for 20 s");
			/* unreachable for a while: look for it on the network, it may have a new address */
			if (!t->ready && t->bt[0] && t->unreachable_since && now - t->unreachable_since > 60000 &&
			    now - t->last_rediscover > 300000) {
				t->last_rediscover = now;
				mdns_start(3000);
			}
			if (t->c && t->c->fd >= 0) tv_flush(t);
			else if (t->qcount) tv_flush(t); /* expire stale */
		}

		struct pollfd p[2 + MAX_TVS + 1];
		struct tv *owner[2 + MAX_TVS + 1];
		int np = 0;
		p[np].fd = lfd; p[np].events = POLLIN; owner[np++] = NULL;
		int mi = -1, pi = -1;
		if (mdns.fd >= 0) { mi = np; p[np].fd = mdns.fd; p[np].events = POLLIN; owner[np++] = NULL; }
		if (pair.c && pair.c->fd >= 0) { pi = np; p[np].fd = pair.c->fd; p[np].events = conn_events(pair.c); owner[np++] = NULL; }
		for (int i = 0; i < MAX_TVS; i++) {
			struct tv *t = &tvs[i];
			if (t->used && t->c && t->c->fd >= 0) { p[np].fd = t->c->fd; p[np].events = conn_events(t->c); owner[np++] = t; }
		}
		int timeout = 250;
		if (poll(p, (nfds_t)np, timeout) < 0 && errno != EINTR) { logmsg("poll: %s", strerror(errno)); sleep(1); continue; }
		if (p[0].revents & POLLIN) {
			int cfd = accept(lfd, NULL, NULL);
			if (cfd >= 0) { http_handle(cfd); close(cfd); }
		}
		if (mi >= 0 && (p[mi].revents & POLLIN)) mdns_read();
		/* The HTTP request above may have closed or replaced connections (pairing
		 * restarted, TV forgotten or re-paired): only pump what is still the
		 * polled descriptor. */
		if (pi >= 0 && p[pi].revents && pair.c && pair.c->fd == p[pi].fd) {
			if (conn_pump(pair.c, pair_on_message, NULL) < 0 && pair.state != P_PAIRED && pair.state != P_FAILED && pair.state != P_IDLE)
				pair_fail(pair.c->error[0] ? pair.c->error : "The TV closed the connection.");
		}
		for (int k = 0; k < np; k++) {
			struct tv *t = owner[k];
			if (!t || !p[k].revents) continue;
			if (!t->used || !t->c || t->c->fd != p[k].fd) continue;
			if (conn_pump(t->c, tv_on_message, t) < 0) tv_lost(t, t->c->error);
		}
		/* queued output (keys, pings) goes out even without socket events */
		if (pair.c && pair.c->fd >= 0 && pair.c->outn) conn_pump(pair.c, pair_on_message, NULL);
		for (int i = 0; i < MAX_TVS; i++) {
			struct tv *t = &tvs[i];
			if (t->used && t->c && t->c->fd >= 0 && (t->c->outn || t->c->connecting)) {
				if (conn_pump(t->c, tv_on_message, t) < 0) tv_lost(t, t->c->error);
			}
		}
	}
}
