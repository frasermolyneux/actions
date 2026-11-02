# Sonar policy arguments

`sonar-policy-arguments` validates a platform-managed `.sonarcloud.json` file and emits scanner CLI arguments for repositories that cannot use the shared .NET code-quality workflow.

```yaml
- name: Prepare managed Sonar policy
  id: sonar-policy
  uses: frasermolyneux/actions/sonar-policy-arguments@sonar-policy-arguments/v1.0

- name: Run Sonar analysis
  uses: SonarSource/sonarcloud-github-action@v5
  with:
    args: >
      -Dsonar.projectKey=example
      ${{ steps.sonar-policy.outputs.cli-arguments }}
```

The action fails closed when the policy schema, rationale, ignored rules, or source exclusions differ from the approved platform contract. It emits the same `sonar.exclusions` and `sonar.issue.ignore.multicriteria` properties as the shared code-quality workflow. A repository without `.sonarcloud.json` receives an empty `cli-arguments` output.
