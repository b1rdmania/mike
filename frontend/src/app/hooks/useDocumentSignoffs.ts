"use client";

import { useCallback, useEffect, useState } from "react";
import {
    getDocumentAudit,
    listSignoffs,
    type AuditEvent,
    type AuditVerification,
    type Signoff,
} from "@/app/lib/mikeApi";

export interface DocumentSignoffsResult {
    signoffs: Signoff[];
    events: AuditEvent[];
    verification: AuditVerification | null;
    loading: boolean;
    error: string | null;
    /** Refetch after a new sign-off lands. */
    refresh: () => void;
}

/**
 * Legalise control layer (experiment). Loads a document's provenance trail
 * (who signed which version) and its hash-chained audit log, including whether
 * the chain still verifies.
 */
export function useDocumentSignoffs(
    documentId: string | null | undefined,
): DocumentSignoffsResult {
    const [signoffs, setSignoffs] = useState<Signoff[]>([]);
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [verification, setVerification] =
        useState<AuditVerification | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick((t) => t + 1), []);

    useEffect(() => {
        if (!documentId) {
            setSignoffs([]);
            setEvents([]);
            setVerification(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);

        (async () => {
            try {
                const [signoffData, auditData] = await Promise.all([
                    listSignoffs(documentId),
                    getDocumentAudit(documentId),
                ]);
                if (cancelled) return;
                setSignoffs(signoffData.signoffs ?? []);
                setEvents(auditData.events ?? []);
                setVerification(auditData.verification ?? null);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [documentId, tick]);

    return { signoffs, events, verification, loading, error, refresh };
}
