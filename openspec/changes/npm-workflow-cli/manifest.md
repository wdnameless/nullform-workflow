# Requirements manifest: npm-workflow-cli

## User requirements

| ID | Verbatim user quote | Requirement | Status |
|---|---|---|---|
| R01 | «Я хочу чтобы все устанавливалось через npm как другие приложения.» | A real npm package installs with npm install -g from a tarball; bin command nullform works without a git clone. Package contains required runtime assets, not private configs/history/build artifacts. | in-spec |
| R02 | «Чтобы человек выбрал свой харнесс через CLI» | Interactive init selects one of claude/codex/opencode/cursor/omp/openclaw/hermes/openhuman; --harness supports noninteractive use. Invalid input/cancellation/headless missing selection cannot silently choose a different harness. | in-spec |
| R03 | «и под него бы подстроился наш воркфлоу.» | Selected adapter installs instructions/skills/supported integrations in native locations; doctor checks that selected adapter. OMP plugins and configuration must not be required for other harnesses. Missing host runtime is explicit SETUP, not invented readiness. | in-spec |
| R04 | «давай» | Approved proposal: show planned writes before confirmation; preserve user instructions/settings/keys/unrelated files; repeated init and update remain idempotent. Bad existing config fails before destructive changes. | in-spec |
| R05 | «давай» | Approved proposal: persist selected harness, custom root and installed version; doctor and subsequent update use this installation, not a fresh autodetection. | in-spec |
| R06 | «давай» | Approved proposal: nullform update obtains a version from npm, reinstalls and checks the persisted target without Git; errors do not claim success. No background daemon or postinstall home mutations. | in-spec |
| R07 | «nullform-workflow» | npm package name nullform-workflow; CLI command nullform. One package and existing installer, no second installer framework. | in-spec |
| R08 | «Реализация и проверенный npm-пакет» | Deliver .tgz and prove real global npm installation plus upgrade through a loopback registry; public npmjs publishing explicitly outside this run. No credentials requested. | in-spec |

## Boundaries and evidence

- Package version: 1.1.0; VERSION and package.json agree. Existing source-install entrypoints remain usable; developer Git sync is not the public npm updater.
- User-approved prompt changes are limited to workflow-owned integration material. Unrelated user prompts/configurations and the two pre-existing working-tree changes remain untouched.
- Host applications, paid providers and credentials are external prerequisites. Their absence is surfaced as SETUP; application sessions are not silently restarted.
- No claim of all host runtimes exercised unless actually available. Packaged adapter/state/update behavior must be exercised for all eight choices in isolated homes.
- npm whoami returned ENEEDAUTH; user selected verified npm package delivery rather than public publishing.
