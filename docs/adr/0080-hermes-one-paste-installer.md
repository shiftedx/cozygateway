# ADR 0080: Hermes-native one-paste install

The supported one-paste path targets an existing Hermes installation. It
discovers profile homes through the Hermes CLI, installs a version-matched
attach plugin per selected profile, and runs one shared CozyGateway service.
Hermes continues to own its profile gateway services.

The generated gateway configuration uses one `hermes.profiles` identity per
Hermes profile. It intentionally does not create legacy `agents[]` identities
or duplicate native-data-plane identities. Tokens stay in mode-600 environment
files and configuration carries token environment-variable names only.

Network exposure is outside installer scope. LAN binding is the default;
Tailscale, Cloudflare named tunnels, certificates, DNS, and firewall policy
remain explicit operator work.
