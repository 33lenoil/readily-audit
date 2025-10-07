import AuditClient from "../components/AuditClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <div className="mx-auto max-w-6xl p-6">
        <header className="mb-8 text-center">
          <div className="mb-4">
            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              Readily Compliance Checker
            </h1>
            <div className="w-24 h-1 bg-gradient-to-r from-blue-500 to-indigo-500 mx-auto mt-3 rounded-full"></div>
          </div>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
            Upload an Audit Questions PDF, extract questions, and automatically
            check policies for evidence with AI-powered compliance verification.
          </p>
        </header>

        <div className="shadow-xl border-0 bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200">
          <div className="p-6 pb-0">
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold text-gray-800">
                Compliance Analysis
              </h2>
              <p className="text-gray-600">
                Streamline your audit process with intelligent question
                extraction and policy verification
              </p>
            </div>
          </div>
          <div className="p-6 pt-6">
            {/* Client island (AuditClient has "use client" at top) */}
            <AuditClient />
          </div>
        </div>
      </div>
    </main>
  );
}
