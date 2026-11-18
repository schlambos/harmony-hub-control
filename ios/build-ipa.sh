#!/usr/bin/env bash
# Build an unsigned release IPA (melodious-ios-2.5.0.ipa) for AltStore / SideStore sideloading.
#
# Usage:
#   ./ios/build-ipa.sh [--output /path/to/melodious-ios-2.5.0.ipa] [--require-xcode]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/Melodious"
XCODEPROJ="$PROJECT_ROOT/Melodious.xcodeproj"
VERSION="2.5.0"
BUILD_NUM="1"
BUNDLE_ID="app.melodious.ios"
DEFAULT_OUT="$SCRIPT_DIR/melodious-ios-${VERSION}.ipa"
OUT_IPA="$DEFAULT_OUT"
REQUIRE_XCODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o)
      OUT_IPA="$2"
      shift 2
      ;;
    --require-xcode)
      REQUIRE_XCODE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/melodious-ipa.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

STAGE_DIR="$WORK_DIR/stage"
PAYLOAD_DIR="$STAGE_DIR/Payload"
APP_BUNDLE="$PAYLOAD_DIR/Melodious.app"
DERIVED_DATA="$WORK_DIR/DerivedData"

mkdir -p "$PAYLOAD_DIR"

if xcodebuild -version >/dev/null 2>&1; then
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
else
  if [[ "$REQUIRE_XCODE" -eq 1 ]]; then
    echo "ERROR: Full Xcode.app is required (--require-xcode), but active developer dir is $(xcode-select -p 2>/dev/null || echo 'none')." >&2
    exit 1
  fi
  echo "NOTE: Full Xcode.app (iPhoneOS.sdk) is not active on this host (active: $(xcode-select -p 2>/dev/null || echo 'none'))."
  echo "      Compiling Swift sources in Release mode via CommandLineTools and packaging unsigned Payload/Melodious.app..."

  SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
  if [[ ! -d "$SDK_PATH" ]]; then
    SDK_PATH="$(xcrun --show-sdk-path)"
  fi

  mkdir -p "$APP_BUNDLE"
  SWIFT_FILES=()
  while IFS= read -r -d '' file; do
    SWIFT_FILES+=("$file")
  done < <(find "$PROJECT_ROOT/Melodious" -name "*.swift" -print0 | sort -z)

  xcrun swiftc \
    -O \
    -sdk "$SDK_PATH" \
    -module-name Melodious \
    "${SWIFT_FILES[@]}" \
    -o "$APP_BUNDLE/Melodious"

  # Strip ad-hoc linker signature so the binary in the IPA is strictly unsigned
  codesign --remove-signature "$APP_BUNDLE/Melodious" >/dev/null 2>&1 || true

  # Resolve Info.plist variables matching Xcode's Release-iphoneos output
  sed \
    -e "s/\$(DEVELOPMENT_LANGUAGE)/en/g" \
    -e "s/\$(EXECUTABLE_NAME)/Melodious/g" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/${BUNDLE_ID}/g" \
    -e "s/\$(PRODUCT_NAME)/Melodious/g" \
    "$PROJECT_ROOT/Melodious/Info.plist" > "$APP_BUNDLE/Info.plist"

  printf 'APPL????' > "$APP_BUNDLE/PkgInfo"
  cp "$PROJECT_ROOT/Melodious/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png" "$APP_BUNDLE/AppIcon-1024.png"
fi

# Ensure no code signature or embedded provisioning profile is present in the unsigned IPA
rm -rf "$APP_BUNDLE/_CodeSignature" "$APP_BUNDLE/CodeResources" "$APP_BUNDLE/embedded.mobileprovision"

mkdir -p "$(dirname "$OUT_IPA")"
rm -f "$OUT_IPA"
(
  cd "$STAGE_DIR"
  zip -qry "$OUT_IPA" Payload
)

echo "==> Verifying unsigned IPA archive: $OUT_IPA"
LISTING="$(unzip -l "$OUT_IPA")"
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

shasum -a 256 "$OUT_IPA"
echo "==> Successfully built unsigned IPA: $OUT_IPA"
