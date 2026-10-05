# Why

Review rules currently distinguish implementation review from blind acceptance, but one skill contradicts those roles and gates accept static verdict text without checking real independent executions.

# What Changes

Separate the roles consistently and make native review execution evidence mandatory for heavy/program work. Preserve lean lanes and existing safety gates.

# Impact

Operators use the existing workflow CLI. A static ACCEPT report alone no longer closes a changed heavy slice. This is an intentional clean cutover, not a parallel legacy acceptance path.
