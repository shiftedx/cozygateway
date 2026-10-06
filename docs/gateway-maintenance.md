# Gateway maintenance controls

CozyChat enables restart/update controls only when CozyGateway advertises
`com.cozylabs.gateway-maintenance: 1`. This is deliberately a separated capability: the gateway
container never mounts `docker.sock` and never runs Compose itself.

## Docker Compose (canonical)

For Docker deployments, use `docker-compose.maintenance.yml`. It starts a locked-down Python
sidecar that has the Docker socket and can restart **only** the fixed gateway container named by
the operator. It exposes a tiny Unix socket to the gateway; no phone request can choose a Docker
target, command, image, path, or URL.

Create a persistent host directory owned by the UID that runs the shipped gateway image (1000 by
default), then add these values to the Compose environment file:

```sh
install -d -m 0700 -o 1000 -g 1000 /home/operator/.local/state/cozygateway-maintenance
COZYGATEWAY_MAINTENANCE_SOCKET_DIR=/home/operator/.local/state/cozygateway-maintenance
# Numeric group id, e.g. stat -c '%g' /var/run/docker.sock on Linux.
COZYGATEWAY_DOCKER_GID=999
# Exact already-created gateway container, never supplied by a phone request.
COZYGATEWAY_MAINTENANCE_CONTAINER_NAME=cozygateway-gateway-1
COZYGATEWAY_MAINTENANCE_CURRENT_VERSION=0.6.4
# The gateway process inside the shipped image is the `node` user (UID 1000).
COZYGATEWAY_MAINTENANCE_ALLOWED_UID=1000
```

Start it with every normal production layer plus this override, for example:

```sh
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.maintenance.yml up -d
```

The gateway waits for the sidecar healthcheck before it boots, eliminating the capability-probe
race. The sidecar has a read-only root filesystem, no Linux capabilities, no-new-privileges, a
small temporary filesystem, no network, and a restart-unless-stopped policy. It is the only service in this
setup that mounts `docker.sock`. Its Python image is digest-pinned in the Compose override; update
the pinned digest deliberately as part of a reviewed dependency refresh.

Restart is safe for persistent Compose volumes. Gateway self-update intentionally remains
unavailable in 0.6.4: no update is advertised or installed until the host workflow has a
post-update health proof and rollback mechanism. Set
`COZYGATEWAY_MAINTENANCE_LATEST_VERSION=0.6.4` to report **up to date**; any missing or differing
declared target reports **unavailable** and rejects update requests.

The socket directory is mounted read-only into the gateway container. The socket is mode `0600`,
and on Linux the supervisor additionally validates `SO_PEERCRED` against
`COZYGATEWAY_MAINTENANCE_ALLOWED_UID`. The supervisor persists scheduled operation IDs before it
acknowledges them, retaining them for 24 hours so a gateway crash/retry cannot schedule the same
host action twice.

## Legacy host supervisor

For non-Docker or existing host-owned Compose installations, copy
`deploy/cozygateway-compose-maintenance.service` into the user's systemd service directory and
create `~/.config/cozygateway/maintenance.env` with these fixed values:

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

The host mode retains the same constrained gateway IPC protocol, but it depends on a user service
remaining alive. The Docker sidecar above is the supported production configuration. The shipped
supervisor is dependency-free Python 3 stdlib, so Docker deployments do not require a host Node
or Python runtime.
