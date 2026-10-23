# Elegant Objects in Go/Rust

Map "freezing" to ownership and value semantics.

## Go

- Small structs, constructed by `NewX(...)` returning values (not
  pointers) when the object is a value; unexported fields, behavior
  methods on the struct.
- No getter/setter pairs: unexported state + methods that act.
- Interfaces declared at the consumer side, kept tiny (1–2 methods).
- No `init()` mutating package state; no package-level `var` registries.
- Errors as values at boundaries; never `nil` meaning "absent" deep
  inside the domain — use `(T, bool)` or a dedicated zero-object.

## Rust

- Ownership is the freezer: move semantics by default, `&self` methods
  that don't mutate; `Cell/RefCell` only with a written justification.
- Structs with private fields + `impl` behavior; `pub` fields only for
  plain data carriers crossing a crate boundary.
- Traits over inheritance (there is none); blanket impls sparingly.
- `Option<T>` is the honest absent — never sentinel values, never
  `unwrap()` outside tests and proven-infallible paths.
- Builders for >3 constructor params, consumed by `build()`.
