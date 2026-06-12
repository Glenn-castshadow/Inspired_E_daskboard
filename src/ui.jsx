export function PageShell({
  children,
  fillParent = false,
  scroll = false,
  maxWidth = null,
  padBottom = 0,
  style = {},
}) {
  return (
    <div
      style={{
        height: fillParent ? "100%" : "calc(100vh - 48px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: scroll ? "auto" : "hidden",
        background: "var(--bg-canvas)",
        color: "var(--text)",
        padding: `32px 40px ${padBottom}px`,
        fontFamily: "'DM Sans', sans-serif",
        ...(maxWidth ? { maxWidth } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, children, style = {} }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 24,
        marginBottom: children ? 16 : 28,
        flexShrink: 0,
        ...style,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            margin: 0,
            fontFamily: "'Playfair Display', serif",
            fontSize: 26,
            lineHeight: 1.12,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <div
            style={{
              marginTop: 6,
              fontSize: 13,
              lineHeight: 1.45,
              color: "var(--text-faint)",
            }}
          >
            {subtitle}
          </div>
        )}
        {children && <div style={{ marginTop: 16 }}>{children}</div>}
      </div>
      {actions && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {actions}
        </div>
      )}
    </header>
  );
}

export function SubTabBar({ tabs, active, onChange, style = {} }) {
  return (
    <nav
      style={{
        display: "flex",
        gap: 3,
        marginBottom: 24,
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        ...style,
      }}
    >
      {tabs.map((tab) => {
        const selected = active === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            style={{
              padding: "7px 16px 9px",
              background: selected ? "var(--accent-bg)" : "transparent",
              border: "none",
              borderBottom: selected ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: "-1px",
              borderRadius: "7px 7px 0 0",
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: selected ? 700 : 500,
              color: selected ? "var(--accent)" : "var(--text-muted)",
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

export const ghostButtonStyle = (disabled = false) => ({
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 12,
  color: disabled ? "var(--text-fainter)" : "var(--text-muted)",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  cursor: disabled ? "default" : "pointer",
  padding: "6px 10px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
});
