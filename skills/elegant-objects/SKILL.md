---
name: elegant-objects
description: Object-oriented design in the Elegant Objects style (Yegor Bugayenko), adapted per stack. Use when designing classes, reviewing OOP code, or refactoring toward immutable, composable objects. Covers TypeScript/JavaScript, Python, Java/C#, and Go/Rust adaptations.
---

# Elegant Objects (per-stack adaptation)

Source ideas: Yegor Bugayenko, *Elegant Objects*; prompt
https://github.com/yegor256/prompt (MIT). Hard rules below are the Java
original; each stack section adapts what the language cannot express.

## Core rules (all stacks)

1. Immutable objects: freeze attributes after construction.
2. No static methods, no public static literals, no setters, no getters
   that leak representation (behavior, not data).
3. No `-er` names (Manager, Helper, Util, Controller-as-bag): name the
   thing, not the action-on-things. No utility classes.
4. Composition over implementation inheritance; one primary constructor,
   secondaries delegate to it.
5. Fail fast: reject null/undefined/invalid input at the boundary.
6. Small objects: one responsibility, few attributes (target 1–4).
7. No getters/setters round-trips: tell objects what to do, don't ask
   for their state and decide outside.

## Stack adaptations

Read ONLY the file matching the project stack:

- **TypeScript/JavaScript**: [references/typescript.md](references/typescript.md)
  (frozen classes, `as const`, no enums-as-bags, module singletons only
  for truly global seams).
- **Python**: [references/python.md](references/python.md)
  (`@dataclass(frozen=True)`, protocols over ABCs, no module-level
  mutable state).
- **Java/C#**: [references/java.md](references/java.md)
  (closest to the original: final classes, records, no Lombok @Data).
- **Go/Rust**: [references/go-rust.md](references/go-rust.md)
  (value semantics, ownership instead of freezing, traits/interfaces).

## Review checklist (any stack)

- [ ] Would making this mutable break a caller? If yes, freeze it.
- [ ] Does any caller do `x.getA() + x.getB()`? Move the computation inside.
- [ ] Is there a `*Util/*Helper/*Manager`? Dissolve it into real objects.
- [ ] Does a constructor do work beyond assignment? Extract a factory.
- [ ] Is there a null/undefined return meaning "absent"? Use a dedicated
      absent-object, Optional/Maybe, or throw at the boundary.
