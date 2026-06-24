"use client";

/**
 * Legalise control layer (experiment — NOT upstream Mike).
 *
 * The sign-off + provenance surface for a single document version. Three jobs:
 *   1. Let a named human stand behind the selected version (signed /
 *      signed-with-observations / rejected). The server forces
 *      `signer_is_author = false` for AI-drafted versions, so the UI says so up
 *      front: you sign as reviewer, never as author of machine-written text.
 *   2. Show the provenance trail — every sign-off recorded against the doc.
 *   3. Show the hash-chained audit log and whether it still verifies.
 */

import { useState } from "react";
import {
    AlertTriangle,
    Check,
    Loader2,
    PenLine,
    ShieldCheck,
    X,
} from "lucide-react";
import {
    signOffVersion,
    type SignoffDecision,
} from "@/app/lib/mikeApi";
import { useDocumentSignoffs } from "@/app/hooks/useDocumentSignoffs";
import { cn } from "@/lib/utils";

const MACHINE_AUTHORED = new Set(["generated", "assistant_edit"]);

const DECISION_OPTIONS: {
    value: SignoffDecision;
    label: string;
    badge: string;
}[] = [
    {
        value: "signed",
        label: "Sign off",
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
    },
    {
        value: "signed_with_observations",
        label: "Sign with observations",
        badge: "border-amber-200 bg-amber-50 text-amber-700",
    },
    {
        value: "rejected",
        label: "Reject",
        badge: "border-red-200 bg-red-50 text-red-700",
    },
];

function decisionBadge(decision: SignoffDecision) {
    return (
        DECISION_OPTIONS.find((o) => o.value === decision)?.badge ??
        "border-gray-200 bg-gray-50 text-gray-600"
    );
}

function decisionLabel(decision: SignoffDecision) {
    return DECISION_OPTIONS.find((o) => o.value === decision)?.label ?? decision;
}

interface Props {
    documentId: string;
    selectedVersionId: string | null;
    selectedVersionNumber: number | null;
    selectedVersionSource: string | null;
    /** Disabled for users without write access (shared, read-only). */
    canSign?: boolean;
}

export function DocumentSignoffPanel({
    documentId,
    selectedVersionId,
    selectedVersionNumber,
    selectedVersionSource,
    canSign = true,
}: Props) {
    const { signoffs, events, verification, loading, error, refresh } =
        useDocumentSignoffs(documentId);

    const [decision, setDecision] = useState<SignoffDecision>("signed");
    const [note, setNote] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const machineAuthored = MACHINE_AUTHORED.has(selectedVersionSource ?? "");
    const versionLabel =
        selectedVersionNumber != null ? `V${selectedVersionNumber}` : "version";

    async function handleSubmit() {
        if (!selectedVersionId) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            await signOffVersion(
                documentId,
                selectedVersionId,
                decision,
                note.trim() || undefined,
            );
            setNote("");
            setDecision("signed");
            refresh();
        } catch (e) {
            setSubmitError(
                e instanceof Error ? e.message : "Could not record sign-off.",
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-gray-900">
                <PenLine className="h-3.5 w-3.5 text-gray-500" />
                Sign-off &amp; provenance
            </div>

            {/* Sign-off action for the selected version */}
            <div className="rounded-xl border border-white/70 bg-white px-3 py-2.5 shadow-[0_1px_4px_rgba(15,23,42,0.045)]">
                {selectedVersionId ? (
                    <>
                        <div className="mb-1.5 text-[11px] text-gray-500">
                            Stand behind{" "}
                            <span className="font-medium text-gray-700">
                                {versionLabel}
                            </span>
                        </div>
                        {machineAuthored && (
                            <div className="mb-2 flex items-start gap-1.5 rounded-md bg-blue-50 px-2 py-1.5 text-[11px] leading-snug text-blue-700">
                                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                                <span>
                                    AI-drafted version. You sign as the{" "}
                                    <strong>reviewer</strong>, not the author —
                                    nobody is recorded as author of machine-written
                                    text.
                                </span>
                            </div>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                            {DECISION_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setDecision(opt.value)}
                                    disabled={!canSign || submitting}
                                    className={cn(
                                        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                        decision === opt.value
                                            ? opt.badge
                                            : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50",
                                    )}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                        <textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            disabled={!canSign || submitting}
                            placeholder={
                                decision === "signed_with_observations"
                                    ? "Note your observations (recommended)…"
                                    : "Optional note…"
                            }
                            rows={2}
                            className="mt-2 w-full resize-none rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-700 placeholder:text-gray-300 focus:border-blue-300 focus:outline-none disabled:opacity-50"
                        />
                        {submitError && (
                            <div className="mt-1.5 text-[11px] text-red-600">
                                {submitError}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={!canSign || submitting}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {submitting ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <PenLine className="h-3 w-3" />
                            )}
                            Record {decisionLabel(decision).toLowerCase()}
                        </button>
                        {!canSign && (
                            <div className="mt-1.5 text-[11px] text-gray-400">
                                Read-only access — you can&apos;t record a
                                sign-off.
                            </div>
                        )}
                    </>
                ) : (
                    <div className="py-1 text-[11px] text-gray-400">
                        Select a version to sign off.
                    </div>
                )}
            </div>

            {/* Provenance trail */}
            <div>
                <div className="mb-1 text-[11px] font-medium text-gray-500">
                    Provenance trail
                </div>
                {loading && signoffs.length === 0 ? (
                    <div className="py-1 text-[11px] text-gray-400">Loading…</div>
                ) : signoffs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-[11px] text-gray-400">
                        No sign-offs yet.
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {signoffs.map((s) => (
                            <div
                                key={s.id}
                                className="rounded-lg border border-white/70 bg-white px-3 py-2 shadow-[0_1px_4px_rgba(15,23,42,0.045)]"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span
                                        className={cn(
                                            "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                                            decisionBadge(s.decision),
                                        )}
                                    >
                                        {decisionLabel(s.decision)}
                                    </span>
                                    <span className="text-[10px] text-gray-400">
                                        {new Date(s.signed_at).toLocaleString()}
                                    </span>
                                </div>
                                <div className="mt-1 truncate text-[11px] text-gray-700">
                                    {s.signer_email ?? "Unknown signer"}
                                    <span className="text-gray-400">
                                        {" · "}
                                        {s.signer_is_author
                                            ? "author"
                                            : "reviewer"}
                                    </span>
                                </div>
                                {s.note && (
                                    <div className="mt-1 text-[11px] italic text-gray-500">
                                        “{s.note}”
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Tamper-evident audit trail */}
            <div>
                <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-gray-500">
                        Audit trail
                    </span>
                    {verification && (
                        <span
                            className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                                verification.ok
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-red-200 bg-red-50 text-red-700",
                            )}
                            title={
                                verification.ok
                                    ? `Hash chain verified across ${verification.count} event(s)`
                                    : verification.reason ??
                                      "Hash chain broken"
                            }
                        >
                            {verification.ok ? (
                                <ShieldCheck className="h-3 w-3" />
                            ) : (
                                <X className="h-3 w-3" />
                            )}
                            {verification.ok
                                ? "Chain verified"
                                : `Broken @ ${verification.broken_at_seq ?? "?"}`}
                        </span>
                    )}
                </div>
                {error ? (
                    <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-600">
                        {error}
                    </div>
                ) : events.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-[11px] text-gray-400">
                        No recorded events.
                    </div>
                ) : (
                    <ol className="space-y-1">
                        {events.map((e) => (
                            <li
                                key={e.seq}
                                className="flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5"
                            >
                                <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-[11px] font-medium text-gray-700">
                                            {e.action}
                                        </span>
                                        <span className="shrink-0 text-[10px] text-gray-400">
                                            #{e.seq}
                                        </span>
                                    </div>
                                    <div className="truncate font-mono text-[10px] text-gray-400">
                                        {e.hash.slice(0, 16)}…
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </div>
    );
}
