---
name: domain-modeling
description: Define and maintain a living ubiquitous language in CONTEXT.md and evaluate ADR triggers.
---

# Domain Modeling & Ubiquitous Language

Maintain a clean, unambiguous mental model of the domain in `CONTEXT.md` at the project root.

## 1. Golden Rules
- **Ubiquitous Language**: Keep names consistent across discussions, types, database schemas, and UI elements.
- **Domain vs Implementation**: Distinguish domain concepts (e.g. `Order`, `Customer`, `Settlement`) from technical implementation constructs (e.g. `OrderRepository`, `PostgresConnection`, `JWTToken`).
- **Challenge Ambiguity**: If a user uses synonymous or ambiguous terms (e.g., "account" vs "user" vs "profile"), stop and clarify against `CONTEXT.md`.

## 2. CONTEXT.md Standard Structure
```markdown
# Domain Context

## Ubiquitous Language
- **<Concept>**: Crisp 1-sentence definition of what it is in the business domain.
- **<Disambiguation>**: Clarification of what this concept is NOT.

## Domain Invariants
- <Invariant 1>: Business rules that must always hold true.

## Architectural Decision Records (ADRs)
### ADR-001: <Title>
- **Context**: The problem/trade-off faced.
- **Decision**: What was chosen.
- **Consequences**: Trade-offs accepted.
```

## 3. Inline ADR Trigger
Trigger a brief (≤10 line) ADR whenever a decision:
1. Is hard or costly to reverse later.
2. Involves a significant architectural trade-off.
3. Diverges from standard or expected patterns.
