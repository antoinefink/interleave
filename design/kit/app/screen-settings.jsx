/* ============================================================
   SETTINGS — real preferences surface
   ============================================================ */

function SettingRow({ label, hint, children }) {
  return (
    <div className="spread" style={{ padding: '14px 0', borderBottom: '1px solid var(--border-faint)', gap: 20, alignItems: 'center' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 'var(--t-base)', fontWeight: 500 }}>{label}</div>
        {hint && <div className="faint" style={{ fontSize: 'var(--t-sm)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>);
}

function SettingsScreen({ onOpenCmd, theme, onNav }) {
  const D = window.IR_DATA;
  const S = D.settings;
  const [budget, setBudget] = useState(S.reviewBudget);
  const [retention, setRetention] = useState(Math.round(S.desiredRetention * 100));
  const [topicInt, setTopicInt] = useState(S.topicInterval);
  const [prio, setPrio] = useState(S.defaultPriority);
  const [layout, setLayout] = useState(S.keyboardLayout);
  const [autoP, setAutoP] = useState(S.autoPostpone);
  const [flash, setFlash] = useState(null);
  function toast(t) { setFlash(t); setTimeout(() => setFlash(null), 1400); }

  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} />
      <div className="page">
        <div className="page-pad" style={{ maxWidth: 720, margin: '0 auto' }}>
          <div className="page-head"><div><h1 className="page-title">Settings</h1><p className="page-sub">Local-first · everything stays on this device</p></div></div>

          <div className="sec-title" style={{ marginBottom: 4 }}>Review & scheduling</div>
          <div className="panel panel-pad" style={{ padding: '4px 18px', marginBottom: 24 }}>
            <SettingRow label="Daily review budget" hint="Soft cap on items surfaced per day. Overflow auto-postpones by priority.">
              <div className="row" style={{ gap: 10 }}>
                <input type="range" min="20" max="150" step="5" value={budget} onChange={e => setBudget(+e.target.value)} style={{ width: 160, accentColor: 'var(--accent)' }} />
                <span className="mono" style={{ width: 56, textAlign: 'right', fontWeight: 600 }}>{budget}/day</span>
              </div>
            </SettingRow>
            <SettingRow label="Desired retention" hint="FSRS target recall probability. Higher = more reviews, stronger memory.">
              <div className="row" style={{ gap: 10 }}>
                <input type="range" min="80" max="97" step="1" value={retention} onChange={e => setRetention(+e.target.value)} style={{ width: 160, accentColor: 'var(--accent)' }} />
                <span className="mono" style={{ width: 56, textAlign: 'right', fontWeight: 600, color: 'var(--accent-text)' }}>{retention}%</span>
              </div>
            </SettingRow>
            <SettingRow label="Default topic interval" hint="How often a topic resurfaces on the attention scheduler.">
              <Segmented value={topicInt} onChange={setTopicInt} options={[{ value: 3, label: '3d' }, { value: 7, label: '7d' }, { value: 14, label: '14d' }, { value: 30, label: '30d' }]} />
            </SettingRow>
            <SettingRow label="Auto-postpone over budget" hint="When the queue exceeds budget, postpone lowest-priority items (protected items are never touched).">
              <Toggle on={autoP} onChange={setAutoP} />
            </SettingRow>
            <SettingRow label="Default source priority" hint="Priority assigned to newly imported sources.">
              <div className="row" style={{ gap: 6 }}>{['A', 'B', 'C', 'D'].map(p => <button key={p} className={cx('chip', prio === p && 'chip--active')} style={{ justifyContent: 'center', minWidth: 36 }} onClick={() => setPrio(p)}><span className={'prio-dot prio-dot--' + p.toLowerCase()}></span>{p}</button>)}</div>
            </SettingRow>
          </div>

          <div className="sec-title" style={{ marginBottom: 4 }}>Interface</div>
          <div className="panel panel-pad" style={{ padding: '4px 18px', marginBottom: 24 }}>
            <SettingRow label="Theme" hint="Light, dark, or follow the system.">
              <Segmented value={theme} onChange={() => onNav && onNav('__theme')} options={[{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }]} />
            </SettingRow>
            <SettingRow label="Keyboard layout" hint="Affects default shortcut bindings.">
              <Segmented value={layout} onChange={setLayout} options={[{ value: 'QWERTY', label: 'QWERTY' }, { value: 'Dvorak', label: 'Dvorak' }, { value: 'Vim', label: 'Vim' }]} />
            </SettingRow>
          </div>

          <div className="sec-title" style={{ marginBottom: 4 }}>Data & backup</div>
          <div className="panel panel-pad" style={{ padding: '4px 18px' }}>
            <SettingRow label="Vault location" hint="~/Documents/IncrementalReading.vault · 1,284 cards · 4.2 MB">
              <Btn icon="external" size="sm">Reveal</Btn>
            </SettingRow>
            <SettingRow label="Automatic backups" hint="Last backup: today, 06:00 · kept 30 days">
              <Toggle on={true} onChange={() => {}} />
            </SettingRow>
            <SettingRow label="Export everything" hint="Markdown + JSON archive of all sources, extracts, and cards.">
              <div className="row" style={{ gap: 6 }}>
                <Btn icon="download" size="sm" onClick={() => toast('Exporting vault…')}>Export</Btn>
                <Btn icon="trash" size="sm" variant="ghost" onClick={() => onNav('trash')}>Open trash</Btn>
              </div>
            </SettingRow>
          </div>
        </div>
      </div>
      {flash && <div className="snackbar fade-up" style={{ background: 'var(--text)' }}><Icon name="check" size={14} />{flash}</div>}
    </div>);
}

Object.assign(window, { SettingsScreen });
