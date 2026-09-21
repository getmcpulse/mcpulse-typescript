import { AgreementTracker, resolve_agree } from "./agree.js";
import { PayloadBuffer } from "./buffer.js";
import { register_exit_flush } from "./exit.js";
import { new_session_id } from "./hash.js";
import type { ResolvedOptions } from "./options.js";

/**
 * One session and one buffer per destination, for the life of the process.
 *
 * The first version made both inside `watch()`, which is right for a stdio
 * server — one process, one `watch()`, one session — and wrong for an HTTP one.
 * A streamable-HTTP server builds a fresh `McpServer` per request, so `watch()`
 * runs per request too, and every tool call became a session of its own.
 *
 * That is not a cosmetic difference. Retries are found by looking for the same
 * tool twice inside one session, and first-call success is defined as no retry
 * following. With one call per session there can never be a retry, so the
 * server reports a perfect score however badly it is doing — the one number
 * this product exists to tell the truth about.
 *
 * Keyed by endpoint and key rather than a bare singleton: two watched servers
 * reporting to different MCPs in one process are two different streams, and
 * merging them would file one customer's calls under another's.
 */

export interface Stream {
  session_id: string;
  buffer: PayloadBuffer;
  /**
   * Whoever most recently identified themselves on `initialize`.
   *
   * Lives here for the same reason the session id does. It was a local in
   * `attach()`, which works for stdio — one `watch()`, one client — and fails
   * for HTTP exactly as the session did: `initialize` is handled by one
   * `McpServer` instance and `tools/call` by the next one, so the call never
   * saw the name and every event was filed as "unknown".
   *
   * It follows the session's model rather than the transport's: one value per
   * process per destination, last identification wins. For a server with two
   * concurrent clients that is an approximation — but it is the same
   * approximation the shared session already makes, and a name that is
   * occasionally the other client's beats a column that is always "unknown".
   */
  client_name: string;
  /**
   * Cross-tool agreement, when `watch()` was given a declaration. `null` when
   * it was not, which is the ordinary case.
   *
   * Here rather than in `attach()` for the reason the session id is here: an
   * HTTP server builds a fresh `McpServer` per request, so a tracker made per
   * `watch()` would only ever see one tool call and could never compare
   * anything with anything.
   *
   * The first declaration wins, like the session id. Two `watch()` calls in
   * one process reporting to the same MCP with different `agree` maps is a
   * mistake rather than a request for two trackers, and picking the first is
   * the same answer the session already gives.
   */
  agreement: AgreementTracker | null;
}

const streams = new Map<string, Stream>();

export function stream_for(
  options: ResolvedOptions,
  log: (message: string, detail?: unknown) => void,
): Stream {
  const key = `${options.endpoint}|${options.key}`;

  let stream = streams.get(key);
  if (!stream) {
    const session_id = new_session_id();
    const agree = resolve_agree(options.agree, options.agreeOptions, log);

    stream = {
      session_id,
      buffer: new PayloadBuffer(options, log),
      client_name: "unknown",
      agreement: agree ? new AgreementTracker(agree, session_id, log) : null,
    };
    streams.set(key, stream);
    register_exit_flush(stream.buffer);
  }

  return stream;
}
