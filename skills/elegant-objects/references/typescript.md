# Elegant Objects in TypeScript/JavaScript

The language has no `final` classes or true immutability; approximate it.

- Classes: `readonly` fields assigned once in the constructor;
  `Object.freeze(this)` at the end of construction for value objects.
- No `static` methods except factory entry points (`X.of(...)`) that
  return instances; never static mutable state.
- No getters leaking internals: `getItems()` returning the live array
  is a violation — return `readonly T[]` copies or expose behavior.
- Prefer `as const` objects and discriminated unions over enums-as-bags.
- Module-level singletons only for true global seams (clock, random);
  inject everything else through constructors.
- Reject `any` returns meaning "unknown shape": define the interface.
- Composition: small classes wired in a composition root, not deep
  inheritance chains (`extends` only for genuine is-a with no overrides
  weakening the parent).
