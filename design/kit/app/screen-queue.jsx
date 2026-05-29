/* ============================================================
   SCREEN 1 — Daily Queue / Home Command Center
   ============================================================ */

function QueueItem({ item, data, onOpen, onDone, active }) {
  const isCard = data.scheduler === 'fsrs';
  return (
    <div className={cx('qitem', data.protected && 'qitem--protected', active && 'qitem--active', 'fade-up')} onClick={() => onOpen(item, data)}>
      <TypeIcon type={data.type} />
      <div className="qitem__main">
        <div className="qitem__title truncate">{titleFor(data)}</div>
        <div className="qitem__meta">
          {data.type === 'source' && <span className="qitem__sub"><Icon name="globe" size={13} /> {data.author}</span>}
          {data.type === 'card' && <span className="qitem__sub">from <i>{data.sourceTitle}</i></span>}
          {data.type === 'extract' && <Stage stage={data.stage} />}
          {data.type === 'topic' && <span className="qitem__sub"><Icon name="layers" size={13} /> {data.sources} sources · {data.cards} cards</span>}
          {data.type === 'synthesis_note' && <span className="qitem__sub"><Icon name="synthesis" size={13} /> {data.words} words</span>}
          {data.type === 'task' && <span className="qitem__sub"><Icon name="task" size={13} /> {data.kind} task</span>}
          <Dot />
          {data.concept && <ConceptTag name={data.concept} />}
          <Dot />
          <SchedulerChip item={data} />
          {data.stagnant && <><Dot /><span className="badge badge--stagnant">Stagnant</span></>}
          {data.scheduler === 'attention' && (data.yieldExtracts != null || data.yieldCards != null) &&
            <><Dot /><span className="qitem__sub mono">yield {data.yieldExtracts || 0}e · {data.yieldCards || 0}c</span></>}
        </div>
      </div>
      <div className="qitem__action" onClick={(e) => e.stopPropagation()}>
        <Prio p={data.prio} />
        {data.leech && <span className="badge badge--leech">Leech</span>}
        <Status due={data.due} label={data.dueLabel} />
        <span className="next-action" onClick={() => onOpen(item, data)}><Icon name={item.actionIcon} size={12} />{item.action}</span>
        <button className="btn btn--icon btn--ghost btn--sm" title="Mark done" onClick={() => onDone(item.ref)}><Icon name="check" size={14} /></button>
      </div>
    </div>);

}

function titleFor(d) {
  if (!d) return '';
  if (d.type === 'card') return (d.cardType === 'cloze' ? 'Cloze · ' : 'Q&A · ') + d.front.replace(/\{\{(.+?)\}\}/, '[…]');
  if (d.type === 'extract') return 'Extract · "' + d.title + '"';
  if (d.type === 'topic') return 'Topic · ' + d.title;
  if (d.type === 'synthesis_note') return d.title;
  return d.title;
}

function QueueScreen({ onNav, onOpenCmd, onOpen, theme }) {
  const D = window.IR_DATA;
  const [filter, setFilter] = useState('all');
  const [done, setDone] = useState([]);
  const [budget, setBudget] = useState(30);
  const [mode, setMode] = useState('full');

  const filters = [
  { id: 'all', label: 'All' },
  { id: 'card', label: 'Cards' },
  { id: 'source', label: 'Sources' },
  { id: 'extract', label: 'Extracts' },
  { id: 'task', label: 'Tasks' },
  { id: 'high', label: 'High priority' }];


  const items = D.queue.map((q) => ({ ...q, data: D.byId(q.ref) })).filter((q) => q.data && done.indexOf(q.ref) < 0);
  const counts = {
    all: items.length,
    card: items.filter((i) => i.data.type === 'card').length,
    source: items.filter((i) => i.data.type === 'source').length,
    extract: items.filter((i) => i.data.type === 'extract').length,
    task: items.filter((i) => i.data.type === 'task').length,
    high: items.filter((i) => i.data.prio === 'A').length
  };
  const shown = items.filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'high') return i.data.prio === 'A';
    return i.data.type === filter;
  });

  const overdue = items.filter((i) => i.data.due === 'overdue').length;
  const protectedN = items.filter((i) => i.data.protected).length;
  const leeches = D.cards.filter((c) => c.leech).length;
  const extractBacklog = D.extracts.filter((e) => (e.yieldCards || 0) === 0).length;
  const B = D.budget;
  const [postponed, setPostponed] = useState(false);

  return (
    <>
      <div className="main">
        <Topbar onOpenCmd={onOpenCmd} right={<Btn variant="primary" icon="play" onClick={() => onNav('review')}>Start session</Btn>} />
        <div className="page">
          <div className="page-pad" style={{ maxWidth: 940, margin: '0 auto' }}>
            <div className="page-head">
              <div>
                <h1 className="page-title">Daily Queue</h1>
                <p className="page-sub">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {items.length} items due · est. {Math.max(8, items.length * 2)} min</p>
              </div>
            </div>

            {/* overload management */}
            <div className="panel panel-pad" style={{ marginBottom: 14, display: 'grid', gridTemplateColumns: '1.1fr 1px 1fr', gap: 18, alignItems: 'center' }}>
              <BudgetMeter used={B.used} target={B.target} />
              <div style={{ background: 'var(--border)', alignSelf: 'stretch' }}></div>
              <div className="row" style={{ gap: 16, justifyContent: 'space-around' }}>
                <div className="col" style={{ gap: 1, alignItems: 'center' }}><span className="mono" style={{ fontSize: 'var(--t-lg)', fontWeight: 600 }}>{B.importsToday}</span><span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>imported today</span></div>
                <div className="col" style={{ gap: 1, alignItems: 'center' }}><span className="mono" style={{ fontSize: 'var(--t-lg)', fontWeight: 600, color: B.importsToday > 2 ? 'var(--warn)' : 'var(--text)' }}>2.1×</span><span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>import : process</span></div>
                <div className="col" style={{ gap: 1, alignItems: 'center' }}><span className="mono" style={{ fontSize: 'var(--t-lg)', fontWeight: 600 }}>+3d</span><span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>vacation cost</span></div>
              </div>
            </div>

            {B.used > B.target && !postponed &&
              <div style={{ marginBottom: 14 }}><Banner variant="info" icon="gauge" title={(B.used - B.target) + ' items over today\u2019s budget'} body="High-priority cards are protected. Auto-postpone the lowest-priority sources & extracts to stay on track?" actions={<><Btn size="sm" variant="soft" icon="postpone" onClick={() => setPostponed(true)}>Auto-postpone {B.used - B.target}</Btn><Btn size="sm" variant="ghost">Catch-up mode</Btn></>} /></div>
            }
            {postponed &&
              <div style={{ marginBottom: 14 }}><Banner variant={null} icon="checkCircle" title={(B.used - B.target) + ' low-priority items postponed'} body="Back within budget. Protected items were untouched." actions={<Btn size="sm" variant="ghost" onClick={() => setPostponed(false)}>Undo</Btn>} /></div>
            }

            {/* session controls */}
            <div className="sessionbar" style={{ marginBottom: 18 }} data-comment-anchor="e8bf7b44aa-div-91-13">
              <Btn variant="primary" icon="play" onClick={() => onNav('review')}>Start session</Btn>
              <div className="vdiv" style={{ height: 24 }}></div>
              <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>Budget</span>
              <Segmented value={budget} onChange={setBudget} options={[{ value: 15, label: '15m' }, { value: 30, label: '30m' }, { value: 60, label: '60m' }, { value: 0, label: 'All' }]} />
              <div className="vdiv" style={{ height: 24 }}></div>
              <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>Mode</span>
              <Segmented value={mode} onChange={setMode} options={[{ value: 'full', label: 'Full' }, { value: 'review', label: 'Review-only', icon: 'review' }, { value: 'read', label: 'Reading-only', icon: 'bookmark' }, { value: 'catch', label: 'Catch-up' }]} />
            </div>

            {/* filters */}
            <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {filters.map((f) =>
              <span key={f.id} className={cx('chip', filter === f.id && 'chip--active')} onClick={() => setFilter(f.id)}>
                  {f.label}<span className="chip__count">{counts[f.id]}</span>
                </span>
              )}
            </div>

            {/* list */}
            {shown.length > 0 ?
            <div className="col" style={{ gap: 8 }}>
                {shown.map((q, i) =>
              <QueueItem key={q.ref} item={q} data={q.data} onOpen={onOpen} onDone={(ref) => setDone((d) => [...d, ref])} />
              )}
              </div> :
            items.length === 0 ?
            <div className="panel" style={{ marginTop: 8 }}>
                <EmptyState icon="checkCircle" title="Queue clear for today" body="You've processed everything due. Nicely done — the next items unlock tomorrow morning. Your high-priority sources are protected and won't pile up.">
                  <Btn onClick={() => setDone([])}>Reset demo</Btn>
                  <Btn variant="primary" icon="upload" onClick={() => onNav('inbox')}>Import something new</Btn>
                </EmptyState>
              </div> :

            <div className="panel"><EmptyState icon="filter" title={'No ' + filter + ' items'} body="Nothing matches this filter right now. Try another filter or clear it."><Btn onClick={() => setFilter('all')}>Show all</Btn></EmptyState></div>
            }
          </div>
        </div>
      </div>

      {/* right status panel */}
      <aside className="inspector">
        <div className="inspector__head"><span className="inspector__title">Today's status</span></div>
        <div className="inspector__body">
          <div className="insp-sec">
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Metric sm value={items.length} label="Due today" />
              <Metric sm value={overdue} label="Overdue" variant={overdue ? 'danger' : null} />
              <Metric sm value={protectedN} label="Protected" />
              <Metric sm value={extractBacklog} label="Extract backlog" />
            </div>
          </div>

          <div className="insp-sec">
            <div className="insp-sec__title">Review forecast · 7 days</div>
            <div className="panel panel-pad" style={{ padding: 14 }}>
              <Spark data={D.forecast} hotLast={false} />
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="mono" style={{ fontSize: 9, color: 'var(--text-3)' }}>{d}</span>)}
              </div>
            </div>
          </div>

          {leeches > 0 &&
          <div className="insp-sec">
              <div className="insp-sec__title">Maintenance</div>
              <div className="note" onClick={() => onNav('review')} style={{ cursor: 'pointer' }}>
                <Icon name="leech" size={14} />
                <span className="grow"><span className="note__n">{leeches} leech card{leeches > 1 ? 's' : ''}</span> · lapsed 8+ times</span>
                <Icon name="chevronRight" size={13} />
              </div>
            </div>
          }

          <div className="insp-sec">
            <div className="insp-sec__title">Protected items</div>
            {D.sources.filter((s) => s.protected).concat(D.cards.filter((c) => c.prio === 'A')).slice(0, 3).map((s) =>
            <div key={s.id} className="row" style={{ gap: 9, padding: '6px 0' }}>
                <Prio p="A" dot />
                <span className="truncate grow" style={{ fontSize: 'var(--t-sm)' }}>{titleFor(s)}</span>
                <Icon name="pin" size={13} />
              </div>
            )}
          </div>
        </div>
      </aside>
    </>);

}

Object.assign(window, { QueueScreen, QueueItem, titleFor });