// mend — hidden-spec-cli-01 entry, round-3 rewrite from SPEC.md alone.
//
// Implements the mend patch tool: unified diff, search/replace, V4A
// (*** Begin Patch), and JSON edit lists, in auto or --format mode.
// Behaviour is derived from SPEC.md: matching is tiered (exact, then
// trailing-whitespace-insensitive, then fully whitespace-insensitive),
// with the empty-line walk for old-text matching (an exactly-empty old
// line consumes an exactly-empty file line when present, otherwise it
// matches nothing; a non-empty old line skips exactly-empty file lines).
// A creation section's file is the `+` lines of its hunks, in order
// (SPEC 6), and its final line break follows its last `+` line.

import * as fs from "node:fs";
import * as path from "node:path";
import { runTrial } from "./runner.ts";

const FORMATS = ["unified", "search-replace", "v4a", "json", "auto"] as const;
type Format = (typeof FORMATS)[number];

class Exit2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

class EditFail extends Error {
  code: string;
  failPath: string;
  constructor(code: string, failPath: string) {
    super(code + " " + failPath);
    this.code = code;
    this.failPath = failPath;
  }
}

// ---------------------------------------------------------------- files/lines

function patchLines(text: string): string[] {
  // SPEC 3: split at \n, one trailing \r removed each, no empty piece
  // after a final \n.
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

function fileBreak(text: string): string {
  // SPEC 3: CRLF when first LF follows a CR, else LF.
  const i = text.indexOf("\n");
  if (i > 0 && text[i - 1] === "\r") return "\r\n";
  return "\n";
}

function splitFile(text: string): { lines: string[]; br: string; ends: boolean } {
  // Empty file -> ([], LF, false).
  if (text === "") return { lines: [], br: "\n", ends: false };
  const br = fileBreak(text);
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return "";
  let s = lines.join(br);
  if (ends) s += br;
  return s;
}

function isSafe(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function checkSafe(p: string): void {
  if (!isSafe(p)) throw new EditFail("unsafe", p);
}

// ---------------------------------------------------------------- matching

function stripTier(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, "");
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function lineMatch(a: string, b: string, tier: number): boolean {
  return stripTier(a, tier) === stripTier(b, tier);
}

type Occ = { pos: number; end: number; mapping: (number | null)[] };

function occurrences(old: string[], lines: string[], tier: number): Occ[] {
  // Walk matcher: O[0] anchors on a real file line at the tier; the rest
  // walks forward, where an exactly-empty O line consumes an exactly-empty
  // file line if present else matches nothing, and a non-empty O line
  // skips exactly-empty file lines. Returns (pos, end, mapping) triples;
  // mapping[k] is the file index O[k] matched, or null when it matched
  // nothing. Positions may overlap.
  if (old.length === 0) return [];
  const n = lines.length;
  const out: Occ[] = [];
  for (let i = 0; i < n; i++) {
    if (!lineMatch(old[0], lines[i], tier)) continue;
    let f = i + 1;
    const mapping: (number | null)[] = [i];
    let ok = true;
    for (let k = 1; k < old.length; k++) {
      const o = old[k];
      if (o === "") {
        if (f < n && lines[f] === "") {
          mapping.push(f);
          f += 1;
        } else {
          mapping.push(null);
        }
      } else {
        while (f < n && lines[f] === "") f += 1;
        if (f < n && lineMatch(o, lines[f], tier)) {
          mapping.push(f);
          f += 1;
        } else {
          ok = false;
          break;
        }
      }
    }
    if (ok) out.push({ pos: i, end: f, mapping });
  }
  return out;
}

function findTier(
  occsFn: (tier: number) => Occ[],
  tiers: number[],
): { tier: number | null; occs: Occ[] } {
  // First tier with >= 1 occurrence, else (null, []).
  for (const tier of tiers) {
    const occs = occsFn(tier);
    if (occs.length > 0) return { tier, occs };
  }
  return { tier: null, occs: [] };
}

function findFirstTier(
  old: string[],
  lines: string[],
  lo: number,
  tiers: number[],
): { tier: number | null; occs: Occ[] } {
  return findTier(
    (tier) => occurrences(old, lines, tier).filter((o) => o.pos >= lo),
    tiers,
  );
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

type Item = { kind: "ctx" | "old" | "new"; text: string };

function mapNewLines(
  oItems: Item[],
  nItems: Item[],
  lines: string[],
  mapping: (number | null)[],
  pos: number,
  tier: number,
): string[] {
  // A context line of N is written as the file's own matched line (mapping
  // gives the file index its O line matched); a context line whose O line
  // matched nothing is written as its own text (it is always ''). At tier 2
  // every other N line is re-indented (SPEC 5).
  const oCtxIdx: number[] = [];
  for (let k = 0; k < oItems.length; k++) if (oItems[k].kind === "ctx") oCtxIdx.push(k);
  let nCtxPos = 0;
  const fFirst = pos < lines.length ? lines[pos] : "";
  const pFirst = oItems.length > 0 ? oItems[0].text : "";
  const F = leadingWs(fFirst);
  const P = leadingWs(pFirst);
  const out: string[] = [];
  for (const item of nItems) {
    if (item.kind === "ctx") {
      const mi = mapping[oCtxIdx[nCtxPos]];
      nCtxPos += 1;
      out.push(mi !== null && mi !== undefined ? lines[mi] : item.text);
    } else if (tier === 2) {
      const text = item.text;
      if (text !== "" && text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "") !== "" && text.startsWith(P)) {
        out.push(F + text.slice(P.length));
      } else {
        out.push(text);
      }
    } else {
      out.push(item.text);
    }
  }
  return out;
}

function applyMatch(
  lines: string[],
  ends: boolean,
  oldItems: Item[],
  newItems: Item[],
  pos: number,
  end: number,
  mapping: (number | null)[],
  tier: number,
  noFinal: boolean,
  matchedToEnd: boolean,
): { lines: string[]; ends: boolean } {
  // Replace lines[pos:end] (the walk span) with mapped N lines.
  const mapped = mapNewLines(oldItems, newItems, lines, mapping, pos, tier);
  const newLines = lines.slice(0, pos).concat(mapped, lines.slice(end));
  const newEnds = matchedToEnd ? !noFinal : ends;
  return { lines: newLines, ends: newEnds };
}

// ---------------------------------------------------------------- CLI

function parseCli(argv: string[]): {
  fmt: Format;
  check: boolean;
  strict: boolean;
  patchArg: string | null;
} {
  let fmt: Format = "auto";
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (endOpts) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      endOpts = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (seen.has("check")) throw new Exit2("error: usage");
        seen.add("check");
        check = true;
      } else if (a === "--strict") {
        if (seen.has("strict")) throw new Exit2("error: usage");
        seen.add("strict");
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (seen.has("format")) throw new Exit2("error: usage");
        seen.add("format");
        const v = a.slice("--format=".length);
        if (!(FORMATS as readonly string[]).includes(v)) throw new Exit2("error: usage");
        fmt = v as Format;
      } else {
        throw new Exit2("error: usage");
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) throw new Exit2("error: usage");
  const patch = positional.length > 0 ? positional[0] : null;
  return { fmt, check, strict, patchArg: patch };
}

function isBlank(ln: string): boolean {
  return ln.trim() === "";
}

function detectFormat(lines: string[]): Format {
  const nonblank = lines.filter((ln) => ln.trim() !== "");
  if (nonblank.length === 0) throw new Exit2("error: format");
  const first = nonblank[0];
  if (first.trim() === "*** Begin Patch") return "v4a";
  const stripped = first.trimStart();
  if (stripped !== "" && (stripped[0] === "[" || stripped[0] === "{")) return "json";
  for (const ln of lines) {
    if (ln.replace(/[ \t]+$/, "") === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    if (ln.startsWith("diff --git ")) return "unified";
    if (ln.startsWith("--- ") && idx + 1 < lines.length && lines[idx + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  throw new Exit2("error: format");
}

// ---------------------------------------------------------------- unified

const HUNK_RE = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(.*)$/;
const DIFFGIT_RE = /^diff --git a\/(.*) b\/(.*)$/;

function headerPath(line: string): string {
  // Text after the four characters, up to first tab, surrounding spaces off.
  return line.slice(4).split("\t", 1)[0].trim();
}

function stripAbPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function normUnifiedPath(raw: string): string {
  // Strip one leading a//b/ prefix; the result may be '/dev/null'.
  // Null-ness is judged on the STRIPPED value (strip-then-compare): e.g.
  // 'b//dev/null' strips to '/dev/null' and means no file for the kind
  // decision, but the string '/dev/null' itself is still the path value, so
  // a creation naming it fails safety (it starts with '/').
  return stripAbPrefix(raw);
}

interface UnifiedHunk {
  a: number | null;
  body: string[];
  skipped: boolean;
}

class UnifiedSection {
  gitOld: string | null = null;
  gitNew: string | null = null;
  hdrOld: string | null = null;
  hdrNew: string | null = null;
  hasHdr = false;
  renameOld: string | null = null;
  renameNew: string | null = null;
  hasRename = false;
  newFile = false;
  deletedFile = false;
  hunks: UnifiedHunk[] = [];

  paths(): [string | null, string | null] {
    if (this.hasHdr) return [this.hdrOld, this.hdrNew];
    if (this.hasRename) return [this.renameOld, this.renameNew];
    return [this.gitOld, this.gitNew];
  }

  kind(): string {
    const [old, next] = this.paths();
    if (old === "/dev/null" || this.newFile) return "create";
    if (next === "/dev/null" || this.deletedFile) return "delete";
    if (old !== next) return "move";
    return "change";
  }
}

function startSectionFromDiffgit(ln: string, idx: number): UnifiedSection {
  const m = DIFFGIT_RE.exec(ln);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  const s = new UnifiedSection();
  // The tokens as written still carry their a//b/ prefixes; the
  // /dev/null check runs on those tokens, before the strip.
  s.gitOld = normUnifiedPath("a/" + m[1]);
  s.gitNew = normUnifiedPath("b/" + m[2]);
  return s;
}

function readBody(lines: string[], start: number): { body: string[]; next: number } {
  // Consume body lines from start. Body ends at first other line,
  // diff --git line, --- line followed by +++ line, or EOF. Trailing lines
  // whose context text is empty ('' or ' ') are not part of the body.
  const n = lines.length;
  let j = start;
  const body: string[] = [];
  while (j < n) {
    const ln = lines[j];
    if (ln.startsWith("diff --git ")) break;
    if (ln.startsWith("--- ") && j + 1 < n && lines[j + 1].startsWith("+++ ")) break;
    if (ln === "" || ln[0] === " " || ln[0] === "+" || ln[0] === "-" || ln[0] === "\\") {
      body.push(ln);
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && (body[body.length - 1] === "" || body[body.length - 1] === " ")) {
    body.pop();
  }
  return { body, next: j };
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const ln = lines[i];
    if (ln.startsWith("diff --git ")) {
      cur = startSectionFromDiffgit(ln, i);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && ln.startsWith("--- ")) {
      if (i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        cur.hdrOld = normUnifiedPath(headerPath(ln));
        cur.hdrNew = normUnifiedPath(headerPath(lines[i + 1]));
        cur.hasHdr = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader && ln.startsWith("+++ ")) {
      // lone +++ in header: any other header line, ignored
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && ln.startsWith("rename from")) {
      if (ln === "rename from" || ln.startsWith("rename from ")) {
        // Rename paths are kept verbatim: no a//b/ prefix strip.
        cur.renameOld = ln.slice("rename from".length).trim();
        cur.hasRename = true;
      }
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && ln.startsWith("rename to")) {
      if (ln === "rename to" || ln.startsWith("rename to ")) {
        cur.renameNew = ln.slice("rename to".length).trim();
        cur.hasRename = true;
      }
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && (ln === "new file mode" || ln.startsWith("new file mode "))) {
      cur.newFile = true;
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && (ln === "deleted file mode" || ln.startsWith("deleted file mode "))) {
      cur.deletedFile = true;
      i += 1;
      continue;
    }
    if (ln.startsWith("@@")) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      if (cur.kind() === "delete") {
        // Hunks not read: skip without validating the header.
        const r = readBody(lines, i + 1);
        cur.hunks.push({ a: null, body: r.body, skipped: true });
        i = r.next;
        continue;
      }
      const m = HUNK_RE.exec(ln);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const r = readBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1], 10), body: r.body, skipped: false });
      i = r.next;
      continue;
    }
    if (cur === null) {
      // Outside any section: prose, or a ---/+++ pair starting a section.
      if (ln.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        cur = new UnifiedSection();
        cur.hdrOld = normUnifiedPath(headerPath(ln));
        cur.hdrNew = normUnifiedPath(headerPath(lines[i + 1]));
        cur.hasHdr = true;
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Inside a section, after hunks, outside a body: prose ignored, except
    // a ---/+++ pair starts a new section.
    if (ln.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
      cur = new UnifiedSection();
      cur.hdrOld = normUnifiedPath(headerPath(ln));
      cur.hdrNew = normUnifiedPath(headerPath(lines[i + 1]));
      cur.hasHdr = true;
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

function hunkItems(body: string[]): { oItems: Item[]; nItems: Item[]; noFinal: boolean } {
  const oItems: Item[] = [];
  const nItems: Item[] = [];
  let lastCtxPlus = -1;
  for (let idx = 0; idx < body.length; idx++) {
    const ln = body[idx];
    if (ln === "") {
      oItems.push({ kind: "ctx", text: "" });
      nItems.push({ kind: "ctx", text: "" });
      lastCtxPlus = idx;
    } else if (ln[0] === " ") {
      oItems.push({ kind: "ctx", text: ln.slice(1) });
      nItems.push({ kind: "ctx", text: ln.slice(1) });
      lastCtxPlus = idx;
    } else if (ln[0] === "-") {
      oItems.push({ kind: "old", text: ln.slice(1) });
    } else if (ln[0] === "+") {
      nItems.push({ kind: "new", text: ln.slice(1) });
      lastCtxPlus = idx;
    } else if (ln[0] === "\\") {
      // "\ No newline at end of file": not a line, handled below.
    }
  }
  let noFinal = false;
  if (
    lastCtxPlus >= 0 &&
    lastCtxPlus + 1 < body.length &&
    body[lastCtxPlus + 1].startsWith("\\")
  ) {
    noFinal = true;
  }
  return { oItems, nItems, noFinal };
}

function applyUnifiedSection(
  sec: UnifiedSection,
  tree: Map<string, string>,
  tiers: number[],
): [string, string] | null {
  // Apply one unified section. Returns [old, new] for a successful move,
  // else null. Throws EditFail.
  const [old, next] = sec.paths();
  const kind = sec.kind();
  if (kind === "create") {
    // SPEC 6: a creation's file is the `+` lines of all its hunks, in
    // order; its final line break follows its last `+` line. Context and
    // `-` lines of a creation hunk are not file content.
    checkSafe(next as string);
    if (tree.has(next as string)) throw new EditFail("exists", next as string);
    const plus: string[] = [];
    let lastPlus: { hi: number; bi: number } | null = null;
    for (let hi = 0; hi < sec.hunks.length; hi++) {
      const h = sec.hunks[hi];
      for (let bi = 0; bi < h.body.length; bi++) {
        const ln = h.body[bi];
        if (ln.startsWith("+")) {
          plus.push(ln.slice(1));
          lastPlus = { hi, bi };
        }
      }
    }
    let ends = true;
    if (lastPlus !== null) {
      const body = sec.hunks[lastPlus.hi].body;
      if (lastPlus.bi + 1 < body.length && body[lastPlus.bi + 1].startsWith("\\")) {
        ends = false;
      }
    }
    tree.set(next as string, plus.length > 0 ? joinFile(plus, "\n", ends) : "");
    return null;
  }
  if (kind === "delete") {
    checkSafe(old as string);
    if (!tree.has(old as string)) throw new EditFail("missing", old as string);
    tree.delete(old as string);
    return null;
  }
  // Change or move.
  checkSafe(old as string);
  if (kind === "move") checkSafe(next as string);
  if (!tree.has(old as string)) throw new EditFail("missing", old as string);
  if (kind === "move" && tree.has(next as string)) throw new EditFail("exists", next as string);
  let { lines, br, ends } = splitFile(tree.get(old as string) as string);
  let d = 0;
  for (const h of sec.hunks) {
    const { oItems, nItems, noFinal } = hunkItems(h.body);
    const oLines = oItems.map((it) => it.text);
    if (oLines.length === 0) {
      let pos = (h.a as number) + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const mapped = nItems.map((it) => it.text); // no context lines when O empty
      const atEnd = pos >= lines.length;
      lines = lines.slice(0, pos).concat(mapped, lines.slice(pos));
      if (atEnd) ends = !noFinal;
      d += nItems.length - oItems.length;
      continue;
    }
    const { tier, occs } = findTier(
      (t) => occurrences(oLines, lines, t),
      tiers,
    );
    if (tier === null) throw new EditFail("no-match", old as string);
    const target = (h.a as number) - 1 + d;
    let best = occs[0];
    for (const o of occs) {
      const da = Math.abs(o.pos - target);
      const db = Math.abs(best.pos - target);
      if (da < db || (da === db && o.pos < best.pos)) best = o;
    }
    const matchedToEnd = best.end === lines.length;
    const r = applyMatch(lines, ends, oItems, nItems, best.pos, best.end, best.mapping, tier, noFinal, matchedToEnd);
    lines = r.lines;
    ends = r.ends;
    d += nItems.length - oItems.length;
  }
  if (kind === "move") {
    tree.set(next as string, joinFile(lines, br, ends));
    tree.delete(old as string);
    return [old as string, next as string];
  }
  tree.set(old as string, joinFile(lines, br, ends));
  return null;
}

// ---------------------------------------------------------------- search/replace

function marker(ln: string, text: string): boolean {
  return ln.replace(/[ \t]+$/, "") === text;
}

interface SrEdit {
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[]): SrEdit[] {
  const edits: SrEdit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0; // index just after previous block's >>>>>>> line
  let prevPath: string | null = null;
  while (i < n) {
    if (!marker(lines[i], "<<<<<<< SEARCH")) {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // Path line: nearest line before SEARCH, after prev block, non-blank,
    // stripped does not start with ```.
    let foundPath: string | null = null;
    let j = searchIdx - 1;
    while (j >= prevEnd) {
      const ln = lines[j];
      if (ln.trim() !== "" && !ln.trim().startsWith("```")) {
        foundPath = ln.trim();
        break;
      }
      j -= 1;
    }
    if (foundPath === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      foundPath = prevPath;
    }
    // Find ======= then >>>>>>> REPLACE after SEARCH.
    let sep: number | null = null;
    let k = searchIdx + 1;
    while (k < n) {
      if (marker(lines[k], "=======")) {
        sep = k;
        break;
      }
      if (marker(lines[k], ">>>>>>> REPLACE")) break;
      k += 1;
    }
    if (sep === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end: number | null = null;
    k = sep + 1;
    while (k < n) {
      if (marker(lines[k], ">>>>>>> REPLACE")) {
        end = k;
        break;
      }
      k += 1;
    }
    if (end === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const old = lines.slice(searchIdx + 1, sep);
    const next = lines.slice(sep + 1, end);
    edits.push({ path: foundPath, old, new: next });
    prevPath = foundPath;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function applySearchReplace(edit: SrEdit, tree: Map<string, string>, tiers: number[]): null {
  const path = edit.path;
  const old = edit.old;
  const next = edit.new;
  checkSafe(path);
  if (old.length === 0) {
    if (tree.has(path)) throw new EditFail("exists", path);
    tree.set(path, next.length > 0 ? joinFile(next.slice(), "\n", true) : "");
    return null;
  }
  if (!tree.has(path)) throw new EditFail("missing", path);
  const { lines, br, ends } = splitFile(tree.get(path) as string);
  const { tier, occs } = findTier((t) => occurrences(old, lines, t), tiers);
  if (tier === null) throw new EditFail("no-match", path);
  if (occs.length > 1) throw new EditFail("ambiguous", path);
  const occ = occs[0];
  const oItems: Item[] = old.map((t) => ({ kind: "old" as const, text: t }));
  const nItems: Item[] = next.map((t) => ({ kind: "new" as const, text: t }));
  const r = applyMatch(lines, ends, oItems, nItems, occ.pos, occ.end, occ.mapping, tier, false, false);
  tree.set(path, joinFile(r.lines, br, r.ends));
  return null;
}

// ---------------------------------------------------------------- v4a

const SEC_RE = /^\*\*\* (Add|Delete|Update) File:(?: (.*))?$/;
const MOVE_RE = /^\*\*\* Move to:(?: (.*))?$/;

interface V4aChunk {
  anchor: string | null;
  body: Item[];
  eof: boolean;
}

interface V4aSection {
  kind: string; // add | delete | update
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): V4aSection[] {
  const n = lines.length;
  let first: number | null = null;
  for (let idx = 0; idx < n; idx++) {
    if (!isBlank(lines[idx])) {
      first = idx;
      break;
    }
  }
  if (first === null) throw new Exit2("error: parse 1");
  if (lines[first].trim() !== "*** Begin Patch") throw new Exit2(`error: parse ${first + 1}`);
  let last: number | null = null;
  for (let idx = n - 1; idx >= 0; idx--) {
    if (!isBlank(lines[idx])) {
      last = idx;
      break;
    }
  }
  if (lines[last as number].trim() !== "*** End Patch") throw new Exit2(`error: parse ${n + 1}`);
  const lastIdx = last as number;
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < lastIdx) {
    const ln = lines[i];
    if (isBlank(ln)) {
      i += 1;
      continue;
    }
    const m = SEC_RE.exec(ln);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1].toLowerCase();
    const path = (m[2] ?? "").trim();
    const sec: V4aSection = {
      kind,
      path,
      line: i + 1,
      moveTo: null,
      addLines: [],
      chunks: [],
    };
    i += 1;
    if (kind === "add") {
      const collected: string[] = [];
      while (i < lastIdx) {
        const l2 = lines[i];
        if (SEC_RE.exec(l2)) break;
        if (l2 === "*** End Patch") throw new Exit2(`error: parse ${i + 1}`);
        if (l2.startsWith("+")) {
          collected.push(l2.slice(1));
          i += 1;
        } else if (l2 === "") {
          collected.push("");
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
      sec.addLines = collected;
    } else if (kind === "delete") {
      while (i < lastIdx) {
        const l2 = lines[i];
        if (SEC_RE.exec(l2)) break;
        if (isBlank(l2)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      // update
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let pendingBlank: number[] = [];
      let moveTo: string | null = null;
      let lastClosedByEof = false;

      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };

      while (i < lastIdx) {
        const l2 = lines[i];
        if (SEC_RE.exec(l2)) break;
        if (l2 === "*** End Patch") throw new Exit2(`error: parse ${i + 1}`);
        const mm = MOVE_RE.exec(l2);
        if (mm) {
          if (cur !== null || chunks.length > 0 || moveTo !== null) {
            throw new Exit2(`error: parse ${i + 1}`);
          }
          if (pendingBlank.length > 0) throw new Exit2(`error: parse ${pendingBlank[0] + 1}`);
          moveTo = (mm[1] ?? "").trim();
          i += 1;
          continue;
        }
        if (l2.startsWith("@@")) {
          if (pendingBlank.length > 0) throw new Exit2(`error: parse ${pendingBlank[0] + 1}`);
          closeChunk();
          lastClosedByEof = false;
          cur = { anchor: l2.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (l2 === "*** End of File") {
          if (cur === null) {
            // Trailing blanks then End of File with no chunk, or End of
            // File with no open chunk: a parse error at its line.
            throw new Exit2(`error: parse ${i + 1}`);
          }
          cur.eof = true;
          closeChunk();
          lastClosedByEof = true;
          i += 1;
          continue;
        }
        if (l2 === "" || l2[0] === " " || l2[0] === "+" || l2[0] === "-") {
          if (cur === null) {
            if (chunks.length > 0) {
              if (l2 === "") {
                pendingBlank.push(i);
                i += 1;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
            // Flush pending blanks as empty context lines.
            for (const _b of pendingBlank) cur.body.push({ kind: "ctx", text: "" });
            pendingBlank = [];
          }
          if (l2 === "") {
            cur.body.push({ kind: "ctx", text: "" });
          } else if (l2[0] === " ") {
            cur.body.push({ kind: "ctx", text: l2.slice(1) });
          } else if (l2[0] === "-") {
            cur.body.push({ kind: "old", text: l2.slice(1) });
          } else {
            cur.body.push({ kind: "new", text: l2.slice(1) });
          }
          i += 1;
          continue;
        }
        if (pendingBlank.length > 0) throw new Exit2(`error: parse ${pendingBlank[0] + 1}`);
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      // Trailing blank lines at end of section are not part of it: drop
      // trailing empty context lines from the last chunk, unless it was
      // closed by *** End of File (its blanks sit before that line, not at
      // the end of the section).
      if (chunks.length > 0 && !lastClosedByEof) {
        const body = chunks[chunks.length - 1].body;
        while (body.length > 0 && body[body.length - 1].kind === "ctx" && body[body.length - 1].text === "") {
          body.pop();
        }
      }
      sec.moveTo = moveTo;
      sec.chunks = chunks;
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${sec.line}`);
      }
    }
    sections.push(sec);
  }
  return sections;
}

function applyV4aSection(
  sec: V4aSection,
  tree: Map<string, string>,
  tiers: number[],
): [string, string] | null {
  const kind = sec.kind;
  const path = sec.path;
  if (kind === "add") {
    checkSafe(path);
    if (tree.has(path)) throw new EditFail("exists", path);
    const ls = sec.addLines;
    tree.set(path, ls.length > 0 ? joinFile(ls.slice(), "\n", true) : "");
    return null;
  }
  if (kind === "delete") {
    checkSafe(path);
    if (!tree.has(path)) throw new EditFail("missing", path);
    tree.delete(path);
    return null;
  }
  // update
  checkSafe(path);
  const newPath = sec.moveTo;
  if (newPath !== null) checkSafe(newPath);
  if (!tree.has(path)) throw new EditFail("missing", path);
  if (newPath !== null && tree.has(newPath)) throw new EditFail("exists", newPath);
  let { lines, br, ends } = splitFile(tree.get(path) as string);
  let cursor = 0;
  for (const ch of sec.chunks) {
    const anchor = ch.anchor;
    if (anchor) {
      let found: number | null = null;
      for (const tier of tiers) {
        for (let j = cursor; j < lines.length; j++) {
          if (lineMatch(anchor, lines[j], tier)) {
            found = j;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new EditFail("no-match", path);
      cursor = found + 1;
    }
    const oItems = ch.body.filter((it) => it.kind === "ctx" || it.kind === "old");
    const nItems = ch.body.filter((it) => it.kind === "ctx" || it.kind === "new");
    const oLines = oItems.map((it) => it.text);
    if (oLines.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const mapped = nItems.map((it) => it.text);
      lines = lines.slice(0, pos).concat(mapped, lines.slice(pos));
      cursor = pos + mapped.length;
      continue;
    }
    const { tier, occs } = findFirstTier(oLines, lines, cursor, tiers);
    if (tier === null) throw new EditFail("no-match", path);
    let occ: Occ;
    if (ch.eof) {
      const ok = occs.filter((o) => o.end === lines.length);
      if (ok.length === 0) throw new EditFail("no-match", path);
      occ = ok[0];
    } else {
      occ = occs[0];
    }
    const r = applyMatch(lines, ends, oItems, nItems, occ.pos, occ.end, occ.mapping, tier, false, false);
    lines = r.lines;
    ends = r.ends;
    cursor = occ.pos + nItems.length;
  }
  if (newPath !== null) {
    tree.set(newPath, joinFile(lines, br, ends));
    tree.delete(path);
    return [path, newPath];
  }
  tree.set(path, joinFile(lines, br, ends));
  return null;
}

// ---------------------------------------------------------------- json

function validateEdit(obj: unknown): JsonEdit | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const cmd = o["command"];
  if (cmd !== "create" && cmd !== "str_replace" && cmd !== "insert") return null;
  const p = o["path"];
  if (typeof p !== "string") return null;
  if (cmd === "create") {
    const ft = o["file_text"];
    if (typeof ft !== "string") return null;
    return { command: cmd, path: p, file_text: ft };
  }
  if (cmd === "str_replace") {
    const old = o["old_str"];
    if (typeof old !== "string" || old === "") return null;
    const nw = o["new_str"] === undefined ? "" : o["new_str"];
    if (typeof nw !== "string") return null;
    return { command: cmd, path: p, old_str: old, new_str: nw };
  }
  // insert
  const il = o["insert_line"];
  if (typeof il !== "number" || !Number.isInteger(il)) return null;
  const nw = o["new_str"];
  if (typeof nw !== "string") return null;
  return { command: cmd, path: p, insert_line: il, new_str: nw };
}

type JsonEdit =
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }
  | { command: "insert"; path: string; insert_line: number; new_str: string };

function parseJson(lines: string[], rawText: string): JsonEdit[] {
  const nonblank: [number, string][] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (!isBlank(lines[idx])) nonblank.push([idx, lines[idx]]);
  }
  if (nonblank.length === 0) throw new Exit2("error: parse 1");
  const [firstIdx, firstLn] = nonblank[0];
  if (firstLn.trim().startsWith("[")) {
    const startLine = firstIdx + 1;
    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Exit2(`error: parse ${startLine}`);
    }
    if (!Array.isArray(data)) throw new Exit2(`error: parse ${startLine}`);
    if (data.length === 0) throw new Exit2("error: parse 1");
    const edits: JsonEdit[] = [];
    for (const el of data) {
      const e = validateEdit(el);
      if (e === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (const [idx, ln] of nonblank) {
    let obj: unknown;
    try {
      obj = JSON.parse(ln);
    } catch {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    const e = validateEdit(obj);
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  }
  return edits;
}

function countOverlapping(text: string, sub: string): number {
  let n = 0;
  let start = 0;
  for (;;) {
    const j = text.indexOf(sub, start);
    if (j < 0) return n;
    n += 1;
    start = j + 1;
  }
}

function applyJsonEdit(edit: JsonEdit, tree: Map<string, string>): null {
  const path = edit.path;
  const cmd = edit.command;
  checkSafe(path);
  if (cmd === "create") {
    if (tree.has(path)) throw new EditFail("exists", path);
    tree.set(path, edit.file_text);
    return null;
  }
  if (!tree.has(path)) throw new EditFail("missing", path);
  if (cmd === "str_replace") {
    const text = tree.get(path) as string;
    const old = edit.old_str;
    const nw = edit.new_str;
    const { br } = splitFile(text);
    if (br === "\r\n") {
      const nt = text.split("\r\n").join("\n");
      const no = old.split("\r\n").join("\n");
      const nn = nw.split("\r\n").join("\n");
      const c = countOverlapping(nt, no);
      if (c === 0) throw new EditFail("no-match", path);
      if (c > 1) throw new EditFail("ambiguous", path);
      const res = nt.replace(no, () => nn);
      tree.set(path, res.split("\n").join("\r\n"));
    } else {
      const c = countOverlapping(text, old);
      if (c === 0) throw new EditFail("no-match", path);
      if (c > 1) throw new EditFail("ambiguous", path);
      tree.set(path, text.replace(old, () => nw));
    }
    return null;
  }
  // insert
  const { lines, br, ends } = splitFile(tree.get(path) as string);
  const il = edit.insert_line;
  if (il < 0 || il > lines.length) throw new EditFail("no-match", path);
  const ns = edit.new_str;
  let newLines: string[] = [];
  if (ns !== "") {
    const parts = ns.split("\n");
    if (ns.endsWith("\n")) parts.pop();
    newLines = parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  }
  const merged = lines.slice(0, il).concat(newLines, lines.slice(il));
  tree.set(path, joinFile(merged, br, ends));
  return null;
}

// ---------------------------------------------------------------- driver

function utf8Bytes(s: string): Buffer {
  return Buffer.from(s, "utf-8");
}

function computeChanges(
  orig: Map<string, string>,
  next: Map<string, string>,
  moves: [string, string][],
): string[] {
  const entries: [Buffer, string][] = [];
  const movePairs = new Set<string>();
  for (const [old, newp] of moves) {
    if (orig.has(old) && !next.has(old) && !orig.has(newp) && next.has(newp)) {
      entries.push([utf8Bytes(newp), `R ${old} -> ${newp}`]);
      movePairs.add(old);
      movePairs.add(newp);
    }
  }
  const allPaths = new Set<string>([...orig.keys(), ...next.keys()]);
  for (const p of allPaths) {
    if (movePairs.has(p)) continue;
    const b = orig.get(p);
    const a = next.get(p);
    if (b === a) continue;
    if (b === undefined) {
      entries.push([utf8Bytes(p), `A ${p}`]);
    } else if (a === undefined) {
      entries.push([utf8Bytes(p), `D ${p}`]);
    } else {
      entries.push([utf8Bytes(p), `M ${p}`]);
    }
  }
  entries.sort((x, y) => Buffer.compare(x[0], y[0]));
  return entries.map((e) => e[1]);
}

function listTree(root: string): Map<string, string> {
  // All regular files under root, relative paths with forward slashes.
  const tree = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const relPath = rel === "" ? name : rel + "/" + name;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, relPath);
      } else if (st.isFile()) {
        try {
          tree.set(relPath, fs.readFileSync(full, "utf-8"));
        } catch {
          // Unreadable file: leave it out of the tree.
        }
      }
    }
  };
  walk(root, "");
  return tree;
}

function writeTreeDiff(orig: Map<string, string>, next: Map<string, string>, root: string): void {
  for (const [p, content] of next) {
    if (orig.get(p) === content) continue;
    const full = path.join(root, ...p.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  for (const p of orig.keys()) {
    if (next.has(p)) continue;
    const full = path.join(root, ...p.split("/"));
    try {
      fs.unlinkSync(full);
    } catch {
      // Already gone.
    }
  }
}

type Edit =
  | { kind: "unified"; sec: UnifiedSection }
  | { kind: "sr"; edit: SrEdit }
  | { kind: "v4a"; sec: V4aSection }
  | { kind: "json"; edit: JsonEdit };

function main(argv: string[]): number {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    if (e instanceof Exit2) {
      fs.writeSync(1, e.line + "\n");
      return 2;
    }
    throw e;
  }
  const { fmt: fmt0, check, strict, patchArg } = cli;
  let patchText: string;
  if (patchArg === null || patchArg === "-") {
    patchText = fs.readFileSync(0, "utf-8");
  } else {
    try {
      patchText = fs.readFileSync(patchArg, "utf-8");
    } catch {
      fs.writeSync(1, "error: no-patch\n");
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let edits: Edit[];
  try {
    let fmt = fmt0;
    if (fmt === "auto") fmt = detectFormat(lines);
    if (fmt === "unified") {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new Exit2("error: parse 1");
      edits = sections.map((s) => ({ kind: "unified" as const, sec: s }));
    } else if (fmt === "search-replace") {
      const blocks = parseSearchReplace(lines);
      if (blocks.length === 0) throw new Exit2("error: parse 1");
      edits = blocks.map((b) => ({ kind: "sr" as const, edit: b }));
    } else if (fmt === "v4a") {
      const secs = parseV4a(lines);
      if (secs.length === 0) throw new Exit2("error: parse 1");
      edits = secs.map((s) => ({ kind: "v4a" as const, sec: s }));
    } else {
      const jedits = parseJson(lines, patchText);
      edits = jedits.map((e) => ({ kind: "json" as const, edit: e }));
    }
  } catch (e) {
    if (e instanceof Exit2) {
      fs.writeSync(1, e.line + "\n");
      return 2;
    }
    throw e;
  }
  const tree = listTree(process.cwd());
  const orig = new Map<string, string>(tree);
  const failures: EditFail[] = [];
  const moves: [string, string][] = [];
  const tiers = strict ? [0] : [0, 1, 2];
  for (const edit of edits) {
    try {
      let r: [string, string] | null = null;
      if (edit.kind === "unified") r = applyUnifiedSection(edit.sec, tree, tiers);
      else if (edit.kind === "sr") r = applySearchReplace(edit.edit, tree, tiers);
      else if (edit.kind === "v4a") r = applyV4aSection(edit.sec, tree, tiers);
      else r = applyJsonEdit(edit.edit, tree);
      if (r !== null) moves.push(r);
    } catch (e) {
      if (e instanceof EditFail) {
        failures.push(e);
      } else {
        throw e;
      }
    }
  }
  const n = edits.length;
  if (failures.length > 0) {
    let out = "";
    for (const f of failures) out += `error: ${f.code} ${f.failPath}\n`;
    out += `failed: ${failures.length} of ${n} edits\n`;
    fs.writeSync(1, out);
    return 1;
  }
  const changes = computeChanges(orig, tree, moves);
  let out = "";
  for (const ln of changes) out += ln + "\n";
  const cnt = changes.length;
  out += cnt === 1 ? "ok: 1 file\n" : `ok: ${cnt} files\n`;
  fs.writeSync(1, out);
  if (!check) writeTreeDiff(orig, tree, process.cwd());
  return 0;
}

// Entry: when the trial harness sets MAKEFUN_ENV_URL, hand the trial
// over to the kit runner (it fetches the checks, runs this CLI on each,
// and posts the results); otherwise run as the mend CLI.
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exit(main(process.argv.slice(2)));
}
