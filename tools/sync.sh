#!/usr/bin/env bash
# sync.sh — Sync the live harness with the workflow repo (drift control).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HARNESS_ROOT="${HARNESS_ROOT:-${HOME}/omp-workflow}"
AGENTS_ROOT="${AGENTS_ROOT:-${HOME}/.agents}"
REPO_ROOT=""
MODE="check"
PRUNE=0
CONFIRM=0
FORCE=0
ONLY=""
QUIET=0

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --promote|-Promote)
      MODE="promote"
      shift
      ;;
    --deploy|-Deploy)
      MODE="deploy"
      shift
      ;;
    --check|-Check)
      MODE="check"
      shift
      ;;
    --prune|-Prune)
      PRUNE=1
      shift
      ;;
    --confirm|-Confirm)
      CONFIRM=1
      shift
      ;;
    --force|-Force)
      FORCE=1
      shift
      ;;
    --only|-Only)
      ONLY="$2"
      shift 2
      ;;
    --harness-root|-HarnessRoot)
      HARNESS_ROOT="$2"
      shift 2
      ;;
    --repo-root|-RepoRoot)
      REPO_ROOT="$2"
      shift 2
      ;;
    --agents-root|-AgentsRoot)
      AGENTS_ROOT="$2"
      shift 2
      ;;
    --quiet|-Quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./sync.sh [--check|--promote|--deploy|--prune [--confirm]] [--harness-root <path>] [--repo-root <path>] [--force] [--only <filter>]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$PRUNE" = "1" ] && [ "$MODE" != "check" ]; then
  echo "Choose one of --prune, --promote or --deploy." >&2
  exit 2
fi

# Resolve RepoRoot
if [ -z "$REPO_ROOT" ]; then
  parent_repo="$(cd "$SCRIPT_DIR/.." && pwd)"
  candidates=(
    "$parent_repo"
    "$HARNESS_ROOT/workflow-repo"
    "$HARNESS_ROOT"
  )
  for c in "${candidates[@]}"; do
    if [ -n "$c" ] && [ -f "$c/install.ps1" ] && [ -f "$c/agent/models.yml.example" ]; then
      REPO_ROOT="$c"
      break
    fi
  done
fi

if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/install.ps1" ]; then
  echo "Cannot locate workflow-repo (needs install.ps1 + agent/models.yml.example). Pass --harness-root or run from the repo's tools/ directory." >&2
  exit 2
fi

# Prune mode: delegate to sync-prune.mjs
if [ "$PRUNE" = "1" ]; then
  prune_script="$SCRIPT_DIR/sync-prune.mjs"
  if [ ! -f "$prune_script" ]; then
    echo "sync-prune.mjs not found next to sync.sh ($prune_script). Deploy tools/sync-prune.mjs first." >&2
    exit 2
  fi
  prune_args=("$prune_script" "--harness" "$HARNESS_ROOT" "--repo" "$REPO_ROOT")
  if [ "$CONFIRM" = "1" ]; then
    prune_args+=("--delete")
  fi
  set +e
  node "${prune_args[@]}"
  prune_exit=$?
  set -e
  if [ $prune_exit -ne 0 ]; then
    echo "sync: prune failed (exit $prune_exit)" >&2
    exit $prune_exit
  fi
  if [ "$CONFIRM" != "1" ]; then
    echo "sync: dry-run only - nothing was deleted. Re-run with '--prune --confirm' to delete."
  fi
  exit 0
fi

# Manifest list (same 50 entries as sync.ps1)
MANIFEST=(
  "agent/AGENTS.md"
  "agent/agents/orchestrator.md"
  "agent/agents/fixer.md"
  "agent/agents/oracle.md"
  "agent/agents/designer.md"
  "agent/agents/explorer.md"
  "agent/agents/reviewer.md"
  "agent/agents/librarian.md"
  "agent/agents/sonic.md"
  "rules/enterprise-directives.md	$AGENTS_ROOT"
  "tools/codemap.mjs"
  "tools/prompt-lint.mjs"
  "tools/skills-doctor.mjs"
  "tools/glossary.mjs"
  "tools/replay.mjs"
  "tools/workflow.mjs"
  "tools/auto-review.mjs"
  "tools/cache-doctor.mjs"
  "tools/cache-policy.mjs"
  "tools/return-contract.mjs"
  "tools/session_cost.py"
  "tools/context-inbox.mjs"
  "tools/domain-context.mjs"
  "tools/oracle-model.mjs"
  "tools/debt-ledger.mjs"
  "tools/benchmark.mjs"
  "tools/usage-audit.mjs"
  "tools/test-lens.mjs"
  "tools/doctor.mjs"
  "tools/sync-prune.mjs"
  "tools/memory-cadence.mjs"
  "tools/mutation-test.mjs"
  "tools/gherkin-spec.mjs"
  "tools/dashboard.mjs"
  "tools/fix-plugin-windows.cjs"
  "tools/audit.ps1"
  "tools/sync.ps1"
  "tools/audit.sh"
  "tools/sync.sh"
  "tools/verify.mjs"
  "verify.ps1"
  "verify.sh"
  "core/PORTABLE.md"
  "paseo/profiles.json"
  "paseo/setup-paseo.ps1"
  "templates/design/DESIGN.md"
  "agent/oracle-priority.example.json"
  "agent/plugins.json"
  "templates/design/examples/good/README.md"
  "templates/design/examples/bad/README.md"
  "templates/ci/workflow-gate.yml"
  "templates/workflow/cache-policy.example.json"
  "templates/paseo.json"
  "CONTEXT.md"
  "README.md"
)

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'sync')"
trap 'rm -rf "$TMP_DIR"' EXIT

drift=()
checked=0
suspect=()

harness_slash="${HARNESS_ROOT//\\//}"

for entry in "${MANIFEST[@]}"; do
  # Split tab if present
  rel="${entry%%	*}"
  live_root="$HARNESS_ROOT"
  if [ "$entry" != "$rel" ]; then
    live_root="${entry#*	}"
  fi
  if [ -n "$ONLY" ] && [[ "$rel" != *"$ONLY"* ]]; then
    continue
  fi

  live_path="$live_root/$rel"
  repo_path="$REPO_ROOT/$rel"
  checked=$((checked + 1))
  live_exists=0
  repo_exists=0
  [ -f "$live_path" ] && live_exists=1
  [ -f "$repo_path" ] && repo_exists=1

  # Check if prompt surface for <HARNESS> substitution
  is_prompt_surface=0
  case "$rel" in
    agent/*|rules/*|skills/*)
      is_prompt_surface=1
      ;;
  esac

  has_diff=0

  if [ $live_exists -eq 0 ] && [ $repo_exists -eq 0 ]; then
    has_diff=0
  elif [ $live_exists -eq 0 ] || [ $repo_exists -eq 0 ]; then
    has_diff=1
  else
    tmp_live="$TMP_DIR/live"
    tmp_repo="$TMP_DIR/repo"

    tr -d '\r' < "$live_path" > "$tmp_live"
    if [ $is_prompt_surface -eq 1 ]; then
      sed "s|<HARNESS>|${harness_slash}|g" "$repo_path" | tr -d '\r' > "$tmp_repo"
    else
      tr -d '\r' < "$repo_path" > "$tmp_repo"
    fi

    set +e
    diff -q "$tmp_live" "$tmp_repo" >/dev/null 2>&1
    diff_status=$?
    set -e

    if [ $diff_status -ne 0 ]; then
      has_diff=1
    fi
  fi

  if [ $has_diff -eq 0 ]; then
    continue
  fi

  drift+=("$rel")

  if [ "$MODE" = "promote" ]; then
    if [ $repo_exists -eq 1 ] && [ $live_exists -eq 1 ]; then
      if [ "$repo_path" -nt "$live_path" ]; then
        suspect+=("$rel")
        if [ "$FORCE" != "1" ]; then
          continue
        fi
      fi
    fi
    if [ $live_exists -eq 0 ]; then
      continue
    fi
    mkdir -p "$(dirname "$repo_path")"
    tr -d '\r' < "$live_path" > "$repo_path"
    [ "$QUIET" != "1" ] && echo "  [->] promote $rel"
  elif [ "$MODE" = "deploy" ]; then
    if [ $repo_exists -eq 0 ]; then
      continue
    fi
    mkdir -p "$(dirname "$live_path")"
    if [ $is_prompt_surface -eq 1 ]; then
      sed "s|<HARNESS>|${harness_slash}|g" "$repo_path" | tr -d '\r' > "$live_path"
    else
      tr -d '\r' < "$repo_path" > "$live_path"
    fi
    [ "$QUIET" != "1" ] && echo "  [<-] deploy  $rel"
  else
    [ "$QUIET" != "1" ] && echo "  [XX] DRIFT   $rel"
  fi
done

[ "$QUIET" != "1" ] && echo ""

if [ ${#drift[@]} -eq 0 ]; then
  [ "$QUIET" != "1" ] && echo "sync: clean ($checked files checked)"
  exit 0
fi

if [ "$MODE" = "promote" ] && [ ${#suspect[@]} -gt 0 ]; then
  if [ "$FORCE" != "1" ]; then
    echo "sync: REFUSED - ${#suspect[@]} repo file(s) are NEWER than the live tree:" >&2
    for x in "${suspect[@]}"; do echo "  $x" >&2; done
    echo "" >&2
    echo "Promoting would overwrite that work with a stale harness. Either:" >&2
    echo "  --deploy      push the repo (newer) INTO the live tree, or" >&2
    echo "  --promote --force   if the live tree really is the intended source" >&2
    exit 2
  else
    echo "sync: FORCED - overwrote ${#suspect[@]} newer repo file(s) with the live tree:"
    for x in "${suspect[@]}"; do echo "  $x"; done
  fi
fi

if [ "$MODE" = "promote" ] || [ "$MODE" = "deploy" ]; then
  target_name="deployed to harness"
  [ "$MODE" = "promote" ] && target_name="promoted to repo"
  [ "$QUIET" != "1" ] && echo "sync: ${#drift[@]}/$checked files $target_name"
  exit 0
fi

[ "$QUIET" != "1" ] && echo "sync: ${#drift[@]}/$checked files drifted. Run --promote or --deploy."
exit 1
