# Windows guided setup implementation

1. Keep setup in `scripts/install.ps1`, the published Windows one-liner. Add plain
   progress phases and numbered product choices without altering product updates.
2. Add bounded local model discovery and saved Pi catalog readers. Integrate
   detected choices into fresh interactive model setup; preserve saved/env
   configuration and legacy scripted direct provider input.
3. Test discovery, malformed/missing data, selection, credential handling and
   no-prompt reruns in Windows PowerShell fixtures. Isolate external resources.
4. Review the combined diff, run focused tests on both supported PowerShell
   editions and the Windows installer suite, then prepare the reviewed change
   for integration. Do not modify `.sh` installers or publish a release.
