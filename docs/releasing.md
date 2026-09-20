# Release procedure

## Setup

In the npm package settings, add a GitHub Actions Trusted Publisher:

- Owner: `neiltron`
- Repository: `apple-health-mcp`
- Workflow: `publish.yml`
- Environment: leave blank

The workflow uses GitHub OIDC to authenticate with npm and the MCP Registry.
Do not add an npm token. The workflow installs npm 11, which supports Trusted
Publishing.

## Publish a new version

1. Finish and merge the related PRs before you release.
2. Set the same version in `package.json`, `server.json` (both versions), and
   `src/server.ts`. Commit and merge these changes.
3. Run `npm test`, `npm run typecheck`, and `npm run build`.
4. Create a GitHub release with tag `vX.Y.Z` at the merged commit.
5. Check the `publish` workflow result. The workflow checks the version fields,
   runs the checks, publishes npm, and then publishes MCP Registry metadata.
6. Confirm the new version on npm and the MCP Registry.

A published GitHub release does not mean that npm publication succeeded.
Check the workflow result before you announce the release.

## Recover a failed publication

Do not increase the version only to retry a failed workflow.

If npm publication failed and the version does not exist on npm:

1. Correct the npm Trusted Publisher settings if authentication failed.
2. Rerun the failed workflow. If the workflow itself needed a fix, merge the fix
   first. Then use **Run workflow** with the original release tag or full commit
   SHA and clear **registry_only**.

If npm publication succeeded but MCP Registry publication did not:

1. Open **Actions → publish → Run workflow**.
2. Select `main` as the workflow branch.
3. Set **release_ref** to the release tag or full commit SHA for that npm version.
4. Keep **registry_only** selected.
5. Run the workflow and check the result.

The recovery run checks the source versions and the published npm metadata.
It does not run `npm publish` when **registry_only** is selected. npm versions
cannot be overwritten.

For the manually published `1.4.4`, use commit
`db07ee39e55e9db36bf4fe42612fcc40c0eb6733`. No new package release is required.

Only a successful npm publication from Actions verifies Trusted Publishing.
A registry-only run does not test npm publish permission.
