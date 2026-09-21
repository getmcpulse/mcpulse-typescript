import { describe, expect, it } from "vitest";
import { is_empty_result } from "../src/empty.js";
import { canonicalize } from "../src/canonical.js";
import { args_hash, new_session_id } from "../src/hash.js";
import { decide_outcome, type CallSlot } from "../src/outcome.js";
import { resolve_options, DEFAULT_ENDPOINT } from "../src/options.js";
import { SDK_NAME, SDK_VERSION } from "../src/version.js";
import { readFile } from "node:fs/promises";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const slot = (over: Partial<CallSlot> = {}): CallSlot => ({
  handler_ran: false,
  outcome: null,
  ...over,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("args_hash", () => {
  it("ignores key order, so the same call always hashes the same", () => {
    // Without this every reordered call looks like a retry, and the headline
    // first-call-success metric becomes noise.
    expect(args_hash({ a: 1, b: 2 })).toBe(args_hash({ b: 2, a: 1 }));
  });

  it("does not ignore array order, because that is a different call", () => {
    expect(args_hash({ ids: [1, 2] })).not.toBe(args_hash({ ids: [2, 1] }));
  });

  it("sorts at every depth, not only the top", () => {
    expect(canonicalize({ o: { z: 1, a: 2 } })).toBe('{"o":{"a":2,"z":1}}');
  });

  it("distinguishes different values", () => {
    expect(args_hash({ q: "a" })).not.toBe(args_hash({ q: "b" }));
  });

  it("is always twelve lowercase hex characters", () => {
    expect(args_hash({ q: "anything" })).toMatch(/^[0-9a-f]{12}$/);
  });

  it("survives arguments that cannot be serialised", () => {
    // A circular structure must not take down the tool call that carried it.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => args_hash(circular)).not.toThrow();
    expect(args_hash(circular)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles no arguments at all", () => {
    expect(args_hash(undefined)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("new_session_id", () => {
  it("is prefixed and unique", () => {
    const a = new_session_id();
    expect(a).toMatch(/^s_[0-9a-f]{12}$/);
    expect(a).not.toBe(new_session_id());
  });
});

describe("is_empty_result", () => {
  it("catches the empty array a tool returns while reporting success", () => {
    expect(is_empty_result(text("[]"))).toBe(true);
  });

  it("catches an empty object, an empty string and no content at all", () => {
    expect(is_empty_result(text("{}"))).toBe(true);
    expect(is_empty_result(text("   "))).toBe(true);
    expect(is_empty_result({ content: [] })).toBe(true);
    expect(is_empty_result(null)).toBe(true);
  });

  it("does not call a real answer empty", () => {
    expect(is_empty_result(text("3 orders found"))).toBe(false);
    expect(is_empty_result(text('[{"id":1}]'))).toBe(false);
  });

  it("treats zero and false as answers, not absences", () => {
    // A count of zero is a result. Reporting it as empty would show a working
    // tool as broken.
    expect(is_empty_result(text("0"))).toBe(false);
    expect(is_empty_result(text("false"))).toBe(false);
  });

  it("lets structured content decide when a tool provides it", () => {
    expect(is_empty_result({ content: [{ type: "text", text: "x" }], structuredContent: {} })).toBe(
      true,
    );
    expect(
      is_empty_result({ content: [], structuredContent: { rows: 1 } }),
    ).toBe(false);
  });

  it("does not judge prose that merely fails to parse as JSON", () => {
    expect(is_empty_result(text("Nothing matched your search."))).toBe(false);
  });

  it("leaves multi-part content alone", () => {
    const two = { content: [{ type: "text", text: "" }, { type: "text", text: "" }] };
    expect(is_empty_result(two)).toBe(false);
  });
});

describe("decide_outcome", () => {
  it("takes the handler's own word when it ran", () => {
    expect(decide_outcome(slot({ outcome: "crashed", handler_ran: true }), null, true)).toBe(
      "crashed",
    );
    expect(decide_outcome(slot({ outcome: "tool_error", handler_ran: true }), {}, false)).toBe(
      "tool_error",
    );
  });

  it("calls a failure before the handler ran bad_args", () => {
    // Validation rejected the arguments, so the author's code never executed.
    expect(decide_outcome(slot(), { isError: true }, false)).toBe("bad_args");
    expect(decide_outcome(slot(), null, true)).toBe("bad_args");
  });

  it("calls a throw after the handler ran a crash", () => {
    expect(decide_outcome(slot({ handler_ran: true }), null, true)).toBe("crashed");
  });

  it("is ok when nothing went wrong", () => {
    expect(decide_outcome(slot(), { content: [] }, false)).toBe("ok");
  });
});

describe("resolve_options", () => {
  it("defaults the endpoint and strips a trailing slash", () => {
    expect(resolve_options({ key: "k" }).endpoint).toBe(DEFAULT_ENDPOINT);
    expect(resolve_options({ key: "k", endpoint: "http://localhost:3000/" }).endpoint).toBe(
      "http://localhost:3000",
    );
  });

  it("switches itself off without a key, rather than posting 401s every flush", () => {
    expect(resolve_options({ key: "" }).enabled).toBe(false);
    expect(resolve_options({ key: "   " }).enabled).toBe(false);
  });

  it("respects enabled: false even with a key", () => {
    expect(resolve_options({ key: "k", enabled: false }).enabled).toBe(false);
  });

  it("is on by default", () => {
    expect(resolve_options({ key: "k" }).enabled).toBe(true);
    expect(resolve_options({ key: "k" }).debug).toBe(false);
  });
});

describe("the reported SDK version", () => {
  it("is the version this package publishes as", async () => {
    // `SDK_VERSION` is a constant rather than a read of the manifest, because
    // this file is bundled into both an ESM and a CJS artefact and neither
    // `import.meta.url` nor `__dirname` exists in both. The constant is safe
    // only if something fails when it drifts, so this is that something.
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };

    expect(SDK_VERSION).toBe(manifest.version);
    expect(SDK_NAME).toBe(manifest.name);
  });
});
