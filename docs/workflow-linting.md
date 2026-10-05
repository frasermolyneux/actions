# Workflow linting

`Lint` runs checksum-verified actionlint 1.7.12 with its normal rules and embedded
ShellCheck integration. Composite Bash scripts receive an additional ShellCheck
pass, including the analysis evidence and native-verification helpers.

The released parser does not yet understand GitHub's commit-bound `$/` action and
reusable-workflow references. The owner-approved `scripts/actionlint_compat.py`
adapter creates a temporary, isolated metadata copy and translates only literal
`uses` values from `$/path` to `./path` for static validation. Runtime workflows,
source files, external references, expressions, scripts and configuration remain
unchanged. Local action metadata and reusable-workflow signatures remain available
in the copy; errors and the original linter exit status are never suppressed.
Self targets must have repository-owned metadata before translation. The linter
retains its existing third-party action and reusable-workflow input checks; it does
not independently validate arbitrary local action inputs.
The copy retains line/column positions for the supported literal references.

Self references must use literal, unanchored paths with alphanumeric, dot,
underscore or hyphen segments. Traversal, mutable `@` suffixes, YAML aliases,
escaped self-reference spellings and non-workflow job references fail explicitly.
Unsupported syntax must not silently become a successful validation.

The same job exercises the actual released parser against positive self-action
and reusable-workflow fixtures and negative missing-action, input, expression and
ShellCheck cases. It also verifies that source files are unchanged. To run locally
with Python, PyYAML 6.0.3 and the released actionlint binary:

```powershell
$env:ACTIONLINT = 'C:\Tools\actionlint.exe'
python -m unittest discover -s scripts -p test_actionlint_compat.py
python scripts\actionlint_compat.py --actionlint $env:ACTIONLINT
```

This is temporary parser compatibility, not a runtime fallback or a replacement
security scanner. Native GitHub hosted acceptance and zizmor continue to validate
the actual commit-bound workflows. Remove the adapter and its tests when a
checksum-pinned actionlint release supports `$/` references, after exercising both
the hosted workflows and equivalent positive/negative linter cases.
Upstream support is tracked in
[rhysd/actionlint#732](https://github.com/rhysd/actionlint/pull/732) and
[rhysd/actionlint#711](https://github.com/rhysd/actionlint/issues/711).
