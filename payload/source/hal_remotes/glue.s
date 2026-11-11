# hal_remotes: the places stock hal (4.15.600) enters the added code, and the
# way back into the stock functions. Included by hal_remotes.c, so it is
# assembled with that file's options. tools/build_hal_remotes.py writes the
# jumps to these labels into hal; the table of them is hooks() there.
#
# Every entry sets $gp to hal's own value (0x46b520) first: the C code calls
# hal's imports through hal's GOT, and the lazy-binding stubs need it.

	.set	push
	.set	noreorder
	.set	noat
	.text

	.macro	ENTRY name, target
	.globl	\name
	.type	\name, @function
	.ent	\name
\name:
	lui	$gp, 0x46
	j	\target
	ori	$gp, $gp, 0xb520
	.end	\name
	.size	\name, . - \name
	.endm

	ENTRY	g_send_data, ts_send_data
	ENTRY	g_notify_send, ts_notify_send
	ENTRY	g_update_pair_status, ts_update_pair_status
	ENTRY	g_hot_hbus, ts_hot_hbus
	ENTRY	g_hot_open, ts_hot_open
	ENTRY	g_handler_wait, ts_handler_wait
	ENTRY	g_stats, ts_stats
	ENTRY	g_object_data, ts_object_data

# A stock function whose first two words now jump to an ENTRY above: its body
# starts after the three words that compute $gp.
	ENTRY	orig_hot_send_data, 0x42e084
	ENTRY	orig_hot_hbus_notify_send, 0x42e618
	ENTRY	orig_hot_hbus, 0x42a248
	ENTRY	orig_hot_open, 0x4292f8
	ENTRY	orig_hot_object_data, 0x42bf04

# HOT thread (0x42cfcc), after rf_msg_subscribe succeeded: 0x42d0f8 jumps here
# with $s0 = context, $s1 = subscriber. Gate off: run the two displaced
# instructions and continue in the stock loop. Otherwise ts_hot_loop is the
# loop; when it gives up, leave through the stock exit path.
	.globl	g_hot_loop
	.type	g_hot_loop, @function
	.ent	g_hot_loop
g_hot_loop:
	lui	$gp, 0x46
	ori	$gp, $gp, 0xb520
	move	$a0, $s0
	jal	ts_hot_loop
	move	$a1, $s1
	bnez	$v0, 1f
	nop
	sw	$zero, 0x38($sp)
	j	0x42d100
	addiu	$s2, $sp, 0x18
1:	j	0x42d240
	nop
	.end	g_hot_loop
	.size	g_hot_loop, . - g_hot_loop

# hot_send_data_wait_reply, 0x42e49c: "lw $t8, 0x88($s7)" tested the stock
# context's link flag. Test the context the request went to. The instruction
# after the jal ("lw $t9, -0x7c54($gp)") runs in its delay slot.
	.globl	g_wr_link
	.type	g_wr_link, @function
	.ent	g_wr_link
g_wr_link:
	lui	$t8, %hi(ts_cmd_ctx)
	lw	$t8, %lo(ts_cmd_ctx)($t8)
	jr	$ra
	lw	$t8, 0x88($t8)
	.end	g_wr_link
	.size	g_wr_link, . - g_wr_link

# rf_eliminate_multiple_device, 0x427cdc: an older slot holds the model that
# was just paired ($a2 = model). Returns $a2 = ts_elim_policy(model).
# $v0 (table pointer), $v1 (model) and $a0 (the older slot) are live.
	.globl	g_elim
	.type	g_elim, @function
	.ent	g_elim
g_elim:
	addiu	$sp, $sp, -0x28
	sw	$ra, 0x24($sp)
	sw	$v0, 0x20($sp)
	sw	$v1, 0x1c($sp)
	sw	$a0, 0x18($sp)
	lui	$gp, 0x46
	ori	$gp, $gp, 0xb520
	jal	ts_elim_policy
	move	$a0, $a2
	move	$a2, $v0
	lw	$a0, 0x18($sp)
	lw	$v1, 0x1c($sp)
	lw	$v0, 0x20($sp)
	lw	$ra, 0x24($sp)
	jr	$ra
	addiu	$sp, $sp, 0x28
	.end	g_elim
	.size	g_elim, . - g_elim

	.set	pop
