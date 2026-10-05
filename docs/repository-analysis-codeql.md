# CodeQL native integration acceptance

`.github/workflows/repository-analysis-codeql-tests.yml` exercises the pinned
CodeQL action at `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` and the exact
2.27.1 bundle. This is integration acceptance for the estate engine workstream,
not a released reusable engine or adoption of a complete estate profile.

Live metadata must identify a public repository with the selected language before
initialization. Private, unknown and foreign pull-request sources cannot enter
these jobs. Queries run without automatic database or SARIF publication.

For maintained Actions, JavaScript and Python source, the verifier checks the
actual checkout revision, unchanged tracked files, observed CLI version, queried
SARIF invocation and native database archive. Selected archived source bytes must
match their tracked checkout bytes. Estimated baseline lines are not extraction
evidence. Archive file counts are not evaluated-line or coverage percentages.
Live-public eligibility is checked again before the validated SARIF upload; the
existing native verifier independently binds processing, source and publication.

Separate SDK .NET, Windows Framework 4.8 and C++ fixtures exercise manual
extraction around the preserved analysis-only restore/build/test commands.
Fixture query output and databases are **never uploaded** to native code scanning.
Their bounded proof artifacts explicitly identify fixture-only scope.
Artifacts stay in the originating repository and expire after 14 days. Raw
database archives and source bytes are not copied into proof artifacts.

Every proof records `fullProfileEvidence: false`. A successful fixture or
individual language cannot satisfy full-profile freshness, Sonar coverage import,
consumer rollout or final estate acceptance.

```powershell
python -m unittest discover -s repository-analysis-codeql -p 'test_*.py'
node --check repository-analysis-codeql/integration.mjs
```

The hosted workflow is required for genuine extraction, query and native
publication evidence; local synthetic archive tests are only boundary contracts.
