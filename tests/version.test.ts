import { describe, expect, it } from "vitest";
import { mcp_sdk_version, transport_of, SDK_VERSION } from "../src/version.js";

describe("version detection", () => {
  it("finds the MCP SDK version under this repo's layout", () => {
    // pnpm's content-addressed layout is the case that broke the first version
    // of this: `@modelcontextprotocol/sdk/package.json` resolves to something
    // with no `version` on it, so the lookup succeeded and reported undefined.
    expect(mcp_sdk_version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports this package's own version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("maps transports to a small fixed vocabulary", () => {
    expect(transport_of({ _transport: new (class StdioServerTransport {})() } as never)).toBe("stdio");
    expect(
      transport_of({ _transport: new (class StreamableHTTPServerTransport {})() } as never),
    ).toBe("http");
    expect(transport_of({ _transport: new (class SSEServerTransport {})() } as never)).toBe("sse");
    // Anything unrecognised is excluded from the wire-mapping table rather than
    // guessed at: a row that says stdio when it was SSE cannot be found at all.
    expect(transport_of({ _transport: new (class Carrier {})() } as never)).toBe("unknown");
    expect(transport_of(null)).toBe("unknown");
  });
});
