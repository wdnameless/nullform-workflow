# Elegant Objects in Python

- Value objects: `@dataclass(frozen=True)` (or `NamedTuple`); never
  mutate after construction.
- Behavior over data: methods that act; avoid exposing `.items` lists
  callers then loop over — put the loop inside.
- Protocols (`typing.Protocol`) over ABC inheritance; inherit only
  from one ABC at most, never for code reuse.
- No module-level mutable state; no `@staticmethod` bags — a module
  with only functions and no state is acceptable for pure helpers,
  but a `*_utils.py` with 20 functions is a smell: split by domain.
- Constructors assign only; parsing/validation goes to `@classmethod`
  factories (`from_json`, `parse`) that delegate to `__init__`.
- No `None` returns meaning absent inside the domain: use a dedicated
  sentinel object or raise at the boundary; `Optional` only at IO edges.
