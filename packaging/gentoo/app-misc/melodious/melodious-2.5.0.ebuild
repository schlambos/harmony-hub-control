# Copyright 2026 Nick Andrade
# Distributed under the terms of the GNU General Public License v2

EAPI=8

PYTHON_COMPAT=( python3_{12..15} )

inherit desktop python-single-r1 udev xdg

MY_PN="harmony-hub-control"
# The Electron that desktop/package.json pins.
ELECTRON_PV="45.0.0"

DESCRIPTION="Melodious: local setup and control of Logitech Harmony Hubs, with no cloud"
HOMEPAGE="https://github.com/schlambos/harmony-hub-control"
SRC_URI="
	https://github.com/schlambos/${MY_PN}/archive/refs/tags/v${PV}.tar.gz -> ${P}.tar.gz
	gui? (
		https://github.com/electron/electron/releases/download/v${ELECTRON_PV}/electron-v${ELECTRON_PV}-linux-x64.zip
	)
"
S="${WORKDIR}/${MY_PN}-${PV}"

# LICENSE section 1: the code inherited from Ripthulhu/harmony-hub-control and
# tools/hub-root is all rights reserved; section 2: Melodious's own code is MIT.
LICENSE="all-rights-reserved MIT"
# Hub payload: BusyBox and the USB Ethernet kernel modules (GPL-2), Dropbear
# and BearSSL (MIT), Material Icons (Apache-2.0).
LICENSE+=" Apache-2.0 GPL-2"
# Prebuilt Electron (Chromium, Node.js, FFmpeg and their bundled libraries).
LICENSE+=" gui? ( BSD BSD-2 ISC LGPL-2.1+ MPL-2.0 openssl unicode )"
SLOT="0"
KEYWORDS="-* ~amd64"
IUSE="+gui +usb"
REQUIRED_USE="${PYTHON_REQUIRED_USE}"
# bindist, mirror: the all-rights-reserved code may not be redistributed.
# strip: the payload is MIPS binaries for the hub; Electron is prebuilt.
RESTRICT="bindist mirror strip"

RDEPEND="
	${PYTHON_DEPS}
	virtual/openssh
	gui? (
		app-accessibility/at-spi2-core:2
		app-arch/unzip
		dev-libs/expat
		dev-libs/glib:2
		dev-libs/nspr
		dev-libs/nss
		media-libs/alsa-lib
		media-libs/mesa
		net-print/cups
		sys-apps/dbus
		virtual/udev
		x11-libs/cairo
		x11-libs/gtk+:3
		x11-libs/libX11
		x11-libs/libxcb
		x11-libs/libXcomposite
		x11-libs/libXdamage
		x11-libs/libXext
		x11-libs/libXfixes
		x11-libs/libxkbcommon
		x11-libs/libXrandr
		x11-libs/pango
	)
	usb? (
		$(python_gen_cond_dep 'dev-python/hidapi[${PYTHON_USEDEP}]')
	)
"
BDEPEND="
	${PYTHON_DEPS}
	gui? ( app-arch/unzip )
"

QA_PREBUILT="opt/${PN}/*"

src_unpack() {
	unpack ${P}.tar.gz
	if use gui; then
		mkdir electron || die
		cd electron || die
		unpack electron-v${ELECTRON_PV}-linux-x64.zip
	fi
}

src_compile() {
	use gui || return

	# The desktop app serves the web shell from desktop/build/shell. Upstream
	# stages it with desktop/scripts/bundle-shell.sh, which needs a pinned bun
	# and a git checkout. The same three files are committed, byte for byte,
	# as C arrays in payload/source/harmony_shell_assets.h (bundle-shell.sh
	# fails unless its output matches that header), so take them from there.
	mkdir -p desktop/build/shell || die
	"${EPYTHON}" - payload/source/harmony_shell_assets.h desktop/build/shell <<-'EOF' || die "shell extraction failed"
		import pathlib, re, sys
		text = pathlib.Path(sys.argv[1]).read_text()
		out = pathlib.Path(sys.argv[2])
		for array, name in (
		    ("harmony_index", "index.html"),
		    ("harmony_shell_js", "harmony-shell.js"),
		    ("harmony_shell_css", "harmony-shell.css"),
		):
		    body = re.search(r"unsigned char %s\[\] = \{(.*?)\};" % array, text, re.S).group(1)
		    data = bytes(int(b, 16) for b in re.findall(r"0x[0-9a-f]{2}", body))
		    size = int(re.search(r"unsigned int %s_len = (\d+);" % array, text).group(1))
		    # The array carries one trailing NUL that is not part of the file.
		    if len(data) != size + 1 or data[-1] != 0:
		        sys.exit("%s: expected %d bytes and a NUL, found %d" % (array, size, len(data)))
		    (out / name).write_bytes(data[:-1])
	EOF
	cp payload/web/activity-ui.{js,css} desktop/build/shell/ || die
}

src_install() {
	local dest=/opt/${PN}

	# The tools find their files relative to themselves, and the desktop app
	# finds the tools relative to itself, so keep the repository's layout.
	insinto ${dest}
	doins install_webui.py UPSTREAM_REVISION LICENSE
	# Licences of the payload's third-party parts and, for the GPL-2 ones,
	# the pointers to their corresponding source (as upstream's Docker image).
	doins -r third_party
	insinto ${dest}/build
	doins build/*.sh build/*.ld

	# Everything but payload/source, which is not installed on the hub.
	insinto ${dest}/payload
	doins -r payload/{activity,androidtv,bin,helpers,modules,mqtt,scripts,web}

	insinto ${dest}/tools/hub-root
	doins tools/hub-root/*.py tools/hub-root/dropbearmulti \
		tools/hub-root/{README,PROVENANCE}.md

	python_fix_shebang "${ED}${dest}"/install_webui.py \
		"${ED}${dest}"/tools/hub-root/run_harmony_hub_tool.py
	fperms +x ${dest}/install_webui.py ${dest}/tools/hub-root/run_harmony_hub_tool.py
	dosym -r ${dest}/install_webui.py /usr/bin/melodious-install
	dosym -r ${dest}/tools/hub-root/run_harmony_hub_tool.py /usr/bin/melodious-hub-root

	# The hub is 046d:c129. The kernel's HID core ignores it, so the tools
	# open it through libusb (hidapi); the hidraw line covers kernels that
	# do bind it.
	udev_newrules - 70-melodious-harmony-hub.rules <<-EOF
		SUBSYSTEM=="usb", ATTR{idVendor}=="046d", ATTR{idProduct}=="c129", TAG+="uaccess"
		SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c129", TAG+="uaccess"
	EOF

	dodoc README.md docs/{INSTALL,SETUP_GUIDE,FRESH_HUB_ACTIVATION,RELEASE_NOTES_2_5}.md

	use gui || return

	insinto ${dest}/desktop
	doins desktop/package.json
	doins -r desktop/src desktop/build

	# cp, not doins: keep the executable bits.
	dodir ${dest}/electron
	cp -a "${WORKDIR}"/electron/. "${ED}${dest}/electron/" || die
	fperms 4711 ${dest}/electron/chrome-sandbox

	# Run from the unpacked tree, not an app.asar: upstream enables the Setup
	# Wizard on Linux only in that mode, where it uses the tools above and
	# the interpreter named in MELODIOUS_WIZARD_PYTHON.
	newbin - melodious <<-EOF
		#!/bin/sh
		export MELODIOUS_WIZARD_PYTHON="\${MELODIOUS_WIZARD_PYTHON:-${PYTHON}}"
		exec "${EPREFIX}${dest}/electron/electron" "${EPREFIX}${dest}/desktop" "\$@"
	EOF

	newicon -s 1024 desktop/resources/icon.png melodious.png
	make_desktop_entry melodious Melodious melodious "AudioVideo;Utility"
}

pkg_postinst() {
	udev_reload
	xdg_pkg_postinst

	if [[ -z ${REPLACING_VERSIONS} ]]; then
		elog "Commands (docs in /usr/share/doc/${PF}):"
		use gui && elog "  melodious           the desktop app and Setup Wizard"
		elog "  melodious-hub-root  root a hub, e.g. --action lan-root --hub-host <hub-ip>"
		elog "  melodious-install   install or update Melodious on a rooted hub:"
		elog "                      --hub-host <hub-ip> --hub-id <hub-id>"
		elog
		elog "Run them as your own user, not root: they use the harmony_owner_* SSH"
		elog "key in your ~/.ssh. For USB setup, reconnect the hub after this install"
		elog "so the new udev rule gives your login session access to it."
		elog
		elog "Upstream marks the Linux desktop app and Setup Wizard as not fully tested."
	fi
}

pkg_postrm() {
	udev_reload
	xdg_pkg_postrm
}
