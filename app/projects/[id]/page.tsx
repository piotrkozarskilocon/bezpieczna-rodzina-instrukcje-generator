import Link from "next/link";

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<React.ReactElement> {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/" className="hover:text-slate-900">
          Projekty
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">{id}</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-12">
        <h2 className="text-2xl font-semibold text-slate-900">Projekt: {id}</h2>
        <p className="mt-2 text-sm text-slate-500">
          Phase 0 placeholder — szczegóły projektu pojawią się tu po implementacji edytora.
        </p>
      </div>
    </div>
  );
}
