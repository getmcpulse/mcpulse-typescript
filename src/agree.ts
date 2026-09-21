/**
 * Cross-tool agreement — do two tools that return the same field agree?
 *
 * ── The failure this catches, and why nothing else can ─────────────────────
 * Two tools on one server hand back the same underlying number under different
 * names. A stale cache key, or a versioned key a cron did not follow, and they
 * disagree for hours. Every metric this package already collects stays green
 * the whole time: the calls succeed, the results are non-empty, there are no
 * retries and the latency is fine. Callers get two different answers to one
 * question and nothing anywhere reports it.
 *
 * It is invisible to external monitoring by construction. A proxy sees two
 * well-formed responses; a status page sees two 200s. Only something inside
 * the process can know that `globalLiquidity.value_t` from one tool and
 * `pillars.global_liquidity.value` from another are supposed to be the same
 * figure. That is the one thing this SDK has that nothing outside does.
 *
 * ── Why the declaration is a map and not a list of fields ──────────────────
 * The same value routinely ships under a different name and a different shape
 * in each tool that returns it. A flat list of field names would only work on
 * a server that already names things consistently — which is a server that
 * does not have this bug. So the author names the value once, canonically, and
 * says where it appears in each tool.
 *
 * ── Why the comparison happens here rather than at the API ─────────────────
 * The obvious design is to hash each value and let the server compare hashes.
 * It cannot work. `25.22`, `25.220` and `"25.22"` are the same number and
 * three different hashes, so a representation change in one tool would report
 * as a divergence on every call, forever. Comparing numerically requires the
 * values, and the values are the one thing this package will not send.
 *
 * Both halves of that are satisfied by comparing in-process: the numbers are
 * compared where they already are, and only the verdict leaves.
 *
 * ── What leaves ────────────────────────────────────────────────────────────
 * `{ field, tool_a, tool_b, agreed }` and the time. No value, no difference,
 * no hash of a value. The author already knows what their numbers are; what
 * they do not know is that two tools disagreed about one.
 */

import { canonicalize } from "./canonical.js";
import { WIRE_VERSION, type AgreementPayload } from "./types.js";

/** Where one canonical field appears: which tool, and where in its result. */
export interface AgreementSite {
  tool: string;
  /** Dotted path into the result — `pillars.global_liquidity.value`, `rows[0].v`. */
  path: string;
}

/**
 * One canonical field: where it appears, and how fresh two readings must be.
 *
 * ── Why the window and the tolerance live per field ────────────────────────
 * They were global, and a global freshness bar cannot be right on a server that
 * returns more than one kind of number. From the design partner this was built
 * with: "a quote 30s old is fine for a chat answer, fatal for a trade." Those
 * two values come off the same server, through the same SDK, and a single
 * window either reports the chat answer as a divergence every time the quote
 * ticks, or gives the trade a five-minute blind spot. Neither is a setting
 * anybody would choose; it is just what one number forces.
 */
export interface AgreementField {
  sources: AgreementSite[];
  /** Overrides the global window for this field alone. */
  windowMs?: number;
  /** Overrides the global tolerance for this field alone. */
  tolerance?: number;
}

/**
 * Canonical field name → where it appears.
 *
 * Two shapes are accepted, and the short one is not deprecated: a bare array of
 * sites is the whole declaration when the defaults suit, and most fields they
 * do. The object form is for when they do not.
 *
 * ```ts
 * agree: {
 *   // the long form, when this field needs its own bars
 *   global_liquidity: {
 *     sources: [
 *       { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
 *       { tool: "getPillars",         path: "pillars.global_liquidity.value" },
 *     ],
 *     windowMs: 30_000,
 *     tolerance: 0.0001,
 *   },
 *   // the short form, when the defaults are right
 *   vix: [
 *     { tool: "getVix",     path: "vix.last" },
 *     { tool: "getPillars", path: "pillars.vix.value" },
 *   ],
 * }
 * ```
 */
export type AgreementMap = Record<string, AgreementSite[] | AgreementField>;

/** The sites of one entry, whichever shape it was written in. */
function sites_of(entry: AgreementSite[] | AgreementField): AgreementSite[] {
  if (Array.isArray(entry)) return entry;
  return entry && Array.isArray(entry.sources) ? entry.sources : [];
}

export interface AgreeOptions {
  /**
   * How long a value stays comparable, in milliseconds.
   *
   * Must be shorter than the refresh interval of the underlying data — a
   * window that outlives a refresh compares a figure against its own
   * predecessor and reports a legitimate change as a divergence. And long
   * enough that both tools are plausibly called inside it, or no comparison
   * ever happens at all.
   */
  windowMs?: number;
  /**
   * Relative tolerance for floats. `0.0001` is one part in ten thousand.
   *
   * Integers and strings are compared exactly whatever this says: a count that
   * is off by one is off by one, and rounding it into agreement would hide the
   * only kind of disagreement a count can have.
   */
  tolerance?: number;
}

export const AGREE_WINDOW_MS = 300_000;
export const AGREE_TOLERANCE = 0.0001;

/**
 * Ceilings on the declaration and on what is held.
 *
 * The same discipline as the payload buffer, for the same reason: this runs
 * inside somebody else's server, and the one failure we must never cause is
 * their process running out of memory over our analytics. The held map is
 * bounded by the declaration in practice — one entry per declared field — but
 * it is capped independently so a generated declaration cannot make it
 * unbounded either.
 */
export const MAX_AGREE_FIELDS = 256;
export const MAX_AGREE_SITES = 512;

/** Content parts searched for a path, when the result carries several. */
const MAX_CONTENT_PARTS = 4;

/** The window and tolerance in force for one field, defaults already applied. */
export interface FieldBars {
  window_ms: number;
  tolerance: number;
}

export interface ResolvedAgree {
  /** Tool name → the canonical fields it reports, and where in its result. */
  by_tool: Map<string, Array<{ field: string; path: string }>>;
  /**
   * Per field, the bars that apply to it.
   *
   * Resolved once here rather than looked up per call: `observe` runs in the
   * `finally` of every tool call on the server, and a settings lookup there is
   * a cost paid on a path a model is waiting behind.
   */
  bars: Map<string, FieldBars>;
  /** The defaults, for a field with no override of its own. */
  window_ms: number;
  tolerance: number;
  /** How many `(field, tool)` pairs were declared. */
  site_count: number;
  /**
   * The declaration itself, flattened for the startup payload.
   *
   * ── Why this has to go on the wire ────────────────────────────────────────
   * A verdict only exists when two tools *did* report inside the window. So a
   * field that never produced one is invisible to the API — including the worst
   * case, where a path is mistyped, never resolves, and the check reads as
   * perfect agreement forever.
   *
   * Coverage without the declaration can only say "these tools were checked".
   * With it, it can say **"you declared this and it has never fired"**, which is
   * the finding — a low-traffic tool can leave a field silently wrong for as
   * long as nobody looks.
   *
   * Field names and tool names only. The *paths* stay in this process: they
   * describe the shape of a customer's results, and nothing about coverage
   * needs them.
   */
  declared: Array<{ field: string; tools: string[] }>;
}

/**
 * Read the declaration, or decide there is nothing to do.
 *
 * Returns `null` for anything that cannot produce a comparison: no map, a
 * field named by only one tool, a malformed entry. Silently — a bad
 * declaration must not be able to stop a server booting, and `debug` is where
 * a typo becomes visible.
 */
export function resolve_agree(
  map: AgreementMap | undefined,
  options: AgreeOptions | undefined,
  log: (message: string, detail?: unknown) => void,
): ResolvedAgree | null {
  if (!map || typeof map !== "object") return null;

  const by_tool = new Map<string, Array<{ field: string; path: string }>>();
  const bars = new Map<string, FieldBars>();
  const window_ms = positive(options?.windowMs, AGREE_WINDOW_MS);
  const tolerance = positive(options?.tolerance, AGREE_TOLERANCE);
  let site_count = 0;

  for (const [field, entry] of Object.entries(map).slice(0, MAX_AGREE_FIELDS)) {
    const sites = sites_of(entry);
    if (sites.length === 0) continue;

    const usable = sites.filter(
      (site) =>
        site &&
        typeof site.tool === "string" &&
        site.tool.length > 0 &&
        typeof site.path === "string" &&
        site.path.length > 0,
    );

    // One tool cannot disagree with itself, so a field named once is a
    // declaration with no comparison in it. Said out loud, because the likely
    // cause is a typo in the second tool's name.
    const tools = new Set(usable.map((site) => site.tool));
    if (tools.size < 2) {
      log(`agree: "${field}" names fewer than two tools — nothing to compare`);
      continue;
    }

    for (const site of usable) {
      if (site_count >= MAX_AGREE_SITES) break;
      const list = by_tool.get(site.tool) ?? [];
      list.push({ field, path: site.path });
      by_tool.set(site.tool, list);
      site_count++;
    }

    // Falls back to the global bars one at a time, so a field can override the
    // window and inherit the tolerance.
    const override = Array.isArray(entry) ? undefined : entry;
    bars.set(field, {
      window_ms: positive(override?.windowMs, window_ms),
      tolerance: positive(override?.tolerance, tolerance),
    });
  }

  if (by_tool.size === 0) return null;

  const tuned = [...bars.entries()].filter(
    ([, bar]) => bar.window_ms !== window_ms || bar.tolerance !== tolerance,
  );
  // Rebuilt from `by_tool` rather than collected alongside it, so the two cannot
  // disagree: what is reported as declared is exactly what is being watched.
  const by_field = new Map<string, Set<string>>();
  for (const [tool, sites] of by_tool) {
    for (const site of sites) {
      const tools = by_field.get(site.field) ?? new Set<string>();
      tools.add(tool);
      by_field.set(site.field, tools);
    }
  }

  const declared = [...by_field.entries()]
    .map(([field, tools]) => ({ field, tools: [...tools].sort() }))
    .sort((a, b) => a.field.localeCompare(b.field));

  log(
    `agree: watching ${site_count} declared paths across ${by_tool.size} tools` +
      (tuned.length ? `, ${tuned.length} with their own window or tolerance` : ""),
  );
  return { by_tool, bars, window_ms, tolerance, site_count, declared };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface Held {
  tool: string;
  value: unknown;
  at: number;
  /** Whether this observation ever got compared against another tool's. */
  matched: boolean;
}

/**
 * The comparison itself.
 *
 * Numbers first, and a numeric string counts as a number — `"25.22"` and
 * `25.22` are the same figure written twice, and reporting that as a
 * divergence is the exact mistake that makes hashing unworkable. Two integers
 * are compared exactly; two floats within the relative tolerance agree.
 * Strings that are not numbers are compared exactly. Anything structural falls
 * back to canonical JSON, which at least does not depend on key order.
 */
export function agrees(a: unknown, b: unknown, tolerance: number): boolean {
  const na = as_number(a);
  const nb = as_number(b);

  if (na !== null && nb !== null) {
    if (na === nb) return true;
    if (Number.isInteger(na) && Number.isInteger(nb)) return false;
    const scale = Math.max(Math.abs(na), Math.abs(nb));
    return scale === 0 ? true : Math.abs(na - nb) / scale <= tolerance;
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;

  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function as_number(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  // `Number("")` is 0, which would make an empty string agree with zero.
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `pillars.global_liquidity.value`, `rows[0].v`, `rows.0.v` — all the same. */
function segments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment !== "");
}

function at(root: unknown, path: string): { found: boolean; value: unknown } {
  let node = root;

  for (const key of segments(path)) {
    if (node === null || typeof node !== "object") return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[key];
    if (node === undefined) return { found: false, value: undefined };
  }

  return { found: true, value: node };
}

/**
 * Where a declared path might be, in the order worth trying.
 *
 * An MCP result is an envelope, and which part of it holds the data is a
 * choice the author already made once when they wrote the tool. Making them
 * make it again in the declaration — remembering whether to write
 * `structuredContent.` in front of every path — is a footgun with no upside,
 * so all three shapes are searched: the structured output, the JSON inside a
 * text part, and the result object itself.
 */
function roots(result: unknown): unknown[] {
  const out: unknown[] = [];
  const value = result as { content?: unknown; structuredContent?: unknown } | null;

  if (value && typeof value === "object") {
    if (value.structuredContent !== undefined) out.push(value.structuredContent);

    if (Array.isArray(value.content)) {
      for (const part of value.content.slice(0, MAX_CONTENT_PARTS)) {
        const text = part as { type?: unknown; text?: unknown };
        if (text?.type !== "text" || typeof text.text !== "string") continue;
        try {
          out.push(JSON.parse(text.text));
        } catch {
          /* Prose, not JSON. Nothing to walk. */
        }
      }
    }
  }

  out.push(result);
  return out;
}

/**
 * Holds the most recent value of each declared field, and emits a verdict when
 * a second tool reports the same one inside the window.
 *
 * One per stream rather than per `watch()`, for the reason the session id is:
 * an HTTP server builds a fresh `McpServer` per request, so a tracker made in
 * `watch()` would never see two tools and could never compare anything.
 */
export class AgreementTracker {
  private readonly held = new Map<string, Held>();
  /** `field|tool` pairs whose path has resolved at least once. */
  private readonly seen = new Set<string>();
  /** `field|tool` pairs whose path has never resolved, and how often it missed. */
  private readonly unresolved = new Map<string, number>();
  /** Fields whose window expired with only one tool having reported. */
  private readonly alone = new Map<string, number>();

  constructor(
    private readonly config: ResolvedAgree,
    private readonly session_id: string,
    private readonly log: (message: string, detail?: unknown) => void,
  ) {}

  /**
   * Record what one tool returned, and compare it against what another
   * returned earlier.
   *
   * Synchronous, and cheap enough to be: a handful of property lookups per
   * declared path. It is called from the `finally` of a tool call that has
   * already returned its result to the client, so nothing a model waits on
   * waits on this — but it still must not await, and it does not.
   */
  observe(tool: string, result: unknown, now: number, emit: (payload: AgreementPayload) => void): void {
    const sites = this.config.by_tool.get(tool);
    if (!sites) return;

    const candidates = roots(result);

    for (const site of sites) {
      const key = `${site.field}|${tool}`;

      let found = false;
      let value: unknown;
      for (const root of candidates) {
        const hit = at(root, site.path);
        if (hit.found) {
          found = true;
          value = hit.value;
          break;
        }
      }

      if (!found) {
        // Counted rather than thrown, and named the first time. A declaration
        // whose path never resolves reads as perfect agreement otherwise —
        // the failure mode where a typo looks like a passing check.
        const missed = (this.unresolved.get(key) ?? 0) + 1;
        this.unresolved.set(key, missed);
        if (missed === 1 && !this.seen.has(key)) {
          this.log(`agree: "${site.path}" did not resolve in ${tool} — declared but never observed`);
        }
        continue;
      }

      this.seen.add(key);
      this.unresolved.delete(key);

      // This field's own window and tolerance, resolved at startup. A quote 30s
      // old is fine for a chat answer and fatal for a trade, and both can come
      // off the same server through the same SDK.
      const bar = this.config.bars.get(site.field) ?? {
        window_ms: this.config.window_ms,
        tolerance: this.config.tolerance,
      };

      const previous = this.held.get(site.field);
      const fresh = previous !== undefined && now - previous.at <= bar.window_ms;

      if (previous && !fresh && !previous.matched) {
        // The window closed with one tool having answered and the other not.
        // A low-traffic tool can stay silently wrong for a long time this way,
        // so it is counted rather than passed over as a clean run.
        const count = (this.alone.get(site.field) ?? 0) + 1;
        this.alone.set(site.field, count);
        this.log(`agree: "${site.field}" observed from ${previous.tool} only in the last window`);
      }

      if (fresh && previous.tool !== tool) {
        const agreed = agrees(previous.value, value, bar.tolerance);
        previous.matched = true;

        emit({
          v: WIRE_VERSION,
          type: "agreement",
          session_id: this.session_id,
          field: site.field,
          tool_a: previous.tool,
          tool_b: tool,
          agreed,
          checked_at: new Date(now).toISOString(),
          // The window this verdict was actually reached under, not the global
          // default — otherwise a per-field override is invisible downstream and
          // a 30-second verdict reads as a 5-minute one.
          window_ms: bar.window_ms,
        });

        this.log(`agree: ${site.field} ${agreed ? "agreed" : "DIVERGED"} (${previous.tool} vs ${tool})`);
      }

      this.remember(site.field, {
        tool,
        value,
        at: now,
        // Only a comparison against a *different* tool counts as matched; a
        // tool refreshing its own value has not been checked against anything.
        matched: fresh && previous?.tool !== tool,
      });
    }
  }

  /**
   * What was declared, for the startup payload.
   *
   * Taken from the resolved config rather than from the options, so a field
   * that named only one tool — and therefore watches nothing — is not reported
   * as covered.
   */
  declared(): Array<{ field: string; tools: string[] }> {
    return this.config.declared;
  }

  /** Counters, for tests and for anything that wants to report on a run. */
  stats(): { unresolved: Record<string, number>; alone: Record<string, number>; held: number } {
    return {
      unresolved: Object.fromEntries(this.unresolved),
      alone: Object.fromEntries(this.alone),
      held: this.held.size,
    };
  }

  private remember(field: string, entry: Held): void {
    if (!this.held.has(field) && this.held.size >= MAX_AGREE_FIELDS) {
      // Oldest first, the same rule the payload buffer sheds by.
      const oldest = this.held.keys().next();
      if (!oldest.done) this.held.delete(oldest.value);
    }
    this.held.set(field, entry);
  }
}
