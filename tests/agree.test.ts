import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agrees, AGREE_TOLERANCE } from "../src/agree.js";
import { watch } from "../src/index.js";
import { FLUSH_EVERY_MS } from "../src/options.js";
import type { AgreementPayload, Payload } from "../src/types.js";

/**
 * Cross-tool agreement.
 *
 * The failure under test is the one every other metric in this package reports
 * as healthy: two tools return the same underlying field, they disagree, and
 * the calls all succeed with non-empty results and no retries. Nothing else
 * here can see it, so nothing else here can catch a regression in it.
 *
 * Two properties are load-bearing and both are asserted rather than assumed.
 * **Representation must not be a divergence** — `25.22`, `25.220` and `"25.22"`
 * are one number, and the design exists because hashing gets that wrong. And
 * **no value may leave the process**: a verdict that carried the figure would
 * be the third rule broken by the feature written to respect it.
 */

let key_counter = 0;
let KEY = "";
let sent: Payload[] = [];

beforeEach(() => {
  sent = [];
  // A key per test: the session, its buffer and now its tracker are shared per
  // destination for the life of the process, so a shared key would carry one
  // test's held values into the next.
  KEY = `mp_live_agree_${String(key_counter++).padStart(26, "0")}`;
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as { batch?: Payload[] };
    sent.push(...(body.batch ?? []));
    return new Response(null, { status: 202 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Two tools that both report `global_liquidity`, under different names and at
 * different depths — which is the shape the declaration is a map for.
 */
function build_server(values: { direct: unknown; nested: unknown }) {
  const server = new McpServer({ name: "test", version: "1.0.0" });

  server.registerTool("getGlobalLiquidity", { description: "The headline figure." }, () => ({
    content: [
      { type: "text" as const, text: JSON.stringify({ globalLiquidity: { value_t: values.direct } }) },
    ],
  }));

  server.registerTool("getPillars", { description: "Every pillar at once." }, () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ pillars: { global_liquidity: { value: values.nested }, vix: { value: 14.2 } } }),
      },
    ],
  }));

  server.registerTool("unrelated", { description: "Declares nothing." }, () => ({
    content: [{ type: "text" as const, text: "{}" }],
  }));

  return server;
}

const AGREE = {
  global_liquidity: [
    { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
    { tool: "getPillars", path: "pillars.global_liquidity.value" },
  ],
};

async function call(server: McpServer, name: string) {
  const low = server.server as unknown as {
    _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>>;
  };
  const handler = low._requestHandlers.get("tools/call");
  if (!handler) throw new Error("no tools/call handler registered");

  return handler(
    { method: "tools/call", params: { name, arguments: {} } },
    { signal: new AbortController().signal, requestId: 1 },
  );
}

async function flush() {
  await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS + 10);
}

/** Startup rides on `initialize`, which the call helper above never reaches. */
async function initialize(server: McpServer) {
  const low = server.server as unknown as {
    _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>>;
  };
  const handler = low._requestHandlers.get("initialize");
  if (!handler) throw new Error("no initialize handler registered");

  return handler(
    {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-desktop", version: "1.0.0" },
      },
    },
    { signal: new AbortController().signal, requestId: 0 },
  );
}

const verdicts = () => sent.filter((p): p is AgreementPayload => p.type === "agreement");

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the comparison itself", () => {
  it("treats the same number written three ways as one number", () => {
    // The whole reason the comparison is here and not at the API: each of
    // these hashes differently, so a hash-based check reports three
    // divergences where there is none.
    expect(agrees(25.22, 25.22, AGREE_TOLERANCE)).toBe(true);
    expect(agrees(25.22, 25.22000, AGREE_TOLERANCE)).toBe(true);
    expect(agrees(25.22, "25.22", AGREE_TOLERANCE)).toBe(true);
    expect(agrees("25.220", 25.22, AGREE_TOLERANCE)).toBe(true);
  });

  it("allows a float within tolerance and refuses one outside it", () => {
    expect(agrees(1000.0, 1000.00001, AGREE_TOLERANCE)).toBe(true);
    expect(agrees(1000.0, 1002.5, AGREE_TOLERANCE)).toBe(false);
  });

  it("compares integers exactly, whatever the tolerance says", () => {
    // A count that is off by one is off by one. Rounding it into agreement
    // would hide the only kind of disagreement a count can have.
    expect(agrees(1_000_000, 1_000_001, AGREE_TOLERANCE)).toBe(false);
    expect(agrees(42, "42", AGREE_TOLERANCE)).toBe(true);
  });

  it("compares non-numeric strings exactly", () => {
    expect(agrees("risk-on", "risk-on", AGREE_TOLERANCE)).toBe(true);
    expect(agrees("risk-on", "Risk-On", AGREE_TOLERANCE)).toBe(false);
  });

  it("does not read an empty string as zero", () => {
    expect(agrees("", 0, AGREE_TOLERANCE)).toBe(false);
  });

  it("compares structures by canonical form, so key order is not a divergence", () => {
    expect(agrees({ a: 1, b: 2 }, { b: 2, a: 1 }, AGREE_TOLERANCE)).toBe(true);
    expect(agrees({ a: 1 }, { a: 2 }, AGREE_TOLERANCE)).toBe(false);
  });
});

describe("verdicts", () => {
  it("says nothing at all unless the check is declared", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 99.9 }), { key: KEY });
    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(0);
  });

  it("reports agreement across representations", async () => {
    const server = watch(build_server({ direct: 25.22, nested: "25.220" }), {
      key: KEY,
      agree: AGREE,
    });
    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]).toMatchObject({
      type: "agreement",
      field: "global_liquidity",
      tool_a: "getGlobalLiquidity",
      tool_b: "getPillars",
      agreed: true,
      window_ms: 300_000,
    });
  });

  it("reports a genuine divergence", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
    });
    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.agreed).toBe(false);
  });

  it("sends the verdict and not the values", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
    });
    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    const wire = JSON.stringify(verdicts());
    expect(wire).not.toContain("25.22");
    expect(wire).not.toContain("24.01");
    // Not the difference either, which is a value with a subtraction in front.
    expect(wire).not.toContain("1.21");
    expect(Object.keys(verdicts()[0] ?? {}).sort()).toEqual([
      "agreed",
      "checked_at",
      "field",
      "session_id",
      "tool_a",
      "tool_b",
      "type",
      "v",
      "window_ms",
    ]);
  });

  it("finds the value wherever the result puts it", async () => {
    // Same declaration, structured output instead of a JSON text part. The
    // author should not have to remember which envelope they used.
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.registerTool(
      "getGlobalLiquidity",
      { description: "a", outputSchema: { globalLiquidity: z.object({ value_t: z.number() }) } },
      () => ({
        structuredContent: { globalLiquidity: { value_t: 25.22 } },
        content: [{ type: "text" as const, text: "{}" }],
      }),
    );
    server.registerTool(
      "getPillars",
      { description: "b" },
      () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ pillars: { global_liquidity: { value: 25.22 } } }),
          },
        ],
      }),
    );

    const watched = watch(server, { key: KEY, agree: AGREE });
    await call(watched, "getGlobalLiquidity");
    await call(watched, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.agreed).toBe(true);
  });
});

describe("when there is nothing to compare", () => {
  it("emits nothing when only one of the two tools is called", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
    });
    await call(server, "getGlobalLiquidity");
    await call(server, "getGlobalLiquidity");
    await flush();

    // A low-traffic sibling can leave a field silently wrong for a long time.
    // Silence here is correct and is also the reason that case is counted
    // rather than passed over as a clean run.
    expect(verdicts()).toHaveLength(0);
  });

  it("emits nothing once the window has expired", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
      agreeOptions: { windowMs: 1_000 },
    });

    await call(server, "getGlobalLiquidity");
    await vi.advanceTimersByTimeAsync(5_000);
    await call(server, "getPillars");
    await flush();

    // Two observations either side of a refresh are two different figures.
    // Comparing them would report every refresh as a divergence.
    expect(verdicts()).toHaveLength(0);
  });

  it("still compares inside a shortened window", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
      agreeOptions: { windowMs: 60_000 },
    });

    await call(server, "getGlobalLiquidity");
    await vi.advanceTimersByTimeAsync(1_000);
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.window_ms).toBe(60_000);
  });

  it("skips a path that does not resolve rather than throwing", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: {
        global_liquidity: [
          { tool: "getGlobalLiquidity", path: "globalLiquidity.typo_here" },
          { tool: "getPillars", path: "pillars.global_liquidity.value" },
        ],
      },
    });

    const result = (await call(server, "getGlobalLiquidity")) as { content: unknown[] };
    await call(server, "getPillars");
    await flush();

    // The tool's own answer is untouched, and a typo'd declaration produces no
    // verdict rather than a false clean one.
    expect(result.content).toHaveLength(1);
    expect(verdicts()).toHaveLength(0);
    expect(sent.filter((p) => p.type === "call")).toHaveLength(2);
  });

  it("ignores a field only one tool declares", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: { global_liquidity: [{ tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" }] },
    });
    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(0);
  });

  it("does not compare a failed call's result", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.registerTool("getGlobalLiquidity", { description: "a" }, () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ globalLiquidity: { value_t: 25.22 } }) }],
    }));
    server.registerTool("getPillars", { description: "b" }, () => {
      throw new Error("upstream down");
    });

    const watched = watch(server, { key: KEY, agree: AGREE });
    await call(watched, "getGlobalLiquidity");
    await call(watched, "getPillars");
    await flush();

    // A crash has no figure in it. Comparing whatever the error shape happens
    // to contain would report a divergence caused by the outage, not by drift.
    expect(verdicts()).toHaveLength(0);
  });
});

describe("staying out of the way", () => {
  it("returns the tool's real answer unchanged with the check on", async () => {
    const server = watch(build_server({ direct: 25.22, nested: 24.01 }), {
      key: KEY,
      agree: AGREE,
    });

    const result = (await call(server, "getPillars")) as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toEqual({
      pillars: { global_liquidity: { value: 24.01 }, vix: { value: 14.2 } },
    });
  });

  it("survives a malformed declaration", async () => {
    const server = watch(build_server({ direct: 1, nested: 1 }), {
      key: KEY,
      // Every one of these is wrong in a different way, and none of them may
      // stop a server booting.
      agree: {
        a: null,
        b: [{ tool: "getPillars" }],
        c: "not an array",
        global_liquidity: [
          { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
          { tool: "getPillars", path: "pillars.global_liquidity.value" },
        ],
      } as never,
    });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    // The one usable entry still works.
    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.agreed).toBe(true);
  });
});

describe("per-field windows and tolerances", () => {
  /**
   * The design partner's constraint, stated as a test: "a quote 30s old is fine
   * for a chat answer, fatal for a trade." Both values come off one server
   * through one SDK, so a single global window either reports the chat answer
   * as a divergence every time the quote ticks, or gives the trade a
   * five-minute blind spot.
   */
  it("a field's own window is what decides freshness", async () => {
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, {
      key: KEY,
      agree: {
        global_liquidity: {
          sources: [
            { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
            { tool: "getPillars", path: "pillars.global_liquidity.value" },
          ],
          windowMs: 30_000,
        },
      },
      // The global default is five minutes and would have kept this pair
      // comparable. The field's own thirty seconds is what must apply.
      agreeOptions: { windowMs: 300_000 },
    });

    await call(server, "getGlobalLiquidity");
    await vi.advanceTimersByTimeAsync(60_000);
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(0);
  });

  it("and it is the window reported on the verdict", async () => {
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, {
      key: KEY,
      agree: {
        global_liquidity: {
          sources: [
            { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
            { tool: "getPillars", path: "pillars.global_liquidity.value" },
          ],
          windowMs: 30_000,
        },
      },
      agreeOptions: { windowMs: 300_000 },
    });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    // Otherwise a thirty-second verdict reads downstream as a five-minute one.
    expect(verdicts()[0]?.window_ms).toBe(30_000);
  });

  it("a field's own tolerance is what decides agreement", async () => {
    // 1% apart: inside a 5% tolerance, far outside the 0.01% default. Floats,
    // because two integers are compared exactly whatever the tolerance says —
    // a count that is off by one is off by one.
    const server = build_server({ direct: 100.5, nested: 101.5 });
    watch(server, {
      key: KEY,
      agree: {
        global_liquidity: {
          sources: [
            { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
            { tool: "getPillars", path: "pillars.global_liquidity.value" },
          ],
          tolerance: 0.05,
        },
      },
    });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()[0]?.agreed).toBe(true);
  });

  it("overrides fall back one at a time", async () => {
    // A window of its own, and no tolerance — so the default tolerance applies
    // and this genuine 1% difference is still a divergence.
    const server = build_server({ direct: 100.5, nested: 101.5 });
    watch(server, {
      key: KEY,
      agree: {
        global_liquidity: {
          sources: [
            { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
            { tool: "getPillars", path: "pillars.global_liquidity.value" },
          ],
          windowMs: 30_000,
        },
      },
    });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()[0]?.agreed).toBe(false);
    expect(verdicts()[0]?.window_ms).toBe(30_000);
  });

  it("the bare-array form still works and is not deprecated", async () => {
    const server = build_server({ direct: 25.22, nested: "25.220" });
    watch(server, { key: KEY, agree: AGREE });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.agreed).toBe(true);
    expect(verdicts()[0]?.window_ms).toBe(300_000);
  });

  it("an object with no usable sources is skipped, not thrown on", async () => {
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, {
      key: KEY,
      agree: {
        broken: { windowMs: 1000 },
        alsoBroken: { sources: [] },
        global_liquidity: {
          sources: [
            { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
            { tool: "getPillars", path: "pillars.global_liquidity.value" },
          ],
        },
      } as never,
    });

    await call(server, "getGlobalLiquidity");
    await call(server, "getPillars");
    await flush();

    expect(verdicts()).toHaveLength(1);
  });
});

describe("the declaration on the wire", () => {
  /**
   * Coverage without this can only say which tools produced a verdict. A field
   * whose path is mistyped never produces one, so it reads as a check that keeps
   * passing — which is the failure mode worth catching most.
   */
  it("goes out on the startup payload", async () => {
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, { key: KEY, agree: AGREE });

    await initialize(server);
    await flush();

    const startup = sent.find((payload) => payload.type === "startup");
    expect(startup).toBeDefined();
    expect((startup as never as { agree_declared: unknown }).agree_declared).toEqual([
      { field: "global_liquidity", tools: ["getGlobalLiquidity", "getPillars"] },
    ]);
  });

  it("carries no paths", async () => {
    // A path describes the shape of a customer's results. Nothing about coverage
    // needs it, so it stays in the process.
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, { key: KEY, agree: AGREE });

    await initialize(server);
    await flush();

    const startup = sent.find((payload) => payload.type === "startup");
    expect(JSON.stringify(startup)).not.toContain("globalLiquidity.value_t");
  });

  it("is absent when nothing was declared", async () => {
    // The ordinary case. An empty array would read as "declared nothing and it
    // never fired", which is a different and wrong statement.
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, { key: KEY });

    await initialize(server);
    await flush();

    const startup = sent.find((payload) => payload.type === "startup");
    expect(startup).not.toHaveProperty("agree_declared");
  });

  it("omits a field only one tool declares", async () => {
    // That field watches nothing, so reporting it as covered would overstate
    // what is actually being checked.
    const server = build_server({ direct: 1, nested: 1 });
    watch(server, {
      key: KEY,
      agree: {
        lonely: [{ tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" }],
        global_liquidity: AGREE.global_liquidity,
      },
    });

    await initialize(server);
    await flush();

    const startup = sent.find((payload) => payload.type === "startup");
    const declared = (startup as never as { agree_declared: Array<{ field: string }> })
      .agree_declared;
    expect(declared.map((entry) => entry.field)).toEqual(["global_liquidity"]);
  });
});
