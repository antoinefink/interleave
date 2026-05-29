/* ============================================================
   SCREEN 2 — Import & Inbox Triage
   ============================================================ */

const IMPORT_OPTS = [
  { icon: 'link', label: 'Paste URL', hint: 'Fetch & clean article' },
  { icon: 'paste', label: 'Paste text', hint: 'Plain or rich text' },
  { icon: 'upload', label: 'Upload PDF / EPUB', hint: 'Books & papers' },
  { icon: 'globe', label: 'Browser capture', hint: 'From the extension' },
  { icon: 'text', label: 'Manual note', hint: 'Your own idea' },
];

function ImportRow({ it, active, onClick, onArchive }) {
  return (
    <div className={cx('result', active && 'result--on')} onClick={onClick} style={{ alignItems: 'flex-start', padding: '12px 14px' }}>
      <TypeIcon type={it.type} />
      <div style={{ minWidth: 0 }}>
        <div className="result__title truncate">{it.title}</div>
        <div className="result__meta">
          <span className="badge badge--soft">{it.srcType}</span>
          {it.author && <><span>{it.author}</span><Dot /></>}
          <span className="mono">{it.length}</span><Dot />
          <span>{it.imported}</span>
          {it.duplicate && <><Dot /><span style={{ color: 'var(--warn)' }}><Icon name="dup" size={12} style={{ verticalAlign: '-2px' }} /> possible duplicate</span></>}
        </div>
      </div>
      <button className="btn btn--icon btn--ghost btn--sm" onClick={e => { e.stopPropagation(); onArchive(it.id); }} title="Archive"><Icon name="archive" size={14} /></button>
    </div>
  );
}

function InboxScreen({ onOpenCmd, onNav }) {
  const D = window.IR_DATA;
  const [items, setItems] = useState(D.inbox);
  const [selId, setSelId] = useState(D.inbox[0].id);
  const [prio, setPrio] = useState('B');
  const [toast, setToast] = useState(null);
  const sel = items.find(i => i.id === selId) || items[0];

  function triage(action) {
    setToast(action + ' · ' + (sel ? sel.title.slice(0, 40) : ''));
    setTimeout(() => setToast(null), 1600);
    const rest = items.filter(i => i.id !== selId);
    setItems(rest);
    setSelId(rest[0] ? rest[0].id : null);
  }
  function archive(id) {
    const rest = items.filter(i => i.id !== id);
    setItems(rest);
    if (id === selId) setSelId(rest[0] ? rest[0].id : null);
  }

  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} right={<Btn variant="primary" icon="play" onClick={() => onNav('queue')}>Process queue</Btn>} />
      <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
        {/* import strip */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)' }}>
          <div className="spread" style={{ marginBottom: 12 }}>
            <h1 className="page-title" style={{ fontSize: 'var(--t-xl)' }}>Import & Inbox</h1>
            <span className="page-sub" style={{ margin: 0 }}>{items.length} item{items.length !== 1 ? 's' : ''} awaiting triage</span>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {IMPORT_OPTS.map(o => (
              <button key={o.label} className="panel" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <span className="tico"><Icon name={o.icon} size={14} /></span>
                <div className="col" style={{ gap: 0, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 'var(--t-sm)', fontWeight: 600 }}>{o.label}</span>
                  <span style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-3)' }}>{o.hint}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* two-pane: list + preview */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {items.length === 0 ? (
            <div style={{ flex: 1 }}><EmptyState icon="checkCircle" title="Inbox zero" body="Every imported item has been triaged. New captures from the browser extension or uploads will appear here.">
              <Btn icon="link">Import from URL</Btn><Btn variant="primary" onClick={() => onNav('queue')}>Go to queue</Btn>
            </EmptyState></div>
          ) : (
            <>
              <div style={{ width: 400, flex: 'none', borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 8 }}>
                {items.map(it => <ImportRow key={it.id} it={it} active={it.id === selId} onClick={() => setSelId(it.id)} onArchive={archive} />)}
              </div>

              {/* preview + metadata */}
              {sel && (
                <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px', minWidth: 0 }}>
                    {sel.duplicate && (
                      <div style={{ marginBottom: 16 }}>
                        <Banner variant="info" icon="dup" title="This source may already exist" body={'"' + sel.title + '" closely matches a source imported earlier. Compare before adding a duplicate.'} actions={<><Btn size="sm">Compare</Btn><Btn size="sm" variant="soft" icon="merge">Merge</Btn></>} />
                      </div>
                    )}
                    <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                      <span className="badge badge--soft">{sel.srcType}</span>
                      {sel.srcMeta && <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>{sel.srcMeta}</span>}
                      <Dot /><span className="faint" style={{ fontSize: 'var(--t-sm)' }}>imported {sel.imported}</span>
                    </div>
                    <h2 style={{ fontSize: 'var(--t-xl)', fontWeight: 600, margin: '0 0 6px', letterSpacing: '-0.01em' }}>{sel.title}</h2>
                    {sel.url && <a className="row" style={{ gap: 6, color: 'var(--accent-text)', fontSize: 'var(--t-sm)', textDecoration: 'none', marginBottom: 18 }}><Icon name="link" size={13} />{sel.url}<Icon name="external" size={12} /></a>}
                    <div className="serif" style={{ fontSize: 17, lineHeight: 'var(--lh-read)', color: 'var(--text)' }}>
                      {sel.preview.split('\n\n').map((p, i) => <p key={i} style={{ margin: '0 0 18px' }}>{p}</p>)}
                    </div>
                  </div>

                  {/* metadata + triage rail */}
                  <div style={{ width: 280, flex: 'none', borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
                    <div className="insp-sec">
                      <div className="insp-sec__title">Metadata</div>
                      <div className="field"><label className="field-label">Title</label><input className="input" defaultValue={sel.title} /></div>
                      <div className="field"><label className="field-label">Author</label><input className="input" defaultValue={sel.author} placeholder="Add author…" /></div>
                      <div className="field"><label className="field-label">Concept</label><input className="input" defaultValue={sel.concept} placeholder="Assign concept…" /></div>
                      <div className="field"><label className="field-label">Reason saved</label><textarea className="textarea" rows="2" placeholder="Why is this worth keeping?"></textarea></div>
                    </div>

                    <div className="insp-sec">
                      <div className="insp-sec__title">Priority</div>
                      <div className="row" style={{ gap: 6 }}>
                        {['A', 'B', 'C', 'D'].map(p => (
                          <button key={p} className={cx('chip', prio === p && 'chip--active')} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setPrio(p)}>
                            <span className={'prio-dot prio-dot--' + p.toLowerCase()}></span>{p}
                          </button>
                        ))}
                      </div>
                      <span className="faint" style={{ fontSize: 'var(--t-xs)' }}>{{ A: 'Protected · review daily', B: 'Important · frequent', C: 'Normal cadence', D: 'Someday · low cadence' }[prio]}</span>
                    </div>

                    <div className="insp-sec">
                      <div className="insp-sec__title">Triage <span className="faint">⌨ 1–6</span></div>
                      <Btn variant="primary" icon="play" className="btn--block" onClick={() => triage('Activated')}>Activate <span className="grow"></span><Kbd k="1" /></Btn>
                      <Btn icon="clock" className="btn--block" onClick={() => triage('Read soon')}>Read soon <span className="grow"></span><Kbd k="2" /></Btn>
                      <Btn icon="bookmark" className="btn--block" onClick={() => triage('Saved for later')}>Save for later <span className="grow"></span><Kbd k="3" /></Btn>
                      <Btn icon="archive" className="btn--block" onClick={() => triage('Archived')}>Archive <span className="grow"></span><Kbd k="4" /></Btn>
                      {sel.duplicate && <Btn icon="merge" className="btn--block" onClick={() => triage('Merged')}>Merge duplicate <span className="grow"></span><Kbd k="5" /></Btn>}
                      <Btn variant="danger" icon="trash" className="btn--block" onClick={() => triage('Deleted')}>Delete <span className="grow"></span><Kbd k="6" /></Btn>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && <div className="fade-up" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--canvas)', padding: '9px 16px', borderRadius: 'var(--r-full)', fontSize: 'var(--t-sm)', fontWeight: 500, boxShadow: 'var(--shadow-lg)', display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="check" size={14} />{toast}</div>}
    </div>
  );
}

Object.assign(window, { InboxScreen });
