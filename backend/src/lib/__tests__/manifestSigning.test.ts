import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import {
    canonicalize,
    digestManifestBody,
    manifestPublicKey,
    sealManifest,
    verifyManifest,
} from "../manifestSigning";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);

function withKey(hex: string | null) {
    if (hex === null) delete process.env.MANIFEST_SIGNING_KEY;
    else process.env.MANIFEST_SIGNING_KEY = hex;
}

afterEach(() => {
    delete process.env.MANIFEST_SIGNING_KEY;
});

const BODY = {
    manifest_version: 1,
    exported_at: "2026-07-31T10:00:00.000Z",
    project: { id: "p1", name: "Alpha" },
    documents: [
        {
            id: "d1",
            versions: [{ id: "v1", content_sha256: "a".repeat(64) }],
        },
    ],
};

describe("canonicalize", () => {
    it("sorts object keys so parse order cannot change the digest", () => {
        expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
        expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    });

    it("sorts nested keys but preserves array order", () => {
        expect(canonicalize({ x: [{ b: 1, a: 2 }, 3] })).toBe(
            '{"x":[{"a":2,"b":1},3]}',
        );
        expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    });

    it("emits no whitespace", () => {
        expect(canonicalize(BODY)).not.toMatch(/\s/);
    });

    it("keeps nulls and drops undefined members", () => {
        expect(canonicalize({ a: null, b: undefined, c: 1 })).toBe(
            '{"a":null,"c":1}',
        );
    });

    it("round-trips through JSON without changing the digest", () => {
        const reparsed = JSON.parse(JSON.stringify(BODY));
        expect(digestManifestBody(reparsed).value).toBe(
            digestManifestBody(BODY).value,
        );
    });
});

describe("sealManifest without a key", () => {
    it("reports no signing key", () => {
        withKey(null);
        expect(manifestPublicKey()).toBeNull();
    });

    it("still attaches a digest, with a null signature", () => {
        withKey(null);
        const sealed = sealManifest(BODY);
        expect(sealed.signature).toBeNull();
        expect(sealed.digest.algorithm).toBe("sha256");
        expect(sealed.digest.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("verifies the digest but reports the manifest as unsigned", () => {
        withKey(null);
        expect(verifyManifest(sealManifest(BODY))).toBe("unsigned");
    });

    it("reports an unsigned manifest whose body was edited as tampered", () => {
        withKey(null);
        const sealed = sealManifest(BODY);
        expect(
            verifyManifest({ ...sealed, exported_at: "1999-01-01T00:00:00Z" }),
        ).toBe("tampered");
    });
});

describe("sealManifest with a key", () => {
    it("reports a good signature checked against no pinned key as self-signed", () => {
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        expect(sealed.signature?.algorithm).toBe("ed25519");
        expect(verifyManifest(sealed)).toBe("self-signed");
    });

    it("never returns verified for a manifest forged with the attacker's own key", () => {
        // The attack the `verified`/`self-signed` split exists to stop: rewrite
        // the evidence, re-seal with a key you control, swap in your public
        // key. An unpinned check cannot tell this from the real thing, so it
        // must not call it verified.
        withKey(KEY_A);
        const real = sealManifest(BODY);
        withKey(KEY_B);
        const forged = sealManifest({
            ...BODY,
            documents: [
                { id: "d1", versions: [{ id: "v1", content_sha256: "9".repeat(64) }] },
            ],
        });

        expect(verifyManifest(forged)).toBe("self-signed");
        expect(verifyManifest(forged, real.signature!.public_key)).toBe(
            "key-mismatch",
        );
    });

    it("verifies against the public key served out of band", () => {
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        const published = manifestPublicKey()!;
        expect(sealed.signature!.public_key).toBe(published.public_key);
        expect(sealed.signature!.key_id).toBe(published.key_id);
        expect(verifyManifest(sealed, published.public_key)).toBe("verified");
    });

    it("is deterministic for the same body and key", () => {
        withKey(KEY_A);
        const a = sealManifest({ ...BODY });
        const b = sealManifest({ ...BODY });
        expect(a.digest.value).toBe(b.digest.value);
        expect(a.signature!.value).toBe(b.signature!.value);
    });

    it("rejects a manifest whose body was edited after signing", () => {
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        const tampered = {
            ...sealed,
            documents: [
                {
                    id: "d1",
                    versions: [{ id: "v1", content_sha256: "b".repeat(64) }],
                },
            ],
        };
        expect(verifyManifest(tampered)).toBe("tampered");
    });

    it("rejects a manifest re-digested by an editor without the key", () => {
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        withKey(null);

        // Attacker rewrites the body and recomputes the digest to match, but
        // cannot produce a signature over the new digest.
        const { digest: _d, signature, ...body } = sealed;
        const forgedBody = { ...body, exported_at: "2020-01-01T00:00:00.000Z" };
        const forged = {
            ...forgedBody,
            digest: digestManifestBody(forgedBody),
            signature,
        };

        expect(verifyManifest(forged)).toBe("bad-signature");
    });

    it("flags a signature made by a different key than the expected one", () => {
        withKey(KEY_B);
        const sealed = sealManifest(BODY);
        withKey(KEY_A);
        const expected = manifestPublicKey()!.public_key;

        expect(verifyManifest(sealed, expected)).toBe("key-mismatch");
    });

    it("rejects a corrupted signature value", () => {
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        const flipped = Buffer.from(sealed.signature!.value, "hex");
        flipped[0] ^= 0xff;
        expect(
            verifyManifest({
                ...sealed,
                signature: { ...sealed.signature!, value: flipped.toString("hex") },
            }),
        ).toBe("bad-signature");
    });

    it("produces a signature a plain Ed25519 verifier accepts", () => {
        // Guards the wire format: the value is a raw Ed25519 signature over
        // the digest's bytes, verifiable without any of this module's code.
        withKey(KEY_A);
        const sealed = sealManifest(BODY);
        const spki = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(sealed.signature!.public_key, "hex"),
        ]);
        const ok = crypto.verify(
            null,
            Buffer.from(sealed.digest.value, "hex"),
            crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
            Buffer.from(sealed.signature!.value, "hex"),
        );
        expect(ok).toBe(true);
    });
});

describe("malformed MANIFEST_SIGNING_KEY", () => {
    it("throws rather than silently exporting unsigned manifests", () => {
        withKey("not-hex");
        expect(() => sealManifest(BODY)).toThrow(/MANIFEST_SIGNING_KEY/);
        expect(() => manifestPublicKey()).toThrow(/MANIFEST_SIGNING_KEY/);
    });

    it("throws on a hex key of the wrong length", () => {
        withKey("ab".repeat(16));
        expect(() => sealManifest(BODY)).toThrow(/32-byte hex/);
    });
});
