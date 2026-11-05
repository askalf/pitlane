// Structure-aware input for the fuzz targets. Byte-level mutation of JSON text mostly produces text
// that does not parse, so the targets also build documents from the fuzz bytes: a template of the
// valid shape, with leaves swapped for hostile values, keys dropped and keys added. Deterministic in
// the bytes, so libFuzzer's minimiser and the corpus keep working. Not a target (run.mjs runs only
// *.fuzz.js).

/** Reads the fuzz bytes front to back; past the end it reads zeros, so a short input is still total. */
export class Cursor {
  constructor(buf) { this.buf = buf; this.at = 0; }
  byte() { return this.at < this.buf.length ? this.buf[this.at++] : 0; }
  /** A string of up to `max` bytes taken from the input, as UTF-8 with replacement characters. */
  text(max = 24) {
    const n = Math.min(this.byte() % (max + 1), Math.max(0, this.buf.length - this.at));
    const s = this.buf.subarray(this.at, this.at + n).toString('utf8');
    this.at += n;
    return s;
  }
  rest() { return this.buf.subarray(Math.min(this.at, this.buf.length)).toString('utf8'); }
}

// Words the code under test compares against or builds patterns from.
export const WORDS = [
  '', 'self-hosted', 'Linux', 'X64', 'queued', 'in_progress', 'completed', 'success', 'failure', 'skipped', 'cancelled',
  'timed_out', 'Set up job', 'online', 'offline', 'ephemeral', 'main', 'push', 'pull_request', 'toString', 'valueOf',
  '__proto__', 'constructor', 'a/b', 'a/..', 'a/b/c', '-', '.', '..', '2026-11-03T10:00:00Z', 'NaN', 'Infinity', '\u0000',
  '\r\n', '${{ x }}', '(', '[', 'x'.repeat(300),
];
const NUMBERS = [0, 1, -1, 2, 7, 1.5, 1e21, -1e21, 2 ** 31, 2 ** 53, 2 ** 53 + 2, Number.MAX_VALUE, 1793700000000];

function pick(list, c) { return list[c.byte() % list.length]; }

/** A JSON value chosen by the bytes: a scalar, a word, a text from the input, or a small container. */
export function value(c, depth = 0) {
  const tag = c.byte() % (depth > 2 ? 9 : 13);
  switch (tag) {
    case 0: return null;
    case 1: return true;
    case 2: return false;
    case 3: case 4: return pick(NUMBERS, c);
    case 5: case 6: return pick(WORDS, c);
    case 7: return c.text();
    case 8: return pick(WORDS, c).length;
    case 9: case 10: {
      const a = [];
      for (let n = c.byte() % 4; n > 0; n--) a.push(value(c, depth + 1));
      return a;
    }
    default: {
      // A null-prototype object so a key such as __proto__ stays an own property and reaches the text.
      const o = Object.create(null);
      for (let n = c.byte() % 4; n > 0; n--) o[pick(WORDS, c)] = value(c, depth + 1);
      return o;
    }
  }
}

/**
 * `template` with some leaves replaced by value(), some keys dropped, and some keys added. About one
 * leaf in five is replaced, so most of the document stays valid and the code gets past its early
 * checks to the fields behind them.
 */
export function perturb(template, c, depth = 0) {
  const roll = c.byte();
  if (roll < 48) return value(c);
  if (Array.isArray(template)) {
    const out = template.map((t) => perturb(t, c, depth + 1));
    if (c.byte() < 24) out.push(value(c));
    return out;
  }
  if (template && typeof template === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(template)) {
      if (c.byte() < 12) continue;
      out[k] = perturb(v, c, depth + 1);
    }
    if (c.byte() < 24) out[pick(WORDS, c)] = value(c);
    return out;
  }
  return template;
}
