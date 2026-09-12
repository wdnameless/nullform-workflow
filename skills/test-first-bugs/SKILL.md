---
name: test-first-bugs
description: Test-first bug fixing workflow. Use when a bug is reported - write a failing test first, then fix. Prevents regression and parallelizes fix attempts using subagents.
---

# Test-First Bug Fixing

Enforce a disciplined bug-fixing workflow that prevents regression and parallelizes fix attempts.

## Core Workflow

When a bug is reported, follow these steps in order:

### Phase 1: Reproduce and Document

1. **Understand the bug** — Gather details about expected vs actual behavior
2. **Identify the test location** — Determine where tests live in the project (check for `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*` patterns)
3. **Write a failing test** — Create a test that demonstrates the bug

### Phase 2: Fix with Subagents

1. **Launch fix subagents** — Use the Task tool with `subagent_type=fixer` to attempt fixes
2. **Run the test** — Verify the fix by running the specific test
3. **Iterate if needed** — If test still fails, launch additional subagents with new approaches

### Phase 3: Verify and Complete

1. **Run full test suite** — Ensure no regressions were introduced
2. **Report success** — Confirm the bug is fixed with passing test as proof

## Writing the Failing Test

### Test naming convention

Name the test to describe the bug:

```python
# Python (pytest)
def test_user_login_fails_when_email_has_uppercase():
    ...

# Python (unittest)
def test_should_handle_empty_input_without_crashing(self):
    ...
```

### Test structure

Every bug reproduction test follows this pattern:

```python
def test_bug_description():
    # 1. ARRANGE - Set up the conditions that trigger the bug
    input_data = create_problematic_input()

    # 2. ACT - Perform the action that causes the bug
    result = function_under_test(input_data)

    # 3. ASSERT - Verify the expected (correct) behavior
    assert result == expected_value  # This should FAIL initially
```

## Launching Fix Subagents

Use the Task tool to parallelize fix attempts:

```
Task tool parameters:
- subagent_type: "fixer"
- description: "Fix [bug description]"
- prompt: Include:
  1. The bug description
  2. The failing test location and contents
  3. Suspected cause (if known)
  4. Constraint: "Run the test to verify your fix works"
```

### Parallel fix strategies

Launch multiple subagents with different approaches:
1. **Direct fix agent** — Focus on the immediate code causing the bug
2. **Root cause agent** — Investigate deeper architectural issues
3. **Edge case agent** — Look for similar bugs in related code

## When Projects Lack Tests

If the project has no test infrastructure:

1. Set up minimal test framework first
2. Create the test file in a sensible location
3. Document the test setup for future use

### Quick test setup commands

```bash
# Python
pip install pytest
mkdir -p tests && touch tests/__init__.py

# JavaScript/TypeScript
npm install --save-dev jest
# or
npm install --save-dev vitest
```

## Verifying the Fix

After subagent reports completion:

```bash
# Run the specific test
pytest tests/test_module.py::test_bug_description -v

# Run full suite to check for regressions
pytest
```

## Example Workflow

User reports: "The login function crashes when email has spaces"

**Phase 1** — Write failing test:
```python
# tests/test_auth.py
def test_login_handles_email_with_spaces():
    """Bug: Login crashes when email contains spaces"""
    auth = AuthService()
    
    # This should return an error, not crash
    result = auth.login("user @example.com", "password")
    
    assert result.success == False
    assert "invalid email" in result.error.lower()
```

Run test to confirm it fails:
```bash
pytest tests/test_auth.py::test_login_handles_email_with_spaces -v
# Expected: FAILED (demonstrates the bug)
```

**Phase 2** — Launch subagent:
```
Task tool:
- subagent_type: "fixer"
- description: "Fix email space crash"
- prompt: "Fix the login crash when email contains spaces.
  Bug: AuthService.login() crashes instead of returning error when email has spaces.
  Failing test: tests/test_auth.py::test_login_handles_email_with_spaces
  After fixing, run: pytest tests/test_auth.py::test_login_handles_email_with_spaces -v
  The test must pass to confirm the fix."
```

**Phase 3** — Verify:
```bash
# Specific test passes
pytest tests/test_auth.py::test_login_handles_email_with_spaces -v
# PASSED

# No regressions
pytest tests/test_auth.py -v
# All tests pass
```
