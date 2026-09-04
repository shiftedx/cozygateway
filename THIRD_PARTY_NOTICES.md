# Third-party notices

CozyGateway is [MIT licensed](LICENSE). Bundled dependencies retain their original copyright and license notices.

The bundler collects license and NOTICE files from the exact dependencies that esbuild consumes, embeds them in `cozygateway.mjs` before hashing, and emits `THIRD_PARTY_NOTICES.txt` for release inspection. Missing license text fails the release build. The attach plugin archive carries the project MIT license. Docker deployments preserve dependency license files and operating-system package notices in addition to the project license.

The installer pins the reviewed CozyAgents installer bytes by SHA-256. Its public website URL is a mutable mirror: a changed mirror fails verification until the reviewed pin is updated. Update the POSIX and Windows pins together during a coordinated release; custom sources require an explicit expected digest. Do not replace a digest with one obtained from an untrusted response merely to bypass a mismatch.

Release attestations can be verified with `gh attestation verify <downloaded-asset> --repo shiftedx/cozygateway`. The initial public one-line bootstrap still relies on HTTPS delivery; a checksum fetched beside a payload is not independent authentication of that server.
