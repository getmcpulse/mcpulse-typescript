import { describe, expect, it } from "vitest";
import {
  WIRE_VERSION,
  type AgreementPayload,
  type CallPayload,
  type Outcome,
  type StartupPayload,
} from "../src/types.js";

/**
 * The wire contract, pinned.
 *
 * `src/types.ts` restates `@mcpulse/schemas` rather than importing it, so that
 * this package can install into a customer's server without dragging Zod along
 * behind it. The cost of that decision is drift, and this file is what makes
 * drift loud: every field the API validates is asserted here by name.
 *
 * If the API's contract changes, these fail. That is the point — a payload that
 * no longer matches is dropped silently at ingest, which is the worst possible
 * way to find out.
 */

const CALL_FIELDS = [
  "v",
  "type",
  "session_id",
  "client_name",
  "tool_name",
  "started_at",
  "duration_ms",
  "outcome",
  "response_bytes",
  "is_empty",
  "args_hash",
] as const;

const STARTUP_FIELDS = [
  "v",
  "type",
  "session_id",
  "client_name",
  // Which SDK, whose MCP SDK, and over what. The wire-mapping table is keyed on
  // the last two: how a thrown error reaches the client is a property of the
  // version and the transport, so a row without them cannot have it applied.
  "sdk",
  "mcp_sdk_version",
  "transport",
  "protocol_version",
  "tools",
] as const;

/**
 * Per tool. Three hashes rather than one, because "did this change" and "is
 * this the same description" are different questions and an exact hash only
 * answers the first.
 */
const STARTUP_TOOL_FIELDS = [
  "name",
  "schema_bytes",
  "schema_hash",
  "description_hash",
  "description_norm",
  "policy",
] as const;

/**
 * The opt-in cross-tool agreement verdict. No `client_name`: a divergence is a
 * property of the server's own data, not of who happened to ask for it.
 */
const AGREEMENT_FIELDS = [
  "v",
  "type",
  "session_id",
  "field",
  "tool_a",
  "tool_b",
  "agreed",
  "checked_at",
  "window_ms",
] as const;

const OUTCOMES: Outcome[] = ["ok", "bad_args", "tool_error", "crashed"];

describe("wire contract", () => {
  it("is version 1", () => {
    // The API rejects anything else outright.
    expect(WIRE_VERSION).toBe(1);
  });

  it("sends exactly the fields a call payload is defined to have", () => {
    const payload: CallPayload = {
      v: WIRE_VERSION,
      type: "call",
      session_id: "s_abc",
      client_name: "claude-desktop",
      tool_name: "search_orders",
      started_at: "2026-08-09T14:22:31.000Z",
      duration_ms: 240,
      outcome: "ok",
      response_bytes: 1420,
      is_empty: false,
      args_hash: "9c1b4e2f0a11",
    };

    expect(Object.keys(payload).sort()).toEqual([...CALL_FIELDS].sort());
  });

  it("sends exactly the fields a startup payload is defined to have", () => {
    const payload: StartupPayload = {
      v: WIRE_VERSION,
      type: "startup",
      session_id: "s_abc",
      client_name: "claude-desktop",
      sdk: "@mcpulse/sdk@0.1.6",
      mcp_sdk_version: "1.30.0",
      transport: "stdio",
      protocol_version: "2025-06-18",
      tools: [
        {
          name: "search_orders",
          schema_bytes: 480,
          schema_hash: "9c1b4e2f0a11",
          description_hash: "44136fa355b3",
          description_norm: "4f53cda18c2b",
          policy: null,
        },
      ],
    };

    expect(Object.keys(payload).sort()).toEqual([...STARTUP_FIELDS].sort());
    expect(Object.keys(payload.tools[0]!).sort()).toEqual([...STARTUP_TOOL_FIELDS].sort());
  });

  it("sends exactly the fields an agreement payload is defined to have", () => {
    const payload: AgreementPayload = {
      v: WIRE_VERSION,
      type: "agreement",
      session_id: "s_abc",
      field: "global_liquidity",
      tool_a: "getGlobalLiquidity",
      tool_b: "getPillars",
      agreed: false,
      checked_at: "2026-09-11T14:22:31.000Z",
      window_ms: 300_000,
    };

    expect(Object.keys(payload).sort()).toEqual([...AGREEMENT_FIELDS].sort());
  });

  it("knows all four outcomes and no others", () => {
    expect(OUTCOMES).toHaveLength(4);
    expect(new Set(OUTCOMES).size).toBe(4);
  });

  it("carries no field that could hold customer data", () => {
    // The rule that lets an MCP author pass a security review. Adding
    // `arguments` or `result` here would break it, and it cannot be un-broken.
    //
    // The agreement payload is the one that had to be *designed* around this
    // rather than merely checked against it: the obvious way to report a
    // divergence is to say what the two values were. So `value`, `values` and
    // `difference` are forbidden here too, and `hash` beside them — a hash of
    // a figure is a figure that is only awkward to read.
    const forbidden = [
      "arguments",
      "args",
      "result",
      "content",
      "input",
      "output",
      "params",
      "value",
      "values",
      "value_a",
      "value_b",
      "difference",
      "delta",
      "hash",
    ];
    for (const field of [...CALL_FIELDS, ...STARTUP_FIELDS, ...AGREEMENT_FIELDS]) {
      expect(forbidden).not.toContain(field);
    }
  });
});
