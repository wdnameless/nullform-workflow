# Elegant Objects in Java/C#

Closest to the original doctrine; apply it directly.

- Every class `final` (Java) / `sealed` (C#) unless designed for
  extension; all fields `final`/`readonly`, assigned in one primary
  constructor; secondary constructors delegate via `this(...)`.
- Prefer `record` types for value objects.
- No getters/setters pairs: no Lombok `@Data`, no auto-properties
  exposing settable state; expose behavior methods instead.
- Interfaces declare all public methods; classes implement, never add
  public surface beyond the interface.
- No `null` returns or arguments inside the domain: `Optional<T>`
  at IO edges only, or dedicated absent-objects.
- No static methods except private helpers; no public static literals
  except true mathematical constants.
- No `-er` classes, no `*Utils`: split by domain object.
