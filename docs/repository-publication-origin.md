# Verified publication origins

`repository-publication-origin` is a metadata-only guard for the estate analysis migration.
It preserves existing human/manual/scheduled publication while preventing newly reachable
deployment, Terraform mutation, tag/release, package/image and secret-sync routes after
App-authenticated automatic dependency merges.

It does not merge, check out target source, build, deploy, fetch secrets or change settings.
It reads GitHub metadata using `contents: read`, `pull-requests: read` and `actions: read`.
Use the default repository token or a fresh repository-scoped **read-only** installation
token, not an App merge token, private key, cloud credential or human PAT.
The client permits only the required metadata routes, exact workflow revisions and bounded
pagination. It encodes individual path components, fixes the API origin, and rejects redirects
and traversal/query injection before sending an authenticated request.

## Admission policy

The helper binds live repository metadata to both `github.repository` and the immutable
`github.repository_id`. It binds the current run to its ID, attempt, event and actual
source metadata. PR merge-ref differences never authorize publication.

| Verified origin | Decision |
| --- | --- |
| Human push/merge, with current repository write/maintain/admin permission | Preserve existing publication eligibility |
| Human `workflow_dispatch` or scheduled run, with the same write permission | Preserve existing behavior |
| Same-repository Dependabot PR merged by the exact broker App or GitHub Actions identity | Hold publication; ordinary analysis still runs |
| Pre-existing same-repository App-authored and App-merged automation | Only when explicitly declared by trusted policy |
| Fork-source run, PR validation, unknown bot or ambiguous/mismatched bot merge | Hold for human attention |
| Metadata transport/permission errors, invalid reports or changed execution identity | Fail explicitly; never authorize |

Human merges of reviewed fork PRs remain human merges. A fork's own run cannot authorize
publication. A human rerun does not replace the original bot actor. Actor names, branch names,
commit messages, labels and uploaded flags are not authorization.
Human push admission comes from the original run actor's immutable identity and current write
permission, not the merger of an earlier PR associated with the same commit. This preserves
release-manager tag pushes and authorized branch pushes of existing commits. Only an exact
matching human merger receives the `human-merge` label; other verified human pushes remain
`human-push`. Bot exceptions still require one exact PR and matching author/merge identities.

`app-id` is the broker's immutable App ID. A bot's public App metadata must match it; the
bot username alone is insufficient. `allow-app-authored-merges` defaults to `false` and must
only preserve a reviewed, pre-existing automation policy. It never permits Dependabot
publication. Do not use it to authorize improvement merges, Copilot or arbitrary bots.

Unknown origins emit `publication-allowed=false`, a warning and a job summary explaining
the hold. Metadata errors fail the step. A false/failed guard must never be bypassed with
`always()`, `continue-on-error`, empty-output defaults or a second authentication fallback.

## Direct push and first-hop consumers

Pin a reviewed exact `repository-publication-origin/v1.X.Y` release or commit. Keep the
guard in a trusted metadata job; it needs no checkout.

```yaml
permissions: {}
jobs:
  origin:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      actions: read
    outputs:
      allowed: ${{ steps.origin.outputs.publication-allowed }}
    steps:
      - id: origin
        uses: frasermolyneux/actions/repository-publication-origin@repository-publication-origin/v1.0.0
        with:
          github-token: ${{ github.token }}
          app-id: ${{ vars.GH_APP_ID }}
  publish:
    needs: origin
    if: needs.origin.outputs.allowed == 'true'
    # Retain the original permissions, environment, change/branch/release conditions,
    # needs dependencies, concurrency and publication steps here.
```

Adding the guard is not permission to publish on a new branch or event. Combine its result
with every existing job gate and retain the original job graph. Grant merge/cloud credentials
only to the existing privileged job after admission. Quality/security validation must not
depend on publication admission.

For a first-hop `workflow_run`, the guard follows the real upstream run ID and source SHA,
not the later default-branch checkout. The upstream run must have completed successfully.
Existing source-repository, event, branch and change checks still apply.

## Chained `workflow_run` publication

GitHub run metadata does not expose a complete nested trigger payload. Never guess a root
origin from a chained run's branch or actor. A producer must retain the guard's metadata proof
in the **originating repository**, and the consumer must declare that producer's exact
reviewed workflow path and git blob SHA.

```yaml
- name: Retain authorized producer origin
  if: steps.origin.outputs.publication-allowed == 'true'
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
  with:
    name: repository-publication-origin
    path: ${{ steps.origin.outputs.report-directory }}/origin.json
    if-no-files-found: error
    retention-days: 1
```

The consumer supplies `trusted-producers` as a JSON array of
`{"path":".github/workflows/<producer>.yml","blobSha":"<exact-40-hex-git-blob>"}`.
Compute the blob for the reviewed **guarded** producer definition, not an unguarded historical
workflow. Commit the declaration alongside its guarded caller. When a producer definition
changes, update and review this declaration in the same coordinated change; never resolve
an arbitrary producer into trust at runtime or float its identity on `main`.

The helper verifies the server-side producer run, success, canonical repository, exact
workflow blob, unique unexpired artifact, artifact run/source binding, report bounds,
engine/classification-policy identity and every recorded run/attempt/source. It then
recomputes the original admission from current API metadata instead of trusting a cached
`allowed` flag. Maximum lineage is eight runs. A visibility, permission, source, engine,
policy, attempt or producer-definition change cannot silently reuse old authorization.

For `workflow_run`, GitHub documents `GITHUB_SHA` as the default-branch commit, not the
upstream source. The helper additionally requires the current run's REST `head_sha` to
match `GITHUB_WORKFLOW_SHA`, the executed workflow-definition commit, before producing
a proof. A disagreement fails explicitly. The report retains both runtime SHAs separately
from the root source, and the hosted chain asserts these bindings. The engine digest covers
both `origin.mjs` and the composite `action.yml`; changing either invalidates old proofs.
See [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
and [default variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables).

Missing/expired proof explicitly holds a chained no-op producer. Duplicate, foreign,
malformed or oversized artifacts fail. An unknown chained root has `sourceSha: null`;
it is not relabeled as the newer default tip.

The artifact is an admission witness from an exact trusted producer definition, **not a
general-purpose signed attestation**. Trusting its uploader alone, matching an artifact name,
or copying a JSON proof from another run is insufficient. Do not add this contract to
untrusted PR-executing privileged workflows.

## Evidence and rollout boundary

The `repository-publication-origin-v1` report contains repository identity/visibility,
policy and engine digests, the actual root source SHA, the explicit admission decision,
and bounded run/attempt/event/actor/workflow lineage. It contains no source excerpts,
credentials or private key. Private proofs stay in that private repository; estate reporting
may consume aggregate status only.

```powershell
node --check repository-publication-origin\origin.mjs
node --test repository-publication-origin\origin.test.mjs
git diff --check
```

Hosted contracts run on Ubuntu and Windows. The live fixture uses read-only GitHub metadata
and an intentionally non-production App ID (`1`): it exercises human/PR/run/proof boundaries,
not an actual App dependency merge. The relay/chain workflows exercise real nested
`workflow_run` and artifact processing without merge/cloud credentials or publication.
Actual catalog-scoped App-merge preservation evidence is required during rollout; fixtures
do not substitute for it.
Positive human fixture runs are identified from the trigger actor independently of the guard
output and must authorize with the expected lineage and runtime/root SHA bindings. A successful
hold cannot masquerade as positive acceptance; intentional bot holds have separate assertions.

This shared primitive alone does not mean estate routes are guarded. Install and verify
every affected route, including downstream consumers and existing automation, before
changing dependency-merge authentication.
