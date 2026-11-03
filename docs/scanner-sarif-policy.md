# Scanner SARIF policy

`scanner-sarif-policy` normalizes a completed SARIF file without removing results. The
current policy treats only `zizmor/self-repository` as informational static policy:
the finding recommends commit-bound `$/` syntax but does not itself describe an
exploitable condition. Its SARIF level becomes `note`, while the original level and a
documented rationale remain in result properties.

All other zizmor rules remain security findings at their native level, including
template injection, persisted checkout credentials, unpinned dependencies, environment
file injection and dangerous triggers. Results from other tools are unchanged. Unknown
or malformed SARIF fails rather than being silently accepted, and the action verifies
that policy processing does not add or remove findings.

```yaml
- uses: $/scanner-sarif-policy
  with:
    sarif-file: ${{ steps.scan.outputs.sarifFile }}
```

Use the commit-bound `$/` form from workflows in this repository. External callers use
a folder-scoped `scanner-sarif-policy/v1.X.Y` release tag.
