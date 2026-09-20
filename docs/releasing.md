# Release procedure

## Setup

In the npm package settings, add a GitHub Actions Trusted Publisher:

- Owner: `neiltron`
- Repository: `apple-health-mcp`
- Workflow: `publish.yml`
- Environment: leave blank
- **Allow npm publish:** leave unchecked. Permit staged publishing only.

The workflow uses GitHub OIDC to authenticate with npm and the MCP Registry.
Do not add an npm token. Staged publishing requires npm 11.15.0 or later.
The workflow installs a compatible npm 11 version. Your npm account must have
2FA enabled and permission to publish the package.

## Stage a new version

1. Finish and merge the related PRs before you release.
2. Set the same version in `package.json`, `server.json` (both versions), and
   `src/server.ts`. Commit and merge these changes.
3. Check that tests, lint, typecheck, and build pass on the merged commit.
4. Create a GitHub release with tag `vX.Y.Z` at that commit.
5. Check the `publish` workflow result. It checks the version fields, runs the
   checks, and uses `npm stage publish` to submit the package for approval.

A successful staging run does not make the package public. It does not update
MCP Registry metadata. The workflow summary gives the next steps.

## Approve and publish

1. Sign in to npm and open the **Staged Packages** tab.
2. Review the package name, version, source, and contents.
3. Select **Approve** and complete the 2FA prompt. This publishes the staged
   package to npm. Do not run a separate `npm publish` command.
4. Open **Actions → publish → Run workflow** in GitHub.
5. Select `main` as the workflow branch. Set **release_ref** to the same release
   tag or full commit SHA. Keep **registry_only** selected.
6. Run the workflow. It checks the published npm metadata, then publishes the
   MCP Registry entry. It does not stage or publish an npm package.
7. Confirm the version on npm and the MCP Registry before you announce it.

You can also review and approve from the npm CLI:

```bash
npm stage list @neiltron/apple-health-mcp
npm stage view <stage-id>
npm stage approve <stage-id>
```

Approval requires your npm login and 2FA. The CI credentials cannot approve a
staged package.

## Recover a failed run

Do not increase the version only to retry a failed workflow.

If staging failed, check npm for a pending stage before retrying. Staged and
published packages share the same version namespace. A retry cannot overwrite
an existing stage. Review the existing stage or reject it before staging again.

If the workflow needed a fix, merge the fix first. Use **Run workflow** on
`main` with the original release tag or full commit SHA. Clear **registry_only**
to stage the package. Rerunning an old workflow run does not use workflow fixes
merged later.

If npm publication succeeded but MCP Registry publication failed, use the same
reference with **registry_only** selected. Do not stage the package again.

For the existing `v1.4.5` release, run the updated workflow on `main` with
**release_ref** set to `v1.4.5` and **registry_only** cleared. Approve the staged
package on npm, then run registry-only publication with the same tag. No new
version or GitHub release is required.

References: [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
and [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
