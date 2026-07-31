# Tamper-Evident Project Export

Mike records a SHA-256 of every document version's bytes at write time, and can
export a per-project manifest listing those hashes alongside the accept/reject
trail. A recipient can then check that the files they were given are the files
the workspace held.

This answers the question a firm asks before it will rely on a tool's output:
*can you show that this is what was reviewed and accepted?*

## What Is Recorded

Mike sets `document_versions.content_sha256` wherever it writes version bytes:
upload, version upload, version replace, copy into a project, assistant edit,
generated documents, and bulk replication. It refreshes the hash when
accept/reject resolution rewrites those bytes in place.

The column is nullable. Versions written before this shipped stay unhashed
until something next rewrites their bytes, and show as `null` in the manifest.
An old file set therefore reads as unverifiable rather than as falsely
verified. Backfilling would mean streaming every stored object out of R2, so
that belongs in a separate opt-in job, not a schema migration.

## Getting a Manifest

```
GET /projects/:projectId/export
```

Same access rules as the rest of the project API, and the same MFA requirement
and export rate limit as the account exports. The response is a JSON
attachment:

```jsonc
{
  "manifest_version": 1,
  "exported_at": "2026-07-31T10:00:00.000Z",
  "project": { "id": "...", "name": "...", "cm_number": "...", "created_at": "..." },
  "documents": [
    {
      "id": "...",
      "status": "ready",
      "current_version_id": "...",
      "created_at": "...",
      "versions": [
        {
          "id": "...",
          "version_number": 1,
          "source": "upload",
          "filename": "lease.docx",
          "file_type": "docx",
          "size_bytes": 24576,
          "content_sha256": "…",
          "deleted_at": null,
          "created_at": "..."
        }
      ],
      "edits": [
        {
          "id": "...",
          "version_id": "...",
          "change_id": "...",
          "status": "accepted",
          "created_at": "...",
          "resolved_at": "..."
        }
      ]
    }
  ],
  "digest": { "algorithm": "sha256", "value": "…" },
  "signature": null
}
```

The edit trail carries references only: change ids and how they were resolved.
It never carries the text of an edit.

## Verifying Files

```bash
shasum -a 256 lease.docx
```

Compare against `content_sha256` for that version. A match means the file is
byte-identical to what Mike stored.

## Verifying the Manifest Itself

File hashes prove nothing if the manifest itself cannot be trusted. `digest`
is a SHA-256 over the manifest body, meaning everything except `digest` and
`signature`. Serialise that body with object keys sorted, arrays left in
order, and no whitespace. Sorting is part of the format, not an implementation
detail, because JSON parsers do not preserve key order.

When `MANIFEST_SIGNING_KEY` is set, `signature` carries an Ed25519 signature
over the digest's raw bytes:

```jsonc
"signature": {
  "algorithm": "ed25519",
  "key_id": "…",         // first 16 hex chars of SHA-256 over the public key
  "public_key": "…",     // raw Ed25519 public key, hex
  "value": "…"           // signature over the digest bytes, hex
}
```

Check the signature against the key the deployment serves, **not** the copy
inside the manifest. Whoever edits a manifest can re-sign it with a key of
their own, so the embedded key is a convenience, not evidence.

```
GET /manifest-signing-key
```

That endpoint needs no authentication, since public keys are public. It
returns `null` on a deployment that does not sign.

`backend/src/lib/manifestSigning.ts` exports
`verifyManifest(manifest, expectedPublicKey)`, which returns one of:

| Verdict | Meaning |
| --- | --- |
| `verified` | Digest matches and the signature checks out against the key you pinned. |
| `self-signed` | Signature checks out against the key inside the manifest, but you pinned none. Not evidence. |
| `unsigned` | Digest matches, but the deployment did not sign. |
| `key-mismatch` | Signed by a key other than the one you pinned. |
| `bad-signature` | Signed, digest intact, signature does not verify. |
| `tampered` | The body does not match its recorded digest. |

Only `verified` means provenance was checked. Calling `verifyManifest` without
`expectedPublicKey` returns `self-signed` even for a perfect signature, because
whoever rewrites a manifest can re-sign it with a key of their own and swap in
the matching public key. That forgery is indistinguishable from the real thing
until you pin a key.

## Enabling Signing

```bash
openssl rand -hex 32
```

Set the result as `MANIFEST_SIGNING_KEY` in `backend/.env` and restart. Use a
dedicated secret, not one shared with `DOWNLOAD_SIGNING_SECRET`.

Signing is optional so that a self-hosted deployment without key custody can
still export. A malformed key fails the export with a clear error instead of
quietly producing an unsigned manifest, which is the failure this feature
exists to prevent.

Rotating the key does not invalidate past exports, but whoever checks one
needs the key that was current when Mike made it. `key_id` says which key that
was. Publish retired public keys if old manifests need to stay checkable.

## Limits

- The manifest attests to bytes and to the accept/reject trail. It is not a
  trusted timestamp: `exported_at` is the server's clock, and nothing here
  proves *when* a document existed. An RFC 3161 timestamp or a transparency
  log would be the next step. Both need infrastructure a self-hosted
  deployment may not have.
- A holder of the signing key can produce a manifest saying anything. The key
  is only as good as the deployment holding it.
- Hashes cover the source bytes, not the converted PDF rendition.
