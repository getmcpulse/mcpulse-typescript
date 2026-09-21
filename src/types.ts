/**
 * The MCPulse wire format, as this package builds it.
 *
 * These mirror `@mcpulse/schemas`, which is the contract the API validates
 * against. They are restated here rather than imported for one reason: this
 * package installs into other people's servers, and the schemas package brings
 * Zod with it. Nothing here needs Zod — the SDK writes payloads, the API is
 * what validates them, and dropping a validation library into every customer's
 * process to check our own output would be a cost with no buyer.
 *
 * The price of that is drift, which `tests/contract.test.ts` is there to catch:
 * it pins every field name, the wire version and the outcome list, so a change
 * in the API's contract fails here rather than silently at ingest.
 */

/** Bump only for a breaking change; the API rejects anything else. */
export const WIRE_VERSION = 1;

/**
 * How a tool call ended. Exactly one of these, always.
 *
 * - `ok`         ran and returned a result
 * - `bad_args`   arguments failed schema validation, the handler never ran
 * - `tool_error` ran and returned `isError: true`
 * - `crashed`    threw
 */
export type Outcome = "ok" | "bad_args" | "tool_error" | "crashed";

/** Sent once, when the customer's server boots. */
export interface StartupPayload {
  v: typeof WIRE_VERSION;
  type: "startup";
  session_id: string;
  client_name: string;
  /** This package: `@mcpulse/sdk@0.1.6`, or the equivalent in nine other languages. */
  sdk: string;
  /**
   * The customer's `@modelcontextprotocol/sdk` version, and how they are
   * serving. Both are inputs to the wire-mapping table, which says how a thrown
   * error and a returned `isError` actually reach the client — a property of the
   * SDK version and transport rather than of anyone's server, so it is derived
   * in CI and applied to these rows. `null` when it could not be determined,
   * which means the table is not applied rather than guessed at.
   */
  mcp_sdk_version: string | null;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** The protocol version the client negotiated at `initialize`. */
  protocol_version: string | null;
  /**
   * The cross-tool agreement declaration, when there is one.
   *
   * Field names and the tools that declare them — never the paths, which
   * describe the shape of a customer's results and are not needed to say what
   * is covered.
   *
   * Without this, coverage can only report which tools produced a verdict. With
   * it, it can report a field that was declared and has **never fired** — a
   * mistyped path, or a sibling too quiet to ever land in the same window, both
   * of which read as a check that keeps passing.
   */
  agree_declared?: Array<{ field: string; tools: string[] }>;
  tools: Array<{
    name: string;
    /** What this tool costs the context window, every session, called or not. */
    schema_bytes: number;
    /**
     * ── Churn, and convergence ───────────────────────────────────────────
     * Three hashes, three questions: did the interface change, did the wording
     * change, and is this the same description. The third is normalised, so
     * "Search for threads in the user's mailbox" and "Search threads in a
     * user's mailbox" collapse to one — which finds two tools that converged on
     * the same wording independently, as well as one that changed.
     *
     * Hashes only. No description text leaves the customer's process, and this
     * payload has never carried any.
     */
    schema_hash: string;
    description_hash: string;
    description_norm: string;
    /**
     * Declared preconditions, or `null` when the author declared none.
     *
     * A tool with a policy is excluded from every discoverability metric. A
     * model correctly declining to call it reads as poor discoverability
     * otherwise, and the advice that follows makes the server less safe.
     */
    policy: {
      requires_authorization: boolean;
      requires_verified_identity: boolean;
    } | null;
  }>;
}

/** Sent every time a tool runs. */
export interface CallPayload {
  v: typeof WIRE_VERSION;
  type: "call";
  session_id: string;
  client_name: string;
  tool_name: string;
  /** ISO 8601 with an offset. */
  started_at: string;
  duration_ms: number;
  outcome: Outcome;
  response_bytes: number;
  is_empty: boolean;
  /**
   * First 12 lowercase hex characters of the SHA-256 of the RFC 8785 canonical
   * form of the arguments. Never reversible, and identical across every
   * MCPulse SDK — `tests/fixtures/canonical.json` is what holds them to that.
   * `000000000000` means the arguments were not representable as JSON.
   */
  args_hash: string;
}

/**
 * Sent when two tools that declare the same field have both reported it inside
 * the agreement window. Opt-in: nothing emits one of these unless `watch()`
 * was given an `agree` map. See `agree.ts` for why it exists.
 *
 * The verdict, and nothing else. No value, no difference, and no hash of a
 * value — a hash is a value that is merely hard to read, and it would not work
 * anyway: `25.22`, `25.220` and `"25.22"` are one number and three hashes.
 */
export interface AgreementPayload {
  v: typeof WIRE_VERSION;
  type: "agreement";
  session_id: string;
  /** The author's own canonical name for the field, as they declared it. */
  field: string;
  /** The tool that reported the value first, inside the window. */
  tool_a: string;
  /** The tool whose report triggered the comparison. */
  tool_b: string;
  agreed: boolean;
  /** ISO 8601 with an offset. */
  checked_at: string;
  /** The window the two observations fell inside, so a verdict can be read. */
  window_ms: number;
}

export type Payload = StartupPayload | CallPayload | AgreementPayload;
