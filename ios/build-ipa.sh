#!/usr/bin/env bash
# Build an unsigned release iOS IPA (melodious-ios-2.5.0.ipa) for AltStore / SideStore sideloading.
# Requires a full installation of Xcode with the iOS (iphoneos) SDK.
#
# Usage:
#   ./ios/build-ipa.sh [--output /path/to/melodious-ios-2.5.0.ipa]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/Melodious"
XCODEPROJ="$PROJECT_ROOT/Melodious.xcodeproj"
VERSION="2.5.0"
DEFAULT_OUT="$SCRIPT_DIR/melodious-ios-${VERSION}.ipa"
OUT_IPA="$DEFAULT_OUT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: $1 requires a file path argument." >&2
        exit 1
      fi
      OUT_IPA="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--output /path/to/melodious-ios-${VERSION}.ipa]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

ACTIVE_DEV_DIR="$(xcode-select -p 2>/dev/null || echo 'none')"
if ! command -v xcodebuild >/dev/null 2>&1 \
  || ! xcodebuild -version >/dev/null 2>&1 \
  || ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "ERROR: Full Xcode with the iOS (iphoneos) SDK is required to build an iOS IPA." >&2
  echo "       Active developer directory: ${ACTIVE_DEV_DIR}" >&2
  echo "       Install Xcode from the Mac App Store and select it with:" >&2
  echo "         sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/melodious-ipa.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

STAGE_DIR="$WORK_DIR/stage"
PAYLOAD_DIR="$STAGE_DIR/Payload"
APP_BUNDLE="$PAYLOAD_DIR/Melodious.app"
DERIVED_DATA="$WORK_DIR/DerivedData"
STAGE_IPA="$WORK_DIR/melodious-ios-${VERSION}.ipa"

mkdir -p "$PAYLOAD_DIR"

echo "==> Building unsigned Release Melodious.app with xcodebuild (generic/platform=iOS)..."
xcodebuild \
  -project "$XCODEPROJ" \
  -scheme Melodious \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  AD_HOC_CODE_SIGNING_ALLOWED=NO \
  clean build

BUILT_APP="$DERIVED_DATA/Build/Products/Release-iphoneos/Melodious.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "ERROR: Expected built app at $BUILT_APP" >&2
  exit 1
fi
cp -R "$BUILT_APP" "$APP_BUNDLE"

# Ensure no code signature or embedded provisioning profile is present in the unsigned IPA
rm -rf "$APP_BUNDLE/_CodeSignature" "$APP_BUNDLE/CodeResources" "$APP_BUNDLE/embedded.mobileprovision"

(
  cd "$STAGE_DIR"
  zip -qry "$STAGE_IPA" Payload
)

echo "==> Verifying unsigned iOS IPA archive..."
LISTING="$(unzip -l "$STAGE_IPA")"
echo "$LISTING"

if ! grep -q "Payload/Melodious.app/Melodious" <<<"$LISTING"; then
  echo "ERROR: IPA is missing Payload/Melodious.app/Melodious" >&2
  exit 1
fi
if ! grep -q "Payload/Melodious.app/Info.plist" <<<"$LISTING"; then
  echo "ERROR: IPA is missing Payload/Melodious.app/Info.plist" >&2
  exit 1
fi
if grep -q "embedded.mobileprovision" <<<"$LISTING"; then
  echo "ERROR: IPA unexpectedly contains an embedded.mobileprovision" >&2
  exit 1
fi
if grep -q "_CodeSignature" <<<"$LISTING"; then
  echo "ERROR: IPA unexpectedly contains _CodeSignature" >&2
  exit 1
fi

VERIFY_BIN="$WORK_DIR/verify-Melodious"
unzip -q -p "$STAGE_IPA" "Payload/Melodious.app/Melodious" > "$VERIFY_BIN"

PLATFORMS="$(otool -arch all -l "$VERIFY_BIN" | awk '
  /cmd LC_BUILD_VERSION/ { in_bv = 1; next }
  in_bv && /^Load command/ { in_bv = 0 }
  in_bv && $1 == "platform" { print $2; in_bv = 0 }
')"

if [[ -z "$PLATFORMS" ]]; then
  echo "ERROR: Could not find LC_BUILD_VERSION platform in Payload/Melodious.app/Melodious" >&2
  exit 1
fi

while IFS= read -r plat; do
  if [[ "$plat" != "2" && "$plat" != "IOS" ]]; then
    echo "ERROR: Payload/Melodious.app/Melodious is not an iOS binary (LC_BUILD_VERSION platform: $plat; expected iOS platform 2)." >&2
    otool -arch all -lv "$VERIFY_BIN" | grep -A 5 LC_BUILD_VERSION >&2 || true
    exit 1
  fi
done <<< "$PLATFORMS"

mkdir -p "$(dirname "$OUT_IPA")"
mv -f "$STAGE_IPA" "$OUT_IPA"

shasum -a 256 "$OUT_IPA"
echo "==> Successfully built unsigned iOS IPA: $OUT_IPA"
