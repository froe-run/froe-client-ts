---
name: publish-npm
description: >
  Use when the user says "/publish-npm", "publish the SDK", "release to
  npm", or "npm publish". Applies to the froe SDK package (this repo).
  Runs preflight checks automatically; the irreversible publish step waits
  for the user's explicit go.
---

# Publish the SDK to npm

Everything up to the publish is automatic. Publishing is outward-facing and
irreversible on the registry, so the user gates it: the publish step never
runs without the user's explicit go.

## Step 1: preflight

From the repo root:

- `git status --porcelain` is empty. Any output at all means stop and
  report; uncommitted or untracked work should not ship.
- `npm run build` is green. Stop and show the output if not.
- `npm test` is green. Stop and show the output if not.

## Step 2: version check

- Read `version` from `package.json`.
- Run `npm view froe version`.
- If the package exists and the published version equals the local version,
  stop: a bump is needed. Ask the user which one (patch, minor, major), then
  apply it with `npm version <bump> --no-git-tag-version` and rerun the
  build and tests from step 1.
- If `npm view` fails with `E404`, the name is unclaimed; say this is the
  first publish and continue.
- If `npm view` fails with any other error (registry unreachable, network
  error), stop and report it; do not assume unclaimed. If the published
  version is ahead of the local version, the local tree is stale: stop and
  report, do not publish.

## Step 3: license check

If `package.json` has no `"license"` field, warn that npm will flag the
package as unlicensed on publish. Ask the user whether to add one; do not
choose a license yourself.

## Step 4: pack review

Run `npm pack --dry-run` and show the file list. Verify it contains only
`dist/`, `README.md`, `package.json`, and `LICENSE`. Stop and report if
`src/` or test files show up in the list.

## Step 5: auth check

Run `npm whoami`. If it fails (not logged in), stop; do not run `npm login`
yourself, it is interactive. Tell the user to run it, and that the
`! npm login` prefix works to run it inside this session.

## Step 6: the gate

Present a summary: package name, version, target registry, file count, and
unpacked size (from the step 4 dry run). Wait for the user's explicit go.
Never run `npm publish` without it.

## Step 7: publish

- Run `npm publish` (add `--access public` only if the package name is
  scoped, e.g. `@scope/froe`).
- Verify with `npm view froe version`.
- Suggest, without running it, `git tag v<version>`.

## Step 8: failure handling

On `E403` or `E409` (name taken, or this version already published), report
the exact error and stop. Never retry with `--force`.
