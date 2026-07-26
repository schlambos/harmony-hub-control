# Harmony Hub Control on Unraid

This package turns the upstream Linux/macOS installer into an Unraid-friendly
container. It does **not** move the actual Harmony runtime off the Hub:

1. On the first successful start, the container SSH-installs the upstream MIPS
   payload onto an already-rooted Harmony Hub.
2. It writes `/config/state/install.json`, so ordinary container and Unraid
   restarts do not reinstall or reboot the Hub.
3. It remains running as a small reverse proxy. The Unraid **WebUI** link opens
   the dashboard that is actually served by the Hub on port 8080.

The bundled upstream snapshot is commit
`d87cebafdee36ec33f1e4ea3055239dbfea6aa09`.

## Prerequisites

- An already-rooted Logitech Harmony Hub reachable from Unraid.
- The matching private key produced by the root tool, normally named
  `harmony_owner_*`.
- The exact numeric Hub ID printed by the root tool. Do not guess it.
- Docker enabled on Unraid.

The upstream repository does not include rooting tools.

## 1. Build the image on Unraid

Copy this entire directory to the Unraid server, open an Unraid terminal, and
run the following from that directory:

```sh
docker build --pull --tag harmony-hub-control:local .
```

The local tag deliberately avoids requiring a public registry. If you later
publish your own image, change `<Repository>` in the XML template to that image
reference.

## 2. Install the SSH key

Create the key directory and copy the private key into it:

```sh
mkdir -p /mnt/user/appdata/harmony-hub-control/keys
cp /path/to/harmony_owner_your-key /mnt/user/appdata/harmony-hub-control/keys/harmony_owner_key
chmod 700 /mnt/user/appdata/harmony-hub-control/keys
chmod 600 /mnt/user/appdata/harmony-hub-control/keys/harmony_owner_key
```

Do not put the private key in the image, Git, or the XML template. The template
mounts this directory read-only. At runtime, the container copies the key to a
temporary file with mode `0600` before invoking SSH.

## 3. Install the Unraid template

Copy the template to Unraid's user-template directory:

```sh
cp unraid/harmony-hub-control.xml \
  /boot/config/plugins/dockerMan/templates-user/my-harmony-hub-control.xml
```

In the Unraid UI:

1. Open **Docker** and select **Add Container**.
2. Choose **Harmony-Hub-Control** from the Template list.
3. Enter the Hub's static IP/hostname and exact numeric Hub ID.
4. Leave MQTT disabled unless a broker is already reachable from the Hub.
5. Review the cloud-blocker and Hub-reboot settings, then apply the template.

The default host port is `8088`. Once the first install succeeds, the container
stays running and `http://UNRAID-IP:8088/` proxies the Hub dashboard.

## First-start behavior

The installer:

- connects to the Hub over SSH;
- creates a timestamped backup under
  `/data/codex-backups/webui-handoff-*` on the Hub;
- uploads and verifies the bundled MIPS binaries;
- configures the optional MQTT bridge;
- starts the hub-side web UI and Bluetooth helper;
- enables the upstream cloud blocker by default; and
- reboots only the **Harmony Hub** once by default so the blocker takes effect.

Follow progress under **Docker > Harmony-Hub-Control > Logs**. On success, the
log ends with the Hub URL, backup path, and successful-install marker.

If installation fails, the container exits nonzero and does not write the
success marker. Correct the setting or network/key issue, then start it again.

## Normal operation and updates

The container's steady-state job is only the reverse proxy. Harmony commands,
MQTT, Bluetooth, and the dashboard runtime execute on the Hub itself.

The hub dashboard's **System > Software update** function can update the
hub-side payload from upstream without rebuilding this container.

To deliberately redeploy the payload currently baked into the image:

```sh
docker exec harmony-hub-control /usr/local/bin/harmony-container install
```

This creates another Hub-side backup. It can reboot the Hub if
`REBOOT_HUB_AFTER_INSTALL=true`.

To inspect the marker and probe the hub:

```sh
docker exec harmony-hub-control /usr/local/bin/harmony-container status
```

Avoid leaving `FORCE_INSTALL=true` or `INSTALL_MODE=always`; either setting
reinstalls on every container start.

## MQTT password handling

For simple private-LAN setups, the masked `MQTT_PASSWORD` template variable is
supported, but Docker environment variables remain visible in container
metadata.

For better local handling, put the password on one line in a file under
`/mnt/user/appdata/harmony-hub-control`, set its permissions to `0600`, and set
`MQTT_PASSWORD_FILE` to its in-container path under `/config`. The file setting
takes precedence over `MQTT_PASSWORD`.

## Docker Compose alternative

Copy `.env.example` to `.env`, edit the required values, place the private key
at `./keys/harmony_owner_key`, then run:

```sh
docker compose up --build
```

The Compose example intentionally uses `restart: "no"` so a bad first-run
configuration does not create an automatic retry loop. After a successful
install, Unraid's normal container autostart setting can manage restarts.

## Troubleshooting

- `SSH private key not found`: verify the `/keys` mapping and `SSH_KEY_PATH`.
- `Permission denied (publickey)`: verify this key belongs to this rooted Hub.
- `Host key verification failed`: review
  `/mnt/user/appdata/harmony-hub-control/.ssh/known_hosts`; do not blindly
  delete it if the Hub's SSH identity was not intentionally changed.
- `Hub ID is required` or IR commands fail: use the exact ID from the root
  tool, not the Logitech account name or a guessed value.
- Proxy returns `502 Bad Gateway`: the container is running, but the Hub UI is
  not reachable at `HUB_HOST:HUB_WEB_PORT`.
- Dashboard returns `401 Unauthorized`: optional HTTP Basic authentication has
  been enabled on the Hub; use the Hub credentials. The proxy passes the
  authorization header through.
- A large eight-device configuration can trigger an upstream low-memory HTML
  rendering problem on some Hubs. Track the upstream report at
  <https://github.com/Ripthulhu/harmony-hub-control/issues/2>.

The upstream installer leaves a recovery backup on the Hub before each
deployment. The upstream `restore_backup.ps1` script can restore the newest
backup from a Windows system if rollback is required.

## Security

- Keep the Hub and proxy on a trusted LAN or behind your own access controls.
- Enable the dashboard's optional sign-in under **System > Web UI sign-in** if
  untrusted LAN clients can reach it.
- Never expose the Hub's SSH or HTTP ports directly to the internet.
- The container is not privileged and only receives the `/config` and
  read-only `/keys` mounts from the template.

The upstream project currently has no license file. This bundle is suitable for
a private local build; confirm redistribution rights with the upstream author
before publishing a public image.
