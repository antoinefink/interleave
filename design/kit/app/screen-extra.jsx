/* ============================================================
   EXTRA SURFACES — Trash, Synthesis note, Task
   ============================================================ */

function TrashScreen({ onOpenCmd, onNav, onToast }) {
  const D = window.IR_DATA;
  const [items, setItems] = useState(D.trash);
  function restore(it) { setItems(x => x.filter(i => i.id !== it.id)); onToast && onToast('Restored · ' + it.title.slice(0, 36), () => setItems(D.trash)); }
  function purge(it) { setItems(x => x.filter(i => i.id !== it.id)); }
  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} right={items.length > 0 && <Btn variant="danger" icon="trash" onClick={() => setItems([])}>Empty trash</Btn>} />
      <div className="page">
        <div className="page-pad" style={{ maxWidth: 760, margin: '0 auto' }}>
          <div className="page-head"><div><h1 className="page-title">Trash</h1><p className="page-sub">Local-first · deleted items are recoverable for 30 days</p></div></div>
          {items.length === 0 ? (
            <div className="panel"><EmptyState icon="trash" title="Trash is empty" body="Nothing to recover. Deleted sources, extracts, and cards land here first and can be restored.">
              <Btn onClick={() => setItems(D.trash)}>Reset demo</Btn><Btn variant="primary" onClick={() => onNav('library')}>Back to library</Btn>
            </EmptyState></div>
          ) : (
            <div className="panel" style={{ overflow: 'hidden' }}>
              {items.map((it, i) => (
                <div key={it.id} className="result" style={{ borderRadius: 0, borderBottom: i < items.length - 1 ? '1px solid var(--border-faint)' : 'none', padding: '12px 16px' }}>
                  <TypeIcon type={it.type} />
                  <div style={{ minWidth: 0 }}>
                    <div className="result__title truncate" style={{ color: 'var(--text-2)' }}>{it.title}</div>
                    <div className="result__meta"><span style={{ textTransform: 'capitalize' }}>{it.type}</span><Dot /><span>from {it.from}</span><Dot /><span>deleted {it.deleted}</span></div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Btn size="sm" icon="restore" onClick={() => restore(it)}>Restore</Btn>
                    <Btn size="sm" variant="ghost" icon="trash" onClick={() => purge(it)} title="Delete permanently"></Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>);
}

function SynthesisScreen({ onOpenCmd, onNav, ctx }) {
  const D = window.IR_DATA;
  const note = (ctx && ctx.type === 'synthesis_note') ? ctx : D.synthesis[0];
  const [text, setText] = useState(note.text + '\n\n');
  return (
    <>
      <div className="main">
        <Topbar onOpenCmd={onOpenCmd}>
          <div className="crumbs">
            <span className="crumb" onClick={() => onNav('library')}><Icon name="library" size={14} /> Library</span>
            <span className="crumb-sep"><Icon name="chevronRight" size={13} /></span>
            <span className="crumb crumb--current"><TypeIcon type="synthesis_note" /> Synthesis</span>
          </div>
        </Topbar>
        <div style={{ padding: '18px 28px 14px', borderBottom: '1px solid var(--border)' }}>
          <h1 className="page-title" style={{ fontSize: 'var(--t-xl)', marginBottom: 6 }}>{note.title}</h1>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="badge badge--soft"><Icon name="synthesis" size={12} style={{ marginRight: 4, verticalAlign: '-2px' }} />Incremental writing</span>
            <ConceptTag name={note.concept} /><Prio p={note.prio} /><SchedulerChip item={note} /><Dot />
            <span className="qitem__sub mono">{note.words} words · draws on {note.sources} sources · {note.extracts} extracts</span>
          </div>
        </div>
        <div className="page">
          <div className="reader" style={{ padding: '32px 0 120px' }}>
            <textarea className="editor" style={{ width: '100%', minHeight: 420, fontFamily: 'var(--font-read)', fontSize: 18, lineHeight: 'var(--lh-read)' }} value={text} onChange={e => setText(e.target.value)}></textarea>
          </div>
        </div>
      </div>
      <aside className="inspector">
        <div className="inspector__head"><span className="inspector__title">Sources drawn on</span></div>
        <div className="inspector__body">
          <div className="insp-sec">
            <div className="insp-sec__title">Linked extracts</div>
            {D.extracts.filter(e => e.concept === note.concept).slice(0, 3).map(e => (
              <div key={e.id} className="result" style={{ padding: '8px 10px', border: '1px solid var(--border)', marginBottom: 4 }} onClick={() => onNav('builder')}>
                <TypeIcon type="extract" />
                <div style={{ minWidth: 0 }}><div className="truncate" style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>{e.title}</div><div className="row" style={{ marginTop: 2 }}><Stage stage={e.stage} /></div></div>
              </div>
            ))}
          </div>
          <div className="insp-sec">
            <div className="insp-sec__title">Insert reference</div>
            <Btn icon="extract" className="btn--block" variant="soft">Cite an extract</Btn>
            <Btn icon="source" className="btn--block">Cite a source</Btn>
          </div>
        </div>
      </aside>
    </>);
}

function TaskScreen({ onOpenCmd, onNav, ctx }) {
  const D = window.IR_DATA;
  const task = (ctx && ctx.type === 'task') ? ctx : D.tasks[0];
  const linked = D.byId(task.linked);
  const [doneState, setDoneState] = useState(false);
  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} />
      <div className="page" style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="page-pad" style={{ maxWidth: 620, width: '100%' }}>
          <div className="row" style={{ gap: 8, marginBottom: 14 }}>
            <span className="badge badge--soft">{task.kind} task</span><ConceptTag name={task.concept} /><Prio p={task.prio} /><SchedulerChip item={task} />
          </div>
          <div className="panel panel-pad">
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <TypeIcon type="task" lg />
              <h2 className="serif" style={{ fontSize: 'var(--t-xl)', margin: 0, lineHeight: 'var(--lh-snug)' }}>{task.title}</h2>
            </div>
            {linked && (
              <div className="refblock serif" style={{ marginTop: 16 }}>
                References <b>{linked.title ? linked.title.split('—')[0] : 'a source'}</b>
                <button className="refblock__src" onClick={() => onNav('reader')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontFamily: 'var(--font-ui)', marginTop: 8 }}>
                  <Icon name="external" size={12} /> Open linked source
                </button>
              </div>
            )}
            <hr className="divider" />
            {!doneState ? (
              <div className="row" style={{ gap: 8 }}>
                <Btn variant="primary" icon="checkCircle" onClick={() => setDoneState(true)}>Mark resolved</Btn>
                <Btn icon="postpone" onClick={() => onNav('queue')}>Postpone</Btn>
                <Btn icon="trash" variant="ghost">Dismiss</Btn>
              </div>
            ) : (
              <Banner variant={null} icon="checkCircle" title="Task resolved" body="Removed from the queue." actions={<Btn size="sm" onClick={() => onNav('queue')}>Back to queue</Btn>} />
            )}
          </div>
        </div>
      </div>
    </div>);
}

Object.assign(window, { TrashScreen, SynthesisScreen, TaskScreen });
