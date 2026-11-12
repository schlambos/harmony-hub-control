#!/bin/sh
# Merge main into the current branch (or a pull request via --pr <N>),
# automatically resolving derived-file conflicts (binaries, build/pins/*,
# MANIFEST.txt, generated web headers, and pre-Phase-2 inline pin hunks) by
# rebuilding with tools/repin.sh and verifying with tools/ci/verify_pins.py.
#
# Why merge instead of rebase:
#   - A branch with several commits that each rebuilt codex_webui would conflict
#     on every commit during a rebase; merging main resolves in a single step.
#   - Merging preserves contributor commit SHA-1s and authorship on PR branches
#     and pushes back without --force.
#
# Usage:
#   sh tools/absorb_main.sh [--main <ref>] [--no-fetch]
#   sh tools/absorb_main.sh --pr <N> [--push] [--main <ref>]
set -eu

SCRIPT_PATH=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
HERE=$(dirname -- "$SCRIPT_PATH")
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (CDPATH= cd -- "$HERE/.." && pwd))
cd "$REPO_ROOT"

MAIN_REF=""
PR_NUM=""
PUSH=0
NO_FETCH=0

usage() {
  cat <<'EOF'
Usage:
  sh tools/absorb_main.sh [--main <ref>] [--no-fetch]
  sh tools/absorb_main.sh --pr <N> [--push] [--main <ref>]

Merges main into the branch. If any hand-written file conflicts, stops
immediately (exit != 0), lists the conflicting hand-written files, and aborts
the merge cleanly. If only derived files conflict, resolves them automatically,
rebuilds the changed binaries via tools/repin.sh, verifies with
tools/ci/verify_pins.py, and commits the merge.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr)
      [ "$#" -ge 2 ] || { echo "error: --pr requires a pull request number" >&2; exit 1; }
      PR_NUM="$2"
      shift 2
      ;;
    --push)
      PUSH=1
      shift
      ;;
    --main)
      [ "$#" -ge 2 ] || { echo "error: --main requires a ref" >&2; exit 1; }
      MAIN_REF="$2"
      shift 2
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "$PR_NUM" ]; then
  if [ "$NO_FETCH" -eq 0 ] && git remote get-url origin >/dev/null 2>&1; then
    git fetch origin main >/dev/null 2>&1 || true
  fi
  _target_main="${MAIN_REF:-origin/main}"
  if ! git rev-parse -q --verify "$_target_main" >/dev/null 2>&1; then
    _target_main="main"
  fi
  _wt=$(mktemp -d "${TMPDIR:-/tmp}/melodious-absorb-pr-${PR_NUM}.XXXXXX")
  cleanup_wt() {
    git -C "$REPO_ROOT" worktree remove --force "$_wt" >/dev/null 2>&1 || rm -rf "$_wt"
  }
  trap cleanup_wt EXIT HUP INT TERM
  git worktree add --detach "$_wt" "$_target_main" >/dev/null
  (
    cd "$_wt"
    gh pr checkout "$PR_NUM" >/dev/null
    sh "$SCRIPT_PATH" --no-fetch --main "$_target_main"
    python3 "$HERE/ci/verify_pins.py" --root "$_wt"
    if [ "$PUSH" -eq 1 ]; then
      _head_ref=$(gh pr view "$PR_NUM" --json headRefName --jq .headRefName)
      _upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
      if [ -n "$_upstream" ]; then
        _remote="${_upstream%%/*}"
        git push "$_remote" "HEAD:refs/heads/$_head_ref"
      else
        git push origin "HEAD:refs/heads/$_head_ref"
      fi
      echo "absorb_main: pushed updated PR #$PR_NUM ($_head_ref)"
    else
      echo "absorb_main: PR #$PR_NUM absorbed $_target_main cleanly in temporary worktree (pass --push to push to the PR branch)"
    fi
  )
  exit 0
fi

# Ensure working tree has no ongoing merge/rebase or uncommitted changes
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "error: a merge is already in progress; finish or 'git merge --abort' first" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit or stash changes before running absorb_main.sh" >&2
  git status --short >&2
  exit 1
fi

if [ -z "$MAIN_REF" ]; then
  if [ "$NO_FETCH" -eq 0 ] && git remote get-url origin >/dev/null 2>&1; then
    git fetch origin main >/dev/null 2>&1 || true
  fi
  if git rev-parse -q --verify origin/main >/dev/null 2>&1; then
    MAIN_REF="origin/main"
  elif git rev-parse -q --verify main >/dev/null 2>&1; then
    MAIN_REF="main"
  else
    echo "error: neither origin/main nor main exists; pass --main <ref>" >&2
    exit 1
  fi
else
  if ! git rev-parse -q --verify "$MAIN_REF" >/dev/null 2>&1; then
    echo "error: target ref '$MAIN_REF' does not exist" >&2
    exit 1
  fi
fi

MERGE_BASE=$(git merge-base HEAD "$MAIN_REF")
PRE_HEAD=$(git rev-parse HEAD)

if git merge-base --is-ancestor "$MAIN_REF" HEAD; then
  echo "absorb_main: branch already contains $MAIN_REF"
  python3 "$HERE/ci/verify_pins.py" --root "$REPO_ROOT"
  exit 0
fi

# Identify binaries whose source inputs or binaries changed on the branch
# (MERGE_BASE..HEAD) and on main (MERGE_BASE..MAIN_REF).
ZIG_BINS="codex_webui codex_bt_pair_agent codex_bthid_keyboard codex_hal_ltcp codex_hbus codex_dhcpd codex_portal codex_usbeth codex_flash_free codex_androidtv"

SRC_BINS=""
BIN_TOUCHED=""

add_src_bin() {
  case " $SRC_BINS " in
    *" $1 "*) ;;
    *) SRC_BINS="$SRC_BINS $1" ;;
  esac
}

add_bin_touched() {
  case " $BIN_TOUCHED " in
    *" $1 "*) ;;
    *) BIN_TOUCHED="$BIN_TOUCHED $1" ;;
  esac
}

scan_inputs() {
  _diff_range="$1"
  for _p in $(git diff --name-only "$_diff_range"); do
    case "$_p" in
      tools/webui-sim/public/*|tools/package_harmony_shell.sh|payload/web/*|tools/embed_activity_ui.sh|payload/source/codex_webui.c|payload/source/remote_skin_jpg.h)
        add_src_bin codex_webui
        ;;
      payload/source/harmony_shell_assets.h|payload/source/activity_ui_assets.h)
        add_src_bin codex_webui
        ;;
      payload/source/codex_bt_pair_agent.c) add_src_bin codex_bt_pair_agent ;;
      payload/source/codex_bthid_keyboard.c) add_src_bin codex_bthid_keyboard ;;
      payload/source/codex_hal_ltcp.c) add_src_bin codex_hal_ltcp ;;
      payload/source/codex_hbus.c) add_src_bin codex_hbus ;;
      payload/source/codex_dhcpd.c) add_src_bin codex_dhcpd ;;
      payload/source/codex_portal.c) add_src_bin codex_portal ;;
      payload/source/codex_usbeth.c) add_src_bin codex_usbeth ;;
      payload/source/codex_flash_free.c) add_src_bin codex_flash_free ;;
      payload/source/codex_androidtv.c) add_src_bin codex_androidtv ;;
      build/discard-mips-pdr.ld)
        for _zb in $ZIG_BINS; do add_src_bin "$_zb"; done
        ;;
      payload/bin/MANIFEST.txt|payload/bin/FILES) ;;
      payload/bin/*) add_bin_touched "${_p#payload/bin/}" ;;
      payload/helpers/codex_flash_free) add_bin_touched codex_flash_free ;;
      build/pins/*) add_bin_touched "${_p#build/pins/}" ;;
    esac
  done
}

scan_inputs "$MERGE_BASE..HEAD"
BRANCH_SRC_BINS="$SRC_BINS"
BRANCH_BIN_TOUCHED="$BIN_TOUCHED"

SRC_BINS=""
BIN_TOUCHED=""
scan_inputs "$MERGE_BASE..$MAIN_REF"
MAIN_SRC_BINS="$SRC_BINS"

# Perform the merge without committing so we can inspect conflicts and repin
if git merge --no-commit --no-ff "$MAIN_REF" >/dev/null 2>&1; then
  MERGE_STATUS=0
else
  MERGE_STATUS=$?
fi

UNMERGED=$(git diff --name-only --diff-filter=U || true)

is_derived_path() {
  case "$1" in
    payload/bin/*|payload/helpers/codex_flash_free|build/pins/*|payload/source/harmony_shell_assets.h|payload/source/activity_ui_assets.h|tools/webui-sim/build/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Resolve pre-Phase-2 inline pin conflict hunks in build/build_harmony_tools_kali.sh
# and docs/BUILD.md when the branch side of the conflict only edited legacy pin lines.
try_resolve_legacy_pin_file() {
  _file="$1"
  python3 - "$REPO_ROOT" "$MERGE_BASE" "$PRE_HEAD" "$MAIN_REF" "$_file" <<'PY'
import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
merge_base, pre_head, main_ref, rel = sys.argv[2:6]
path = root / rel

def is_legacy_pin_line(rel_path: str, line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    if rel_path == "build/build_harmony_tools_kali.sh":
        if re.match(r"^[A-Z]+_EXPECT_(SHA256|SIZE)=\S+$", s):
            return True
        if s.startswith("#:") or s.startswith("BEARSSL_") or s.startswith("BUSYBOX_") or s.startswith("DROPBEAR_"):
            return True
        if re.match(r"^[A-Z]+_(SHA256|SIZE)=\$\(", s):
            return True
        if re.match(r'^if \[ "\$[A-Z]+_SHA256" != "\$[A-Z]+_EXPECT_SHA256"', s):
            return True
        if re.match(r'^echo "error: .* build is not exact', s):
            return True
        if s in {"exit 1", "fi"}:
            return True
        return False
    if rel_path == "docs/BUILD.md":
        if re.match(r"^\| `[\w.-]+` \| \d+ \| `[0-9a-f]{64}` \|$", s):
            return True
        if re.search(r"size \d+,\s*SHA-256", s) or re.match(r"^`[0-9a-f]{64}`\.?$", s):
            return True
        if re.search(r"`payload/source/[\w./-]+`\s*(?:—|blob)\s*`[0-9a-f]{40}`", s):
            return True
        if "Pinned source blobs:" in s or "_EXPECT_SHA256" in s or "MANIFEST.txt" in s:
            return True
        return False
    return False

# Check what lines the branch actually changed in (merge_base..pre_head) for this file.
diff = subprocess.run(
    ["git", "diff", "-U0", f"{merge_base}..{pre_head}", "--", rel],
    cwd=root,
    check=True,
    capture_output=True,
    text=True,
).stdout

changed_lines = []
for raw in diff.splitlines():
    if raw.startswith(("+++", "---", "@@")):
        continue
    if raw.startswith(("+", "-")):
        changed_lines.append(raw[1:])

if not changed_lines:
    sys.exit(1)

# If every line changed by the branch in this file was a legacy pin line, take main's version.
if all(is_legacy_pin_line(rel, ln) for ln in changed_lines):
    theirs = subprocess.run(
        ["git", "show", f"{main_ref}:{rel}"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    path.write_bytes(theirs)
    sys.exit(0)

# Otherwise, inspect individual conflict blocks in the file: if every conflict
# block's HEAD side only differs on legacy pin lines, resolve each block to main's side.
text = path.read_text(encoding="utf-8", errors="replace")
pattern = re.compile(
    r"^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n",
    re.M | re.S,
)
if not pattern.search(text):
    sys.exit(1)

for m in pattern.finditer(text):
    ours_block = m.group(1)
    if not all(is_legacy_pin_line(rel, ln) for ln in ours_block.splitlines()):
        sys.exit(1)

resolved = pattern.sub(lambda m: m.group(2), text)
path.write_text(resolved, encoding="utf-8")
sys.exit(0)
PY
}

HAND_CONFLICTS=""
DERIVED_CONFLICTS=""

for _f in $UNMERGED; do
  if is_derived_path "$_f"; then
    DERIVED_CONFLICTS="$DERIVED_CONFLICTS $_f"
  elif [ "$_f" = "build/build_harmony_tools_kali.sh" ] || [ "$_f" = "docs/BUILD.md" ]; then
    if try_resolve_legacy_pin_file "$_f"; then
      git add -- "$_f"
      echo "absorb_main: resolved pre-Phase-2 legacy pin conflict in $_f"
    else
      HAND_CONFLICTS="$HAND_CONFLICTS $_f"
    fi
  else
    HAND_CONFLICTS="$HAND_CONFLICTS $_f"
  fi
done

if [ -n "$HAND_CONFLICTS" ]; then
  echo "error: absorb_main stopped because hand-written files conflict with $MAIN_REF:" >&2
  for _hf in $HAND_CONFLICTS; do
    echo "  - $_hf" >&2
  done
  git merge --abort >/dev/null 2>&1 || git reset --merge >/dev/null 2>&1 || true
  echo "absorb_main: merge aborted cleanly; working tree restored to $(git rev-parse --short HEAD)" >&2
  exit 1
fi

# Resolve all conflicting derived files by starting from main's version
for _df in $DERIVED_CONFLICTS; do
  if git cat-file -e "$MAIN_REF:$_df" 2>/dev/null; then
    git checkout --theirs -- "$_df"
    git add -- "$_df"
  else
    git rm -f -- "$_df" >/dev/null
  fi
done

# Determine which binaries must be rebuilt by repin.sh:
# - Any binary whose source inputs changed on the branch (BRANCH_SRC_BINS)
# - Any binary that conflicted and had source changes on either side
REBUILD_BINS=""
add_rebuild() {
  case " $REBUILD_BINS " in
    *" $1 "*) ;;
    *) REBUILD_BINS="$REBUILD_BINS $1" ;;
  esac
}

for _b in $BRANCH_SRC_BINS; do
  add_rebuild "$_b"
done

for _df in $DERIVED_CONFLICTS; do
  case "$_df" in
    payload/source/harmony_shell_assets.h|payload/source/activity_ui_assets.h|payload/bin/codex_webui|build/pins/codex_webui)
      add_rebuild codex_webui
      ;;
    payload/bin/MANIFEST.txt|payload/bin/FILES)
      ;;
    payload/bin/*)
      _bname="${_df#payload/bin/}"
      case " $BRANCH_SRC_BINS $MAIN_SRC_BINS " in
        *" $_bname "*) add_rebuild "$_bname" ;;
      esac
      ;;
    payload/helpers/codex_flash_free|build/pins/codex_flash_free)
      case " $BRANCH_SRC_BINS $MAIN_SRC_BINS " in
        *" codex_flash_free "*) add_rebuild codex_flash_free ;;
      esac
      ;;
    build/pins/*)
      _bname="${_df#build/pins/}"
      case " $BRANCH_SRC_BINS $MAIN_SRC_BINS " in
        *" $_bname "*) add_rebuild "$_bname" ;;
      esac
      ;;
  esac
done

# For any binary the branch touched directly without changing its C source
# (e.g. a binary-only branch or pre-built binary), if it conflicted with main's
# binary and no source changed, keep the branch's binary unless main also changed it.
for _b in $BRANCH_BIN_TOUCHED; do
  case " $REBUILD_BINS " in
    *" $_b "*) continue ;;
  esac
  case " $MAIN_SRC_BINS " in
    *" $_b "*)
      add_rebuild "$_b"
      ;;
    *)
      _rel="payload/bin/$_b"
      [ "$_b" = codex_flash_free ] && _rel="payload/helpers/codex_flash_free"
      if git cat-file -e "$PRE_HEAD:$_rel" 2>/dev/null; then
        git checkout "$PRE_HEAD" -- "$_rel"
      fi
      ;;
  esac
done

REPIN_SCRIPT="$REPO_ROOT/tools/repin.sh"
[ -f "$REPIN_SCRIPT" ] || REPIN_SCRIPT="$HERE/repin.sh"

if [ -n "$REBUILD_BINS" ]; then
  # shellcheck disable=SC2086
  REPIN_REPO_ROOT="$REPO_ROOT" sh "$REPIN_SCRIPT" --base "$MAIN_REF" $REBUILD_BINS
else
  REPIN_REPO_ROOT="$REPO_ROOT" sh "$REPIN_SCRIPT" --pin-only
fi

git add -- payload/bin build/pins payload/helpers/codex_flash_free \
  payload/source/harmony_shell_assets.h payload/source/activity_ui_assets.h

if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  git commit --no-edit
elif ! git diff --cached --quiet; then
  git commit -m "chore(build): repin derived artifacts after absorbing $MAIN_REF"
fi

python3 "$HERE/ci/verify_pins.py" --root "$REPO_ROOT"
echo "absorb_main: cleanly absorbed $MAIN_REF into $(git rev-parse --abbrev-ref HEAD)"
