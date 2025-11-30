---
applyTo: '**'
---

When touching any foldered composite action, remember that versioning is per-folder: each action owns a local `version.json` and Nerdbank.GitVersioning only advances tags for files under that folder. On merge to `main`, the `actions-versioning` workflow automatically retags the folders you modified with `<folder>/vX.Y.Z`, `<folder>/vX.Y`, and `<folder>/vX`, so bump that folder’s `version.json` before merging whenever you introduce breaking or feature-level changes. If you introduce a brand new action folder, update the `ACTIONS` array in `.github/workflows/actions-versioning.yml` so the workflow knows to tag it.

