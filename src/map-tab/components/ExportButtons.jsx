import { useState } from 'react';
import { exportAsPng, exportAsJpeg } from '../utils/exportMap.js';

export default function ExportButtons({ mapRef }) {
  const [busy, setBusy] = useState(null); // 'png' | 'jpeg' | null

  async function handleExport(format) {
    if (!mapRef.current || busy) return;
    setBusy(format);
    try {
      if (format === 'png') await exportAsPng(mapRef.current);
      else await exportAsJpeg(mapRef.current);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <ExportBtn
          label="PNG"
          loading={busy === 'png'}
          disabled={!!busy}
          onClick={() => handleExport('png')}
        />
        <ExportBtn
          label="JPEG"
          loading={busy === 'jpeg'}
          disabled={!!busy}
          onClick={() => handleExport('jpeg')}
        />
      </div>
    </div>
  );
}

function ExportBtn({ label, loading, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors',
        disabled
          ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
          : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
      ].join(' ')}
    >
      {loading ? '…' : `↓ ${label}`}
    </button>
  );
}
