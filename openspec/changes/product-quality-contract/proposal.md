# Why

The workflow strongly checks process artifacts but auto-review can report success for an application whose declared build fails. Performance and UI quality need applicable, measurable acceptance instead of generic aspirations; useful architecture boundaries must not be removed solely to reduce line count. The user approved all five recommendations in the system-design assessment.

# What Changes

Extend the existing auto-review command to execute native project checks, distinguish missing/inapplicable/failed evidence and avoid installing checking tools. Record a compact quality contract in the existing manifest/interfaces process. Make architecture and UI guidance conditional and consistent with the project. Add a meaningful consumer benchmark/check and a truthful evaluation protocol using existing machinery, without running models.

# Impact

Changes affect auto-review and its actual verifier/CI consumers, repository-owned roles/core/templates, and benchmark fixtures/docs. This deliberately supersedes the historical report-only type/lint auto-review behavior; historical OpenSpec receipts remain untouched. No new package/framework/config service, no live user/global instructions, no release bypass. Final recorded source-bound review remains a separate prerequisite under the existing spending prohibition.

# Capabilities

## New Capabilities
- `product-quality-contract`: native verification and applicable product-quality evidence.

## Modified Capabilities
- None. Existing runtime entrypoints stay stable; only the documented auto-review gate semantics become stricter.
