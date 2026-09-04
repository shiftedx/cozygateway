# Keeping your Gateway available

Keep the Gateway computer powered on, awake and connected whenever you expect to use your bots. Closing CozyChat does not stop the Gateway. The normal macOS and Windows installation starts a background service at login. Linux uses a user service with lingering; the installer reports when host policy prevents that setup.

## Check and recover

Open a new terminal after installation and run:

```sh
cozygateway status
```

Follow the next action it reports. A reachable Gateway does not prove that each bot has connected or that its model provider is working. Check the individual bot in CozyChat as well.

To update or repair the installation:

```sh
cozygateway repair
```

`cozygateway update` performs the same operation. If the command itself cannot start, repeat the installation command from the official setup page. Updates preserve the recorded listener, public origin and profile selection. A saved selection of `all` includes newly discovered Hermes profiles; an explicit selection stays limited to those profiles.

Do not delete the Gateway directory, reset pairing or remove bots to solve an update failure. Keep the existing installation and its credentials so recovery can preserve your devices and configuration. Software rollback is not a backup of the Gateway database, Hermes profiles or bot workspaces. Back up important data separately; protect backup credentials as carefully as the originals.

## Sharing a computer with Hermes

CozyGateway needs authenticated local access to a Hermes Dashboard. If the preferred Dashboard rejects its credential, the supervisor preserves that Dashboard and starts a separate control Dashboard on an available loopback port. It records the authenticated endpoint for future starts. You should not need to edit a service wrapper or replace another Dashboard's password.

The control Dashboard is local to the computer. It is separate from the address your phone uses to reach CozyGateway. The installer does not create a tunnel, DNS entry or firewall rule; see [connectivity](connectivity.md) for access from another network.

## Reporting a problem

Include the product version, operating system, status/error code and the step that failed. Do not include pairing codes, tokens, complete environment files or conversation contents. See [support](../SUPPORT.md).

Release testing must distinguish a local process restart from a full machine reboot, and macOS qualification from Windows or Linux qualification. An untested platform or recovery path remains unverified.
