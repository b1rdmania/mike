import crypto from "crypto";

/**
 * Ed25519 signing for tamper-evident export manifests.
 *
 * A manifest already carries a SHA-256 per document version, which proves an
 * exported file has not changed *if you trust the manifest*. Signing closes
 * that gap: the manifest's own digest is signed with a server-held key, so a
 * recipient holding the deployment's public key can tell an untouched manifest
 * from an edited one.
 *
 * Optional by design. Mike self-hosts, and a deployment that has not set up a
 * key should still be able to export — it just gets `signature: null` and the
 * weaker guarantee. Set MANIFEST_SIGNING_KEY to turn signing on; a malformed
 * key throws rather than silently downgrading to unsigned, because a manifest
 * that is quietly unsigned is the failure this feature exists to prevent.
 *
 * Key material is a raw 32-byte Ed25519 seed, hex-encoded, matching the
 * `openssl rand -hex 32` pattern already used for DOWNLOAD_SIGNING_SECRET.
 */

// PKCS#8 / SPKI DER prefixes for Ed25519 (RFC 8410). Node will not build a key
// object from bare 32-byte key material, so it is wrapped in the fixed DER
// envelope first. Ed25519 seeds and public keys are both 32 bytes.
const PKCS8_ED25519_PREFIX = Buffer.from(
    "302e020100300506032b657004220420",
    "hex",
);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_HEX_CHARS = 128;

/**
 * Domain separation. The signature covers this context string and a NUL byte
 * before the digest, so a signature made here can never be replayed as one
 * over some other object that happens to hash to the same 32 bytes. Bump the
 * version suffix if the signed payload's shape ever changes.
 */
const SIGNING_CONTEXT = "mike-project-manifest-v1";

function signedPayload(digestHex: string): Buffer {
    return Buffer.concat([
        Buffer.from(`${SIGNING_CONTEXT}\0`, "utf8"),
        Buffer.from(digestHex, "hex"),
    ]);
}

export interface ManifestSignature {
    algorithm: "ed25519";
    /** First 16 hex chars of SHA-256 over the raw public key. Rotation aid. */
    key_id: string;
    /** Raw Ed25519 public key, hex. Convenience only — see verifyManifest. */
    public_key: string;
    /** Signature over SIGNING_CONTEXT + NUL + the raw digest bytes, hex. */
    value: string;
}

export interface ManifestDigest {
    algorithm: "sha256";
    value: string;
}

export interface SigningIdentity {
    algorithm: "ed25519";
    key_id: string;
    public_key: string;
}

function seedFromEnv(): Buffer | null {
    const raw = process.env.MANIFEST_SIGNING_KEY?.trim();
    if (!raw) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
            "MANIFEST_SIGNING_KEY must be a 32-byte hex string " +
                "(generate with `openssl rand -hex 32`). Unset it to export " +
                "unsigned manifests.",
        );
    }
    return Buffer.from(raw, "hex");
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
    return crypto.createPublicKey({
        key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
        format: "der",
        type: "spki",
    });
}

function keyIdFromRawPublicKey(raw: Buffer): string {
    return crypto
        .createHash("sha256")
        .update(raw)
        .digest("hex")
        .slice(0, 16);
}

/**
 * The configured signing key, or null when signing is off. Both signing and
 * key publication go through here so they cannot disagree about the key id.
 */
function signingKey(): {
    privateKey: crypto.KeyObject;
    identity: SigningIdentity;
} | null {
    const seed = seedFromEnv();
    if (!seed) return null;

    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    const spki = crypto.createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
    }) as Buffer;
    const publicKeyRaw = spki.subarray(spki.length - ED25519_KEY_BYTES);

    return {
        privateKey,
        identity: {
            algorithm: "ed25519",
            key_id: keyIdFromRawPublicKey(publicKeyRaw),
            public_key: publicKeyRaw.toString("hex"),
        },
    };
}

/**
 * The deployment's manifest public key, or null when signing is off. Served
 * over HTTP so a recipient can get the key from the deployment rather than
 * trusting the copy inside the manifest they were handed.
 */
export function manifestPublicKey(): SigningIdentity | null {
    return signingKey()?.identity ?? null;
}

/**
 * Deterministic JSON: object keys sorted, no whitespace.
 *
 * A verifier holding only the parsed manifest has to recompute the same
 * digest, and JSON parsers do not preserve key order. Sorting is therefore
 * part of the format, not an implementation detail. (RFC 8785 in spirit; the
 * manifest holds no floats, so that spec's number rules do not bite.)
 */
export function canonicalize(value: unknown): string {
    // NaN and Infinity both stringify to "null", which would let two different
    // bodies share a digest. Nothing in a manifest is a float, so this is a
    // guard rather than a live concern, but a digest collision is the one
    // thing canonicalisation must not permit.
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Manifest bodies must hold finite numbers");
    }
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

    return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
}

/** SHA-256 over the canonical form of the manifest body. */
export function digestManifestBody(body: unknown): ManifestDigest {
    return {
        algorithm: "sha256",
        value: crypto
            .createHash("sha256")
            .update(canonicalize(body), "utf8")
            .digest("hex"),
    };
}

/**
 * Attach `digest` and `signature` to a manifest body.
 *
 * The digest covers the body only — neither `digest` nor `signature` is an
 * input to itself. The signature is over a context string, a NUL byte, and
 * then the digest's raw bytes; see SIGNING_CONTEXT.
 */
export function sealManifest<T extends Record<string, unknown>>(
    body: T,
): T & { digest: ManifestDigest; signature: ManifestSignature | null } {
    const digest = digestManifestBody(body);
    const key = signingKey();
    if (!key) return { ...body, digest, signature: null };

    return {
        ...body,
        digest,
        signature: {
            ...key.identity,
            value: crypto
                .sign(null, signedPayload(digest.value), key.privateKey)
                .toString("hex"),
        },
    };
}

/**
 * What a manifest is worth. One verdict rather than a set of flags, so states
 * that cannot happen together cannot be represented.
 */
export type ManifestVerdict =
    /** Digest matches and the signature checks out against a pinned key. */
    | "verified"
    /**
     * Signature checks out against the key carried inside the manifest, but
     * the caller pinned no key to compare it with. This is NOT evidence:
     * whoever rewrites a manifest can re-sign it with a key of their own and
     * land here. Only `verified` means provenance was checked.
     */
    | "self-signed"
    /** Digest matches, but the deployment did not sign the manifest. */
    | "unsigned"
    /** Signed by a key other than the one expected. */
    | "key-mismatch"
    /** Signed, digest intact, but the signature does not verify. */
    | "bad-signature"
    /** The body does not match its recorded digest. */
    | "tampered";

/**
 * Check a sealed manifest.
 *
 * Pass `expectedPublicKey` (hex) from `GET /manifest-signing-key` or another
 * out-of-band source. That is the only way to get `verified`. Called without
 * one, a good signature returns `self-signed` instead, because checking a
 * manifest against a key it supplies itself proves only that its author owned
 * some key — never which one.
 */
export function verifyManifest(
    manifest: Record<string, unknown>,
    expectedPublicKey?: string,
): ManifestVerdict {
    const { digest, signature, ...body } = manifest as {
        digest?: ManifestDigest;
        signature?: ManifestSignature | null;
    } & Record<string, unknown>;

    let bodyDigest: ManifestDigest;
    try {
        bodyDigest = digestManifestBody(body);
    } catch {
        return "tampered";
    }

    if (
        !digest ||
        typeof digest !== "object" ||
        digest.algorithm !== "sha256" ||
        typeof digest.value !== "string" ||
        !/^[0-9a-f]{64}$/.test(digest.value) ||
        digest.value !== bodyDigest.value
    ) {
        return "tampered";
    }

    if (signature == null) return "unsigned";
    if (
        typeof signature !== "object" ||
        signature.algorithm !== "ed25519" ||
        typeof signature.public_key !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(signature.public_key) ||
        typeof signature.value !== "string" ||
        !new RegExp(`^[0-9a-fA-F]{${ED25519_SIGNATURE_HEX_CHARS}}$`).test(
            signature.value,
        )
    ) {
        return "bad-signature";
    }

    const hasExpectedKey = expectedPublicKey !== undefined;
    const expected = expectedPublicKey?.trim().toLowerCase();
    if (hasExpectedKey && (!expected || !/^[0-9a-f]{64}$/.test(expected))) {
        return "bad-signature";
    }

    const embeddedKey = signature.public_key.toLowerCase();
    if (expected && expected !== embeddedKey) {
        return "key-mismatch";
    }
    const keyHex = expected ?? embeddedKey;

    try {
        const ok = crypto.verify(
            null,
            signedPayload(digest.value),
            publicKeyFromRaw(Buffer.from(keyHex, "hex")),
            Buffer.from(signature.value, "hex"),
        );
        if (!ok) return "bad-signature";
        return hasExpectedKey ? "verified" : "self-signed";
    } catch {
        return "bad-signature";
    }
}
