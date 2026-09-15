---
name: codebase-design
description: Design deep modules with narrow interfaces and clear testing seams. Avoid shallow wrappers.
---

# Codebase Architecture & Deep Module Design

Principles derived from John Ousterhout's *Philosophy of Software Design* and Michael Feathers' *Working Effectively with Legacy Code*.

## 1. Deep vs Shallow Modules
- **Deep Module**: An abstraction with a simple, narrow interface that conceals complex, non-trivial implementation details (e.g. Unix file I/O: open/read/write/close).
- **Shallow Module**: An interface that is relatively complex compared to the small functionality it provides, or 1:1 pass-through wrappers.

## 2. The Deletion Test
To verify if a module or abstraction earns its place:
- Mentally or experimentally delete the module.
- If deleting it causes its complexity to vanish without spilling into callers, it was an unnecessary shallow wrapper. Delete it.
- If deleting it causes significant complexity to spill across N callers, the module is load-bearing and deep. Keep it.

## 3. Seam Placement & Dependency Inversion
- A **seam** is a place where behavior can be altered or intercepted without editing the consuming source code.
- **Consumer-Defined Interfaces**: Interfaces belong to the consumer package/module that uses them, not to the provider that implements them.
- Inject dependencies across seams to allow fast, isolated deterministic tests.
