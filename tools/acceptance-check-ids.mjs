/**
 * The operation-conformance check sets, as one definition.
 *
 * These lists were previously duplicated between the runner that produces the artifact and
 * the packaging policy that validates it. Adding a check therefore silently broke packaging
 * until someone remembered the second copy — which is exactly what happened when the matrix
 * grew from v1 to v2. This module exists so there is one list and no side effects on import;
 * the runner cannot be imported for the purpose, because importing it runs the suite.
 *
 * Both arrays are sorted, because both consumers compare them against a sorted set of
 * observed ids.
 */

export const READ_ONLY_ACCEPTANCE_CHECK_IDS = Object.freeze([
  "compose-project-conformance",
  "container-inspect-stats",
  "core-handshake",
  "image-scout-report",
  "installed-command-inventory",
  "literal-cli-run",
  "literal-pipes-session",
  "long-lived-session",
  "pinned-cli-run",
  "pinned-pipes-session",
  "snapshot-list-conformance",
]);

export const MUTATION_ACCEPTANCE_CHECK_IDS = Object.freeze([
  "compose-lifecycle",
  "container-export-archive",
  "container-lifecycle",
  "dind-isolation",
  "image-prune-all",
  "image-prune-dangling",
  "image-pull-session",
  "image-remove-one-tag",
  "image-save-load-roundtrip",
  "image-tag-action",
  "pty-session",
  "volume-file-browse",
  "volume-prune-all",
  "volume-prune-default",
  "volume-remove-exact",
]);

/**
 * Checks that may legitimately report `skipped` rather than `passed`.
 *
 * Compose and Scout are optional Docker CLI plugins, so a release machine can genuinely lack
 * them and blocking the release for that would be wrong. Every OTHER check must pass: a skip
 * elsewhere means the matrix did not exercise something it claims to cover, which is the
 * failure mode that let a session-cancellation defect through eighteen passing checks.
 *
 * A permitted skip is still not a pass. The runner records it in `skippedChecks` and counts it
 * separately, and the packaging policy requires that record to be present and consistent, so a
 * skip is always visible to whoever signs the release off.
 */
export const SKIPPABLE_ACCEPTANCE_CHECK_IDS = Object.freeze([
  "compose-lifecycle",
  "compose-project-conformance",
  "image-scout-report",
]);

export const ACCEPTANCE_SCHEMA_VERSION = 3;
export const ACCEPTANCE_MATRIX_VERSION = 2;
