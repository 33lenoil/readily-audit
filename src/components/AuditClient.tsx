"use client";

import React, { useState, useEffect } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Progress,
  Tabs,
  Tab,
  Alert,
} from "@heroui/react";
import {
  DocumentArrowUpIcon,
  PlayIcon,
  CheckCircleIcon,
  XCircleIcon,
  DocumentTextIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { Question } from "../types";

type CheckResult = {
  questionId: string;
  status: "Met" | "Not Met";
  evidence?: { snippet: string; fileName: string; page: number };
  rationale?: string;
};

const STARTERS = /^(does(?:\s+the\s+p&?p)?|do|is|are|will|shall|must)\s/i;

function normalizeText(s: string): string {
  return s
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExplicitQuestions(text: string): string[] {
  const out: string[] = [];
  const re =
    /((?:Does(?:\s+the\s+P&?P)?|Do|Is|Are|Will|Shall|Must)[^?]{8,}?\?)/gi;
  for (const m of text.matchAll(re)) out.push(normalizeText(m[1]));
  return out;
}

function extractHeuristicQuestions(text: string): string[] {
  const lines = text
    .split(/[\r\n]+/)
    .map(normalizeText)
    .filter(Boolean);
  const candidates: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (STARTERS.test(ln)) {
      let merged = ln;
      let lookahead = 0;
      while (
        lookahead < 2 &&
        i + 1 < lines.length &&
        lines[i + 1].length < 160
      ) {
        merged = `${merged} ${lines[i + 1]}`.trim();
        i++;
        lookahead++;
      }
      candidates.push(merged);
    }
  }
  const paras = text
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter(Boolean);
  for (const p of paras)
    if (STARTERS.test(p) && p.length >= 12) candidates.push(p);

  const seen = new Set<string>();
  return candidates
    .map(normalizeText)
    .filter((q) => q.length >= 12 && q.length <= 600)
    .filter((q) => {
      const k = q.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// Client-side PDF text extraction + AI question extraction
async function extractQuestionsFromPdfWithAI(file: File): Promise<Question[]> {
  const buf = new Uint8Array(await file.arrayBuffer());

  // Load pdf.js (legacy ESM) in the browser
  type PdfjsWithVersion = typeof import("pdfjs-dist/legacy/build/pdf.mjs") & {
    version?: string;
  };
  const pdfjs = (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as PdfjsWithVersion;

  // Match worker version to the imported api version
  const version = pdfjs.version ?? "4.10.38";
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;

  // Extract full text
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let all = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = (content.items as Array<{ str?: string }>)
        .map((it) => (typeof it.str === "string" ? it.str : ""))
        .join(" ");
      all += " " + text;
    }
  } finally {
    await doc.destroy();
  }

  const normalized = normalizeText(all);

  // Primary: AI extraction for precise, deduped questions
  try {
    const res = await fetch("/api/llm-extract-questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: normalized }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        questions?: string[];
        count?: number;
      };
      const arr = Array.isArray(data.questions) ? data.questions : [];
      if (arr.length > 0) {
        return arr.map((text, i) => ({ id: `q_${i + 1}`, text }));
      }
    }
  } catch {
    // fall through to heuristics
  }

  // Fallback: local heuristics
  let list = extractExplicitQuestions(normalized);
  if (list.length === 0) list = extractHeuristicQuestions(normalized);

  const seen = new Set<string>();
  const deduped = list.map(normalizeText).filter((q) => {
    const k = q.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return deduped.map((text, i) => ({ id: `q_${i + 1}`, text }));
}

export default function AuditClient() {
  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"met" | "not-met">("met");
  const [progress, setProgress] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const onChooseFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setQuestions([]);
    setResults([]);
    setError(null);
  };

  const handleExtract = async () => {
    if (!file) return;
    setExtracting(true);
    setError(null);
    setQuestions([]);
    setResults([]);
    setProgress(0);

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress((prev) => Math.min(prev + 10, 90));
    }, 200);

    try {
      const qs = await extractQuestionsFromPdfWithAI(file);
      clearInterval(progressInterval);
      setProgress(100);
      setQuestions(qs);
      if (qs.length === 0)
        setError("No questions detected. Try a different file?");
    } catch (err) {
      clearInterval(progressInterval);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setExtracting(false);
      setTimeout(() => setProgress(0), 1000);
    }
  };

  const handleCheck = async () => {
    if (!questions.length) return;
    setChecking(true);
    setError(null);
    setResults([]);
    setActiveTab("met");
    setProgress(0);

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress((prev) => Math.min(prev + 5, 90));
    }, 300);

    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions }),
      });
      if (!res.ok) throw new Error(`check failed: ${res.status}`);
      const data = await res.json();
      clearInterval(progressInterval);
      setProgress(100);
      setResults(data.results ?? []);
    } catch (err) {
      clearInterval(progressInterval);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setChecking(false);
      setTimeout(() => setProgress(0), 1000);
    }
  };

  // Filter results by status
  const metResults = results.filter((r) => r.status === "Met");
  const notMetResults = results.filter((r) => r.status === "Not Met");

  const getStatusColor = (status: CheckResult["status"]) => {
    return status === "Met" ? "success" : "danger";
  };

  const getStatusIcon = (status: CheckResult["status"]) => {
    return status === "Met" ? CheckCircleIcon : XCircleIcon;
  };

  return (
    <div className="space-y-6">
      {/* File Upload Section */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <DocumentArrowUpIcon className="w-5 h-5 text-blue-600" />
            <h3 className="text-lg font-semibold text-default-600">
              Upload Audit Questions
            </h3>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <div className="space-y-4">
            <Input
              type="file"
              accept="application/pdf"
              onChange={onChooseFile}
              className="w-full"
              isDisabled={extracting || checking}
              classNames={{
                input: "cursor-pointer",
                inputWrapper:
                  "cursor-pointer hover:border-blue-400 transition-colors",
              }}
              startContent={
                <DocumentTextIcon className="w-4 h-4 text-gray-400" />
              }
            />

            {file && (
              <Alert color="success" variant="flat">
                <DocumentTextIcon className="w-4 h-4" />
                <div>
                  Selected: <strong>{file.name}</strong> (
                  {(file.size / 1024 / 1024).toFixed(2)} MB)
                </div>
              </Alert>
            )}

            <div className="flex gap-3">
              <Button
                color="primary"
                onPress={handleExtract}
                isDisabled={!file || extracting || checking}
                isLoading={extracting}
                startContent={
                  !extracting && <DocumentTextIcon className="w-4 h-4" />
                }
                className="flex-1"
              >
                {extracting ? "Extracting Questions..." : "Extract Questions"}
              </Button>

              <Button
                color="success"
                onPress={handleCheck}
                isDisabled={!questions.length || checking || extracting}
                isLoading={checking}
                startContent={!checking && <PlayIcon className="w-4 h-4" />}
                className="flex-1"
              >
                {checking ? "Running Analysis..." : "Run Compliance Check"}
              </Button>
            </div>

            {(extracting || checking) && isHydrated && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>
                    {extracting
                      ? "Processing PDF..."
                      : "Analyzing compliance..."}
                  </span>
                  <span>{progress}%</span>
                </div>
                <Progress
                  value={progress}
                  color="primary"
                  className="w-full"
                  size="sm"
                />
              </div>
            )}

            {error && (
              <Alert color="danger" variant="flat">
                <ExclamationTriangleIcon className="w-4 h-4" />
                <div>
                  <div className="font-semibold">Error</div>
                  <div>{error}</div>
                </div>
              </Alert>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Questions Section */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <DocumentTextIcon className="w-5 h-5 text-indigo-600" />
              <h3 className="text-lg font-semibold text-default-600">
                Extracted Questions
              </h3>
            </div>
            {questions.length > 0 && (
              <Chip color="primary" variant="flat" size="sm">
                {questions.length} questions
              </Chip>
            )}
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          {!questions.length ? (
            <div className="text-center py-8">
              <DocumentTextIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">
                Upload a PDF and extract questions to get started
              </p>
            </div>
          ) : (
            <div className="space-y-3 pt-4">
              {questions.map((q, index) => (
                <div key={q.id} className="p-3 bg-gray-50 rounded-lg border">
                  <div className="flex items-start gap-3">
                    <span className="text-sm font-medium text-default-600 min-w-0 flex-shrink-0">
                      {index + 1}.
                    </span>
                    <p className="text-sm text-gray-700 leading-relaxed flex-1">
                      {q.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Results Section */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CheckCircleIcon className="w-5 h-5 text-green-600" />
            <h3 className="text-lg font-semibold text-default-600">
              Compliance Results
            </h3>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          {!results.length ? (
            <div className="text-center py-8">
              <ClockIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">
                Run compliance check to see results
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <Tabs
                selectedKey={activeTab}
                onSelectionChange={(key) =>
                  setActiveTab(key as "met" | "not-met")
                }
                color="primary"
                variant="underlined"
                className="w-full"
              >
                <Tab
                  key="met"
                  title={
                    <div className="flex items-center gap-2">
                      <CheckCircleIcon className="w-4 h-4" />
                      Met ({metResults.length})
                    </div>
                  }
                />
                <Tab
                  key="not-met"
                  title={
                    <div className="flex items-center gap-2">
                      <XCircleIcon className="w-4 h-4" />
                      Not Met ({notMetResults.length})
                    </div>
                  }
                />
              </Tabs>

              <Divider />

              <div className="space-y-4">
                {(activeTab === "met" ? metResults : notMetResults).length ===
                  0 && (
                  <div className="text-center py-8">
                    <InformationCircleIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-gray-500">
                      No {activeTab === "met" ? "Met" : "Not Met"} results found
                    </p>
                  </div>
                )}
                {(activeTab === "met" ? metResults : notMetResults).length >
                  0 &&
                  (activeTab === "met" ? metResults : notMetResults).map(
                    (r) => {
                      const question = questions.find(
                        (q) => q.id === r.questionId
                      );
                      const StatusIcon = getStatusIcon(r.status);

                      return (
                        <Card
                          key={r.questionId}
                          className="border border-gray-200"
                        >
                          <CardBody className="p-4">
                            <div className="flex items-start justify-between gap-4 mb-3">
                              <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900 leading-relaxed">
                                  {question?.text ?? r.questionId}
                                </p>
                              </div>
                              <Chip
                                color={getStatusColor(r.status)}
                                variant="flat"
                                startContent={
                                  <StatusIcon className="w-3 h-3" />
                                }
                                size="sm"
                              >
                                {r.status}
                              </Chip>
                            </div>

                            {r.evidence && (
                              <div className="mt-4 p-3 bg-gray-50 rounded-lg border">
                                <div className="flex items-start gap-2 mb-2">
                                  <DocumentTextIcon className="w-4 h-4 text-gray-500 mt-0.5" />
                                  <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                                    Evidence
                                  </span>
                                </div>
                                <blockquote className="text-sm text-gray-800 italic leading-relaxed border-l-2 border-blue-200 pl-3">
                                  &ldquo;{r.evidence.snippet}&rdquo;
                                </blockquote>
                                <div className="mt-2 text-xs text-gray-500 font-medium">
                                  📄 {r.evidence.fileName}, page{" "}
                                  {r.evidence.page}
                                </div>
                              </div>
                            )}

                            {r.rationale && (
                              <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                                <div className="flex items-start gap-2">
                                  <InformationCircleIcon className="w-4 h-4 text-blue-600 mt-0.5" />
                                  <div>
                                    <span className="text-xs font-medium text-blue-800 uppercase tracking-wide">
                                      Analysis
                                    </span>
                                    <p className="text-sm text-blue-700 mt-1">
                                      {r.rationale}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}
                          </CardBody>
                        </Card>
                      );
                    }
                  )}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
