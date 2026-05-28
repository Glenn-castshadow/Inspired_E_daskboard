import { useState } from 'react';

/**
 * Sidebar section with a twirl-down chevron.
 * Pass defaultOpen={false} to start collapsed.
 */
export default function CollapsibleSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      {/* ── Header / toggle ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between w-full text-xs font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200 transition-colors"
      >
        <span>{title}</span>
        {/* Chevron points right (collapsed) → down (expanded) */}
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : 'rotate-0'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* ── Collapsible content — max-height animation ── */}
      <div
        style={{
          maxHeight:  open ? '900px' : '0',
          overflow:   'hidden',
          transition: 'max-height 0.22s ease-in-out',
        }}
      >
        <div className="pt-2">
          {children}
        </div>
      </div>
    </div>
  );
}
