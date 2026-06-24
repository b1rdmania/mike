// Legalise control layer (experiment, NOT for upstream PR)
//
// Per-document, hash-chained audit trail. Each event's hash covers the
// previous event's hash plus this event's fields, so any alteration or
// deletion of a past event breaks every link after it. Append-only.
//
// NOTE (experiment-grade): the chain head is read then written at the app
// layer, so two truly-concurrent events on the SAME document could race the
// head. Tamper-EVIDENCE still holds (a verify pass detects the break); strict
// serialisation would need a DB trigger / WORM (as Legalise does). Events are
// per-document and rarely concurrent, so this is acceptable for the test.

import { createHash } from "crypto";
import type { createServerSupabase } from "./supabase";

type Supa = ReturnType<typeof createServerSupabase>;

/** Deterministic JSON: object keys sorted recursively, so re-hashing a value
 * read back from jsonb yields the same string regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

interface AuditFields {
  documentId: string;
  actorUserId: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  contentSha256?: string | null;
}

function eventHash(prevHash: string, f: AuditFields): string {
  const canonical = stableStringify({
    document_id: f.documentId,
    actor_user_id: f.actorUserId ?? null,
    action: f.action,
    resource_type: f.resourceType ?? null,
    resource_id: f.resourceId ?? null,
    payload: f.payload ?? {},
    content_sha256: f.contentSha256 ?? null,
    prev_hash: prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Append one event to a document's chain. Best-effort: never throws into the
 * caller's request path — a failed audit write is logged, not fatal. */
export async function recordAudit(db: Supa, f: AuditFields): Promise<void> {
  try {
    const { data: head } = await db
      .from("audit_events")
      .select("hash")
      .eq("document_id", f.documentId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevHash = (head?.hash as string | undefined) ?? "";
    const hash = eventHash(prevHash, f);
    const { error } = await db.from("audit_events").insert({
      document_id: f.documentId,
      actor_user_id: f.actorUserId ?? null,
      action: f.action,
      resource_type: f.resourceType ?? null,
      resource_id: f.resourceId ?? null,
      payload: f.payload ?? {},
      content_sha256: f.contentSha256 ?? null,
      prev_hash: prevHash,
      hash,
    });
    if (error) console.error("[audit] insert failed", { action: f.action, error });
  } catch (e) {
    console.error("[audit] record threw", { action: f.action, e });
  }
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  broken_at_seq: number | null;
  reason: string | null;
}

/** Recompute the chain for a document and confirm every link holds. */
export async function verifyAuditChain(
  db: Supa,
  documentId: string,
): Promise<ChainVerification> {
  const { data: rows } = await db
    .from("audit_events")
    .select(
      "seq, action, actor_user_id, resource_type, resource_id, payload, content_sha256, prev_hash, hash",
    )
    .eq("document_id", documentId)
    .order("seq", { ascending: true });

  const events = (rows ?? []) as Array<{
    seq: number;
    action: string;
    actor_user_id: string | null;
    resource_type: string | null;
    resource_id: string | null;
    payload: Record<string, unknown> | null;
    content_sha256: string | null;
    prev_hash: string;
    hash: string;
  }>;

  let prev = "";
  for (const e of events) {
    if (e.prev_hash !== prev) {
      return {
        ok: false,
        count: events.length,
        broken_at_seq: e.seq,
        reason: "prev_hash does not match prior event hash",
      };
    }
    const expected = eventHash(prev, {
      documentId,
      actorUserId: e.actor_user_id,
      action: e.action,
      resourceType: e.resource_type,
      resourceId: e.resource_id,
      payload: e.payload ?? {},
      contentSha256: e.content_sha256,
    });
    if (expected !== e.hash) {
      return {
        ok: false,
        count: events.length,
        broken_at_seq: e.seq,
        reason: "recomputed hash does not match stored hash",
      };
    }
    prev = e.hash;
  }
  return { ok: true, count: events.length, broken_at_seq: null, reason: null };
}
