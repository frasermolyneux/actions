# AGENTS.md — actions

Repository `actions` in the frasermolyneux organization. Adapt this brief with repo-specific scope and validation commands.

This file is the brief for the **GitHub Copilot coding agent** (and any other agent that follows the [agents.md](https://agents.md) convention) when it runs in a cloud runner without the local VS Code multi-root workspace context.

> If you are a human reading this in VS Code, prefer `.github/copilot-instructions.md` for project orientation. `AGENTS.md` is the agent execution brief.

---

## Required reading (read these BEFORE doing any work)

1. `.github/copilot-instructions.md` — repo-specific orientation, build commands, conventions
2. Relevant repository-native files under `.github/instructions/`
3. Stack-specific files available through the organization catalog when relevant

---

## Org conventions via MCP (when available)

If a `frasermolyneux-copilot` MCP server is configured in your client (`~/.copilot/mcp-config.json`, VS Code user `mcp.json`, or an equivalent stdio MCP wire-up), **prefer its catalog tools** over your own assumptions when answering questions about org standards, branching, workflows, Terraform, .NET projects, Azure patterns, or shared library / platform consumption contracts. The catalog source-of-truth is maintained outside this repository. The `copilot-setup` action does not clone or distribute that catalog. If no MCP server is configured in your client, use the repository-native instructions available in this checkout.

---

## Stack guardrails



Use the organization catalog for tenant facts and enforceable standards when available. Keep repository-specific, enforceable guidance in repository-native instruction files.

### Patterns (apply where relevant)


### Platform consumption contracts (only those this repo consumes)


### Shared library / automation contracts (only those this repo consumes)


---

## Build, test, format



```pwsh
# Build
dotnet build

# Tests (excluding integration tests, matching CI)
dotnet test --filter "FullyQualifiedName!~IntegrationTests"

# Single test
dotnet test --filter "FullyQualifiedName~MyTestClass.MyTestMethod"

# Format check
dotnet format src/<Solution>.sln --verify-no-changes
```



```pwsh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend-config=backends/dev.backend.hcl
terraform -chdir=terraform validate
terraform -chdir=terraform plan -var-file=tfvars/dev.tfvars
```

---

## Do NOT

- ❌ Do not `git commit`, `git push`, force-push, rebase, `reset --hard`, or create/delete branches. Work on the branch you were assigned to.
- ❌ Do not introduce client secrets, connection strings, or hard-coded subscription IDs / GUIDs. Auth is OIDC + managed identity only — see `standards.oidc-and-secrets.instructions.md`.
- ❌ Do not bypass `terraform fmt`, `dotnet format`, test runs, or other validation gates.
- ❌ Do not change resource naming/tagging conventions — they are enforced (`standards.azure-naming.instructions.md`, `standards.azure-tagging.instructions.md`).
- ❌ Do not pull context from sibling workspace folders. Only what is inside this repository is in scope unless the task explicitly requires a read-only consumer inventory.
- ❌ Do not assume tools/SDKs are installed beyond what `.github/workflows/copilot-setup-steps.yml` provisions. If you need more, add the step and explain why.
- ❌ Do not modify `.github/workflows/`, `.github/dependabot.yml`, `version.json`, `Directory.Build.props`, or any `platform-*` consumption wiring unless that is the explicit task.



---

## Opening the PR

You MUST use `.github/PULL_REQUEST_TEMPLATE.md` as your PR body — do **not** write a freeform body. The org template is inherited from `frasermolyneux/.github` and GitHub pre-populates it when you open the PR. Concretely:

1. Fill `## Summary` (one line) and `Closes #<issue>`.
2. Tick the relevant `## Type of change` box.
3. Paste the **actual command output** from your Build, Tests, and Format check runs into `## Validation evidence`. Show the real summary line, not "tests passed".
4. Fill `## Risk and rollout` — blast radius, auto-deploy?, manual steps post-merge, rollback plan.
5. Tick **every** box in `## Agent attestation`.
6. Delete `## Consumer impact` only if no published contract (Abstractions / Client NuGet / Service Bus DTO / Terraform output) changed.

Complete the `## Agent attestation` section before requesting review; reviewers use it as a readiness checklist.

---

## Pre-PR checks (run before you open the PR)

- [ ] Build succeeds locally / in CI
- [ ] Tests pass (excluding integration tests where applicable)
- [ ] Format check passes (`terraform fmt -check` / `dotnet format --verify-no-changes`)
- [ ] No new secrets / GUIDs / connection strings introduced
- [ ] Changes align with files in **Stack guardrails**
- [ ] `code-review` sub-agent run; High/Medium findings resolved or justified in the PR body

---

## Escalation

If you hit any of the conditions below, **open the PR as draft** and **apply the `needs-decision` label** instead of pushing forward to ready-for-review. Post a comment on the originating issue summarising what's blocking you and what decision is needed.

This protects against the agent silently expanding scope, bypassing a contract change, or merging a half-resolved review finding.

Stop and escalate when:

- Required reading file is missing or conflicting.
- The change would require touching `.github/workflows/`, `version.json`, or `platform-*` wiring outside the stated scope.
- A `code-review` finding is High severity and you cannot resolve it without expanding scope.
- A required tool/SDK is unavailable in the runner and `copilot-setup-steps.yml` would need significant modification.
- The acceptance criteria are ambiguous or contradict the linked instruction files.

