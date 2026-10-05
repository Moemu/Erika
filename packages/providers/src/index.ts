/** GitHub DataProvider: snapshot TTL + SWR, ETag conditional revalidation, single-flight,
 * negative cache for not-found, transient short cache via per-repo exponential
 * backoff, upstream Retry-After honored exactly, primary-quota global pause,
 * bounded maps, and a hard private-repo rejection. */

export interface RepoData {
  fullName: string;
  name: string;
  description: string | null;
  stargazersCount?: number;
  forksCount?: number;
  openIssuesCount?: number;
  /** latest release tag (lazy: only fetched when a template displays it) */
  releaseTag?: string | null;
  licenseSpdxId?: string | null;
  language?: string | null;
  /** Latest code push timestamp from GitHub's pushed_at. */
  pushedAt?: string | null;
  avatarUrl?: string;
  defaultBranch?: string;
  private: boolean;
}

export type Freshness = "fresh" | "stale";

export interface RepoSnapshot {
  data: RepoData;
  freshness: Freshness;
  /** data content version -- render cache key component */
  version: string;
}

export class NotFoundError extends Error {
  constructor(public repoKey: string) {
    super(`repository not found (or private): ${repoKey}`);
    this.name = "NotFoundError";
  }
}

export type UpstreamKind = "rate-limited" | "transient" | "stale-expired";

export class UpstreamError extends Error {
  constructor(
    public kind: UpstreamKind,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface ProviderOptions {
  token?: string;
  /** how long a snapshot is served as fresh before background revalidation (default 30 min) */
  freshTtlMs?: number;
  /** hard ceiling for serving stale data in normal operation (default 48 h);
   * an explicit primary-quota pause serves stale regardless -- that is the
   * documented degradation path for rate limiting */
  maxStaleMs?: number;
  /** negative cache for not-found (default 1 h) */
  notFoundTtlMs?: number;
  /** base for self-computed transient backoff (default 60 s, exponential per
   * consecutive failure, capped at backoffCapMs) */
  transientTtlMs?: number;
  /** ceiling for self-computed backoff; upstream Retry-After values are NOT capped */
  backoffCapMs?: number;
  /** upstream request timeout (default 5 s) */
  timeoutMs?: number;
  /** max entries per internal map; oldest evicted (default 5000) */
  mapCap?: number;
  fetchImpl?: typeof fetch;
  /** injectable clock for tests */
  now?: () => number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  freshTtlMs: 30 * 60_000,
  maxStaleMs: 48 * 60 * 60_000,
  notFoundTtlMs: 60 * 60_000,
  transientTtlMs: 60_000,
  backoffCapMs: 15 * 60_000,
  timeoutMs: 5000,
  mapCap: 5000,
};

interface Snapshot {
  data: RepoData;
  etag?: string;
  fetchedAt: number;
  version: string;
}

function stableVersion(data: RepoData): string {
  const payload = JSON.stringify([
    data.fullName, data.name, data.description,
    data.stargazersCount ?? null, data.forksCount ?? null, data.openIssuesCount ?? null,
    data.avatarUrl ?? null,
    data.licenseSpdxId ?? null, data.language ?? null, data.pushedAt ?? null,
  ]);
  return Buffer.from(payload).toString("base64url");
}

export interface GitHubProvider {
  getRepo(owner: string, repo: string): Promise<RepoSnapshot>;
  /** latest release tag, or null when the repo has no releases; never throws
   * for "no releases" (a 404 here is not a missing repository) */
  getLatestRelease(owner: string, repo: string): Promise<string | null>;
}

export function createGitHubProvider(options: ProviderOptions = {}): GitHubProvider {
  const opts = { ...DEFAULTS, ...options };
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  const snapshots = new Map<string, Snapshot>();
  const notFoundUntil = new Map<string, number>();
  const backoffUntil = new Map<string, number>();
  const failCounts = new Map<string, number>();
  const lastError = new Map<string, UpstreamError>();
  const inflight = new Map<string, Promise<void>>();
  const releases = new Map<string, { tag: string | null; at: number }>();
  /** primary quota exhausted (x-ratelimit-remaining: 0): pause ALL repos */
  let pausedUntil = 0;

  const key = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

  /** Bounded LRU-ish insert: refresh recency, evict oldest over cap. */
  function boundedSet<V>(map: Map<string, V>, k: string, v: V): void {
    if (map.has(k)) map.delete(k);
    map.set(k, v);
    while (map.size > opts.mapCap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function pauseFor(seconds: number, why: string): void {
    const until = now() + Math.max(0, seconds) * 1000;
    if (until > pausedUntil) {
      pausedUntil = until;
      log(`primary quota pause for ${Math.round(seconds)}s: ${why}`);
    }
  }

  function classifyStatus(status: number, headers: Headers, repoKey: string): never {
    if (status === 404 || status === 410) throw new NotFoundError(repoKey);
    if (status === 403 || status === 429) {
      const remaining = headers.get("x-ratelimit-remaining");
      const retryAfter = headers.get("retry-after");
      const reset = headers.get("x-ratelimit-reset");
      const retryAfterSeconds = retryAfter
        ? Number(retryAfter)
        : reset
          ? Math.max(0, Number(reset) - Math.floor(now() / 1000))
          : undefined;
      // primary quota exhausted -> pause every repo on this token
      if (remaining === "0") {
        pauseFor(retryAfterSeconds ?? 300, `403/429 with remaining=0 on ${repoKey}`);
      }
      throw new UpstreamError(
        "rate-limited",
        `GitHub rate limited ${repoKey} (status ${status}, remaining=${remaining})`,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }
    throw new UpstreamError("transient", `GitHub returned ${status} for ${repoKey}`);
  }

  async function fetchRepo(
    repoKey: string,
    etag?: string,
  ): Promise<{ status: number; data?: RepoData; etag?: string }> {
    const url = `https://api.github.com/repos/${repoKey}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "erika-banner/0.1",
    };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (etag) headers["If-None-Match"] = etag;

    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (res.status === 304) return { status: 304, etag };
    if (!res.ok) classifyStatus(res.status, res.headers, repoKey);

    const body = (await res.json()) as Record<string, unknown>;
    if (body.private === true) {
      // hard rejection: never expose private repos even with a privileged token
      log(`refusing private repo ${repoKey}`);
      throw new NotFoundError(repoKey);
    }
    const license = body.license as { spdx_id?: unknown } | null | undefined;
    const data: RepoData = {
      fullName: String(body.full_name ?? repoKey),
      name: String(body.name ?? repoKey.split("/")[1]),
      description: (body.description as string | null) ?? null,
      stargazersCount: typeof body.stargazers_count === "number" ? body.stargazers_count : undefined,
      forksCount: typeof body.forks_count === "number" ? body.forks_count : undefined,
      openIssuesCount: typeof body.open_issues_count === "number" ? body.open_issues_count : undefined,
      licenseSpdxId: typeof license?.spdx_id === "string" && license.spdx_id !== "NOASSERTION"
        ? license.spdx_id : null,
      language: typeof body.language === "string" ? body.language : null,
      pushedAt: typeof body.pushed_at === "string" ? body.pushed_at : null,
      avatarUrl: typeof (body.owner as Record<string, unknown> | undefined)?.avatar_url === "string"
        ? ((body.owner as Record<string, unknown>).avatar_url as string)
        : undefined,
      defaultBranch: typeof body.default_branch === "string" ? body.default_branch : undefined,
      private: false,
    };
    return { status: 200, data, etag: res.headers.get("etag") ?? undefined };
  }

  /** Latest release tag, cached per repo. "No releases" and upstream failures
   * both resolve to null: the field is decoration, never worth failing a
   * render for. */
  async function getLatestRelease(owner: string, repo: string): Promise<string | null> {
    const repoKey = key(owner, repo);
    const hit = releases.get(repoKey);
    if (hit && now() - hit.at < opts.freshTtlMs) return hit.tag;
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "erika-banner/0.1",
      };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const res = await doFetch(`https://api.github.com/repos/${repoKey}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const tag = res.ok ? ((await res.json()) as { tag_name?: unknown }).tag_name : null;
      const value = typeof tag === "string" ? tag : null;
      boundedSet(releases, repoKey, { tag: value, at: now() });
      return value;
    } catch (err) {
      log(`latest release fetch failed for ${repoKey}: ${err instanceof Error ? err.message : err}`);
      boundedSet(releases, repoKey, { tag: null, at: now() });
      return null;
    }
  }

  /** Blocking or background revalidation, merged per key (single-flight).
   * Backoff / quota-pause checks happen BEFORE a task is registered, so a
   * skipped attempt can never poison the inflight map (regression: an early
   * return inside the task left a settled promise in inflight and the repo
   * stopped refreshing forever). */
  function revalidate(repoKey: string, background: boolean): Promise<void> {
    const existing = inflight.get(repoKey);
    if (existing) return existing;
    if (now() < pausedUntil) return Promise.resolve(); // quota pause: no network at all
    if (now() < (backoffUntil.get(repoKey) ?? 0)) return Promise.resolve(); // per-repo backoff

    const p = (async () => {
      try {
        const snap = snapshots.get(repoKey);
        const res = await fetchRepo(repoKey, snap?.etag);
        if (res.status === 304 && snap) {
          boundedSet(snapshots, repoKey, { ...snap, fetchedAt: now() });
        } else if (res.data) {
          boundedSet(snapshots, repoKey, {
            data: res.data,
            etag: res.etag,
            fetchedAt: now(),
            version: stableVersion(res.data),
          });
        }
        failCounts.delete(repoKey);
        backoffUntil.delete(repoKey);
        lastError.delete(repoKey);
      } catch (err) {
        if (err instanceof NotFoundError) {
          snapshots.delete(repoKey);
          failCounts.delete(repoKey);
          boundedSet(notFoundUntil, repoKey, now() + opts.notFoundTtlMs);
          if (!background) throw err;
          return;
        }
        const upstream =
          err instanceof UpstreamError
            ? err
            : new UpstreamError("transient", `network error for ${repoKey}: ${err instanceof Error ? err.message : err}`);
        // self-computed backoff is exponential in consecutive failures and
        // capped; upstream-specified waits (Retry-After / quota reset) were
        // already applied verbatim upstream (pausedUntil) or below (exact).
        const count = (failCounts.get(repoKey) ?? 0) + 1;
        failCounts.set(repoKey, count);
        const selfBackoff = Math.min(opts.transientTtlMs * 2 ** (count - 1), opts.backoffCapMs);
        const waitMs =
          upstream.kind === "rate-limited" && upstream.retryAfterSeconds !== undefined
            ? upstream.retryAfterSeconds * 1000 // upstream-specified: exact, uncapped
            : selfBackoff;
        boundedSet(backoffUntil, repoKey, now() + waitMs);
        boundedSet(lastError, repoKey, upstream);
        if (!background) throw upstream;
        log(`background revalidation failed for ${repoKey}: ${upstream.message} (retry in ${Math.round(waitMs / 1000)}s)`);
      } finally {
        inflight.delete(repoKey);
      }
    })();
    inflight.set(repoKey, p);
    return p;
  }

  return {
    async getRepo(owner, repo) {
      const repoKey = key(owner, repo);

      // primary quota pause: serve whatever snapshot exists, never the network
      if (now() < pausedUntil) {
        const snap = snapshots.get(repoKey);
        if (snap) return { data: snap.data, freshness: "stale", version: snap.version };
        throw new UpstreamError(
          "rate-limited",
          `GitHub primary quota paused for another ${Math.ceil((pausedUntil - now()) / 1000)}s`,
          Math.ceil((pausedUntil - now()) / 1000),
        );
      }

      const nfUntil = notFoundUntil.get(repoKey) ?? 0;
      if (now() < nfUntil) throw new NotFoundError(repoKey);
      if (nfUntil) notFoundUntil.delete(repoKey);

      const snap = snapshots.get(repoKey);
      if (snap) {
        const age = now() - snap.fetchedAt;
        if (age < opts.freshTtlMs) {
          boundedSet(snapshots, repoKey, snap); // LRU touch
          return { data: snap.data, freshness: "fresh", version: snap.version };
        }
        if (age < opts.maxStaleMs) {
          // SWR: serve stale now, refresh in the background (single-flight)
          void revalidate(repoKey, true);
          return { data: snap.data, freshness: "stale", version: snap.version };
        }
        // beyond max staleness: one blocking attempt, then give up on old data
        try {
          await revalidate(repoKey, false);
        } catch (cause) {
          throw new UpstreamError(
            "stale-expired",
            `stale data for ${repoKey} exceeded max age and revalidation failed: ` +
              (cause instanceof Error ? cause.message : cause),
          );
        }
        const fresh = snapshots.get(repoKey);
        if (fresh && now() - fresh.fetchedAt < opts.maxStaleMs) {
          return { data: fresh.data, freshness: "fresh", version: fresh.version };
        }
        throw new UpstreamError("stale-expired", `stale data for ${repoKey} exceeded max age and revalidation failed`);
      }

      const backoffUntilAt = backoffUntil.get(repoKey) ?? 0;
      if (now() < backoffUntilAt) {
        const saved = lastError.get(repoKey);
        const seconds = Math.ceil((backoffUntilAt - now()) / 1000);
        if (saved) {
          throw new UpstreamError(saved.kind, `${saved.message}; backing off for another ${seconds}s`, saved.retryAfterSeconds);
        }
        throw new UpstreamError("transient", `recent failure for ${repoKey}; backing off for another ${seconds}s`);
      }

      await revalidate(repoKey, false);
      const fresh = snapshots.get(repoKey);
      if (fresh) return { data: fresh.data, freshness: "fresh", version: fresh.version };
      throw new UpstreamError("transient", `upstream fetch failed for ${repoKey}`);
    },

    getLatestRelease,
  };
}
