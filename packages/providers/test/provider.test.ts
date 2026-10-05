import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  UpstreamError,
  createGitHubProvider,
  type RepoData,
} from "../src/index.js";

function ghResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function repoBody(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Moemu/Erika",
    name: "Erika",
    description: "A URL-driven banner service",
    stargazers_count: 9,
    forks_count: 1,
    private: false,
    owner: { avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createGitHubProvider", () => {
  it("maps metadata in one request and changes the snapshot version when each field changes", async () => {
    let clock = 0;
    let body = repoBody({ license: { spdx_id: "MIT" }, language: "TypeScript", pushed_at: "2026-09-30T00:00:00Z" });
    let calls = 0;
    const provider = createGitHubProvider({ now: () => clock, freshTtlMs: 1, maxStaleMs: 2, fetchImpl: async () => {
      calls++;
      return ghResponse(body);
    } });
    let snap = await provider.getRepo("Moemu", "Erika");
    expect(snap.data).toMatchObject({ licenseSpdxId: "MIT", language: "TypeScript", pushedAt: "2026-09-30T00:00:00Z" });
    await provider.getRepo("Moemu", "Erika");
    expect(calls).toBe(1);
    for (const change of [{ license: { spdx_id: "Apache-2.0" } }, { language: "Python" }, { pushed_at: "2026-10-01T00:00:00Z" }]) {
      body = { ...body, ...change };
      clock += 10;
      const next = await provider.getRepo("Moemu", "Erika");
      expect(next.version).not.toBe(snap.version);
      snap = next;
    }
    expect(calls).toBe(4);
  });

  it("handles missing metadata and an unrecognized license", async () => {
    for (const license of [null, { spdx_id: "NOASSERTION" }]) {
      const provider = createGitHubProvider({ fetchImpl: async () => ghResponse(repoBody({ license, language: null, pushed_at: null })) });
      const snap = await provider.getRepo("Moemu", "Erika");
      expect(snap.data).toMatchObject({ licenseSpdxId: null, language: null, pushedAt: null });
    }
  });
  it("sends the token as a bearer header and revalidates with If-None-Match", async () => {
    const seen: Array<{ auth?: string; inm?: string | null }> = [];
    let call = 0;
    const provider = createGitHubProvider({
      token: "ghp_secret_value",
      freshTtlMs: 0, // every read revalidates
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ auth: headers.get("authorization") ?? undefined, inm: headers.get("if-none-match") });
        call++;
        return call === 1
          ? ghResponse(repoBody(), { etag: '"v1"' })
          : new Response(null, { status: 304 });
      }) as unknown as typeof fetch,
    });

    const first = await provider.getRepo("Moemu", "Erika");
    expect(first.data.stargazersCount).toBe(9);
    await provider.getRepo("Moemu", "Erika"); // revalidate -> 304, stays fresh
    const third = await provider.getRepo("Moemu", "Erika");

    expect(seen[0].auth).toBe("Bearer ghp_secret_value");
    expect(seen[0].inm).toBeNull();
    expect(seen[1].inm).toBe('"v1"'); // conditional request saves quota (404/304 not billed)
    expect(third.data.stargazersCount).toBe(9);
  });

  it("never sends an authorization header without a token", async () => {
    let auth: string | null = "unset";
    const provider = createGitHubProvider({
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization");
        return ghResponse(repoBody());
      }) as unknown as typeof fetch,
    });
    await provider.getRepo("Moemu", "Erika");
    expect(auth).toBeNull();
  });

  let script: Array<(url: string, init?: RequestInit) => Response>;
  const fetchMock = {
    get impl() {
      return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const next = script.shift();
        if (!next) throw new Error("unexpected extra fetch call");
        return next(String(url), init);
      }) as unknown as typeof fetch;
    },
  };

  beforeEach(() => {
    script = [];
  });

  it("fetches and maps repo fields; second call within TTL hits cache", async () => {
    let calls = 0;
    const provider = createGitHubProvider({
      token: "t0k3n",
      fetchImpl: async () => {
        calls++;
        return ghResponse(repoBody(), { etag: '"abc"' });
      },
    });
    const snap = await provider.getRepo("Moemu", "Erika");
    expect(snap.freshness).toBe("fresh");
    expect(snap.data.stargazersCount).toBe(9);
    expect(snap.data.avatarUrl).toContain("avatars.githubusercontent.com");
    expect(snap.version).toBeTypeOf("string");

    const snap2 = await provider.getRepo("moemu", "Erika"); // case-insensitive key
    expect(snap2.data.name).toBe("Erika");
    expect(calls).toBe(1); // single flight / TTL cache
  });

  it("revalidates with If-None-Match after TTL; 304 renews freshness without new data", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const provider = createGitHubProvider({
      token: "t0k3n",
      freshTtlMs: 50,
      fetchImpl: async (_url, init) => {
        calls.push(init);
        const inm = init?.headers && (init.headers as Record<string, string>)["If-None-Match"];
        if (inm === '"abc"') return new Response(null, { status: 304 });
        return ghResponse(repoBody(), { etag: '"abc"' });
      },
    });
    await provider.getRepo("Moemu", "Erika");
    await sleep(60); // expire fresh TTL -> SWR: stale served, background revalidation
    const stale = await provider.getRepo("Moemu", "Erika");
    expect(stale.freshness).toBe("stale");
    await sleep(10); // let the background revalidation (304) land
    const fresh = await provider.getRepo("Moemu", "Erika");
    expect(calls[1]?.headers).toHaveProperty("If-None-Match", '"abc"');
    expect(fresh.data.stargazersCount).toBe(9);
    expect(fresh.freshness).toBe("fresh");
  });

  it("serves stale while revalidating in background (SWR), data change updates version", async () => {
    let current = repoBody({ stargazers_count: 9 });
    const provider = createGitHubProvider({
      token: "t0k3n",
      freshTtlMs: 10,
      fetchImpl: async () => ghResponse(current, { etag: '"v2"' }),
    });
    await provider.getRepo("Moemu", "Erika");
    await sleep(15);
    const staleSnap = await provider.getRepo("Moemu", "Erika");
    expect(staleSnap.freshness).toBe("stale");
    expect(staleSnap.data.stargazersCount).toBe(9);

    current = repoBody({ stargazers_count: 42 });
    await sleep(10); // background revalidation from the stale serve lands (still 9)
    await provider.getRepo("Moemu", "Erika"); // serves 9 stale again + refreshes -> 42
    await sleep(15);
    const fresh = await provider.getRepo("Moemu", "Erika");
    expect(fresh.data.stargazersCount).toBe(42);
    expect(fresh.version).not.toBe(staleSnap.version);
  });

  it("caches not-found in a negative cache (second call does not hit network)", async () => {
    let calls = 0;
    const provider = createGitHubProvider({
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 404 });
      },
    });
    await expect(provider.getRepo("No", "Such")).rejects.toBeInstanceOf(NotFoundError);
    await expect(provider.getRepo("No", "Such")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toBe(1);
  });

  it("treats private repos as not-found even when authorized", async () => {
    const provider = createGitHubProvider({
      token: "privileged",
      fetchImpl: async () => ghResponse(repoBody({ private: true })),
    });
    await expect(provider.getRepo("Moemu", "Private-Stuff")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps rate limiting with Retry-After", async () => {
    const provider = createGitHubProvider({
      fetchImpl: async () =>
        new Response("{}", {
          status: 403,
          headers: { "retry-after": "120", "x-ratelimit-remaining": "0" },
        }),
    });
    const err = await provider.getRepo("Moemu", "Erika").catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).kind).toBe("rate-limited");
    expect((err as UpstreamError).retryAfterSeconds).toBe(120);
  });

  it("short-caches transient failures, then recovers", async () => {
    let healthy = false;
    let calls = 0;
    const provider = createGitHubProvider({
      transientTtlMs: 20,
      fetchImpl: async () => {
        calls++;
        if (!healthy) throw new Error("boom");
        return ghResponse(repoBody());
      },
    });
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toBeInstanceOf(UpstreamError);
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1); // short cache absorbed the retry
    await sleep(25);
    healthy = true;
    const snap = await provider.getRepo("Moemu", "Erika");
    expect(snap.data.name).toBe("Erika");
  });

  it("throws stale-expired when revalidation fails beyond max staleness", async () => {
    let healthy = true;
    const provider = createGitHubProvider({
      freshTtlMs: 5,
      maxStaleMs: 40,
      transientTtlMs: 10,
      fetchImpl: async () => {
        if (!healthy) throw new Error("boom");
        return ghResponse(repoBody());
      },
    });
    await provider.getRepo("Moemu", "Erika");
    await sleep(10); // past fresh TTL -> background SWR kicked in while healthy
    await provider.getRepo("Moemu", "Erika");
    healthy = false;
    await sleep(60); // beyond maxStale with a dead upstream
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toMatchObject({
      kind: "stale-expired",
    });
  });

  it("merges concurrent first fetches (single-flight)", async () => {
    let calls = 0;
    const provider = createGitHubProvider({
      fetchImpl: async () => {
        calls++;
        await sleep(20);
        return ghResponse(repoBody());
      },
    });
    const [a, b] = await Promise.all([
      provider.getRepo("Moemu", "Erika"),
      provider.getRepo("Moemu", "Erika"),
    ]);
    expect(calls).toBe(1);
    expect(a.version).toBe(b.version);
  });
});

describe("rate-limit handling regressions", () => {
  it("P1 regression: requests during backoff must not poison inflight; refresh recovers", async () => {
    let calls = 0;
    let healthy = false;
    let clock = 1_700_000_000_000;
    const provider = createGitHubProvider({
      now: () => clock,
      transientTtlMs: 500,
      fetchImpl: async () => {
        calls++;
        if (!healthy) throw new Error("boom");
        return ghResponse(repoBody({ stargazers_count: 42 }), { etag: '"ok"' });
      },
    });
    // first failure (blocking) -> backoffUntil = +500ms
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
    // request during backoff: no network, error, AND no inflight poisoning
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
    // backoff over, upstream recovered -> must hit the network again
    healthy = true;
    clock += 600;
    const snap = await provider.getRepo("Moemu", "Erika");
    expect(calls).toBe(2);
    expect(snap.data.stargazersCount).toBe(42);
    expect(snap.freshness).toBe("fresh");
  });

  it("upstream Retry-After is honored exactly (not capped at 15 min)", async () => {
    let calls = 0;
    let clock = 1_700_000_000_000;
    const provider = createGitHubProvider({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
        }
        return ghResponse(repoBody());
      },
    });
    await expect(provider.getRepo("Moemu", "Erika")).rejects.toMatchObject({ kind: "rate-limited" });
    clock += 16 * 60_000; // 16 minutes: still inside the 60 min upstream wait
    const still = await provider.getRepo("Moemu", "Erika").catch((e) => e);
    expect(still).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 3600 });
    expect(calls).toBe(1);
    clock += 50 * 60_000; // 66 minutes total: past the upstream wait
    const snap = await provider.getRepo("Moemu", "Erika");
    expect(calls).toBe(2);
    expect(snap.freshness).toBe("fresh");
  });

  it("self-computed transient backoff is exponential per consecutive failure", async () => {
    let calls = 0;
    let clock = 1_700_000_000_000;
    const provider = createGitHubProvider({
      now: () => clock,
      transientTtlMs: 100,
      backoffCapMs: 10_000,
      fetchImpl: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    await expect(provider.getRepo("A", "a")).rejects.toBeInstanceOf(UpstreamError); // backoff 100ms
    clock += 90;
    await expect(provider.getRepo("A", "a")).rejects.toBeInstanceOf(UpstreamError); // inside backoff, no fetch
    expect(calls).toBe(1);
    clock += 20; // 110ms: past 1st backoff
    await expect(provider.getRepo("A", "a")).rejects.toBeInstanceOf(UpstreamError); // fetch #2 -> backoff 200ms
    expect(calls).toBe(2);
    clock += 250; // t=360ms: past the 2nd failure's 200ms backoff window (110+200=310)
    await expect(provider.getRepo("A", "a")).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(3);
  });

  it("primary quota exhaustion pauses ALL repos on the token", async () => {
    let calls = 0;
    let clock = 1_700_000_000_000;
    const provider = createGitHubProvider({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(clock / 1000) + 600) } });
      },
    });
    await expect(provider.getRepo("A", "a")).rejects.toMatchObject({ kind: "rate-limited" });
    // a different repo must NOT hit the network during the pause
    await expect(provider.getRepo("B", "b")).rejects.toMatchObject({ kind: "rate-limited" });
    expect(calls).toBe(1);
    // pause expiry is covered by the SWR/backoff tests: once pausedUntil passes,
    // the next getRepo revalidation attempts the network again
  });

  it("bounded maps evict oldest entries over cap", async () => {
    let calls = 0;
    const provider = createGitHubProvider({
      mapCap: 2,
      fetchImpl: async () => {
        calls++;
        return ghResponse(repoBody(), { etag: `"e${calls}"` });
      },
    });
    await provider.getRepo("A", "a");
    await provider.getRepo("B", "b");
    await provider.getRepo("C", "c"); // cap 2: A evicted
    await provider.getRepo("A", "a"); // A must refetch from the network -> B evicted
    expect(calls).toBe(4);
    await provider.getRepo("C", "c"); // still cached: no network
    expect(calls).toBe(4);
    await provider.getRepo("B", "b"); // evicted: network again
    expect(calls).toBe(5);
  });
});
