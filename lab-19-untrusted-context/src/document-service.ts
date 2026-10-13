import type { AclService } from "./acl.js";
import type { DocumentRepository, SourceDocument, SourceRef } from "./document-repository.js";
import type { ForbiddenValue } from "./egress-scan.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export type Freshness = "current" | "stale" | "superseded";

/**
 * The only fields of a document that may enter model context. `projectDocument` builds a new object
 * from exactly these; it never spreads the stored record, so a field added to the record later
 * (or a sensitive one that is already there) cannot ride along.
 */
export const PROJECTED_FIELDS = ["sourceId", "version", "title", "topic", "assertedValue", "updatedAt", "freshness", "body"] as const;

export interface DocumentView {
  sourceId: string;
  version: number;
  title: string;
  topic: string;
  assertedValue?: string;
  updatedAt: string;
  freshness: Freshness;
  body: string;
}

export type Conflict = {
  topic: string;
  sources: Array<SourceRef & { value: string }>;
};

export interface SearchOutcome {
  query: string;
  hits: DocumentView[];
  conflicts: Conflict[];
}

const STALE_AFTER_DAYS = 180;
const MAX_HITS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOPWORDS = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "on", "in", "what", "how", "do", "does", "about", "with", "me", "tell"]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function projectDocument(doc: SourceDocument, now: Date): DocumentView {
  const ageDays = (now.getTime() - Date.parse(doc.updatedAt)) / DAY_MS;
  const freshness: Freshness = doc.supersededBy !== undefined ? "superseded" : ageDays > STALE_AFTER_DAYS ? "stale" : "current";
  const view: DocumentView = {
    sourceId: doc.sourceId,
    version: doc.version,
    title: doc.title,
    topic: doc.topic,
    updatedAt: doc.updatedAt,
    freshness,
    body: doc.body,
  };
  if (doc.assertedValue !== undefined) view.assertedValue = doc.assertedValue;
  return view;
}

/**
 * Caches rendered search outcomes per (tenant, subject, query). A cached entry is trusted only
 * after every hit is re-checked against the live repository and ACL — the cache never stores an
 * access decision, so a revoked source or a new version evicts the entry instead of being served.
 */
export class RetrievalCache {
  private readonly entries = new Map<string, { outcome: SearchOutcome; fingerprint: string }>();

  private static keyFor(context: SecurityContext, query: string): string {
    return JSON.stringify([context.tenantId, context.subject, tokenize(query).sort().join(" ")]);
  }

  /** `fingerprint` describes everything the outcome depended on; `stillValid` re-checks the stored hits themselves. */
  public get(context: SecurityContext, query: string, fingerprint: string, stillValid: (outcome: SearchOutcome) => boolean): SearchOutcome | undefined {
    const key = RetrievalCache.keyFor(context, query);
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    if (cached.fingerprint !== fingerprint || !stillValid(cached.outcome)) {
      this.entries.delete(key);
      return undefined;
    }
    return cached.outcome;
  }

  public set(context: SecurityContext, query: string, fingerprint: string, outcome: SearchOutcome): void {
    this.entries.set(RetrievalCache.keyFor(context, query), { outcome, fingerprint });
  }

  public get size(): number {
    return this.entries.size;
  }
}

export interface DocumentServiceOptions {
  repository: DocumentRepository;
  acl: AclService;
  cache?: RetrievalCache;
  clock?: () => Date;
}

/**
 * Authorized retrieval. The ACL is applied to the candidate set *before* scoring, so an unreadable
 * document contributes nothing: not a hit, not a score, not a count. Every result carries the
 * source identity (`sourceId`, `version`) the answer must cite.
 */
export class DocumentService {
  private readonly repository: DocumentRepository;
  private readonly acl: AclService;
  private readonly cache: RetrievalCache;
  private readonly clock: () => Date;

  public constructor(options: DocumentServiceOptions) {
    this.repository = options.repository;
    this.acl = options.acl;
    this.cache = options.cache ?? new RetrievalCache();
    this.clock = options.clock ?? (() => new Date());
  }

  public get retrievalCache(): RetrievalCache {
    return this.cache;
  }

  public search(context: SecurityContext, query: string): SearchOutcome {
    assertSecurityContext(context);
    const readable = this.repository.listTenant(context.tenantId).filter((doc) => this.acl.canRead(context, doc));
    // The readable set (IDs and versions) is part of what a result depends on: a grant can add a hit or
    // a conflicting sibling, and a cached "no evidence" or "no conflict" would then be false.
    const fingerprint = readable.map((doc) => `${doc.sourceId}@${doc.version}`).sort().join(",");
    const cached = this.cache.get(context, query, fingerprint, (outcome) => this.hitsStillValid(context, outcome));
    if (cached) return cached;

    const tokens = tokenize(query);
    const scored = readable
      .map((doc) => {
        const docTokens = new Set(tokenize(`${doc.title} ${doc.topic.replaceAll("-", " ")} ${doc.body}`));
        return { doc, score: tokens.filter((token) => docTokens.has(token)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.sourceId.localeCompare(b.doc.sourceId))
      .slice(0, MAX_HITS)
      .map((entry) => entry.doc);

    // A source that disagrees with a hit must be shown next to it even if it scored lower.
    const included = new Map(scored.map((doc) => [doc.sourceId, doc]));
    for (const doc of scored) {
      if (doc.assertedValue === undefined) continue;
      for (const sibling of readable) {
        if (sibling.topic === doc.topic && sibling.assertedValue !== undefined) included.set(sibling.sourceId, sibling);
      }
    }

    const now = this.clock();
    const hits = [...included.values()].map((doc) => projectDocument(doc, now));
    const outcome: SearchOutcome = { query, hits, conflicts: detectConflicts(hits) };
    this.cache.set(context, query, fingerprint, outcome);
    return outcome;
  }

  /** Unknown and unreadable are indistinguishable to the caller: both are `undefined`. */
  public read(context: SecurityContext, sourceId: string): DocumentView | undefined {
    assertSecurityContext(context);
    const doc = this.repository.get(context.tenantId, sourceId);
    if (!doc || !this.acl.canRead(context, doc)) return undefined;
    return projectDocument(doc, this.clock());
  }

  /** Is the source this reference names still readable by the caller right now? (Version is not an access question.) */
  public canReadRef(context: SecurityContext, ref: SourceRef): boolean {
    assertSecurityContext(context);
    const doc = this.repository.get(context.tenantId, ref.sourceId);
    return doc !== undefined && this.acl.canRead(context, doc);
  }

  public currentVersion(context: SecurityContext, sourceId: string): number | undefined {
    assertSecurityContext(context);
    return this.repository.get(context.tenantId, sourceId)?.version;
  }

  /**
   * What must not appear in a provider request, an answer, or an outbound payload for this caller
   * *now*: the body and marker of every document they cannot read (any tenant), and every sensitive
   * field of every document (for any caller). This is a detection backstop; the ACL applied before
   * retrieval is what keeps these values out.
   */
  public forbiddenValues(context: SecurityContext): ForbiddenValue[] {
    assertSecurityContext(context);
    const forbidden: ForbiddenValue[] = [];
    for (const doc of this.repository.all()) {
      const label = `${doc.tenantId}/${doc.sourceId}`;
      if (!this.acl.canRead(context, doc)) {
        forbidden.push({ label: `unreadable-source:${label}`, value: doc.body });
        if (doc.marker !== undefined) forbidden.push({ label: `unreadable-source-marker:${label}`, value: doc.marker });
      }
      for (const [field, value] of Object.entries(doc.sensitive)) {
        forbidden.push({ label: `sensitive-field:${field}:${label}`, value });
      }
    }
    return forbidden;
  }

  private hitsStillValid(context: SecurityContext, outcome: SearchOutcome): boolean {
    const now = this.clock();
    return outcome.hits.every((hit) => {
      const doc = this.repository.get(context.tenantId, hit.sourceId);
      return doc !== undefined && doc.version === hit.version && this.acl.canRead(context, doc) && projectDocument(doc, now).freshness === hit.freshness;
    });
  }
}

export function detectConflicts(hits: readonly DocumentView[]): Conflict[] {
  const byTopic = new Map<string, DocumentView[]>();
  for (const hit of hits) {
    if (hit.assertedValue === undefined) continue;
    byTopic.set(hit.topic, [...(byTopic.get(hit.topic) ?? []), hit]);
  }
  const conflicts: Conflict[] = [];
  for (const [topic, group] of byTopic) {
    if (new Set(group.map((hit) => hit.assertedValue)).size < 2) continue;
    conflicts.push({
      topic,
      sources: group.map((hit) => ({ sourceId: hit.sourceId, version: hit.version, value: hit.assertedValue ?? "" })),
    });
  }
  return conflicts;
}
