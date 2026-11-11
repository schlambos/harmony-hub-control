/*
 * hal_remotes: the code added to the hub's own /usr/bin/hal (firmware 4.15.600)
 * for "Multiple remotes of one model" and "Two remotes with a screen".
 * See docs/MULTI_REMOTE.md and docs/TWO_SCREEN_REMOTES.md.
 *
 * Built freestanding for mips32r2 big-endian, no PIC, no libc, by
 * tools/build_hal_remotes.py, which places the result in hal's unloaded .pdr
 * bytes and maps them with the spare program header. Nothing here runs unless
 * hal reaches one of the hooks in glue.s.
 *
 * Rules the build checks on the compiled code:
 *   - stock hal functions are called at their stock address through $t9
 *     (they compute $gp from $t9);
 *   - imports are called through hal's own GOT, with $gp = hal's $gp (glue.s
 *     sets it on every entry);
 *   - nothing writes $gp.
 *
 * HOT is the transport between the hub and remotes with a screen (EquadID
 * 16417). Stock hal has one HOT context, so two such remotes share one set of
 * sequence numbers, one link flag and one "send to" slot. With the two-screen
 * gate on, every screen-remote slot gets its own context and the stock state
 * machine runs on each of them from the one HOT thread.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;

/* ---- stock hal (4.15.600) ---- */

#define HAL_GP 0x46b520u
#define PRIMARY ((void *)0x466f74)        /* the stock HOT context (0x170 bytes) */
#define PRIMARY_SUB ((void *)0x466f94)    /* its radio subscriber (context + 0x20) */
#define HOT_MODE (*(u32 *)0x466f70)       /* 0 = hub, 1 = remote; hal is built from shared code */
#define JUNIPER_INDEX (*(u32 *)0x467134)  /* stock: highest slot holding a 16417 */
#define HOT_IDLE 0x462284u                /* state table of hot_Idle */
#define HOT_REQUEST_OBJ ((u32 *)0x469e10) /* where a remote's request waits for the handler thread */

#define U8(p, o) (*(u8 *)((u8 *)(p) + (o)))
#define U16(p, o) (*(u16 *)((u8 *)(p) + (o)))
#define U32(p, o) (*(u32 *)((u8 *)(p) + (o)))

/* HOT context fields */
#define C_STATE 0x04      /* state table; +0x28 in it is the state id (0 Idle, 1 CoolDown, >1 mid-object) */
#define C_TRANS 0x18      /* name of the transition being run */
#define C_PEER 0x7c       /* radio slot frames are sent to */
#define C_PEER2 0x7d
#define C_FIFO 0x80       /* frames sent since the peer was last heard */
#define C_LINK 0x88
#define C_TIMEOUT 0x8c    /* poll timeout in ms, 0 = none */
#define C_NTIMEOUT 0x90
#define C_RECV_BUF 0xcc   /* the object being received */
#define C_RECV_TYPE 0xd0
#define C_RECV_LEN 0xd4
#define C_SEND_MUTEX 0xec
#define C_SEND_COND 0x104
#define C_IOV 0x110
#define C_IOVCNT 0x114
#define C_TYPE 0x118
#define C_RESULT 0x124
#define C_VERSION 0x128
#define C_STATS 0x12c
#define C_SIZE 0x170

/* state table entries */
#define ST_LINKLOSS 0x08
#define ST_SENDOBJECT 0x1c
#define ST_TIMEOUT 0x20
#define ST_ID 0x28

typedef int (*log_fn)(int, const char *, ...);
#define libhal_log ((log_fn)0x416058)
#define rf_msg_wait ((int (*)(void *, u32, void *))0x42b1f4)
#define rf_msg_interrupt ((int (*)(void *))0x42af18)
#define hot_recv_parse_packet ((void (*)(void *, void *, int))0x42cbbc)
#define hot_inc_stat ((void (*)(void *, u32, u32))0x42bb48)
#define hot_object_wait ((int (*)(void *, int *))0x42c0ac)
#define hot_stats_handler ((int (*)(void *))0x42e724)

#define GOT(off) (*(void **)(HAL_GP + (off)))
#define pthread_mutex_lock ((int (*)(void *))GOT(-0x7a5c))
#define pthread_mutex_unlock ((int (*)(void *))GOT(-0x7e48))
#define pthread_cond_wait ((int (*)(void *, void *))GOT(-0x7f2c))
#define pthread_cond_signal ((int (*)(void *))GOT(-0x7c1c))
#define json_integer ((void *(*)(long long))GOT(-0x7984))
#define json_object_set_new_nocheck ((int (*)(void *, const char *, void *))GOT(-0x7a80))
#define STAT_NAMES ((const char **)GOT(-0x7bd8))

/* stock strings, so the log reads as it always did */
#define S_HOT_SEND_DATA ((const char *)0x44c18c)
#define S_TX_SENDING ((const char *)0x44be98)
#define S_TX_LINK_LOSS ((const char *)0x44beb8)
#define S_TX_ERROR ((const char *)0x44bedc)
#define S_TX_DONE ((const char *)0x44bef4)
#define S_NOT_PAIRED ((const char *)0x44be4c)
#define S_NOTIFY_SEND ((const char *)0x44c144)
#define S_NOTIFY_SENT ((const char *)0x44bfc4)
#define S_NOTIFY_FAILED ((const char *)0x44bf90)
#define S_TIMEOUT ((const char *)0x44bcb0)
#define S_SENDOBJECT ((const char *)0x44bcb8)
#define S_LINKLOSS ((const char *)0x44bcc4)

/* The hooks: where stock hal enters this code, and the way back. */
__asm__(".include \"glue.s\"");

/* stock bodies of the functions whose entry now jumps here (glue.s) */
int orig_hot_send_data(u32 type, void *iov, int iovcnt);
int orig_hot_hbus_notify_send(void *data, void *len);
int orig_hot_hbus(void *request);
int orig_hot_open(void *file, const char *path);
int orig_hot_object_data(void *ctx, u32 *obj);

/* ---- state ---- */

#define SLOTS 6
#define QUEUE 16
#define MUTEX_SIZE 24 /* uClibc 0.9.30.1 linuxthreads; all-zero is an initialised mutex */
#define GATES_PATH "/var/run/codex_hal_gates"
#define MODEL_SCREEN 0x4021
#define MODEL_DONGLE 0x880e

struct ts_state {
	u8 inited;
	u8 two;    /* gate: two remotes with a screen */
	u8 multi;  /* gate: multiple remotes of one model (no screen) */
	u8 serial; /* two-screen fallback: one object at a time, other slots wait */

	u8 mask;        /* bit n: slot n holds a 16417 */
	u8 last_req;    /* slot of the request the handler thread took last */
	u8 last_active; /* slot heard last */
	u8 reply_slot;  /* slot the handler thread's current request came from */

	/*
	 * Slots and their contexts. Written under alloc_mutex by whichever thread
	 * meets a slot first, read by the HOT thread without it: volatile, so the
	 * stores land in the order written (the count last).
	 */
	volatile u8 nctx; /* contexts in use; ctxs[0] is always the stock one */
	u8 primary_taken;
	u8 hint_slot;
	u8 pin_slot;
	u32 hint_sp;
	u32 pin_until;

	void *volatile ctx[SLOTS + 1]; /* slot -> context */
	volatile u8 index[SLOTS + 1];  /* slot -> position in ctxs */
	volatile u8 slot_of[SLOTS];    /* position in ctxs -> slot */
	void *volatile ctxs[SLOTS];
	u32 deadline[SLOTS];
	volatile u8 sendreq[SLOTS + 1];

	u32 drops;

	u8 queue_head; /* requests waiting for the handler thread (ts_object_data) */
	u8 queued;
	u32 queue[QUEUE][4]; /* laid out as the head of the request object */

	u8 alloc_mutex[MUTEX_SIZE];
	u8 outer[SLOTS + 1][MUTEX_SIZE]; /* one hub-initiated object per slot at a time (stock: one in all) */
	u8 pool[SLOTS - 1][C_SIZE];
};

static struct ts_state ts = { .nctx = 1, .ctxs = { PRIMARY } };

/* The context hot_send_data_wait_reply tests for link loss (glue.s, g_wr_link). */
void *ts_cmd_ctx = PRIMARY;

/* ---- small helpers ---- */

static long sys3(long nr, long a, long b, long c)
{
	register long v0 __asm__("$2") = nr;
	register long a0 __asm__("$4") = a;
	register long a1 __asm__("$5") = b;
	register long a2 __asm__("$6") = c;
	register long a3 __asm__("$7");
	__asm__ volatile("syscall"
			 : "+r"(v0), "=r"(a3)
			 : "r"(a0), "r"(a1), "r"(a2)
			 : "$1", "$3", "$8", "$9", "$10", "$11", "$12", "$13", "$14", "$15", "$24", "$25", "hi", "lo",
			   "memory");
	return a3 ? -1 : v0;
}

#define SYS_read 4003
#define SYS_open 4005
#define SYS_close 4006
#define SYS_clock_gettime 4263

static u32 now_ms(void)
{
	u32 t[2];

	t[0] = t[1] = 0;
	sys3(SYS_clock_gettime, 1, (long)t, 0);
	return t[0] * 1000u + t[1] / 1000000u;
}

static void zero(void *p, u32 n)
{
	volatile u8 *b = p;

	while (n--)
		*b++ = 0;
}

/*
 * rcS.local writes the gates just before it binds this hal: three characters,
 * '1' or '0', for two-screen, multi-remote and serial. No file, or anything
 * else in it, leaves every gate off and every hook on its stock path.
 */
static void ts_init(void)
{
	char b[4];
	long fd, n;

	if (ts.inited)
		return;
	b[0] = b[1] = b[2] = '0';
	fd = sys3(SYS_open, (long)GATES_PATH, 0, 0);
	if (fd >= 0) {
		n = sys3(SYS_read, fd, (long)b, 3);
		sys3(SYS_close, fd, 0, 0);
		if (n != 3)
			b[0] = b[1] = b[2] = '0';
	}
	ts.two = b[0] == '1';
	ts.multi = b[1] == '1';
	ts.serial = b[2] == '1';
	ts.inited = 1;
	libhal_log(6, "%s: gates two-screen=%d multi-remote=%d serial=%d\n", "hal_remotes", ts.two, ts.multi,
		   ts.serial);
}

static int slot_ok(u32 slot)
{
	return slot - 1 < SLOTS;
}

static int is_screen_slot(u32 slot)
{
	return slot_ok(slot) && ((ts.mask >> slot) & 1);
}

/* The context of a slot. The first slot that shows up keeps the stock one. */
static void *ctx_get(u32 slot)
{
	void *c;
	u32 i;

	if (!slot_ok(slot))
		return PRIMARY;
	c = ts.ctx[slot];
	if (c)
		return c;
	pthread_mutex_lock(ts.alloc_mutex);
	c = ts.ctx[slot];
	if (!c) {
		if (!ts.primary_taken) {
			ts.primary_taken = 1;
			i = 0;
			c = PRIMARY;
		} else {
			i = ts.nctx;
			c = ts.pool[i - 1];
			zero(c, C_SIZE); /* as hot_init leaves the stock one */
			U32(c, 0) = (u32)c;
			U32(c, C_STATE) = HOT_IDLE;
			U32(c, C_VERSION) = 0x201;
			ts.ctxs[i] = c;
			ts.deadline[i] = 0;
		}
		ts.slot_of[i] = slot;
		ts.index[slot] = i;
		if (i)
			ts.nctx = i + 1;
		ts.ctx[slot] = c;
		libhal_log(6, "%s: slot %d uses HOT context %d\n", "hal_remotes", slot, i);
	}
	pthread_mutex_unlock(ts.alloc_mutex);
	return c;
}

static u32 ctx_index(void *c)
{
	u32 i;

	for (i = 1; i < ts.nctx; i++)
		if (ts.ctxs[i] == c)
			return i;
	return 0;
}

static int ctx_busy(void *c)
{
	u32 st = U32(c, C_STATE);

	return st && U32(st, ST_ID) > 1;
}

/* Serial mode: is a context other than this one in the middle of an object? */
static int other_busy(void *c)
{
	u32 i;

	for (i = 0; i < ts.nctx; i++)
		if (ts.ctxs[i] != c && ctx_busy(ts.ctxs[i]))
			return 1;
	return 0;
}

static void arm(void *c)
{
	u32 t = U32(c, C_TIMEOUT);

	if (t)
		ts.deadline[ctx_index(c)] = now_ms() + t;
}

static void arm_all(void)
{
	u32 i;

	for (i = 0; i < ts.nctx; i++)
		arm(ts.ctxs[i]);
}

static void fire(void *c, u32 entry, const char *name)
{
	u32 st = U32(c, C_STATE);

	if (!st)
		return;
	U32(c, C_TRANS) = (u32)name;
	((void (*)(void *, u32, u32))U32(st, entry))(c, 0, 0);
	U32(c, C_TRANS) = 0;
	arm(c);
}

/* ---- the HOT thread ---- */

static void link_lost(void *c)
{
	U32(c, C_VERSION) = 0x201;
	U32(c, C_FIFO) = 0;
	U32(c, C_LINK) = 0;
	hot_inc_stat(c, 0xe, 1);
	fire(c, ST_LINKLOSS, S_LINKLOSS);
}

/*
 * Called once by the HOT thread after it subscribed to the radio (glue.s,
 * g_hot_loop). Returns 0 with the gate off: the stock loop then runs,
 * untouched. Otherwise this is the loop, and it returns only when the stock
 * one would have given up.
 */
int ts_hot_loop(void *primary, void *sub)
{
	u32 msg[8];
	u8 *b = (u8 *)msg;
	u32 i, n, slot, wait, rem, now;
	s32 which;
	int rc, errors = 0;
	void *c;

	(void)primary;
	ts_init();
	if (!ts.two)
		return 0;

	for (;;) {
		/* objects other threads asked to send (ts_send_slot) */
		for (slot = 0; slot <= SLOTS; slot++) {
			if (!ts.sendreq[slot])
				continue;
			c = slot ? ts.ctx[slot] : PRIMARY;
			if (ts.serial && other_busy(c))
				continue;
			ts.sendreq[slot] = 0;
			fire(c, ST_SENDOBJECT, S_SENDOBJECT);
		}

		/* wait for the radio, at most until the earliest poll timeout */
		n = ts.nctx;
		if (n == 1) {
			/* one context: the stock wait, to the millisecond */
			wait = U32(PRIMARY, C_TIMEOUT);
			which = wait ? 0 : -1;
		} else {
			now = now_ms();
			wait = 0;
			which = -1;
			for (i = 0; i < n; i++) {
				if (!U32(ts.ctxs[i], C_TIMEOUT))
					continue;
				rem = ts.deadline[i] - now;
				if ((s32)rem < 1)
					break; /* due: the other remote's frames must not put it off */
				if (which < 0 || rem < wait) {
					wait = rem;
					which = i;
				}
			}
			if (i < n) {
				c = ts.ctxs[i];
				U32(c, C_FIFO) = 0;
				U32(c, C_NTIMEOUT)++;
				fire(c, ST_TIMEOUT, S_TIMEOUT);
				continue;
			}
		}
		rc = rf_msg_wait(sub, wait, msg);

		if (rc == -1) {
			if (errors >= 4)
				return 1;
			errors++;
			continue;
		}
		errors = 0;
		if (rc == -0x91) {
			if (which >= 0) {
				c = ts.ctxs[which];
				U32(c, C_FIFO) = 0;
				U32(c, C_NTIMEOUT)++;
				fire(c, ST_TIMEOUT, S_TIMEOUT);
			}
			continue;
		}
		if (rc == -4)
			continue;

		if (b[0] == 0x10 && b[2] == 0x41 && (b[4] & 0x40)) {
			/*
			 * A device dropped its link. A screen remote's own: its context.
			 * Any other device's: every context, which is what stock does
			 * with its one.
			 */
			if (is_screen_slot(b[1])) {
				link_lost(ctx_get(b[1]));
			} else {
				n = ts.nctx;
				for (i = 0; i < n; i++)
					link_lost(ts.ctxs[i]);
			}
			continue;
		}
		if (b[0] != 0x12) {
			arm_all();
			continue;
		}

		/* a HOT frame: byte 1 is the slot it came from */
		slot = b[1];
		c = ctx_get(slot);
		if (slot_ok(slot))
			ts.last_active = slot;
		if (ts.serial && other_busy(c)) {
			ts.drops++; /* its sender resends on its next poll timeout */
			continue;
		}
		U32(c, C_FIFO) = 0;
		U32(c, C_LINK) = 1;
		U32(c, C_NTIMEOUT) = 0;
		hot_recv_parse_packet(c, b, 0x1e);
		arm(c);
	}
}

/*
 * hot_object_data(ctx, obj): a finished object is handed to the thread waiting
 * for it. For requests that is the one handler thread, through the one request
 * object, and stock replaces a request the handler has not taken yet. One
 * remote waits for each answer, so there never was a second; two remotes can
 * each finish one before the handler is back. Those wait here, in order, and
 * the handler takes the next when it comes back for one (ts_handler_wait).
 * The queue is only touched with the request object's mutex held.
 */
static void take_from_ctx(u32 *obj, void *ctx)
{
	obj[0] = U32(ctx, C_RECV_BUF);
	obj[1] = U32(ctx, C_RECV_LEN);
	obj[2] = U32(ctx, C_RECV_TYPE);
	U8(obj, 0xc) = U8(ctx, C_PEER);
	U8(obj, 0xd) = U8(ctx, C_PEER2);
	U32(ctx, C_RECV_BUF) = 0;
	U32(ctx, C_RECV_LEN) = 0;
}

int ts_object_data(void *ctx, u32 *obj)
{
	u32 *q;

	ts_init();
	if (!ts.two || HOT_MODE || obj != HOT_REQUEST_OBJ || ts.nctx == 1) /* one remote: stock, to the letter */
		return orig_hot_object_data(ctx, obj);
	if (pthread_mutex_lock(obj + 5))
		return -1;
	if (!obj[0] && !ts.queued) {
		take_from_ctx(obj, ctx); /* what stock does */
		obj[4] = 1;
		pthread_cond_signal(obj + 11);
	} else if (ts.queued < QUEUE) {
		q = ts.queue[(ts.queue_head + ts.queued) % QUEUE];
		take_from_ctx(q, ctx);
		ts.queued++;
	} else {
		pthread_mutex_unlock(obj + 5);
		libhal_log(3, "%s: request queue full, the oldest waiting request is replaced\n", "hal_remotes");
		return orig_hot_object_data(ctx, obj);
	}
	pthread_mutex_unlock(obj + 5);
	return 0;
}

/* ---- addressing ---- */

static u32 linked_mask(void)
{
	u32 s, m = 0;

	for (s = 1; s <= SLOTS; s++)
		if (((ts.mask >> s) & 1) && ts.ctx[s] && U32(ts.ctx[s], C_LINK))
			m |= 1u << s;
	return m;
}

/*
 * THE TARGETING RULE for objects the hub starts (a command to a remote: its IR
 * blaster, LED, HID relay, firmware, time, ...). Change it here.
 *
 *   1. "hot.1N.<cmd>" or "/rf/hot/1N/<path>" names slot N (ts_hot_hbus, ts_hot_open);
 *   2. the rest of a file session goes where its open went;
 *   3. "hot.1.<cmd>": the remote whose request the hub took last, if it is linked;
 *   4. else the linked remote heard last;
 *   5. else the highest linked screen-remote slot;
 *   6. else stock's choice, the highest screen-remote slot.
 *
 * With one screen remote paired every step gives that remote, as stock does.
 */
static u32 ts_pick_target(u32 base)
{
	u32 here = (u32)&here;
	u32 m, s;

	if (ts.hint_sp && ts.hint_sp - here < 0x3000 && is_screen_slot(ts.hint_slot))
		return ts.hint_slot;
	if (base >= 2 && base <= 6 && is_screen_slot(ts.pin_slot) && (s32)(ts.pin_until - now_ms()) > 0)
		return ts.pin_slot;
	m = linked_mask();
	if ((m >> ts.last_req) & 1)
		return ts.last_req;
	if ((m >> ts.last_active) & 1)
		return ts.last_active;
	for (s = SLOTS; s >= 1; s--)
		if ((m >> s) & 1)
			return s;
	return JUNIPER_INDEX & 0xff;
}

/* hot_send_data on one slot's context; the stock function, context by context. */
static int ts_send_slot(u32 slot, u32 type, void *iov, int iovcnt)
{
	void *c = ctx_get(slot);
	void *outer = ts.outer[slot_ok(slot) ? slot : 0];
	int rc, res;

	if (pthread_mutex_lock(outer))
		return -1;
	if (pthread_mutex_lock((u8 *)c + C_SEND_MUTEX)) {
		pthread_mutex_unlock(outer);
		return -1;
	}
	libhal_log(7, S_TX_SENDING, S_HOT_SEND_DATA, type);
	U8(c, C_PEER2) = 1;
	U32(c, C_IOV) = (u32)iov;
	U32(c, C_IOVCNT) = (u32)iovcnt;
	U32(c, C_TYPE) = type;
	U8(c, C_PEER) = slot;
	ts.sendreq[slot_ok(slot) ? slot : 0] = 1;
	rf_msg_interrupt(PRIMARY_SUB);
	rc = pthread_cond_wait((u8 *)c + C_SEND_COND, (u8 *)c + C_SEND_MUTEX);
	res = (int)U32(c, C_RESULT);
	if (rc) {
		res = -1;
	} else if (!U32(c, C_LINK)) {
		libhal_log(3, S_TX_LINK_LOSS, S_HOT_SEND_DATA);
		res = -0x1f7;
	} else if (res < 0) {
		libhal_log(3, S_TX_ERROR, S_HOT_SEND_DATA, res);
	} else {
		libhal_log(7, S_TX_DONE, S_HOT_SEND_DATA);
	}
	pthread_mutex_unlock((u8 *)c + C_SEND_MUTEX);
	pthread_mutex_unlock(outer);
	return res;
}

/* hot_send_data(type, iov, iovcnt): entry of the stock function (glue.s). */
int ts_send_data(u32 type, void *iov, int iovcnt)
{
	u32 base = type & 0xff;
	u32 slot;

	ts_init();
	if (!ts.two || HOT_MODE)
		return orig_hot_send_data(type, iov, iovcnt);
	if (!JUNIPER_INDEX) {
		libhal_log(3, S_NOT_PAIRED, S_HOT_SEND_DATA);
		return -1;
	}
	if (base & 0x80) {
		/* a reply: to the remote that asked */
		slot = ts.reply_slot;
		if (!slot_ok(slot))
			slot = ts_pick_target(0);
	} else {
		slot = ts_pick_target(base);
		if (base >= 1 && base <= 6) {
			ts.pin_slot = slot;
			ts.pin_until = now_ms() + 10000;
		}
		ts_cmd_ctx = ctx_get(slot);
	}
	return ts_send_slot(slot, type, iov, iovcnt);
}

/* hot_hbus_notify_send(data, len): a state notify goes to every linked screen remote. */
int ts_notify_send(void *data, void *len)
{
	void *iov[2];
	u32 targets[SLOTS];
	u32 i, n = 0, m;
	int r, res = 0;

	ts_init();
	if (!ts.two || HOT_MODE)
		return orig_hot_hbus_notify_send(data, len);
	m = linked_mask();
	for (i = 1; i <= SLOTS; i++)
		if ((m >> i) & 1)
			targets[n++] = i;
	iov[0] = data;
	iov[1] = len;
	for (i = 0; i < n; i++) {
		r = ts_send_slot(targets[i], 10, iov, 1);
		if (r >= 0) {
			libhal_log(7, S_NOTIFY_SENT, S_NOTIFY_SEND);
			continue;
		}
		libhal_log(3, S_NOTIFY_FAILED, S_NOTIFY_SEND, r);
		res = r;
		/*
		 * With more than one target, a remote that didn't take a notify sits
		 * out until it is heard again, so it can't hold up the others for
		 * five seconds a notify. With one target this is stock: keep trying.
		 */
		if (n > 1)
			U32(ts.ctx[targets[i]], C_LINK) = 0;
	}
	return res;
}

/* hot_update_pair_status(table): the stock function, plus which slots hold a screen remote. */
void ts_update_pair_status(u8 *table)
{
	u32 juniper = JUNIPER_INDEX;
	u32 i, mask = 0;
	s32 idx;

	for (i = 0; i < SLOTS; i++, table += 0x18) {
		idx = (s32)U32(table, 0x14);
		if (idx > 0 && U16(table, 0) == MODEL_SCREEN) {
			juniper = (u32)idx;
			if (slot_ok((u32)idx))
				mask |= 1u << idx;
		}
	}
	JUNIPER_INDEX = juniper;
	ts.mask = mask;
}

/*
 * The handler thread's wait for the next request (it holds the request
 * object's mutex): hand it one that queued up meanwhile, and remember who
 * sent the one it gets.
 */
int ts_handler_wait(u32 *obj, int *timeout)
{
	u32 *q;
	int rc;

	if (ts.queued && !obj[0] && obj == HOT_REQUEST_OBJ) {
		q = ts.queue[ts.queue_head];
		obj[0] = q[0];
		obj[1] = q[1];
		obj[2] = q[2];
		obj[3] = q[3];
		obj[4] = 1;
		ts.queue_head = (ts.queue_head + 1) % QUEUE;
		ts.queued--;
	}
	rc = hot_object_wait(obj, timeout);
	ts.reply_slot = U8(obj, 0xc);
	ts.last_req = ts.reply_slot;
	return rc;
}

/* "hot.<n>.<cmd>" or "/rf/hot/<n>/<path>": n = 10 + slot names a remote. */
static u32 explicit_slot(const char *p)
{
	u32 n = 0, digits = 0;

	if (p[0] == '/' && p[1] == 'r' && p[2] == 'f' && p[3] == '/' && p[4] == 'h' && p[5] == 'o' && p[6] == 't' &&
	    p[7] == '/')
		p += 8;
	else if (p[0] == 'h' && p[1] == 'o' && p[2] == 't' && p[3] == '.')
		p += 4;
	else
		return 0;
	while (*p >= '0' && *p <= '9' && digits < 3) {
		n = n * 10 + (u32)(*p++ - '0');
		digits++;
	}
	if (!digits || (*p != '.' && *p != '/'))
		return 0;
	return n > 10 && is_screen_slot(n - 10) ? n - 10 : 0;
}

/* libhal_rf_hot_hbus_without_lock(request): entry of the stock function. */
int ts_hot_hbus(void *request)
{
	u32 slot = ts.two ? explicit_slot((const char *)U32(request, 4)) : 0;
	int r;

	if (slot) {
		ts.hint_slot = slot;
		ts.hint_sp = (u32)&slot;
	}
	r = orig_hot_hbus(request);
	if (slot)
		ts.hint_sp = 0;
	return r;
}

/* libhal_rf_hot_open(file, path): entry of the stock function. */
int ts_hot_open(void *file, const char *path)
{
	u32 slot = ts.two ? explicit_slot(path) : 0;
	int r;

	if (slot) {
		ts.hint_slot = slot;
		ts.hint_sp = (u32)&slot;
	}
	r = orig_hot_open(file, path);
	if (slot)
		ts.hint_sp = 0;
	return r;
}

/* ---- pairing: which same-model duplicate stays ---- */

/*
 * rf_eliminate_multiple_device found an older slot holding the model that was
 * just paired (glue.s, g_elim). 0: keep both. 1: unpair the older one now.
 * 2: stock's path for a screen remote (unpair, or the delayed unpair).
 */
u32 ts_elim_policy(u32 model)
{
	ts_init();
	if (model == MODEL_DONGLE)
		return 0;
	if (model == MODEL_SCREEN)
		return ts.two ? 0 : 2;
	if (model > MODEL_SCREEN && model <= MODEL_SCREEN + 3) /* 16418-16420, the keyboard among them */
		return 1;
	return ts.multi ? 0 : 1;
}

/* ---- hot.stats ---- */

static char *put(char *p, const char *s)
{
	while (*s)
		*p++ = *s++;
	*p = 0;
	return p;
}

static void set_int(void *obj, const char *key, u32 v)
{
	json_object_set_new_nocheck(obj, key, json_integer((long long)v));
}

/* hot.stats: stock's 17 counters over every context, then the two-screen view. */
int ts_stats(void *request)
{
	static const u8 per_slot[] = { 3, 2, 10, 15, 13 };
	int rc = hot_stats_handler(request);
	void *obj = (void *)U32(request, 0x10);
	char key[32], *p;
	u32 i, k, n, v, x;

	ts_init();
	if (rc || !obj || !ts.two)
		return rc;
	n = ts.nctx;
	if (n > 1) {
		for (k = 0; k < 17; k++) {
			v = 0;
			for (i = 0; i < n; i++) {
				x = U32(ts.ctxs[i], C_STATS + 4 * k);
				if (k == 4 || k == 5) /* TX/RX MAX LENGTH */
					v = x > v ? x : v;
				else
					v += x;
			}
			set_int(obj, STAT_NAMES[k], v);
		}
	}
	set_int(obj, "TS MODE", ts.serial ? 2 : 1);
	set_int(obj, "TS SLOTS", ts.mask);
	set_int(obj, "TS CONTEXTS", ts.primary_taken ? n : 0);
	set_int(obj, "TS DROPS", ts.drops);
	for (i = 0; i < n; i++) {
		if (!i && !ts.primary_taken)
			continue;
		key[0] = 'S';
		key[1] = (char)('0' + ts.slot_of[i]);
		key[2] = ' ';
		put(key + 3, "LINK");
		set_int(obj, key, U32(ts.ctxs[i], C_LINK));
		for (k = 0; k < sizeof(per_slot); k++) {
			p = put(key + 3, STAT_NAMES[per_slot[k]]);
			(void)p;
			set_int(obj, key, U32(ts.ctxs[i], C_STATS + 4 * per_slot[k]));
		}
	}
	return rc;
}
