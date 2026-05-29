/* ============================================================
   INCREMENTAL READING — App shell (sidebar, topbar, ⌘K palette)
   ============================================================ */

function Sidebar({ route, onNav, theme, onTheme, onCheat }) {
  const D = window.IR_DATA;
  const primary = D.nav.slice(0, 5);
  const secondary = D.nav.slice(5);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__logo"><Icon name="layers" size={16} /></span>
        <div className="col" style={{ gap: 0 }}>
          <span className="brand__name">Incremental</span>
          <span className="brand__sub">Reading OS</span>
        </div>
      </div>

      <nav className="nav">
        {primary.map(n => (
          <button key={n.id} className={cx('nav__item', route === n.id && 'nav__item--on')} onClick={() => onNav(n.id)}>
            <Icon name={n.icon} size={17} />{n.label}
            {n.badge ? <span className="nav__badge">{n.badge}</span> : null}
          </button>
        ))}
        <div className="nav-label">Organize</div>
        {secondary.map(n => (
          <button key={n.id} className={cx('nav__item', route === n.id && 'nav__item--on')} onClick={() => onNav(n.id)}>
            <Icon name={n.icon} size={17} />{n.label}
            {n.badge ? <span className="nav__badge">{n.badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar__foot">
        <div className="streak">
          <Icon name="flame" size={13} />
          <span className="streak__n">128-day streak</span>
          <span className="streak__l">94%</span>
        </div>
        <div className="spread" style={{ position: 'relative' }}>
          <div className="userchip" style={{ flex: 1 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}>
            <span className="avatar">AK</span>
            <div className="col" style={{ gap: 0 }}>
              <span style={{ fontSize: 'var(--t-sm)', fontWeight: 600 }}>Ana Kestrel</span>
              <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-3)' }}>Local vault</span>
            </div>
            <Icon name="chevronDown" size={14} style={{ marginLeft: 'auto', color: 'var(--text-3)' }} />
          </div>
          {menuOpen && (
            <div className="menu" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 60 }} onClick={(e) => e.stopPropagation()}>
              <button className="menu__item" onClick={() => { onTheme(); }}>
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
                <span className="grow" style={{ textAlign: 'left' }}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
              </button>
              <button className="menu__item" onClick={() => { onNav('settings'); setMenuOpen(false); }}>
                <Icon name="settings" size={14} /><span className="grow" style={{ textAlign: 'left' }}>Settings</span>
              </button>
              <button className="menu__item" onClick={() => { onCheat && onCheat(); setMenuOpen(false); }}>
                <Icon name="keyboard" size={14} /><span className="grow" style={{ textAlign: 'left' }}>Keyboard shortcuts</span><Kbd k="?" />
              </button>
              <hr className="card-sep" />
              <button className="menu__item"><Icon name="shield" size={14} /><span className="grow" style={{ textAlign: 'left' }}>Local vault · synced</span></button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenCmd, right, children }) {
  return (
    <header className="topbar">
      {children}
      <div className="cmdbar" onClick={onOpenCmd} style={{ marginLeft: children ? 0 : 0 }}>
        <Icon name="search" size={15} />
        <span className="cmdbar__ph">Search, import, or run command…</span>
        <Kbd k={['⌘', 'K']} />
      </div>
      <div className="grow"></div>
      {right}
    </header>
  );
}

const CMDK_ITEMS = [
  { group: 'Go to', icon: 'queue', label: 'Daily Queue', route: 'queue', kbd: ['G', 'Q'] },
  { group: 'Go to', icon: 'inbox', label: 'Inbox triage', route: 'inbox', kbd: ['G', 'I'] },
  { group: 'Go to', icon: 'review', label: 'Review session', route: 'review', kbd: ['G', 'R'] },
  { group: 'Go to', icon: 'library', label: 'Library & search', route: 'library', kbd: ['G', 'L'] },
  { group: 'Go to', icon: 'concepts', label: 'Concept map', route: 'concepts', kbd: ['G', 'C'] },
  { group: 'Create', icon: 'link', label: 'Import from URL…', route: 'inbox' },
  { group: 'Create', icon: 'paste', label: 'Paste text as source…', route: 'inbox' },
  { group: 'Create', icon: 'upload', label: 'Upload PDF / EPUB…', route: 'inbox' },
  { group: 'Create', icon: 'text', label: 'New manual note…', route: 'inbox' },
  { group: 'Session', icon: 'play', label: 'Start daily session', route: 'review' },
  { group: 'Session', icon: 'review', label: 'Review-only mode', route: 'review' },
  { group: 'Session', icon: 'bookmark', label: 'Reading-only mode', route: 'queue' },
];

function CommandPalette({ open, onClose, onNav }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const filtered = useMemo(() => CMDK_ITEMS.filter(i => i.label.toLowerCase().includes(q.toLowerCase())), [q]);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 30); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[sel]; if (it) { onNav(it.route); onClose(); } }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, sel, onClose, onNav]);

  if (!open) return null;
  let lastGroup = null;
  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={e => e.stopPropagation()}>
        <div className="cmdk__input">
          <Icon name="search" size={18} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search, import, or run command…" />
          <Kbd k="Esc" />
        </div>
        <div className="cmdk__list">
          {filtered.length === 0 && <div className="cmdk__group">No commands match "{q}"</div>}
          {filtered.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="cmdk__group" key={'g' + i}>{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <React.Fragment key={i}>
                {head}
                <div className={cx('cmdk__item', sel === i && 'cmdk__item--on')} onMouseEnter={() => setSel(i)} onClick={() => { onNav(it.route); onClose(); }}>
                  <Icon name={it.icon} size={16} />
                  <span className="grow">{it.label}</span>
                  {it.kbd && <Kbd k={it.kbd} />}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, Topbar, CommandPalette });
