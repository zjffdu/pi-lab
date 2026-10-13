import { readFileSync } from "node:fs";

import { ROLES, type Role } from "./directory.js";

/** A source identity as the model, the citations, and the provenance records see it. */
/** A type alias, not an interface: it is stored in tool `details`, which must be assignable to pi-durable's `JsonObject`. */
export type SourceRef = {
  sourceId: string;
  version: number;
};

export interface DocumentAcl {
  roles: Role[];
  subjects: string[];
}

export interface SourceDocument {
  tenantId: string;
  sourceId: string;
  version: number;
  title: string;
  /** Slug used to detect two sources disagreeing about the same thing. */
  topic: string;
  /** What this source asserts about `topic`, when it asserts a single value. */
  assertedValue?: string;
  updatedAt: string;
  supersededBy?: string;
  acl: DocumentAcl;
  body: string;
  /**
   * A distinctive token that appears in `body`. It lets a detector recognize the document even when
   * only part of it is quoted; it is never the isolation mechanism.
   */
  marker?: string;
  /** Fields that must never reach a provider, a client, or an outbound tool, for any principal. */
  sensitive: Record<string, string>;
}

const ID = /^[A-Za-z0-9._-]+$/;
const SLUG = /^[a-z0-9-]+$/;
const isString = (value: unknown): value is string => typeof value === "string";

function isDocument(value: unknown): value is SourceDocument {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  const acl = d.acl as Record<string, unknown> | undefined;
  return (
    isString(d.tenantId) &&
    isString(d.sourceId) &&
    ID.test(d.sourceId) &&
    typeof d.version === "number" &&
    Number.isInteger(d.version) &&
    isString(d.title) &&
    isString(d.topic) &&
    SLUG.test(d.topic) &&
    (d.assertedValue === undefined || (isString(d.assertedValue) && SLUG.test(d.assertedValue))) &&
    isString(d.updatedAt) &&
    !Number.isNaN(Date.parse(d.updatedAt)) &&
    (d.supersededBy === undefined || (isString(d.supersededBy) && ID.test(d.supersededBy))) &&
    typeof acl === "object" &&
    acl !== null &&
    Array.isArray(acl.roles) &&
    acl.roles.every((role) => (ROLES as readonly unknown[]).includes(role)) &&
    Array.isArray(acl.subjects) &&
    acl.subjects.every(isString) &&
    isString(d.body) &&
    (d.marker === undefined || isString(d.marker)) &&
    typeof d.sensitive === "object" &&
    d.sensitive !== null &&
    Object.values(d.sensitive).every(isString)
  );
}

/** Runtime-validated load of `data/documents.json`. Slugs and IDs are constrained so they are safe to echo into markup. */
export function loadDocuments(): SourceDocument[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../data/documents.json", import.meta.url), "utf8"));
  const documents = (parsed as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents) || !documents.every(isDocument)) throw new Error("data/documents.json has an invalid documents array");
  return documents;
}

const key = (tenantId: string, sourceId: string): string => JSON.stringify([tenantId, sourceId]);

/**
 * The raw document store. It knows nothing about principals: every read path that serves a model or
 * a client goes through `DocumentService`, which applies the ACL first. The mutators exist so a test
 * or demo can revoke access or publish a new version after content has entered a conversation.
 */
export class DocumentRepository {
  private readonly docs = new Map<string, SourceDocument>();

  public constructor(documents: readonly SourceDocument[]) {
    for (const doc of documents) this.docs.set(key(doc.tenantId, doc.sourceId), structuredClone(doc));
  }

  public static fromDefaultFixture(): DocumentRepository {
    return new DocumentRepository(loadDocuments());
  }

  public get(tenantId: string, sourceId: string): SourceDocument | undefined {
    return this.docs.get(key(tenantId, sourceId));
  }

  public listTenant(tenantId: string): SourceDocument[] {
    return [...this.docs.values()].filter((doc) => doc.tenantId === tenantId);
  }

  public all(): SourceDocument[] {
    return [...this.docs.values()];
  }

  public setAcl(tenantId: string, sourceId: string, acl: DocumentAcl): void {
    const doc = this.docs.get(key(tenantId, sourceId));
    if (!doc) throw new Error(`No document ${sourceId} in ${tenantId}`);
    doc.acl = { roles: [...acl.roles], subjects: [...acl.subjects] };
  }

  public publishVersion(tenantId: string, sourceId: string, change: { body: string; updatedAt: string }): number {
    const doc = this.docs.get(key(tenantId, sourceId));
    if (!doc) throw new Error(`No document ${sourceId} in ${tenantId}`);
    doc.version += 1;
    doc.body = change.body;
    doc.updatedAt = change.updatedAt;
    return doc.version;
  }
}
