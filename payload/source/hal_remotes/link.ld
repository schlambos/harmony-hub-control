/*
 * hal_remotes sits in the bytes of hal's .pdr section (file 0x53cd0-0x586b0),
 * mapped by the spare program header at the same offset within a page:
 * code and constants first, data from the next page boundary so that writes
 * never touch a page holding code.
 */
ENTRY(g_hot_loop)
SECTIONS
{
	. = 0x473cd0;
	.text : { *(.text .text.*) }
	.rodata : { *(.rodata .rodata.*) }
	_code_end = .;
	. = 0x477000;
	.data : { *(.data .data.*) *(.sdata .sdata.*) *(.sbss .sbss.*) *(.bss .bss.*) *(COMMON) }
	_data_end = .;
	/DISCARD/ : { *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.comment) *(.gnu.attributes) *(.mdebug.*) *(.eh_frame*) *(.note*) *(.got*) *(.llvm_addrsig) }
}
ASSERT(_code_end <= 0x477000, "hal_remotes: code overruns its pages")
ASSERT(_data_end <= 0x4786b0, "hal_remotes: data overruns .pdr")
