# Registry entry automation

A signed `builtin-plugins` release notifies this repo (`repository_dispatch`,
event type `builtin-released`); the `registry-entry-update` workflow
regenerates that plugin's entry — downloading the release assets, verifying
the Ed25519 signature against `keys/signing-key.pub.pem`, and binding the
in-bundle `motrix-plugin.json` id/version to the tag — then opens a PR. The
normal `check` / `test` / `validate` / `aggregate` lockstep CI gates the
PR before a human merges. The entry workflow opens a PR only; merging it enters
the same release coordinator as every other `main` change.

The generator (`scripts/entry-from-release.ts`) is the single source of this
logic; it is also used to populate entries manually (`pnpm entry:from-release`).

## Exact-artifact release DAG

`.github/workflows/publish.yml` is the only forward production writer;
`.github/workflows/restore.yml` is the only recovery writer. Both use
`registry-production`, and a publish run follows this order:

1. On the exact registry source SHA, run `pnpm check`, `pnpm test`,
   `pnpm validate`, and `pnpm aggregate` once. Upload an immutable ZIP whose
   only entry is root `plugins.json`; retain its payload SHA/bytes, source SHA,
   workflow run id, artifact id, and archive digest. Assets are outside this
   tuple and must not be described as attested by it.
2. Download that candidate by artifact id. Verify the raw archive SHA/id,
   complete central directory, exact layout, and embedded registry bytes, then
   safely extract to a fresh directory. The website release wrapper consumes
   only that verified file, serves it over loopback, runs its build tests,
   builds once, and emits strict
   `website-artifact-manifest.json`. Upload that
   manifest at ZIP root and the already-built files only under `dist/` as one
   immutable artifact.
3. A no-write job downloads both artifacts by id, recomputes all file/tree
   hashes directly from their ZIP contents, validates their manifest
   relationship and archive bytes, rejects unsafe/duplicate/extra paths, and
   rejects registry or website source refs that are no longer current.
4. The `plugin-publishing` environment approval is required. After approval,
   repeat every no-write check and the website prebuilt dry-run before touching
   production.
5. Read the current R2 object, create or verify its immutable private backup,
   and upload the canonical release intent before the first live mutation. The
   intent binds the previous object, backup, exact candidate/website artifacts,
   producer identities, and a stable operation id. A retry must recover this
   journal by operation id; it must never reinterpret whatever bytes happen to
   be live.
6. Classify exactly one transition: `cas` when the live SHA and ETag equal the
   intent's opaque previous identity, or `resume` when the candidate registry-v2 SHA is
   already live. Every third state fails closed. Recheck the current registry
   and website `main` refs at the mutation boundary; a recovery dispatch is
   driven by current `main` code while consuming only its retained intent.
7. Deploy only the intent-bound, safely extracted prebuilt website. Never
   accept a separate dist directory, aggregate, or build again. Re-read and
   revalidate the immutable intent, artifacts, current object, and backup after
   deployment.
8. In `cas`, conditionally write the exact candidate to the existing
   `plugins.json` key with `If-Match`; in `resume`, prove those bytes are already
   live and perform no write. Verify direct R2 and cache-busted public SHA/ETag,
   then retain a strict `ReleaseManifest` v2 completion record even when the
   public probe fails after a successful R2 transition. Its downloadable
   completion-artifact wrapper keeps the raw artifact digest
   (`artifactSha256`) distinct from the inner manifest-content digest
   (`manifestSha256`); restore verifies both.

The first registry-v2 cutover is deliberately forward-only. The bounded
previous live bytes are treated as opaque data and retained only for exact
backup/CAS identity and forensic evidence; no legacy JSON shape is parsed, and
those bytes must never be a restore target. Restore becomes available only
after a completed registry-v2 release has retained both matching raw artifacts.
Every restore is an internal `RestoreManifest` v2 transition between two
complete, distinct registry-v2 release tuples. It has no `restoreEtag`: a
future PutObject ETag is observed, not predicted.

Before a restore mutates either service, it persists a private immutable
initial journal: canonical intent and authorized manifest, outgoing payload,
and both directions' raw registry/website artifacts. A pre-write `cas` retry
may encounter any subset of those records; every present object is verified,
only missing objects are created, and a complete readback is mandatory before
deployment. A `resume` requires the complete initial journal. Restore accepts
only `cas` (exact `from` SHA+ETag) or `resume` (exact registry-v2 `to` SHA); it
deploys with a separately frozen current-`main` website driver and
conditionally transitions the registry last.

After the target and reverse-source ETags are observed, restore creates a
strict `RestoreCompletion` v2 and a deterministic swapped reverse manifest.
The completion binds the full restore workflow tuple and all immutable object
keys. The reverse manifest has no self hash; it is reconstructed from the
direct-parent intent and completion, and its `r2-operation` source descriptors
bind the parent completion digest/identity and exact raw artifact keys. A crash
between the two post-transition writes is recoverable from the surviving
record. Restore verifies direct R2 first, then creates and strictly reads back
both completion records, and only then runs the bounded cache-busted public
probe. A public convergence failure therefore preserves the durable completion
chain for an exact-operation retry. Executing the generated reverse seed always
requires a new protected-environment approval.

The public URL remains
`https://dl.motrix.app/registry/plugins.json`; the root is `version: 2`.
See [Registry cutover and restore](registry-cutover-runbook.md) for operations
and partial-failure handling.

Version spaces are independent: candidate/website artifact manifests remain
`schemaVersion: 1`, while release/restore journals remain internal
`schemaVersion: 2`. The latter had not been activated in production, so the
registry-v2 clean break removes its draft pre-state classification in place rather
than inventing an internal v3 or accepting old v2 records.

## Publisher environment setup

Configure the current maintainer as a required reviewer on the
`plugin-publishing` GitHub environment. While the repository has only one
maintainer, leave **Prevent self-review** disabled so the required second-step
confirmation is usable; record that this is not independent review. Enable
**Prevent self-review** and require another maintainer when one is available.
Keep these secrets scoped there:

- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: Object Read & Write on the
  `motrix-registry` bucket only.
- `CLOUDFLARE_ACCOUNT_ID`: R2 endpoint and website deployment account.
- `CLOUDFLARE_API_TOKEN`: minimum website deployment permissions.

Also configure the non-write trust inputs used before approval:

- repository variable `WEBSITE_REPOSITORY` (`owner/repository`) and optional
  `WEBSITE_REF` (defaults to `main`);
- repository secret `WEBSITE_READ_TOKEN` with Contents:read on only the private
  website repository (the normal publish path may fall back to `GITHUB_TOKEN`
  only when that token can read it);
- repository variable `CLOUDFLARE_ACCOUNT_ID`, used to form the restore
  read-only R2 endpoint; and
- repository secrets `R2_READ_ACCESS_KEY_ID` and
  `R2_READ_SECRET_ACCESS_KEY`, restricted to Object Read on only the registry
  bucket. They are the only R2 credentials available to `dry_run: true`.

Workflow artifacts, release records, and private operation records must remain
retained for the documented recovery window. Do not bypass approval with a
manual R2 upload or a website command that performs a build during deploy.
The shared concurrency group coordinates only these repository workflows;
bucket-scoped token policy and an enforced unique-writer rule must also exclude
manual or external writers.

## One-time setup (repo admin)

- **builtin-plugins → a GitHub App for the cross-repo dispatch.** Create an
  org-owned GitHub App with the single Repository permission **Contents:
  Read and write** (what `repository_dispatch` requires), install it on
  `motrixapp/plugin-registry` only, and store its credentials in
  builtin-plugins' **`plugin-signing` environment**:
  - `REGISTRY_DISPATCH_APP_ID` — the App ID (secret or variable),
  - `REGISTRY_DISPATCH_APP_PRIVATE_KEY` — the App private key `.pem` (secret).

  The release workflow's `sign` job mints a short-lived (~1h), repo-scoped
  installation token from these (`actions/create-github-app-token`) and uses
  it to `POST repos/motrixapp/plugin-registry/dispatches`. This is a distinct
  credential from the Ed25519 signing key (`MOTRIX_PLUGIN_SIGNING_KEY`) —
  same environment, far lower sensitivity. Until BOTH App secrets are set,
  the mint + notify steps skip (gated on a credentials-present check) and the
  signed release still succeeds.
- **plugin-registry setting** — Settings → Actions → General → "Allow GitHub
  Actions to create and approve pull requests" must be enabled so the
  workflow's `GITHUB_TOKEN` can open the PR.

## Manual fallback

No dispatch token needed — trigger the workflow directly:

```bash
gh workflow run registry-entry-update.yml -f id=<id> -f tag=<id>@<version>
```

(or the Actions UI). This regenerates and PRs the entry exactly as the
automated path does.

## Security notes

- `repository_dispatch` `client_payload` is attacker-settable by anyone
  holding the dispatch token, so the workflow treats `id`/`tag` as untrusted:
  they are passed through `env:` (never interpolated into a shell) and
  strictly validated (`^motrix\.[a-z0-9][a-z0-9-]*$` and a `<id>@<semver>`
  tag) before use.
- Even a validly-shaped but malicious payload cannot publish a bad package:
  the generator downloads only from the `builtin-plugins` releases, verifies
  the pinned-key Ed25519 signature over the `.moext` bytes, and rejects the
  entry unless the signed in-bundle manifest's id/version match the tag.
- Release and restore manifest ETags are opaque cache/object identities, not
  integrity proofs. SHA-256 covers bytes. An ETag is recorded only for an
  observed object state and is never copied forward as the expected ETag of a
  new PutObject result.
