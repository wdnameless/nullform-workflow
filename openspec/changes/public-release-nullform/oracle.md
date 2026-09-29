# Oracle — blind acceptance, public-release-nullform

Verdict: ACCEPT

Three passes (model `nullform-gateway/gemini-3.8-flash-high`):
- Pass 1 (ReleaseOracleA): ACCEPT — R01–R05 proven; 440/440, verify 29/29.
- Pass 2 (ReleaseOracleB): REJECT on technicality — invalid delta header `## ADDED Requirements (brand + readme)` in `specs/release/spec.md`; all functional rows PROVEN.
- Pass 3 decisive (ReleaseOracleC): ACCEPT — header fixed, pinned CI validator reports valid; R01–R05 proven.

`backups/` untouched; no behavior change.
