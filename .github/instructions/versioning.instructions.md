---
applyTo: '**/action.yml,**/version.json,.github/workflows/actions-versioning.yml'
---

When changing a published action, update its local `version.json` for feature or breaking changes. Patch versions are generated from commit history. When adding a new action folder, also add it to the `ACTIONS` array in `.github/workflows/actions-versioning.yml` so release tags are published.
