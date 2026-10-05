---
name: gitlab-cli-skills
description: Comprehensive GitLab CLI (glab) command reference and workflows for all GitLab operations via terminal. Use when user mentions GitLab CLI, glab commands, GitLab automation, MR/issue management via CLI, CI/CD pipeline commands, Artifact Registry token exchange, repo operations, authentication setup, or any GitLab terminal operations. Routes to specialized sub-skills for auth, CI, MRs, issues, releases, repos, and 30+ other glab commands. Triggers on glab, GitLab CLI, GitLab commands, GitLab terminal, GitLab automation.
metadata: {"openclaw": {"requires": {"bins": ["glab"], "anyBins": ["cosign"]}, "install": [{"id": "brew", "kind": "brew", "formula": "glab", "bins": ["glab"], "label": "Install glab (brew)"}, {"id": "download", "kind": "download", "url": "https://gitlab.com/gitlab-org/cli/-/releases", "label": "Download glab binary"}]}}
requirements:
  binaries:
    - glab
  binaries_optional:
    - cosign
  notes: |
    Requires GitLab authentication via 'glab auth login' (stores token in the active global glab config file).
    Some features may access sensitive files: SSH keys (~/.ssh/id_rsa for DPoP), Docker config (~/.docker/config.json for registry auth).
    Review auth workflows and script contents before autonomous use.
openclaw:
  requires:
    credentials:
      - name: GITLAB_TOKEN
        description: >
          GitLab personal access token with 'api' scope. Used by automation
          scripts (e.g. post-inline-comment.py) to post MR comments via the
          REST API. If not set, scripts fall back to reading the token from
          the active global glab CLI config.
        required: false
        fallback: glab config (set via glab auth login)
    network:
      - description: Outbound HTTPS to your GitLab instance (default https://gitlab.com)
        scope: authenticated API calls only; HTTPS enforced; token never sent over HTTP
    write_access:
      - description: >
          Scripts in this skill can post comments, resolve threads, and approve
          merge requests on your behalf. Review scripts/post-inline-comment.py
          before use in automated or agentic contexts.
---

# GitLab CLI Skills

Comprehensive GitLab CLI (glab) command reference and workflows.

## Quick start

```bash
# First time setup
glab auth login

# Common operations
glab mr create --fill              # Create MR from current branch
glab issue create                  # Create issue
glab ci view                       # View pipeline status
glab repo view --web              # Open repo in browser
```

## Multi-agent identity note

When you want different agents to appear as different GitLab users, give each agent its own GitLab bot/service account. Multiple personal access tokens on the same GitLab user still act as that same visible identity.

Use the **Actor identity** for actor-authored GitLab comments, replies, approvals, and other writes. Use an **agent identity** only when the GitLab action is explicitly that agent's own work product. Choose the intended visible actor **before the first GitLab write**.

Treat shell identity as sticky and unsafe by default. If another env file was sourced earlier in the same shell/session, `glab` may still write as that previously loaded identity unless you deliberately switch and verify first.

A practical pattern is one env file per actor, for example `~/.config/openclaw/env/gitlab-actor.env`, `~/.config/openclaw/env/gitlab-reviewer.env`, and `~/.config/openclaw/env/gitlab-release.env`. Keep these env files outside version control, restrict their permissions (for example `chmod 600`), be mindful of backup exposure, and use least-privilege bot/service-account tokens. In a reused shell, clear stale GitLab auth vars first or start a fresh shell. If those files use plain `KEY=value` lines, load them with exported vars before running `glab`:

```bash
unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN GITLAB_HOST
set -a
source ~/.config/openclaw/env/gitlab-<actor>.env
set +a
```

Plain `source` updates the current shell but may not export variables to child processes such as `glab`. If the token/host vars are not exported, `glab` may silently fall back to shared stored auth from the active global glab config file, which can make the wrong account appear to perform the action.

### Required pre-flight before any GitLab write

Run this immediately before any GitLab write, including `glab mr note`, review replies/approvals, and any `glab api` `POST`/`PATCH`/`PUT`/`DELETE` call:

```bash
glab auth status --hostname "$GITLAB_HOST"
glab api --hostname "$GITLAB_HOST" user
```

This assumes the target actor env file set `GITLAB_HOST` for the exact GitLab instance you intend to modify. Do not write until both commands clearly show the intended visible actor on that host.

### Wrong-identity remediation

If a comment or reply was posted under the wrong identity:

1. Stop posting.
2. Delete the mistaken comment or reply if cleanup is needed.
3. `unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN GITLAB_HOST` or start a fresh shell.
4. Source the correct env file with `set -a; source ...; set +a`.
5. Rerun `glab auth status --hostname "$GITLAB_HOST"` and `glab api --hostname "$GITLAB_HOST" user`.
6. Repost under the correct actor.
7. Verify the thread no longer shows the wrong visible author for the replacement message.

If the wrong-identity write changed state beyond a comment or reply, do not treat the comment cleanup steps as sufficient. Re-auth as above, then use the matching GitLab reversal for that write under the correct actor and host, such as unapproving an MR or sending the compensating `glab api --hostname "$GITLAB_HOST"` mutation for the exact resource that was changed.

## Skill organization

This skill routes to specialized GitLab CLI commands and domains. Refer to the official GitLab CLI documentation for individual command reference:

**Core Workflows:**
- [`glab mr`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/mr/) - Merge requests: create, review, approve, merge
- [`glab issue`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/issue/) - Issues: create, list, update, close, comment
- [`glab ci`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/ci/) - CI/CD: pipelines, jobs, logs, artifacts
- [`glab repo`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/repo/) - Repositories: clone, create, fork, manage

**Project Management:**
- [`glab milestone`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/milestone/) - Release planning and milestone tracking
- [`glab iteration`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/iteration/) - Sprint/iteration management
- [`glab label`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/label/) - Label management and organization
- [`glab release`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/release/) - Software releases and versioning
- [`glab package`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/package/) - Project package registry listing, filtering, and generic package uploads

**Authentication & Config:**
- [`glab auth`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/auth/) - Login, logout, Docker registry auth
- [`glab config`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/config/) - CLI configuration and defaults
- [`glab ssh-key`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/ssh-key/) - SSH key management
- [`glab gpg-key`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/gpg-key/) - GPG keys for commit signing
- [`glab token`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/token/) - Personal and project access tokens
- [`glab todo`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/todo/) - Personal GitLab to-do triage and completion

**CI/CD Management:**
- [`glab job`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/job/) - Individual job operations
- [`glab schedule`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/schedule/) - Scheduled pipelines and cron jobs
- [`glab variable`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/variable/) - CI/CD variables and secrets
- [`glab securefile`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/securefile/) - Secure files for pipelines
- [`glab runner`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/runner/) - Runner management: list, assign/unassign, inspect jobs/managers, pause/unpause, delete
- [`glab runner-controller`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/runner-controller/) - Runner controller, scope, and token management (EXPERIMENTAL, admin-only)

**Collaboration:**
- [`glab user`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/user/) - User profiles and information
- [`glab snippet`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/snippet/) - Code snippets (GitLab gists)
- [`glab incident`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/incident/) - Incident management
- [`glab workitems`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/workitems/) - Work items: tasks, OKRs, key results, next-gen epics

**Advanced:**
- [`glab api`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/api/) - Direct REST API calls
- [`glab artifact-registry`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Experimental short-lived Artifact Registry token exchange and access checks
- [`glab cluster`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/cluster/) - Kubernetes cluster integration
- [`glab container-registry`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Container registry repositories and tags
- [`glab dependency-firewall`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Beta local package-manager registry policy configuration and CI activity summaries
- [`glab deploy-key`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/deploy-key/) - Deploy keys for automation
- [`glab orbit`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - GitLab Knowledge Graph / Orbit discovery, schema inspection, and remote query workflows (EXPERIMENTAL)
- [`glab quick-actions`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - GitLab slash command quick actions for batching state changes
- [`glab security`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Project security scan profile enable/disable/status management (EXPERIMENTAL)
- [`glab stack`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/stack/) - Stacked/dependent merge requests
- [`glab opentofu`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Terraform/OpenTofu state management

**Utilities:**
- [`glab alias`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/alias/) - Custom command aliases
- [`glab completion`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/completion/) - Shell autocompletion
- [`glab help`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/help/) - Command help and documentation
- [`glab version`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/version/) - Version information
- [`glab check-update`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/check-update/) - Update checker
- [`glab whatsnew`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Release notes since the last viewed or post-upgrade baseline
- [`glab changelog`](https://docs.gitlab.com/editor-extensions/gitlab-cli/commands/changelog/) - Changelog generation
- [`glab attestation`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Software supply chain security
- [`glab duo`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - GitLab Duo AI assistant
- [`glab mcp`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Model Context Protocol server for AI assistant integration (EXPERIMENTAL)
- [`glab skills`](https://docs.gitlab.com/editor-extensions/gitlab-cli/) - Install and manage bundled agent skills (EXPERIMENTAL)
## When to use glab vs web UI

**Use glab when:**
- Automating GitLab operations in scripts
- Working in terminal-centric workflows
- Batch operations (multiple MRs/issues)
- Integration with other CLI tools
- CI/CD pipeline workflows
- Faster navigation without browser context switching

**Use web UI when:**
- Complex diff review with inline comments
- Visual merge conflict resolution
- Configuring repo settings and permissions
- Advanced search/filtering across projects
- Reviewing security scanning results
- Managing group/instance-level settings

## Common workflows

### Daily development

```bash
# Start work on issue
glab issue view 123
git checkout -b 123-feature-name

# Create MR when ready
glab mr create --fill --draft

# Mark ready for review
glab mr update --ready

# Merge after approval
glab mr merge --when-pipeline-succeeds --remove-source-branch
```

### Code review

```bash
# List your review queue
glab mr list --reviewer=@me --state=opened

# Review an MR
glab mr checkout 456
glab mr diff
npm test

# Approve
glab mr approve 456
glab mr note 456 -m "LGTM! Nice work on the error handling."
```

### CI/CD debugging

```bash
# Check pipeline status
glab ci status

# View failed jobs
glab ci view

# Get job logs
glab ci trace <job-id>

# Retry failed job
glab ci retry <job-id>
```

## Decision Trees

### "Should I create an MR or work on an issue first?"

```
Need to track work?
├─ Yes → Create issue first (glab issue create)
│         Then: glab mr for <issue-id>
└─ No → Direct MR (glab mr create --fill)
```

**Use `glab issue create` + `glab mr for` when:**
- Work needs discussion/approval before coding
- Tracking feature requests or bugs
- Sprint planning and assignment
- Want issue to auto-close when MR merges

**Use `glab mr create` directly when:**
- Quick fixes or typos
- Working from existing issue
- Hotfixes or urgent changes

### "Which CI command should I use?"

```
What do you need?
├─ Overall pipeline status → glab ci status
├─ Visual pipeline view → glab ci view
├─ Specific job logs → glab ci trace <job-id>
├─ Download build artifacts → glab ci artifact <ref> <job-name>
├─ Validate config file → glab ci lint
├─ Trigger new run → glab ci run
└─ List all pipelines → glab ci list
```

**Quick reference:**
- Pipeline-level: `glab ci status`, `glab ci view`, `glab ci run`
- Job-level: `glab ci trace`, `glab job retry`, `glab job view`
- Artifacts: `glab ci artifact` (by pipeline) or job artifacts via `glab job`

### "Clone or fork?"

```
What's your relationship to the repo?
├─ You have write access → glab repo clone group/project
├─ Contributing to someone else's project:
│   ├─ One-time contribution → glab repo fork + work + MR
│   └─ Ongoing contributions → glab repo fork, then sync regularly
└─ Just reading/exploring → glab repo clone (or view --web)
```

**Fork when:**
- You don't have write access to the original repo
- Contributing to open source projects
- Experimenting without affecting the original
- Need your own copy for long-term work

**Clone when:**
- You're a project member with write access
- Working on organization/team repositories
- No need for a personal copy

### "Project vs group labels?"

```
Where should the label live?
├─ Used across multiple projects → glab label create --group <group>
└─ Specific to one project → glab label create (in project directory)
```

**Group-level labels:**
- Consistent labeling across organization
- Examples: priority::high, type::bug, status::blocked
- Managed centrally, inherited by projects

**Project-level labels:**
- Project-specific workflows
- Examples: needs-ux-review, deploy-to-staging
- Managed by project maintainers

## Related Skills

**MR and Issue workflows:**
- Start with `glab-issue` to create/track work
- Use `glab-mr` to create MR that closes issue
- Script: `scripts/create-mr-from-issue.sh` automates this

**CI/CD debugging:**
- Use `glab-ci` for pipeline-level operations
- Use `glab-job` for individual job operations
- Script: `scripts/ci-debug.sh` for quick failure diagnosis

**Repository operations:**
- Use `glab-repo` for repository management
- Use `glab-auth` for authentication setup
- Script: `scripts/sync-fork.sh` for fork synchronization

**Configuration:**
- Use `glab-auth` for initial authentication
- Use `glab-config` to set defaults and preferences
- Use `glab-alias` for custom shortcuts
