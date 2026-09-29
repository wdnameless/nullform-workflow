# Installer guard parity

## ADDED Requirements

### Requirement: PowerShell installer refuses repo targets

`install.ps1` обязан отклонять цель внутри `$PSScriptRoot` до создания каталогов и копий, с текстом как в Node-инсталлере.

#### Scenario: In-place target
- **WHEN** `install.ps1 -HarnessRoot .` из клона
- **THEN** exit ≠ 0, `agent/AGENTS.md` в гите не изменён.

#### Scenario: Normal target
- **WHEN** цель — пустой каталог вне репо
- **THEN** установка идёт как раньше.
