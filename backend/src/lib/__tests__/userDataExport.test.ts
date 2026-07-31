import { afterEach, describe, expect, it } from "vitest";
import { buildProjectExportManifest } from "../userDataExport";

afterEach(() => {
    delete process.env.MANIFEST_SIGNING_KEY;
});

describe("buildProjectExportManifest", () => {
    it("uses id as a stable tiebreaker for every paginated project query", async () => {
        const rows: Record<string, unknown> = {
            projects: {
                id: "p1",
                name: "Alpha",
                cm_number: null,
                created_at: "2026-01-01T00:00:00.000Z",
            },
            documents: [
                {
                    id: "d1",
                    project_id: "p1",
                    status: "ready",
                    current_version_id: "v1",
                    created_at: "2026-01-02T00:00:00.000Z",
                },
            ],
            document_versions: [
                {
                    id: "v1",
                    document_id: "d1",
                    version_number: 1,
                    source: "upload",
                    filename: "lease.docx",
                    file_type: "docx",
                    size_bytes: 12,
                    content_sha256: "a".repeat(64),
                    deleted_at: null,
                    created_at: "2026-01-02T00:00:00.000Z",
                },
            ],
            document_edits: [],
        };
        const orders: Array<{ table: string; column: string }> = [];

        const db = {
            from(table: string) {
                const query: Record<string, unknown> = {};
                for (const method of ["select", "range", "eq", "in"]) {
                    query[method] = () => query;
                }
                query.order = (column: string) => {
                    orders.push({ table, column });
                    return query;
                };
                query.single = () =>
                    Promise.resolve({ data: rows[table] ?? null, error: null });
                query.then = (
                    resolve: (value: unknown) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve({
                        data: rows[table] ?? [],
                        error: null,
                    }).then(resolve, reject);
                return query;
            },
        };

        await buildProjectExportManifest(db as never, "p1");

        for (const table of [
            "documents",
            "document_versions",
            "document_edits",
        ]) {
            expect(
                orders
                    .filter((order) => order.table === table)
                    .map((order) => order.column),
            ).toEqual(["created_at", "id"]);
        }
    });
});
