# Native SARIF completion verification

`repository-analysis-sarif` verifies **server-side native processing**, not merely an upload
acknowledgement or the uploader step's conclusion. The pinned CodeQL action can stop waiting
after a timeout or metadata-request error; those cases are not completed estate analysis.

The helper re-evaluates its commit-bound sibling context via `$/repository-analysis-context`,
then independently reads live
repository metadata, the current run attempt, the exact SARIF processing identity and its
processed native analyses. Private, exempt, archived, foreign or unselected targets fail
before code-scanning metadata access. This action performs only authenticated reads.
Licensed execution and upload need their own fresh preflight **before** those steps.

## Producer and source boundary

Call it immediately after the **trusted pinned** `github/codeql-action/analyze` or
`upload-sarif` step. Pass that step's actual `sarif-id`, the selected `codeql/<language>` or
`local/<tool>` identity, the pinned/observed scanner version and the actual analyzed SHA.
This initial verifier supports the frozen workflow SHA and native `github.ref`; do not use
it to relabel a custom or different checkout as the workflow source.

The GitHub run's logical head, immutable repository ID, attempt, event and workflow path
must match the executing context. Native analysis must match the actual source, ref, selected
tool/version/category and the native producer key `<caller-workflow-path>:<job-id>`. Creation
must fall after the authenticated attempt start and no later than verification. PR merge
checkout and logical head remain separate. A prior same-source upload is not fresh evidence.
The CodeQL action's category-ending slash is accepted explicitly; other categories are not.

GitHub's analysis metadata does **not** independently attest the scanner process or expose
the upload's workflow-run/attempt binding. Producer-key/time checks restrict replay but
are not a cryptographic producer attestation. Trust comes from the reviewed engine definition,
its pinned uploader's immediate output, real source/extraction/query evidence and subsequent
originating-run/artifact binding. Never feed an issue-supplied upload ID or treat this JSON
alone as proof that every selected capability was scanned.

The metadata token needs repository metadata, `actions: read` and `security-events: read`.
The uploader separately needs `security-events: write`; use the default repository token,
not an App merge token, Copilot PAT, cloud credential or blanket inherited secrets.

## Completion and output

Pending processing is polled for at most 60 checks with five-second intervals. Failed,
unknown, errored or still-pending processing fails explicitly. Analysis lookup is scoped to
the upload ID, bounded to fewer than 100 records, and requires exactly one matching native
tool/category. Missing/ambiguous results, API denial, transport errors, malformed/oversized
responses and identity/version/source mismatches never emit a success-shaped zero.

All request URLs are constructed on `api.github.com`; provider links and redirects are not
followed with credentials. Raw responses/errors, finding excerpts and tokens are not
persisted. `proof.json` contains bounded publication/processing IDs, public repository/policy
identity, actual/logical source, run/definition metadata, observed tool/version/category,
counts and timestamps. Publish it only in the originating repository.

`analysis-id` and `proof-directory` are emitted only after verification. Genuine zero native
results are distinct from processing failure. Native result counts are not a source-coverage
measure, a query/rule-pin check, Sonar completion/coverage import or complete-profile state.
Those separate engine/result prerequisites remain necessary.

## Validation

```powershell
node --test repository-analysis-sarif\verify.test.mjs
git diff --check
```

`repository-analysis-native-tests.yml` exercises the boundaries on Linux/Windows and actually
extracts/query-analyzes this public repository's Actions source using pinned CodeQL 2.27.1.
It verifies the real uploaded analysis through this composite and retains the proof. Fork
PRs do not execute that write-bearing native integration job. Deterministic private-policy
tests are not claimed as an actual private-repository hosted scan.
