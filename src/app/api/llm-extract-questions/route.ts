import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LlmOut = { questions: string[] };

const API_KEY = process.env.GOOGLE_API_KEY || "";
const MODEL_ID = "gemini-2.5-flash-lite";

// --- helpers ---------------------------------------------------------------

function tryParseJsonFromText(text: string): LlmOut | null {
  const trimmed = text.trim();

  // First try to find JSON object in the text
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const jsonText = jsonMatch[0];

  // Try to fix common JSON issues
  try {
    return JSON.parse(jsonText) as LlmOut;
  } catch {
    // Try to fix trailing commas
    try {
      const fixedJson = jsonText
        .replace(/,(\s*[}\]])/g, "$1") // Remove trailing commas before } or ]
        .replace(/,(\s*$)/g, ""); // Remove trailing commas at end
      return JSON.parse(fixedJson) as LlmOut;
    } catch {
      // Try to extract just the questions array if the object structure is malformed
      try {
        const questionsMatch = jsonText.match(
          /"questions"\s*:\s*\[([\s\S]*?)\]/
        );
        if (questionsMatch) {
          const questionsText = questionsMatch[1];
          // Split by comma and clean up each question
          const questions = questionsText
            .split(",")
            .map((q) => q.trim().replace(/^["']|["']$/g, ""))
            .filter((q) => q.length > 0);
          return { questions };
        }
      } catch {
        // If JSON is truncated, try to extract questions from what we have
        const truncatedMatch = jsonText.match(/"questions"\s*:\s*\[([\s\S]*)/);
        if (truncatedMatch) {
          const questionsText = truncatedMatch[1];
          // Split by comma and clean up each question, handling incomplete last question
          const questions = questionsText
            .split(",")
            .map((q) => q.trim().replace(/^["']|["']$/g, ""))
            .filter(
              (q) =>
                q.length > 0 && !q.includes('"questions"') && !q.includes("}")
            );
          if (questions.length > 0) {
            console.warn(
              "JSON appears truncated, extracted partial questions:",
              questions.length
            );
            return { questions };
          }
        }
        return null;
      }
      return null;
    }
  }
}

function normalize(s: string): string {
  return s
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STARTERS = /^(does(?:\s+the\s+p&?p)?|do|is|are|will|shall|must)\s/i;

function looksLikeQuestion(s: string): boolean {
  const t = s.trim();
  // More flexible: any string ending with ? or starting with common question words
  return (
    /\?$/.test(t) ||
    STARTERS.test(t) ||
    /^(what|when|where|why|how|which|who)\s/i.test(t)
  );
}

function cleanupAndDedupe(list: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (typeof item !== "string") continue;
    let q = normalize(item);
    if (!q) continue;

    // Ensure trailing '?'
    if (!q.endsWith("?")) q = `${q}?`;

    if (!looksLikeQuestion(q)) continue;

    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }

  console.log(`Extracted ${out.length} questions`);
  return out;
}

async function callGeminiExtract(inputText: string): Promise<string[]> {
  if (!API_KEY) throw new Error("Missing GOOGLE_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_ID}:generateContent?key=${encodeURIComponent(
    API_KEY
  )}`;

  const prompt = `Extract audit questions from PDF text. Return JSON only:
{"questions": ["question1", "question2"]}

Rules: Questions only, end with ?, no trailing commas, valid JSON.

Text: ${inputText}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1, // Lower temperature for more consistent output
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${msg}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const llmResponse = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  const parsed = tryParseJsonFromText(llmResponse);
  if (!parsed || !Array.isArray(parsed.questions)) {
    // Check if response appears truncated
    if (llmResponse.includes('"questions"') && !llmResponse.includes("]")) {
      throw new Error("LLM response appears truncated");
    }
    throw new Error("Model did not return valid JSON with a questions array");
  }

  return cleanupAndDedupe(parsed.questions);
}

// --- route -----------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as {
      text: string;
    };

    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "Provide { text: string }" }),
        {
          status: 400,
        }
      );
    }

    const questions = await callGeminiExtract(text);

    return new Response(
      JSON.stringify({ questions, count: questions.length }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
