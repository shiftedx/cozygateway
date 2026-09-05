# Native Windows Hermes-update self-heal acceptance

Run this only on the user-owned Windows Hermes machine after installing a release
that includes `windows-reconcile.ps1`. It never installs or updates CozyGateway,
does not read or print credential values, and requires no administrator token.

First run the read-only baseline:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test\windows-hermes-update-acceptance.ps1
```

If that passes, authorize the real Hermes update/reboot-login simulation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\test\windows-hermes-update-acceptance.ps1 -RunHermesUpdate
```

Return the terminal output, `cozygateway status`, and the last 80 lines of
`%LOCALAPPDATA%\cozygateway\local\reconcile.log`. Review those lines for accidental
secrets before sharing; the reconciler redacts common credential labels itself.
Do not include `.env` contents. A pass requires fresh per-profile attach negotiation
after Hermes updates, an unchanged Gateway credential-file hash, and a Scheduled
Task whose action remains under `%LOCALAPPDATA%\cozygateway`.
