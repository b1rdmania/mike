# Tamper-Evident Project Export

Mike records a SHA-256 digest whenever it writes document-version bytes and
exports those hashes with the accept/reject trail. This proves file integrity
relative to the manifest; signing also lets a holder of the deployment's public
key verify the manifest's provenance.

`GET /projects/:projectId/export` uses the same project-member access check as
the rest of the project API, requires MFA when enrolled, and shares the
account-export rate limit.

Each version includes its filename, metadata, and `content_sha256`; edits
include identifiers and resolution status, never edit text. Compare a supplied
file using `shasum -a 256 lease.docx`.

Versions created before hashing was deployed retain a `null` digest until their
bytes are rewritten. They are unverifiable, not falsely verified.

## Manifest verification

`digest` is SHA-256 over the manifest body (everything except `digest` and
`signature`). Canonical serialization sorts object keys, preserves array order,
and emits no whitespace. Only JSON values are accepted.

When `MANIFEST_SIGNING_KEY` is set, `signature` carries an Ed25519 signature
plus the raw public key and a short key id. The signature covers the context
string `mike-project-manifest-v1`, a NUL byte, and then the digest bytes. That
prefix keeps one signing key usable for other object types later without a
signature from one context passing as a signature from another. Pin the public
key from `GET /manifest-signing-key` rather than the manifest.

Never trust only the key embedded in the manifest: an editor can replace the
body and re-sign it with their own key. `verifyManifest(manifest,
expectedPublicKey)` returns:

| Verdict         | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| `verified`      | Digest and signature match the pinned key.               |
| `self-signed`   | Signature is valid, but no key was pinned; not evidence. |
| `unsigned`      | Digest matches, but no signature is present.             |
| `key-mismatch`  | The embedded key differs from the pinned key.            |
| `bad-signature` | The signature envelope or signature is invalid.          |
| `tampered`      | The body does not match the recorded digest.             |

Only `verified` establishes provenance.

Generate a signing seed with `openssl rand -hex 32` and set it as
`MANIFEST_SIGNING_KEY`. A malformed key fails export rather than silently
downgrading to unsigned. Retain retired public keys if old manifests must remain
verifiable after rotation.

## Limits

- Nothing backfills rows written before this shipped.
- `exported_at` is the server clock, not a trusted timestamp.
- Anyone holding the signing key can create a valid manifest.
- Hashes cover source bytes, not converted PDF renditions.
- The manifest builds in memory, as the account exports already do.
