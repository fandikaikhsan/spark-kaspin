"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
export function RequestEvidence({ id, pdf }: { id: string; pdf: boolean }) {
  const [url, setUrl] = useState(""), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    setUrl(""); setError("");
    fetch(`/api/staffing/evidence?request=${id}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Bukti belum dapat dimuat.");
      const blob = await response.blob(); if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Bukti belum dapat dimuat."); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, retry]);
  return <section className="ops-evidence-preview"><h3>Bukti pengajuan</h3>{error ? <p className="ops-error">{error} <button type="button" className="ops-link" onClick={() => setRetry(value => value + 1)}>Coba lagi</button></p> : !url ? <p className="ops-muted" role="status">Memuat bukti…</p> : pdf ? <iframe title="Bukti izin / sakit" src={url} /> : <Image src={url} alt="Bukti izin / sakit" width={1000} height={750} unoptimized style={{ width: "100%", height: "auto", maxHeight: 520, objectFit: "contain" }} />}</section>;
}
