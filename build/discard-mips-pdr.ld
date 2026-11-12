/* Added to every Zig (lld) link for the hub with -Wl,-T,<this file>.
 *
 * clang's MIPS backend writes a .pdr section (procedure descriptors, an
 * old debugging aid) for every function. It isn't loaded at run time and
 * `-s` doesn't remove it, yet it is 26-52 KB of each binary. INSERT keeps
 * lld's default layout and only adds this rule, so the loaded image (every
 * segment and the entry point) is byte-identical with or without it, apart
 * from the ELF header's section-table fields (e_shoff, e_shnum,
 * e_shstrndx), which the loader never reads. tools/elf_load_cmp.py checks it.
 */
SECTIONS
{
  /DISCARD/ : { *(.pdr) }
}
INSERT AFTER .text;
