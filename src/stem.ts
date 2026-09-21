/**
 * The Porter stemmer, for one job: deciding whether two tool descriptions are
 * the same description.
 *
 * ── Why this is in an analytics SDK at all ─────────────────────────────────
 * The startup payload carries a hash of each tool's description so churn can be
 * tracked without the text ever leaving the customer's process. An exact hash
 * answers "did this change". It does not answer "is this the same description",
 * and those are different questions:
 *
 *     "Search for threads in the user's mailbox"
 *     "Search threads in a user's mailbox"
 *
 * Two exact hashes, one description. So a second, normalised hash is sent
 * alongside: lowercased, stopwords dropped, stemmed, tokens sorted. Two tools
 * on one server landing on the same normalised hash have converged on the same
 * wording independently — which means their author could not find a way to tell
 * them apart either, and that is the strongest signal of a real collision this
 * package can produce.
 *
 * ── Why it is written out rather than installed ────────────────────────────
 * This package installs into other people's servers. A stemming dependency
 * would be a transitive dependency in every customer's tree, for one function.
 *
 * More to the point, there are ten MCPulse SDKs and the normalised hash has to
 * be the same hash in all of them, or the same description reported from a
 * Python server and a Go server looks like two descriptions. Two stemmers from
 * two ecosystems that agree on 99% of words would put a silent, unattributable
 * difference into the data. So there is one algorithm, written ten times, held
 * together by `tests/fixtures/stem.json` — the same fixture the schema study
 * and the web checker are held to.
 *
 * Porter (1980) as published, with one deviation: words of three letters or
 * fewer are left alone, because MCP schemas are full of three-letter acronyms
 * and Porter reads their trailing `s` as a plural (`ats` -> `at`, `ids` -> `id`).
 */

const VOWELS = new Set("aeiou");

/** Below this length a word is returned unchanged. See the header. */
export const MIN_STEM_LENGTH = 4;

/** Porter's definition: not a vowel, and not `y` preceded by a consonant. */
function consonant(word: string, i: number): boolean {
  const letter = word.charAt(i);
  if (VOWELS.has(letter)) return false;
  if (letter === "y") return i === 0 || !consonant(word, i - 1);
  return true;
}

/** `m` — the number of vowel-consonant sequences in [C](VC)^m[V]. */
function measure(stem: string): number {
  let m = 0;
  let i = 0;
  const n = stem.length;

  while (i < n && consonant(stem, i)) i++;
  while (i < n) {
    while (i < n && !consonant(stem, i)) i++;
    if (i === n) break;
    m++;
    while (i < n && consonant(stem, i)) i++;
  }
  return m;
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!consonant(stem, i)) return true;
  return false;
}

function doubleConsonant(stem: string): boolean {
  const n = stem.length;
  return n >= 2 && stem.charAt(n - 1) === stem.charAt(n - 2) && consonant(stem, n - 1);
}

/** Ends consonant-vowel-consonant, the last not `w`, `x` or `y`. */
function cvc(stem: string): boolean {
  const n = stem.length;
  if (n < 3) return false;
  return (
    consonant(stem, n - 3) &&
    !consonant(stem, n - 2) &&
    consonant(stem, n - 1) &&
    !"wxy".includes(stem.charAt(n - 1))
  );
}

type Rule = readonly [suffix: string, replacement: string];

/**
 * First matching rule wins, longest suffix first.
 *
 * Sorted by length rather than left in Porter's letter-switched order, which is
 * an implementation detail of his C rather than part of the algorithm.
 * Longest-first gives the same answers — `ization` before `ation`, `ement`
 * before `ment` before `ent` — and it is the one property the Python twin has
 * to reproduce, so it is stated here rather than implied.
 */
function longestFirst(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => b[0].length - a[0].length);
}

function replace(word: string, rules: Rule[], minMeasure: number): string {
  for (const [suffix, replacement] of rules) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    return measure(stem) > minMeasure ? stem + replacement : word;
  }
  return word;
}

const STEP2 = longestFirst([
  ["ational", "ate"], ["tional", "tion"],
  ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["abli", "able"], ["alli", "al"], ["entli", "ent"],
  ["eli", "e"], ["ousli", "ous"],
  ["ization", "ize"], ["ation", "ate"], ["ator", "ate"],
  ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"],
  ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
]);

const STEP3 = longestFirst([
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
  ["ical", "ic"], ["ful", ""], ["ness", ""],
]);

const STEP4 = longestFirst([
  ["al", ""], ["ance", ""], ["ence", ""], ["er", ""], ["ic", ""],
  ["able", ""], ["ible", ""], ["ant", ""], ["ement", ""], ["ment", ""],
  ["ent", ""], ["ou", ""], ["ism", ""], ["ate", ""], ["iti", ""],
  ["ous", ""], ["ive", ""], ["ize", ""],
]);

/**
 * Words already stemmed, so a big paste is not re-stemmed once per pass.
 *
 * `analyse` walks every description several times — content words, input nouns,
 * the inverted index behind the sibling search — and the largest real server in
 * the corpus publishes 2,530 tools. The whole page has a budget of a couple of
 * seconds on the main thread, and Porter is pure, so every answer after the
 * first is free.
 *
 * Bounded, unlike the Python twin's: the input here is a stranger's paste, and
 * an unbounded map keyed on arbitrary words is a memory leak with a nice name.
 * At the cap the whole cache is dropped rather than evicted one entry at a
 * time — an LRU would cost more bookkeeping than the stemmer it is protecting,
 * and a paste large enough to reach 50,000 distinct words is one pass away from
 * finishing anyway.
 */
const CACHE = new Map<string, string>();
const CACHE_LIMIT = 50_000;

/** `screens` and `screening` → `screen`. Lowercase in, lowercase out. */
export function stem(word: string): string {
  const cached = CACHE.get(word);
  if (cached !== undefined) return cached;

  const result = porter(word);
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
  CACHE.set(word, result);
  return result;
}

function porter(word: string): string {
  if (word.length < MIN_STEM_LENGTH) return word;

  /* 1a: plurals. */
  if (word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.endsWith("ies")) word = word.slice(0, -2);
  else if (word.endsWith("ss")) {
    /* kept whole */
  } else if (word.endsWith("s")) word = word.slice(0, -1);

  /* 1b: past tense and gerunds. */
  let stripped = false;
  if (word.endsWith("eed")) {
    if (measure(word.slice(0, -3)) > 0) word = word.slice(0, -1);
  } else if (word.endsWith("ed") && hasVowel(word.slice(0, -2))) {
    word = word.slice(0, -2);
    stripped = true;
  } else if (word.endsWith("ing") && hasVowel(word.slice(0, -3))) {
    word = word.slice(0, -3);
    stripped = true;
  }

  if (stripped) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) word += "e";
    else if (doubleConsonant(word) && !"lsz".includes(word.charAt(word.length - 1))) {
      word = word.slice(0, -1);
    } else if (measure(word) === 1 && cvc(word)) word += "e";
  }

  /* 1c: terminal y. */
  if (word.endsWith("y") && hasVowel(word.slice(0, -1))) word = `${word.slice(0, -1)}i`;

  word = replace(word, STEP2, 0);
  word = replace(word, STEP3, 0);

  /* 4: the suffix comes off entirely, and `ion` needs a stem to hang on. */
  if (word.endsWith("ion")) {
    const base = word.slice(0, -3);
    if (measure(base) > 1 && (base.endsWith("s") || base.endsWith("t"))) word = base;
    else word = replace(word, STEP4, 1);
  } else {
    word = replace(word, STEP4, 1);
  }

  /* 5a: terminal e. */
  if (word.endsWith("e")) {
    const without = word.slice(0, -1);
    const m = measure(without);
    if (m > 1 || (m === 1 && !cvc(without))) word = without;
  }

  /* 5b: doubled l. */
  if (measure(word) > 1 && doubleConsonant(word) && word.endsWith("l")) word = word.slice(0, -1);

  return word;
}
