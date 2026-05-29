/* ============================================================
   SCREEN 6 — Library, Search & Knowledge Map
   ============================================================ */

function ConceptGraph({ concepts, onPick }) {
  // hand-placed practical layout (not decorative)
  const nodes = [
    { id: 'c-sr', x: 300, y: 180, r: 38 },
    { id: 'c-mem', x: 150, y: 110, r: 32 },
    { id: 'c-att', x: 470, y: 120, r: 26 },
    { id: 'c-habit', x: 480, y: 250, r: 24 },
    { id: 'c-sys', x: 180, y: 270, r: 22 },
    { id: 'c-write', x: 360, y: 320, r: 20 },
  ];
  const edges = [['c-sr', 'c-mem'], ['c-sr', 'c-att'], ['c-sr', 'c-habit'], ['c-mem', 'c-sys'], ['c-sr', 'c-write'], ['c-att', 'c-habit'], ['c-mem', 'c-att']];
  const pos = {}; nodes.forEach(n => pos[n.id] = n);
  const nameOf = id => (concepts.find(c => c.id === id) || {}).name || id;
  return (
    <svg viewBox="0 0 620 420" className="graph">
      {edges.map(([a, b], i) => <line key={i} x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y} stroke="var(--border-strong)" strokeWidth="1.5" />)}
      {nodes.map(n => {
        const c = concepts.find(x => x.id === n.id) || {};
        return (
          <g key={n.id} className="gnode" onClick={() => onPick && onPick(n.id)}>
            <circle cx={n.x} cy={n.y} r={n.r} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
            <text x={n.x} y={n.y - 2} textAnchor="middle" fontWeight="600">{nameOf(n.id)}</text>
            <text x={n.x} y={n.y + 12} textAnchor="middle" fontSize="9" fill="var(--text-3)">{(c.cards || 0)} cards</text>
          </g>
        );
      })}
    </svg>
  );
}

function LibraryScreen({ onOpenCmd, onNav, onOpen, initialTab }) {
  const D = window.IR_DATA;
  const all = useMemo(() => [...D.topics, ...D.sources, ...D.extracts, ...D.cards, ...D.synthesis, ...D.tasks], []);
  const [tab, setTab] = useState(initialTab || 'results');
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState({ topic: true, source: true, extract: true, card: true, synthesis_note: true, task: true });
  const [selId, setSelId] = useState(D.sources[0].id);
  const [selected, setSelected] = useState([]);

  const results = all.filter(x => {
    if (!typeFilter[x.type]) return false;
    if (!q) return true;
    const hay = (titleFor(x) + ' ' + (x.concept || '') + ' ' + (x.author || '')).toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const groups = { topic: 'Topics', source: 'Sources', extract: 'Extracts', card: 'Cards', synthesis_note: 'Synthesis notes', task: 'Tasks' };
  const sel = all.find(x => x.id === selId);

  function highlight(text) {
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return <>{text.slice(0, i)}<em>{text.slice(i, i + q.length)}</em>{text.slice(i + q.length)}</>;
  }

  const typeCounts = { topic: D.topics.length, source: D.sources.length, extract: D.extracts.length, card: D.cards.length, synthesis_note: D.synthesis.length, task: D.tasks.length };

  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd}>
        <div className="cmdbar" style={{ cursor: 'text', maxWidth: 460 }}>
          <Icon name="search" size={15} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search sources, extracts, cards, concepts…" style={{ border: 'none', background: 'none', outline: 'none', font: 'inherit', color: 'var(--text)', width: '100%' }} />
        </div>
        <div className="grow"></div>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'results', label: 'Results', icon: 'layers' }, { value: 'map', label: 'Map', icon: 'concepts' }]} />
      </Topbar>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* filter sidebar */}
        <div className="filterbar">
          <div className="filter-group">
            <div className="filter-group__title">Type</div>
            {Object.keys(groups).map(t => (
              <div key={t} className={cx('filter-opt', typeFilter[t] && 'filter-opt--on')} onClick={() => setTypeFilter(f => ({ ...f, [t]: !f[t] }))}>
                <span className={cx('checkbox', typeFilter[t] && 'checkbox--on')}>{typeFilter[t] && <Icon name="check" size={11} />}</span>
                <TypeIcon type={t} /><span>{groups[t]}</span><span className="filter-opt__count">{typeCounts[t]}</span>
              </div>
            ))}
          </div>
          <div className="filter-group">
            <div className="filter-group__title">Concept</div>
            {D.concepts.slice(0, 5).map(c => <div key={c.id} className="filter-opt"><span className="concept-tag" style={{ pointerEvents: 'none' }}>{c.name}</span><span className="filter-opt__count">{c.cards}</span></div>)}
          </div>
          <div className="filter-group">
            <div className="filter-group__title">Priority</div>
            {['A', 'B', 'C', 'D'].map(p => <div key={p} className="filter-opt"><span className={'prio-dot prio-dot--' + p.toLowerCase()}></span>Priority {p}</div>)}
          </div>
          <div className="filter-group">
            <div className="filter-group__title">Maintenance</div>
            {[['warning', 'Orphan cards', 12], ['hourglass', 'Stale facts', 5], ['arrowDown', 'Low-yield sources', 3], ['leech', 'Leeches', 1], ['pause2', 'Stagnant extracts', 2]].map(([ic, l, n]) => (
              <div key={l} className="filter-opt"><Icon name={ic} size={14} /><span>{l}</span><span className="filter-opt__count">{n}</span></div>
            ))}
            <div className="filter-opt" onClick={() => onNav('trash')} style={{ marginTop: 4 }}><Icon name="trash" size={14} /><span>Trash</span><span className="filter-opt__count">{D.trash.length}</span></div>
          </div>
        </div>

        {/* center */}
        {tab === 'results' ? (
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {/* maintenance banner */}
              <div style={{ padding: '14px 16px 0' }}>
                <Banner variant="danger" icon="warning" title="12 orphan cards have no source" body="Cards without lineage can't be verified against their origin." actions={<Btn size="sm">Resolve</Btn>} />
              </div>

              {/* bulk action bar */}
              {selected.length > 0 && (
                <div className="row" style={{ gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                  <span style={{ fontSize: 'var(--t-sm)', fontWeight: 600 }}>{selected.length} selected</span>
                  <div className="vdiv" style={{ height: 20 }}></div>
                  <Btn size="sm" icon="arrowUp">Raise</Btn><Btn size="sm" icon="arrowDown">Lower</Btn>
                  <Btn size="sm" icon="postpone">Postpone</Btn><Btn size="sm" icon="concept">Assign concept</Btn>
                  <Btn size="sm" icon="archive">Archive</Btn><Btn size="sm" icon="external">Export</Btn>
                  <div className="grow"></div>
                  <Btn size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Btn>
                </div>
              )}

              <div style={{ padding: 10 }}>
                {Object.keys(groups).map(type => {
                  const rows = results.filter(r => r.type === type);
                  if (!rows.length) return null;
                  return (
                    <div key={type} style={{ marginBottom: 8 }}>
                      <div className="sec-head"><span className="sec-title">{groups[type]} · {rows.length}</span></div>
                      {rows.map(r => (
                        <div key={r.id} className={cx('result', selId === r.id && 'result--on')} onClick={() => setSelId(r.id)}>
                          <span className={cx('checkbox', selected.includes(r.id) && 'checkbox--on')} onClick={e => { e.stopPropagation(); setSelected(s => s.includes(r.id) ? s.filter(x => x !== r.id) : [...s, r.id]); }}>{selected.includes(r.id) && <Icon name="check" size={11} />}</span>
                          <div style={{ minWidth: 0 }}>
                            <div className="result__title truncate">{highlight(titleFor(r))}</div>
                            <div className="result__meta">
                              {r.concept && <><span className="concept-tag" style={{ pointerEvents: 'none' }}>{r.concept}</span></>}
                              {r.author && <span>{r.author}</span>}
                              <SchedulerChip item={r} />
                              {r.leech && <span className="badge badge--leech">Leech</span>}
                              {r.due && <Status due={r.due} label={r.dueLabel} />}
                            </div>
                          </div>
                          <Prio p={r.prio} />
                        </div>
                      ))}
                    </div>
                  );
                })}
                {results.length === 0 && <EmptyState icon="search" title={'No matches for "' + q + '"'} body="Try a different term, or broaden the type filters on the left." />}
              </div>
            </div>

            {/* detail preview */}
            {sel && (
              <div style={{ width: 320, flex: 'none', borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="row" style={{ gap: 9 }}><TypeIcon type={sel.type} lg /><div className="col" style={{ gap: 0, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 'var(--t-sm)' }} className="truncate">{titleFor(sel).slice(0, 60)}</span><span className="faint" style={{ fontSize: 'var(--t-2xs)', textTransform: 'capitalize' }}>{sel.type}</span></div></div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><Prio p={sel.prio} /><ConceptTag name={sel.concept} /><SchedulerChip item={sel} />{sel.due && <Status due={sel.due} label={sel.dueLabel} />}</div>
                {sel.text && <div className="refblock serif">{sel.text}</div>}
                {sel.front && <div className="refblock serif">{sel.front.replace(/\{\{(.+?)\}\}/g, '[$1]')}</div>}

                <div className="insp-sec">
                  <div className="insp-sec__title">Lineage</div>
                  <LineageTree
                    activeId={sel.id}
                    onPick={(n) => { const d = D.byId(n.id); if (d) onOpen(null, d); }}
                    nodes={[
                      { id: sel.sourceId || sel.id, type: 'source', title: (sel.sourceTitle || sel.title || '').split('—')[0].trim() || 'Source', depth: 0, meta: 'source' },
                      { id: sel.extractId || (sel.type === 'extract' ? sel.id : '_e'), type: 'extract', title: sel.type === 'extract' ? sel.title : (sel.yieldExtracts != null ? sel.yieldExtracts + ' extracts' : '1 extract'), depth: 1, meta: 'extract' },
                      { id: sel.type === 'card' ? sel.id : '_c', type: 'card', title: sel.type === 'card' ? titleFor(sel) : (sel.yieldCards != null ? sel.yieldCards + ' cards' : 'cards'), depth: 2, meta: 'card' },
                    ]}
                  />
                </div>
                <Btn variant="primary" icon="external" className="btn--block" onClick={() => onOpen(null, sel)}>Open {sel.type}</Btn>
              </div>
            )}
          </div>
        ) : (
          /* knowledge map */
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <div style={{ flex: 1, padding: 24, minWidth: 0 }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 style={{ fontSize: 'var(--t-lg)', fontWeight: 600, margin: 0 }}>Concept map</h2>
                <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>{D.concepts.length} concepts · click a node to filter</span>
              </div>
              <div className="panel" style={{ height: 'calc(100% - 40px)', overflow: 'hidden' }}>
                <ConceptGraph concepts={D.concepts} onPick={() => setTab('results')} />
              </div>
            </div>
            <div style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="insp-sec__title">Concepts by volume</div>
              {D.concepts.map(c => (
                <div key={c.id} className="panel panel-pad" style={{ padding: 12 }}>
                  <div className="spread" style={{ marginBottom: 8 }}><span className="concept-tag">{c.name}</span><span className="mono faint" style={{ fontSize: 'var(--t-2xs)' }}>{c.due} due</span></div>
                  <div className="row" style={{ gap: 14 }}>
                    <span style={{ fontSize: 'var(--t-xs)', color: 'var(--text-2)' }}><b style={{ color: 'var(--text)' }}>{c.cards}</b> cards</span>
                    <span style={{ fontSize: 'var(--t-xs)', color: 'var(--text-2)' }}><b style={{ color: 'var(--text)' }}>{c.sources}</b> sources</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { LibraryScreen });
