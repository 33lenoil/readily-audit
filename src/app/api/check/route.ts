import { NextRequest } from "next/server";
import { getDb } from "../../../lib/db";
import { getEmbIndex, cosineSim } from "../../../lib/embedding";
import type { Question } from "../../../types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = "Met" | "Not Met";

type PageRow = {
  fileName: string;
  relativePath: string;
  page: number;
  text: string;
};

type CheckResult = {
  questionId: string;
  status: Status;
  evidence?: { snippet: string; fileName: string; page: number };
};

// constants
const API_KEY = process.env.GOOGLE_API_KEY || "";
const GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(
  API_KEY
)}`;
const EMB_URL = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${encodeURIComponent(
  API_KEY
)}`;

if (!API_KEY) {
  console.warn("WARNING: GOOGLE_API_KEY is not set.");
}

// ========== Retrieval & Packing Knobs (tune here) ==========
const TOP_K = 80; // initial nearest neighbors by cosine
const NEIGHBOR_RADIUS = 3; // include ±3 pages for each hit
const CHAR_BUDGET = 200000; // total context characters to send to LLM
const MAX_BLOCKS = 100; // max number of packed windows
const SENT_WINDOW = 2; // include ±2 sentences around each match
const CHARS_PER_SENT_MAX = 600; // trim very long sentences
const TEMPERATURE = 0.1;

// ========== Query preprocessing ==========
function preprocessQuery(query: string): string {
  // Expand abbreviations and synonyms to improve retrieval
  const expansions = {
    PCP: "primary care provider physician doctor",
    MCP: "plan CalOptima Health organization entity",
    member: "enrollee beneficiary patient client",
    auth: "authorization prior auth preauthorization approval permission",
    notify: "inform advise alert communicate notification",
    days: "calendar days business days working days",
    within: "no later than not to exceed by",
    shall: "must will ensure require mandate",
    claim: "claims billing",
    EOB: "explanation of benefits remittance advice denial letter",
    hospice: "end of life care palliative",
    retrospective: "retro retroactive",
    "direct payment": "direct pay",
    "room and board": "room board accommodation",
  };

  let processed = query.toLowerCase();

  // Apply expansions
  for (const [abbrev, expansion] of Object.entries(expansions)) {
    const regex = new RegExp(`\\b${abbrev.toLowerCase()}\\b`, "gi");
    processed = processed.replace(regex, `${abbrev} ${expansion}`);
  }

  // Add policy-related terms to improve semantic matching
  processed +=
    " policy procedure guideline standard requirement compliance healthcare";

  return processed;
}

// ========== Embedding helper ==========
async function embedQuery(text: string): Promise<Float32Array> {
  const body = { content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY" };
  const r = await fetch(EMB_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { embedding?: { values?: number[] } };
  const v = j.embedding?.values;
  if (!Array.isArray(v)) throw new Error("No embedding.values");
  return Float32Array.from(v);
}

// ========== JSON parsing helper ==========
function tryParseJsonFromText(text: string): {
  status?: string;
  evidence?: { snippet?: string; fileName?: string; page?: number };
} | null {
  const t = text.trim();
  try {
    if (t.startsWith("{") && t.endsWith("}")) return JSON.parse(t);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function callJsonDecision(prompt: string) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: TEMPERATURE,
    },
  };
  const r = await fetch(GEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const parsed = tryParseJsonFromText(text);
  if (!parsed) throw new Error("Model did not return valid JSON");
  return parsed;
}

// ========== Evidence harvesting (sentence-level) ==========
function norm(s: string): string {
  return s
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function splitSentences(t: string): string[] {
  // simple & safe sentence splitter
  const cleaned = norm(t);
  const parts = cleaned
    .split(/(?<=[\.\?\!])\s+(?=[A-Z(])/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [cleaned];
}

// domain anchors: synonyms & signals
const Rx = {
  verb: /\b(shall|must|will|ensure|require)\b/i,
  days: /\b(\d{1,3}|\b(?:fourteen|ten|fifteen|thirty|seven|two|three|five|twelve)\b)\s+(calendar|business)\s+days?\b/i,
  auth: /\b(prior\s+)?authori[sz]e?[sd]?|pre[-\s]?auth(?:orization)?|approval\b/i,
  hospice: /\bhospice\b/i,
  retrospective: /\bretrospective\b/i,
  directPay: /\bdirect\s+payment\b/i,
  pcp: /\b(pcp|primary\s+care\s+provider)\b/i,
  notify: /\bnotify|notification\b/i,
  claim: /\bclaim[s]?\b/i,
  member: /\b(member|enrollee|beneficiary)\b/i,
  roomBoard: /\broom\s+and\s+board\b/i,
  eob: /\b(explanation\s+of\s+benefits|eob|remittance\s+advice|denial\s+letter)\b/i,
};

function sentenceScore(q: string, sent: string): number {
  // heuristic score: verbs + key concepts + numbers/days
  let score = 0;
  if (Rx.verb.test(sent)) score += 3;
  if (Rx.days.test(sent)) score += 3;
  if (Rx.auth.test(sent)) score += 2;
  if (Rx.hospice.test(sent)) score += 2;
  if (Rx.retrospective.test(sent)) score += 2;
  if (Rx.directPay.test(sent)) score += 2;
  if (Rx.pcp.test(sent)) score += 2;
  if (Rx.notify.test(sent)) score += 1;
  if (Rx.claim.test(sent)) score += 1;
  if (Rx.member.test(sent)) score += 1;
  if (Rx.roomBoard.test(sent)) score += 2;
  if (Rx.eob.test(sent)) score += 2;

  // boost if question number appears
  const numMatch = q.match(/\b(\d{1,3})\b/);
  if (numMatch && sent.toLowerCase().includes(numMatch[1])) score += 2;

  // More lenient length penalties
  const len = sent.length;
  if (len < 30) score -= 0.3; // reduced penalty
  if (len > 500) score -= 0.3; // reduced penalty and increased threshold

  // Additional scoring for policy-related terms
  if (
    /\b(policy|procedure|guideline|standard|requirement|compliance)\b/i.test(
      sent
    )
  )
    score += 1;
  if (/\b(shall|must|will|ensure|require|mandate)\b/i.test(sent)) score += 1.5;
  if (/\b(within|no later than|not to exceed|prior to|before)\b/i.test(sent))
    score += 1;

  return score;
}

type Block = { fileName: string; page: number; text: string; score: number };

// More lenient harvesting for when initial approach fails
function harvestBlocksLenient(
  q: string,
  pages: Array<{ fileName: string; page: number; text: string; base: number }>
): Block[] {
  const blocks: Block[] = [];
  for (const p of pages) {
    const sents = splitSentences(p.text);
    for (let i = 0; i < sents.length; i++) {
      const core = sents[i].slice(0, CHARS_PER_SENT_MAX);
      const sc = sentenceScore(q, core);

      // Much more lenient scoring - include almost everything
      if (sc < -1) continue; // only exclude very negative scores

      // include ± window
      const win: string[] = [core];
      for (let w = 1; w <= SENT_WINDOW; w++) {
        if (i - w >= 0) win.unshift(sents[i - w].slice(0, CHARS_PER_SENT_MAX));
        if (i + w < sents.length)
          win.push(sents[i + w].slice(0, CHARS_PER_SENT_MAX));
      }
      const text = norm(win.join(" "));

      // combine sentence score w/ page base (cosine rank turned into small bonus)
      const score = Math.max(sc + p.base, 0.1); // ensure minimum score

      blocks.push({ fileName: p.fileName, page: p.page, text, score });
    }
  }

  // dedupe similar blocks by key
  const seen = new Set<string>();
  const deduped: Block[] = [];
  for (const b of blocks) {
    const key = `${b.fileName}#${b.page}#${b.text.slice(0, 160).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(b);
  }

  // sort by score descending
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function harvestBlocks(
  q: string,
  pages: Array<{ fileName: string; page: number; text: string; base: number }>
): Block[] {
  const blocks: Block[] = [];
  for (const p of pages) {
    const sents = splitSentences(p.text);
    for (let i = 0; i < sents.length; i++) {
      const core = sents[i].slice(0, CHARS_PER_SENT_MAX);
      const sc = sentenceScore(q, core);
      if (sc <= 0) continue;

      // include ± window
      const win: string[] = [core];
      for (let w = 1; w <= SENT_WINDOW; w++) {
        if (i - w >= 0) win.unshift(sents[i - w].slice(0, CHARS_PER_SENT_MAX));
        if (i + w < sents.length)
          win.push(sents[i + w].slice(0, CHARS_PER_SENT_MAX));
      }
      const text = norm(win.join(" "));

      // combine sentence score w/ page base (cosine rank turned into small bonus)
      const score = sc + p.base;

      blocks.push({ fileName: p.fileName, page: p.page, text, score });
    }
  }

  // dedupe similar blocks by key
  const seen = new Set<string>();
  const deduped: Block[] = [];
  for (const b of blocks) {
    const key = `${b.fileName}#${b.page}#${b.text.slice(0, 160).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(b);
  }

  // sort by score descending
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

function packBlocks(blocks: Block[]): string[] {
  const out: string[] = [];
  let used = 0;

  // More aggressive packing: try to fit more content within budget
  for (let i = 0; i < blocks.length && out.length < MAX_BLOCKS; i++) {
    const b = blocks[i];
    const chunk = `[${out.length + 1}] ${b.fileName} p.${b.page}\n"""${
      b.text
    }"""`;

    // Allow going slightly over budget for important blocks (first 20 blocks)
    const budgetThreshold = out.length < 20 ? CHAR_BUDGET * 1.1 : CHAR_BUDGET;

    if (used + chunk.length > budgetThreshold) {
      // If we're still early in the process, try to fit this block anyway
      if (out.length < 10) {
        out.push(chunk);
        used += chunk.length + 2;
        continue;
      }
      break;
    }

    out.push(chunk);
    used += chunk.length + 2;
  }
  return out;
}

// ========== tiny concurrency ==========
async function pMap<T, R>(
  arr: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, arr.length) },
    async function worker() {
      for (; i < arr.length; ) {
        const idx = i++;
        out[idx] = await fn(arr[idx] as T, idx);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

// ─────────── Route ───────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { questions: Question[] };
    if (
      !body ||
      !Array.isArray(body.questions) ||
      body.questions.length === 0
    ) {
      return new Response(
        JSON.stringify({ error: "Provide { questions: Question[] }" }),
        {
          status: 400,
        }
      );
    }

    // DB: fetch page text by (fileName, page)
    const db = getDb();

    // Embedding index
    const emb = getEmbIndex();
    const vecs = emb.items.map((it) => Float32Array.from(it.vector));

    const results = await pMap(
      body.questions,
      4,
      async (q): Promise<CheckResult> => {
        // 1) Embed query (with preprocessing for better retrieval)
        let qVec: Float32Array;
        try {
          const processedQuery = preprocessQuery(q.text);
          qVec = await embedQuery(processedQuery);
        } catch {
          return {
            questionId: q.id,
            status: "Not Met",
          };
        }

        // 2) Nearest neighbors
        const scoredIdx: Array<{ idx: number; score: number }> = [];
        for (let i = 0; i < vecs.length; i++) {
          scoredIdx.push({ idx: i, score: cosineSim(qVec, vecs[i]) });
        }
        scoredIdx.sort((a, b) => b.score - a.score);
        const top = scoredIdx
          .slice(0, TOP_K)
          .map(({ idx, score }) => ({ item: emb.items[idx], score }));

        // 3) Expand with neighbors (±NEIGHBOR_RADIUS)
        const want = new Map<
          string,
          { fileName: string; page: number; base: number }
        >();
        for (const { item, score } of top) {
          for (let d = -NEIGHBOR_RADIUS; d <= NEIGHBOR_RADIUS; d++) {
            const pg = item.page + d;
            if (pg < 1) continue;
            const key = `${item.fileName}#${pg}`;
            // Base score: normalized cosine rank → small bonus
            const base = 0.25 * score;
            if (!want.has(key))
              want.set(key, { fileName: item.fileName, page: pg, base });
          }
        }

        // 4) Pull text for wanted pages
        const pages: Array<{
          fileName: string;
          page: number;
          text: string;
          base: number;
        }> = [];
        for (const v of want.values()) {
          let row: PageRow | undefined;
          try {
            row = db.get(v.fileName, v.page);
          } catch {}
          if (!row?.text) continue;
          pages.push({
            fileName: v.fileName,
            page: v.page,
            text: String(row.text),
            base: v.base,
          });
        }

        if (pages.length === 0) {
          return {
            questionId: q.id,
            status: "Not Met",
          };
        }

        // 5) Harvest + pack many small evidence windows within budget
        const blocks = harvestBlocks(q.text, pages);
        let packed = packBlocks(blocks);

        // If we still have very few blocks, try a more aggressive approach
        if (packed.length < 5) {
          const lenientBlocks = harvestBlocksLenient(q.text, pages);
          packed = packBlocks(lenientBlocks);
        }
        if (packed.length === 0) {
          // fallback: coarse packing of whole pages if no sentence hits
          const fallbackPages = Math.min(pages.length, 20);
          const chunkSize = Math.floor(CHAR_BUDGET / fallbackPages);

          for (const p of pages.slice(0, fallbackPages)) {
            const txt = norm(p.text).slice(0, chunkSize);
            packed.push(
              `[${packed.length + 1}] ${p.fileName} p.${p.page}\n"""${txt}"""`
            );
            if (packed.join("\n\n").length > CHAR_BUDGET) break;
          }
        }
        const context = packed.join("\n\n");

        // 6) Decision (looser rubric still)
        const prompt = `
You are a healthcare compliance auditor. Decide if the requirement is MET or NOT MET based ONLY on the provided excerpts.
If MET, include a verbatim evidence snippet and its citation.

Return STRICT JSON only:
{
  "status": "Met" | "Not Met",
  "evidence": { "snippet": string, "fileName": string, "page": number }
}

REQUIREMENT:
${q.text}

EXCERPTS:
${context}

Decision rubric (recall-favoring):
- Consider the policy MET if its language clearly commits to the requirement, even if phrasing differs.
- Treat these as equivalent: 
  • "no later than" ~ "within" ~ "not to exceed" ~ "by" (+ number of days)
  • "authorization" ~ "prior auth" ~ "preauthorization" ~ "approval" ~ "permission"
  • "PCP" ~ "primary care provider" ~ "physician" ~ "doctor"
  • "Member" ~ "enrollee" ~ "beneficiary" ~ "patient" ~ "client"
  • "MCP" ~ "plan" ~ "CalOptima Health" ~ "organization" ~ "entity"
  • "calendar days" ~ "business days" ~ "working days" (unless specifically different)
  • "notify" ~ "inform" ~ "advise" ~ "alert" ~ "communicate"
- Number forms like "fourteen (14) calendar days" ~ "14 calendar days" ~ "fourteen calendar days".
- If evidence spans multiple sentences, choose ONE that most directly states the commitment.
- Look for implicit commitments - if the policy describes a process that logically requires the action, consider it MET.
- Consider partial matches - if the requirement is mostly met with minor variations, lean toward MET.
- Only answer "Not Met" if the excerpts clearly do NOT support the requirement or contradict it.
`.trim();

        try {
          const parsed = (await callJsonDecision(prompt)) as {
            status?: string;
            evidence?: { snippet?: string; fileName?: string; page?: number };
          };

          const status: Status = parsed?.status === "Met" ? "Met" : "Not Met";
          const evidence =
            status === "Met" &&
            parsed?.evidence &&
            typeof parsed.evidence.snippet === "string" &&
            typeof parsed.evidence.fileName === "string" &&
            typeof parsed.evidence.page === "number"
              ? {
                  snippet: parsed.evidence.snippet,
                  fileName: parsed.evidence.fileName,
                  page: parsed.evidence.page,
                }
              : undefined;

          return {
            questionId: q.id,
            status,
            evidence,
          };
        } catch {
          return {
            questionId: q.id,
            status: "Not Met",
          };
        }
      }
    );

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
