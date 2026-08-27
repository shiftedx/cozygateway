# Connectivity choices

Fresh managed installs bind to `127.0.0.1:8787`, so only the machine can reach the plaintext
origin. Choose LAN access explicitly with `--bind-host 0.0.0.0`. The installer does not alter
network infrastructure.

## User-managed Tailscale

Install Tailscale on the Hermes/gateway host, sign in, and note its tailnet
address:

```sh
tailscale up
tailscale status
tailscale ip -4
```

On the iPhone, install the Tailscale app, sign in to the same tailnet, and turn
on its VPN connection. Confirm the gateway host appears in the app before
pairing CozyChat.

CozyChat requires HTTPS for a Tailscale address: iOS cannot use its local-network
HTTP exception for a `100.x` address or a `.ts.net` hostname. Let Tailscale Serve
terminate TLS and proxy its local `127.0.0.1:8787` target for the tailnet-only endpoint:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

If MagicDNS or HTTPS certificates are not enabled yet, Tailscale Serve prompts you
to enable them in your tailnet's DNS settings. It provisions the certificate for the
host's MagicDNS name and persists its own configuration; do not use Funnel, which
would make the endpoint public. Pair CozyChat with the HTTPS MagicDNS origin reported by
`tailscale serve status`, for example
`https://my-hermes.tailnet-name.ts.net`, and persist that advertised origin by rerunning the
verified installer with:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash -s -- \
  --public-url https://my-hermes.tailnet-name.ts.net
```

Limit the service to the intended phones with your tailnet ACL/grant policy. The
local Hermes attach plugins continue to use `http://127.0.0.1:8787` and do not
need an exposed port. For alternatives or operational details, see Tailscale's
[Serve](https://tailscale.com/docs/features/tailscale-serve) and
[HTTPS certificate](https://tailscale.com/docs/how-to/set-up-https-certificates)
documentation.

## User-managed named Cloudflare Tunnel and domain

Install and authenticate `cloudflared`, then create a durable named tunnel and
DNS route in your own account:

```sh
cloudflared tunnel login
cloudflared tunnel create cozygateway
cloudflared tunnel route dns cozygateway gateway.example.com
```

Create your own tunnel configuration, keeping the tunnel credential path
private. Its ingress must route the hostname to the loopback gateway:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /path/you/control/<tunnel-uuid>.json
ingress:
  - hostname: gateway.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it yourself with `cloudflared tunnel run cozygateway`, or install its
service using Cloudflare's documented command for your operating system. The tunnel/proxy must
support `/ws` upgrades and preserve `Authorization` and `Range` on authenticated REST requests.
The tunnel supplies HTTPS transport and reachability; CozyGateway's device token remains the app
authentication. Persist the exact public origin (which also moves an existing installer-managed LAN
listener back to loopback) with:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash -s -- \
  --public-url https://gateway.example.com
```
Then `cozygateway pair` advertises that origin automatically. Do not use a quick tunnel for a
durable phone endpoint, and do not put bearer tokens in the public hostname or URL.

Neither choice is necessary for same-LAN use. Keep the gateway private unless
you deliberately need remote access.

To stop using a saved tunnel and return an installer-managed gateway to LAN access, rerun the same
verified installer with `--clear-public-url --bind-host 0.0.0.0`. This removes `publicUrl` from the
persisted config before the LAN listener is activated, so later pairing codes no longer advertise
the retired tunnel.
