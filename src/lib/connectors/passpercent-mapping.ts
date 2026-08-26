/**
 * PassPercent mapping — the pure core.
 *
 * Every function here is pure: `(inputs) -> { value, warnings }` (or a bare
 * value for the two simplest functions). No HTTP, no Mongoose models, no
 * `Date.now()`. Task 6 wraps these in the actual sync protocol (fetching
 * `GET /partner/schema`, resolving topper photos via `readPublicMedia`,
 * calling `PUT /partner/institution/results/:year`); Task 8 calls that.
 *
 * Two things this file resolves against PassPercent's LIVE Mongoose schema
 * (`/Users/automicai/Documents/GitHub/passpercent/backend/src/models/Institution.js`,
 * read directly for this task, not just the doc paraphrase of it) rather
 * than the task-5 brief's literal wording — see the two long comments below
 * ("DISAGREEMENT" and "GAP") for what and why. Both are restated in this
 * task's report for the reviewer.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const YEAR_RE = /^\d{4}(-\d{2,4})?$/;

function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function nonEmptyStr(v: unknown): string | undefined {
  const s = str(v);
  return s !== undefined && s.length > 0 ? s : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Drops keys whose value is `undefined` so produced objects never carry a
 * key IDAP had nothing for — the "never send empty" discipline applied to
 * plain objects, not just strings. */
function omitUndefined<T extends Rec>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Rec)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// mapStream
// ---------------------------------------------------------------------------

/**
 * IDAP `Result.level` (+ institution type for UG) -> PassPercent stream key.
 * Pinned map (verified against both codebases, spec §6.4):
 *   CLASS_10 -> sslc
 *   CLASS_12, PUC_2 -> puc
 *   UG + ENGINEERING_COLLEGE -> engineering
 *   UG + MEDICAL_COLLEGE | NURSING_COLLEGE -> medical
 *   UG + any other institution type -> degree
 *   PUC_1, PG, DIPLOMA, OTHER -> unmapped (null)
 * Returns null for anything unrecognized too — the caller is responsible for
 * warning, since this function has no `warnings` output of its own.
 */
export function mapStream(level: string, institutionType: string): string | null {
  switch (level) {
    case "CLASS_10":
      return "sslc";
    case "CLASS_12":
    case "PUC_2":
      return "puc";
    case "UG":
      if (institutionType === "ENGINEERING_COLLEGE") return "engineering";
      if (institutionType === "MEDICAL_COLLEGE" || institutionType === "NURSING_COLLEGE") return "medical";
      return "degree";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// deriveStreams
// ---------------------------------------------------------------------------

const SEGMENT_STREAM_MAP: Record<string, string> = {
  SCHOOL: "sslc",
  PRE_UNIVERSITY: "puc",
  DEGREE: "degree",
  ENGINEERING: "engineering",
};

/** Canonical order for deterministic output — matches PassPercent's own
 * stream-key enum ordering (map §5: sslc, puc, degree, engineering, medical,
 * management). `management` never appears here — nothing in this phase
 * produces it. */
const STREAM_ORDER = ["sslc", "puc", "degree", "engineering", "medical"];

/**
 * Union of segment-derived streams and every stream the results payload will
 * push. The `streams` field on the profile patch MUST be a superset of every
 * key `buildResultsPayloads` uses, or PassPercent's results push 400s citing
 * an unknown stream — this function is what guarantees that superset.
 */
export function deriveStreams(input: {
  segments: string[];
  institutionType: string;
  mappedResultStreams: string[];
}): string[] {
  const set = new Set<string>();
  for (const segment of input.segments) {
    const stream = SEGMENT_STREAM_MAP[segment];
    if (stream) set.add(stream);
  }
  if (input.institutionType === "MEDICAL_COLLEGE") set.add("medical");
  for (const stream of input.mappedResultStreams) set.add(stream);

  const ordered = STREAM_ORDER.filter((s) => set.has(s));
  const extras = [...set].filter((s) => !STREAM_ORDER.includes(s));
  return [...ordered, ...extras];
}

// ---------------------------------------------------------------------------
// buildProfilePatch
// ---------------------------------------------------------------------------

type SchemaField = { name: string; enum?: string[] };

/** IDAP institution field -> PassPercent profile field. `type` is
 * deliberately absent from this list: PassPercent write-restricts it to
 * `School`/`College` and rejects anything else with a 409, so it is NEVER
 * emitted regardless of what IDAP's institution record carries. */
const PROFILE_FIELD_MAP: [string, string][] = [
  ["institutionName", "name"],
  ["city", "city"],
  ["description", "about"],
  ["phone", "phone"],
  ["website", "website"],
  ["address", "addressLine"],
  ["area", "area"],
  ["district", "district"],
  ["taluk", "taluk"],
  ["state", "state"],
  ["pincode", "pincode"],
];

export function buildProfilePatch(input: {
  institution: Rec;
  streams: string[];
  schemaFields: SchemaField[];
}): { patch: Rec; warnings: string[] } {
  const { institution, streams, schemaFields } = input;
  const warnings: string[] = [];
  const patch: Rec = {};

  for (const [from, to] of PROFILE_FIELD_MAP) {
    const value = nonEmptyStr(institution[from]);
    if (value !== undefined) patch[to] = value;
    // undefined/null/"" -> omitted; PassPercent 400s on empty name/city.
  }

  patch.streams = streams;

  const academic = rec(institution.academic);
  const board = academic ? nonEmptyStr(academic.board) : undefined;
  if (board !== undefined) {
    const boardField = schemaFields.find((f) => f.name === "board");
    if (boardField?.enum?.includes(board)) {
      patch.board = board;
    } else {
      warnings.push(
        `Institution board "${board}" is not in PassPercent's board enum — dropped from the profile patch`,
      );
    }
  }

  // `type` is never emitted — see PROFILE_FIELD_MAP's comment.

  return { patch, warnings };
}

// ---------------------------------------------------------------------------
// buildResultsPayloads
// ---------------------------------------------------------------------------

type MappedTopper = { rank: number; name: string; pct: number; photoKey?: string };

/**
 * PassPercent's `TopperSchema` requires `{rank, name, pct}`. IDAP's
 * `percentage` is DTO-typed as a required number, but `rank` is optional —
 * a topper with `rank == null` is skipped and warned (never invent a rank).
 * `note` is not mapped (`subject` on PassPercent's side has different
 * semantics). `photoKey` (from IDAP's `photoUrl`, the storage key) rides
 * along for Task 6 to resolve into an inlined photo; Task 6 strips it before
 * sending.
 */
function mapToppers(source: unknown, warnings: string[], context: string): MappedTopper[] {
  const list = arr(source);
  if (!list) return [];
  const out: MappedTopper[] = [];
  for (const raw of list) {
    const t = rec(raw);
    if (!t) continue;
    const rank = num(t.rank);
    const name = str(t.name) ?? "";
    if (rank == null) {
      warnings.push(`Topper "${name || "(unnamed)"}" in ${context} has no rank — skipped`);
      continue;
    }
    out.push(
      omitUndefined({
        rank,
        name,
        pct: num(t.percentage) ?? 0,
        photoKey: nonEmptyStr(t.photoUrl),
      }) as MappedTopper,
    );
  }
  return out;
}

/**
 * PassPercent's `ExamTopperSchema` is rank-centric like board toppers but
 * uses `score` (optional) instead of `pct` — mapped from IDAP's shared
 * topper type's `percentage` field, the only numeric field it carries.
 * ExamTopperSchema also has an optional `photo` field (verified against the
 * live schema), so selection toppers get `photoKey` too, matching board
 * toppers, even though the brief's line for this rule didn't spell it out.
 */
function mapSelectionToppers(source: unknown, warnings: string[], context: string): Rec[] {
  const list = arr(source);
  if (!list) return [];
  const out: Rec[] = [];
  for (const raw of list) {
    const t = rec(raw);
    if (!t) continue;
    const rank = num(t.rank);
    const name = str(t.name) ?? "";
    if (rank == null) {
      warnings.push(`Selection topper "${name || "(unnamed)"}" in ${context} has no rank — skipped`);
      continue;
    }
    out.push(
      omitUndefined({
        name,
        rank,
        score: num(t.percentage),
        photoKey: nonEmptyStr(t.photoUrl),
      }),
    );
  }
  return out;
}

/**
 * Combination fields per the brief: appeared, passed, distinction,
 * firstClass, highestScore (unrenamed), averageScore -> avgScore (renamed),
 * grades (verbatim — IDAP's combination-level `grades` already uses
 * PassPercent's exact fixed bucket keys, see the GAP note below),
 * boys/girls, toppers (same rank-less-skip rule as board toppers).
 */
function mapCombination(raw: Rec, warnings: string[], context: string): Rec {
  const boys = rec(raw.boys);
  const girls = rec(raw.girls);
  const toppers = mapToppers(raw.toppers, warnings, context);
  const grades = rec(raw.grades);

  return omitUndefined({
    appeared: num(raw.appeared),
    passed: num(raw.passed),
    distinction: num(raw.distinction),
    firstClass: num(raw.firstClass),
    highestScore: num(raw.highestScore),
    avgScore: num(raw.averageScore),
    grades,
    boys: boys ? omitUndefined({ appeared: num(boys.appeared), passed: num(boys.passed) }) : undefined,
    girls: girls ? omitUndefined({ appeared: num(girls.appeared), passed: num(girls.passed) }) : undefined,
    toppers: toppers.length ? toppers : undefined,
  });
}

/**
 * Recruiter category maps identity-lowercase for all six IDAP
 * `RECRUITER_CATEGORIES` values (IT -> it, PRODUCT -> product, CORE -> core,
 * CONSULTING -> consulting, STARTUP -> startup, OTHER -> other) — IDAP's own
 * schema already restricts recruiter.category to this closed enum, so a
 * plain `.toLowerCase()` is exhaustively correct without a lookup table.
 */
function mapRecruiter(raw: unknown): Rec {
  const r = rec(raw) ?? {};
  const category = str(r.category);
  return omitUndefined({
    name: str(r.name) ?? "",
    category: category ? category.toLowerCase() : undefined,
    selected: num(r.selected),
    avgPackage: num(r.averagePackage),
    tieUp: bool(r.tieUp),
    roles: arr(r.roles),
  });
}

/**
 * Stream-level placement: eligible, placed, highestPackage,
 * averagePackage -> avgPackage (renamed), placementPct computed
 * (placed/eligible*100, 1dp) only when both are non-null and eligible > 0.
 *
 * DISAGREEMENT WITH THE BRIEF, RESOLVED IN FAVOR OF THE MAP (per this task's
 * dispatch: "where the brief and the map disagree, the map wins"):
 * task-5-brief.md line 35 says "recruiters -> companies array of
 * {...}". That is wrong for *stream-level* placement. Reading
 * PassPercent's live schema directly
 * (backend/src/models/Institution.js) shows `companies: [RecruiterSchema]`
 * exists ONLY on `CombinationDataSchema` (branch-level placement, alongside
 * a legacy `recruiters: [String]`). The field IDAP's top-level
 * `ResultDTO.placement` — which is stream-level, not branch-level — must
 * write to is `StreamPlacementSchema.recruiters: [RecruiterSchema]`. IDAP
 * has no per-combination placement data at all (ResultDTO's `combinations[]`
 * items carry no eligible/placed/etc.), so `companies` never needs to be
 * emitted by this module. Implemented here as `recruiters`, matching the
 * live schema; flagged in this task's report.
 */
function mapPlacement(raw: Rec): Rec {
  const eligible = num(raw.eligible);
  const placed = num(raw.placed);
  const out: Rec = omitUndefined({
    eligible,
    placed,
    highestPackage: num(raw.highestPackage),
    avgPackage: num(raw.averagePackage),
  });
  if (eligible != null && placed != null && eligible > 0) {
    out.placementPct = round1((placed / eligible) * 100);
  }
  const recruiters = arr(raw.recruiters);
  if (recruiters && recruiters.length > 0) {
    out.recruiters = recruiters.map(mapRecruiter);
  }
  return out;
}

/** IDAP exam code -> PassPercent selection key. Verified against both
 * codebases (map §5): NEET -> neet, JEE_MAIN -> jeeMain,
 * JEE_ADVANCED -> jeeAdvanced, KCET -> kcet, COMEDK -> comedk. */
const EXAM_CODE_MAP: Record<string, string> = {
  NEET: "neet",
  JEE_MAIN: "jeeMain",
  JEE_ADVANCED: "jeeAdvanced",
  KCET: "kcet",
  COMEDK: "comedk",
};

function mapSelections(list: unknown[], warnings: string[], context: string): Rec {
  const out: Rec = {};
  for (const raw of list) {
    const sel = rec(raw);
    if (!sel) continue;
    const examCode = str(sel.examCode);
    const mappedKey = examCode ? EXAM_CODE_MAP[examCode] : undefined;
    if (!mappedKey) {
      warnings.push(`Unrecognized exam code "${examCode ?? "(missing)"}" in ${context} — selection skipped`);
      continue;
    }
    const toppers = mapSelectionToppers(sel.toppers, warnings, `${context} ${mappedKey} selection`);
    out[mappedKey] = omitUndefined({
      appeared: num(sel.appeared),
      qualified: num(sel.qualified),
      bestRank: num(sel.bestRank),
      toppers: toppers.length ? toppers : undefined,
    });
  }
  return out;
}

/**
 * Rolls up every IDAP result landing on one (stream, year) into a single
 * PassPercent `StreamData` object.
 *
 * GAP (not a brief/map disagreement, but worth surfacing): the brief's
 * rollup rule lists "grades buckets summed key-by-key (keys are identical in
 * both systems...)" as a top-level rule alongside appeared/passed/boys/girls.
 * PassPercent's live schema does have a top-level `StreamDataSchema.grades`
 * field. But IDAP's `ResultDTO` has NO top-level field with matching keys —
 * only a freeform `bands[]` (arbitrary label/min/max/count, unrelated shape,
 * see `src/models/Result.ts`'s `BandSchema` vs `GradeCountsSchema`). The only
 * IDAP field that actually has PassPercent's exact fixed bucket keys is
 * `combinations[].grades` (built from `GradeCountsSchema`, matching
 * PassPercent's `GradesSchema` key-for-key). This module therefore passes
 * `grades` through verbatim at the COMBINATION level only (see
 * `mapCombination`) and does not populate a top-level `grades` field on the
 * stream object — inventing a bands-to-buckets conversion isn't specified
 * anywhere and would be re-deriving a value the brief didn't pin. Flagged in
 * this task's report for confirmation before Task 6/8 assume otherwise.
 */
function buildStreamData(streamKey: string, year: string, group: Rec[], warnings: string[]): Rec {
  const context = `stream "${streamKey}" / year "${year}"`;

  let appearedSum = 0;
  let appearedAny = false;
  let passedSum = 0;
  let passedAny = false;

  let boysAppearedSum = 0;
  let boysAppearedAny = false;
  let boysPassedSum = 0;
  let boysPassedAny = false;

  let girlsAppearedSum = 0;
  let girlsAppearedAny = false;
  let girlsPassedSum = 0;
  let girlsPassedAny = false;

  const toppers: MappedTopper[] = [];
  const combinationsByLabel = new Map<string, Rec>();
  let placement: Rec | undefined;
  let selections: Rec | undefined;

  for (const raw of group) {
    const resultId = nonEmptyStr(raw.id) ?? nonEmptyStr(raw.board) ?? "(unidentified result)";

    // appeared/passed: summed ONLY across results where the field `!= null`
    // — a reported zero (`appeared: 0`) counts and contributes 0; a result
    // that never reported it contributes nothing AND is warned. `!= null`
    // (not truthiness) is the only guard that tells these apart, since 0 is
    // falsy but a perfectly valid reported count.
    const appeared = num(raw.appeared);
    if (appeared != null) {
      appearedSum += appeared;
      appearedAny = true;
    } else {
      warnings.push(`Result ${resultId} in ${context} has no reported "appeared" — excluded from the rollup`);
    }

    const passed = num(raw.passed);
    if (passed != null) {
      passedSum += passed;
      passedAny = true;
    } else {
      warnings.push(`Result ${resultId} in ${context} has no reported "passed" — excluded from the rollup`);
    }

    const boys = rec(raw.boys);
    if (boys) {
      const ba = num(boys.appeared);
      if (ba != null) {
        boysAppearedSum += ba;
        boysAppearedAny = true;
      } else {
        warnings.push(`Result ${resultId} in ${context} has no reported boys.appeared — excluded from the rollup`);
      }
      const bp = num(boys.passed);
      if (bp != null) {
        boysPassedSum += bp;
        boysPassedAny = true;
      } else {
        warnings.push(`Result ${resultId} in ${context} has no reported boys.passed — excluded from the rollup`);
      }
    }

    const girls = rec(raw.girls);
    if (girls) {
      const ga = num(girls.appeared);
      if (ga != null) {
        girlsAppearedSum += ga;
        girlsAppearedAny = true;
      } else {
        warnings.push(`Result ${resultId} in ${context} has no reported girls.appeared — excluded from the rollup`);
      }
      const gp = num(girls.passed);
      if (gp != null) {
        girlsPassedSum += gp;
        girlsPassedAny = true;
      } else {
        warnings.push(`Result ${resultId} in ${context} has no reported girls.passed — excluded from the rollup`);
      }
    }

    toppers.push(...mapToppers(raw.toppers, warnings, context));

    const combos = arr(raw.combinations);
    if (combos) {
      for (const c of combos) {
        const combo = rec(c);
        if (!combo) continue;
        const label = nonEmptyStr(combo.label);
        if (!label) continue;
        if (combinationsByLabel.has(label)) {
          warnings.push(
            `Duplicate combination label "${label}" in ${context} — keeping the first, discarding a later result's entry`,
          );
          continue;
        }
        combinationsByLabel.set(label, mapCombination(combo, warnings, `${context}, combination "${label}"`));
      }
    }

    const rawPlacement = rec(raw.placement);
    if (rawPlacement) {
      if (placement === undefined) {
        placement = mapPlacement(rawPlacement);
      } else {
        warnings.push(
          `Duplicate placement data in ${context} — keeping the first result's placement, discarding a later one`,
        );
      }
    }

    const rawSelections = arr(raw.selections);
    if (rawSelections && rawSelections.length > 0) {
      if (selections === undefined) {
        selections = mapSelections(rawSelections, warnings, context);
      } else {
        warnings.push(
          `Duplicate selections data in ${context} — keeping the first result's selections, discarding a later one`,
        );
      }
    }
  }

  const streamData: Rec = {};
  if (appearedAny) streamData.appeared = appearedSum;
  if (passedAny) streamData.passed = passedSum;
  // passPct is NEVER an average of the group's percentages — it is always
  // recomputed from the summed appeared/passed, and only when appeared > 0.
  if (appearedAny && appearedSum > 0) {
    streamData.passPct = round1((passedSum / appearedSum) * 100);
  }
  if (boysAppearedAny || boysPassedAny) {
    streamData.boys = omitUndefined({
      appeared: boysAppearedAny ? boysAppearedSum : undefined,
      passed: boysPassedAny ? boysPassedSum : undefined,
    });
  }
  if (girlsAppearedAny || girlsPassedAny) {
    streamData.girls = omitUndefined({
      appeared: girlsAppearedAny ? girlsAppearedSum : undefined,
      passed: girlsPassedAny ? girlsPassedSum : undefined,
    });
  }
  if (toppers.length) streamData.toppers = toppers;
  if (combinationsByLabel.size) streamData.combinations = Object.fromEntries(combinationsByLabel);
  if (placement) streamData.placement = placement;
  if (selections) streamData.selections = selections;

  return streamData;
}

export function buildResultsPayloads(input: {
  results: Rec[];
  institutionType: string;
}): { byYear: Map<string, { streams: Rec }>; warnings: string[] } {
  const warnings: string[] = [];
  // year -> stream -> contributing results, in input order.
  const groups = new Map<string, Map<string, Rec[]>>();

  for (const raw of input.results) {
    const level = str(raw.level) ?? "";
    const year = str(raw.academicYear) ?? "";

    const stream = mapStream(level, input.institutionType);
    if (!stream) {
      warnings.push(`Result level "${level}" for year "${year}" has no PassPercent stream mapping — skipped`);
      continue;
    }
    if (!YEAR_RE.test(year)) {
      warnings.push(`Result for stream "${stream}" has an unparseable academic year "${year}" — skipped`);
      continue;
    }

    let byStream = groups.get(year);
    if (!byStream) {
      byStream = new Map();
      groups.set(year, byStream);
    }
    const list = byStream.get(stream) ?? [];
    list.push(raw);
    byStream.set(stream, list);
  }

  const byYear = new Map<string, { streams: Rec }>();
  for (const [year, byStream] of groups) {
    const streams: Rec = {};
    for (const [streamKey, group] of byStream) {
      streams[streamKey] = buildStreamData(streamKey, year, group, warnings);
    }
    byYear.set(year, { streams });
  }

  return { byYear, warnings };
}
