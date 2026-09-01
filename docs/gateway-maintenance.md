# Gateway maintenance controls

CozyChat enables restart/update controls only when CozyGateway advertises
`com.cozylabs.gateway-maintenance: 1`. This is deliberately a host-owned capability: the gateway
container never mounts `docker.sock` and never runs Compose itself.

For a Docker Compose host, copy `deploy/cozygateway-compose-maintenance.service` into the user's
systemd service directory and create `~/.config/cozygateway/maintenance.env` with these fixed
host-owned values:

```sh
COZYGATEWAY_MAINTENANCE_SOCKET=/run/user/1000/cozygateway-maintenance/control.sock
COZYGATEWAY_MAINTENANCE_COMPOSE_DIR=/home/operator/cozygateway
# Ordered, comma-separated base layers. Include every production override in use.
COZYGATEWAY_MAINTENANCE_COMPOSE_FILES=/home/operator/cozygateway/docker-compose.yml,/home/operator/cozygateway/docker-compose.override.yml
COZYGATEWAY_MAINTENANCE_CURRENT_VERSION=0.6.4
# Persistent, host-only idempotency state; do not put this under /run.
COZYGATEWAY_MAINTENANCE_STATE_FILE=/home/operator/.local/state/cozygateway/maintenance-operations.json
# UID of the gateway process inside the container (the shipped image's `node` user is 1000).
COZYGATEWAY_MAINTENANCE_ALLOWED_UID=1000
```

Start the gateway with `docker-compose.maintenance.yml` and set
`COZYGATEWAY_MAINTENANCE_SOCKET_DIR` to the socket's containing directory. The gateway probes the
socket on boot; if it is absent or invalid, it advertises no maintenance capability and the phone
controls remain disabled.

Restart is safe for the persistent Compose volumes. Gateway self-update intentionally remains
unavailable in 0.6.4: no update is advertised or installed until the host workflow has a
post-update health proof and rollback mechanism. Set
`COZYGATEWAY_MAINTENANCE_LATEST_VERSION=0.6.4` to report **up to date**; any missing or differing
declared target reports **unavailable** and rejects update requests. The supervisor supplies every
base/production override on restart, so it cannot recreate the gateway without its production
network, ports, or labels. It never accepts a command, path, image, or URL from the phone.

The shipped host supervisor is dependency-free Python 3 stdlib so it runs on production hosts that
do not install Node outside the container.

The socket directory is mounted read-only into the container. The socket is mode `0600`, and on
Linux the supervisor additionally validates `SO_PEERCRED` against
`COZYGATEWAY_MAINTENANCE_ALLOWED_UID`. This is a trust boundary for the gateway process only: a
host user able to replace the mounted socket, state file, or Compose files is already an operator
who can control Docker. The supervisor persists scheduled operation IDs before it acknowledges
them, retaining them for 24 hours so a gateway crash/retry cannot schedule the same host action
twice.
