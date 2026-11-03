#include <stdio.h>
#include <sys/vfs.h>

/*
 * Free-space probe for the installers. The hub's BusyBox has no df, so the
 * installers copy this into their RAM staging folder, run it, and delete it
 * with the folder. It is never installed on flash.
 *
 *   codex_flash_free <path>...
 *   flash type=0x<f_type> total_bytes=<n> free_bytes=<n> avail_bytes=<n> path=<path>
 *
 * Through the hub's unionfs, statfs reports the writable jffs2 branch
 * (mtdblock4), where every persistent write lands. jffs2 counts dirty space
 * as available, because garbage collection reclaims it on demand, and has
 * already taken its write reserve out of f_bavail.
 */
int main(int argc, char **argv) {
    int rc = 0;
    if (argc < 2) {
        fputs("usage: codex_flash_free <path>...\n", stderr);
        return 2;
    }
    for (int i = 1; i < argc; i++) {
        struct statfs st;
        if (statfs(argv[i], &st) != 0) {
            perror(argv[i]);
            rc = 1;
            continue;
        }
        /* Older kernels leave f_frsize at 0; the counts are then in f_bsize. */
        unsigned long long unit = st.f_frsize ? (unsigned long long)st.f_frsize : (unsigned long long)st.f_bsize;
        printf("flash type=0x%lx total_bytes=%llu free_bytes=%llu avail_bytes=%llu path=%s\n",
               (unsigned long)st.f_type,
               (unsigned long long)st.f_blocks * unit,
               (unsigned long long)st.f_bfree * unit,
               (unsigned long long)st.f_bavail * unit,
               argv[i]);
    }
    return rc;
}
