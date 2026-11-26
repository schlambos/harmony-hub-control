# Gentoo ebuild

`app-misc/melodious` installs, under `/opt/melodious`:

| Command | What it is |
| --- | --- |
| `melodious` | The desktop app and Setup Wizard ([desktop/README.md](../../desktop/README.md)), with `USE=gui` (on by default) |
| `melodious-hub-root` | The root tool, [`tools/hub-root/run_harmony_hub_tool.py`](../../tools/hub-root/README.md) |
| `melodious-install` | The hub installer, [`install_webui.py`](../../docs/INSTALL.md), with its payload |

It also installs a udev rule that gives the logged-in user access to a hub on
USB (`046d:c129`), and with `USE=usb` (on by default) pulls in
`dev-python/hidapi` for the USB setup path.

**Status: Not fully tested, needs confirmation**, like the Linux desktop app
itself. Tested on amd64: the package builds, both command-line tools start, and
the desktop app opens its Setup Wizard. Not yet tested against a hub.

## Install

Copy `app-misc/melodious` into a local overlay
([Gentoo wiki: creating an ebuild repository](https://wiki.gentoo.org/wiki/Creating_an_ebuild_repository)),
then as root (with `package.accept_keywords` and `package.license` as directories):

```sh
echo 'app-misc/melodious ~amd64' >> /etc/portage/package.accept_keywords/melodious
echo 'app-misc/melodious all-rights-reserved' >> /etc/portage/package.license/melodious
emerge --ask app-misc/melodious
```

The licence line is needed because part of this repository is all rights
reserved ([LICENSE](../../LICENSE), section 1). For the same reason the ebuild
sets `RESTRICT="bindist mirror"`: don't redistribute the built package.

## How it is built

- The sources are the `v<version>` tag's GitHub archive. Nothing is compiled:
  the hub payload is the MIPS binaries the repository already carries.
- The desktop app runs on the prebuilt Electron that `desktop/package.json`
  pins, downloaded from Electron's GitHub release. `ELECTRON_PV` in the ebuild
  must match that pin.
- The web shell in `desktop/build/shell` is normally staged by
  `desktop/scripts/bundle-shell.sh`, which needs the pinned bun and a git
  checkout. The ebuild instead extracts the same three files from
  `payload/source/harmony_shell_assets.h`, which that script checks its output
  against, so the build needs neither bun nor npm nor network access.
- The app runs from the unpacked tree, not an `app.asar`, because the Setup
  Wizard is enabled on Linux only in source mode. The launcher sets
  `MELODIOUS_WIZARD_PYTHON` to the system Python the package was built for.

## New version

Copy the ebuild to `melodious-<version>.ebuild`, set `ELECTRON_PV` to the
Electron version in `desktop/package.json`, check the Electron runtime
dependencies if that changed, and regenerate the checksums:

```sh
ebuild melodious-<version>.ebuild manifest
```
