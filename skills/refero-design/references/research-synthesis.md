# Research Synthesis and Decision Ledgers

Guidelines for synthesizing Refero styles, screens, and flows into visual directions, product patterns, journey logic, and decision ledgers.

## Contents

- [Synthesis Buckets](#synthesis-buckets)
- [Visual Direction](#visual-direction)
- [Product Pattern](#product-pattern)
- [Journey Logic](#journey-logic)
- [Presenting Findings](#presenting-findings)
- [Decision Ledger Format](#decision-ledger-format)
- [Return to Refero Design](../SKILL.md)

---

## Synthesis Buckets

Separate findings into three buckets: visual direction, product pattern, and journey logic.

### Visual Direction

From styles:

- mood
- typography
- palette
- density
- surfaces
- imagery
- distinctive details
- do/don't rules

Output example:

```text
Use a precise analytics SaaS foundation: white canvas, compact UI copy, restrained black
primary actions, thin borders, and product screenshots in framed panels. Borrow disciplined
accent use from another reference, but keep color rare.
```

### Product Pattern

From screens:

- what the interface needs to contain
- common layouts
- component patterns
- states
- copy and CTAs
- specific tactics

Output example:

```text
Pricing pages commonly put the billing toggle above plan cards, highlight one plan, and
move detailed feature comparison below. We should adapt the comparison structure but keep
the hero quieter because this product sells trust, not hype.
```

### Journey Logic

From flows:

- steps
- decision points
- system responses
- user confidence and friction
- success/failure states

Output example:

```text
Cancellation flows usually collect a reason, offer a relevant alternative, confirm the
destructive action, then state when access ends. The best flows give a clear return path.
```

---

## Presenting Findings

Do not dump every result. Give the user a short research summary before designing when
the task is non-trivial.

Suggested format:

```text
Research summary:
- Styles reviewed: [count] across [directions]
- Screens reviewed: [count], if used
- Flows reviewed: [count], if used

Visual direction:
- [primary style foundation]
- [reference lock / signature traits to preserve]
- [borrowed detail 1]
- [borrowed detail 2]

Product patterns:
- [concrete UI decisions from screens]

Journey logic:
- [flow decisions, if applicable]

Recommendation:
- [what to design and why]
```

## Decision Ledger Format

Before implementation, convert research into a short decision ledger:

| Decision | Source | Source rule / role | Why |
|----------|--------|--------------------|-----|
| [palette/type/layout/media/content choice] | [style/screen/flow/user constraint/craft rule] | [token/component/media role to preserve] | [specific rationale] |

If a major choice has no source, do not ship it as a design decision. Either research
more, tie it to the user's constraints, or remove it.
