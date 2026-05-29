/* ============================================================
   SCREEN 3 — Source Reader / Incremental Reading Workspace
   ============================================================ */

const READING = [
{ kind: 'dim', text: 'For as long as we have studied memory, scientists assumed that sleep was a passive state — a shutting-down of the brain. We now know the opposite is true.' },
{ kind: 'p', text: 'Sleep before learning refreshes our ability to make new memories. It does so each and every night. While we are awake, the hippocampus accumulates new memories throughout the day, acting as a short-term reservoir. Without sufficient sleep, this reservoir saturates, and we lose the ability to take on more.' },
{ kind: 'hl', text: 'A nap, it turns out, can restore that capacity — even a brief one. ', tail: 'In one study, participants who napped showed a marked improvement in their ability to learn new facts in the afternoon, while those who stayed awake grew progressively worse.' },
{ kind: 'h', text: 'The courier service of deep sleep' },
{ kind: 'extracted', text: 'During deep NREM sleep, slow brainwaves serve as a courier service, transporting memory packets from the short-term storage of the hippocampus to the long-term storage site of the neocortex.', note: 'Extract 2 · Clean extract' },
{ kind: 'p', text: 'This nightly transfer accomplishes two things at once. It clears the hippocampus, freeing space for the next day\u2019s learning, and it deposits memories in the cortex, where they become more permanent and integrated with what we already know.' },
{ kind: 'p', text: 'The implication is striking: the act of consolidation is not a side effect of sleep but one of its central purposes. Sleep is the price we pay for plasticity — the cost of a brain that can keep learning across a lifetime.' }];


function SelToolbar({ pos, onAction }) {
  if (!pos) return null;
  return (
    <div className="sel-toolbar fade-up" style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)', zIndex: 80 }} onMouseDown={(e) => e.preventDefault()}>
      <button className="sel-tool sel-tool--accent" onClick={() => onAction('extract')}><Icon name="extract" size={14} /> Extract <Kbd k="E" /></button>
      <button className="sel-tool" onClick={() => onAction('cloze')}><Icon name="cloze" size={14} /> Cloze <Kbd k="C" /></button>
      <button className="sel-tool" onClick={() => onAction('highlight')}><Icon name="highlight" size={14} /> Highlight <Kbd k="H" /></button>
      <span className="tool-div"></span>
      <button className="sel-tool" onClick={() => onAction('task')}><Icon name="task" size={14} /> Task</button>
      <button className="sel-tool" onClick={() => onAction('copy')}><Icon name="copy" size={14} /></button>
    </div>);

}

function ReaderScreen({ onOpenCmd, onNav, onOpen, ctx }) {
  const D = window.IR_DATA;
  const src = ctx && ctx.type === 'source' ? ctx : D.sources[0];
  const readerRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [extracts, setExtracts] = useState(() => D.extracts.filter((e) => e.sourceId === src.id));
  const [flash, setFlash] = useState(null);
  const [processed, setProcessed] = useState([]);
  const [jumped, setJumped] = useState(false);

  useEffect(() => {
    if (src.jumpLoc) { setJumped(true); setFlash('Jumped to source · ' + src.jumpLoc); setTimeout(() => setFlash(null), 1800); }
  }, []);

  function clearSel() {setPos(null);window.getSelection().removeAllRanges();}

  function onMouseUp() {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text || text.length < 3) {setPos(null);return;}
    if (!readerRef.current || !readerRef.current.contains(selection.anchorNode)) {setPos(null);return;}
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setPos({ top: rect.top - 8, left: rect.left + rect.width / 2, text });
  }

  function action(kind) {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text) return;
    if (kind === 'copy') {clearSel();toast('Copied to clipboard');return;}
    try {
      const range = selection.getRangeAt(0);
      const mark = document.createElement('mark');
      mark.className = kind === 'highlight' ? 'hl' : 'extracted';
      range.surroundContents(mark);
    } catch (e) {/* cross-node selection — skip styling */}
    if (kind === 'extract' || kind === 'cloze') {
      const ne = {
        id: 'e-new-' + Date.now(), type: 'extract', scheduler: 'attention', sourceId: src.id, sourceTitle: src.title, parentExtractId: null,
        title: text.length > 70 ? text.slice(0, 70) + '…' : text, text, stage: kind === 'cloze' ? 'Card draft' : 'Raw extract',
        prio: 'C', concept: src.concept, due: 'today', dueLabel: 'Due today', page: 'new', yieldCards: kind === 'cloze' ? 1 : 0, postponed: 0
      };
      setExtracts((x) => [ne, ...x]);
      toast(kind === 'cloze' ? 'Cloze card drafted' : 'Extract created');
    } else if (kind === 'highlight') toast('Highlighted');else
    if (kind === 'task') toast('Task created from selection');
    clearSel();
  }

  function toast(t) {setFlash(t);setTimeout(() => setFlash(null), 1500);}

  useEffect(() => {
    function onKey(e) {
      if (!pos) return;
      const k = e.key.toLowerCase();
      if (k === 'e') {e.preventDefault();action('extract');} else
      if (k === 'c') {e.preventDefault();action('cloze');} else
      if (k === 'h') {e.preventDefault();action('highlight');}
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div className="main">
        <Topbar onOpenCmd={onOpenCmd}>
          <div className="crumbs">
            <span className="crumb" onClick={() => onNav('library')}><Icon name="library" size={14} /> Library</span>
            <span className="crumb-sep"><Icon name="chevronRight" size={13} /></span>
            <span className="crumb crumb--current"><TypeIcon type="source" /> {src.title.split('—')[0].trim()}</span>
          </div>
        </Topbar>

        {/* source header */}
        <div style={{ padding: '18px 28px 14px', borderBottom: '1px solid var(--border)' }}>
          <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <h1 className="page-title" style={{ fontSize: 'var(--t-xl)', marginBottom: 6 }}>{src.title}</h1>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span className="qitem__sub"><Icon name="user" size={13} /> {src.author}</span><Dot />
                <a className="qitem__sub" style={{ color: 'var(--accent-text)', textDecoration: 'none' }} href="#"><Icon name="globe" size={13} /> {src.url}</a><Dot />
                <ConceptTag name={src.concept} /><Dot />
                <Prio p={src.prio} /><Status due={src.due} label={src.dueLabel} /><Dot />
                <SchedulerChip item={src} />
                {src.stagnant && <><Dot /><span className="badge badge--stagnant">Stagnant</span></>}
                <Dot /><span className="qitem__sub mono">last processed {src.lastProcessed} · next {src.next}</span>
              </div>
            </div>
          </div>
          {/* action bar */}
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Btn variant="primary" icon="bookmark" onClick={() => toast('Read-point set here')}>Set read-point <Kbd k="␣" /></Btn>
            <Btn icon="postpone" onClick={() => toast('Postponed 3 days')}>Postpone</Btn>
            <Btn icon="checkCircle" onClick={() => {toast('Marked done');onNav('queue');}}>Mark done</Btn>
            <Btn icon="arrowDown" onClick={() => toast('Priority lowered to C')}>Lower priority</Btn>
            <Btn icon="external">Open original</Btn>
            <Btn variant="danger" icon="trash"></Btn>
          </div>
        </div>

        {/* reading area */}
        <div className="page" onMouseUp={onMouseUp} data-comment-anchor="30453da6a8-div-123-9">
          <div className="reader" ref={readerRef} style={{ padding: '36px 0 120px' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-3)' }}>~ {src.read} read of {src.length} · {Math.round(src.progress * 100)}%</span>
              <span className="mono" style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-3)' }}>select any text to extract</span>
            </div>
            <div className="pbar" style={{ marginBottom: 28 }}><div className="pbar__fill" style={{ width: src.progress * 100 + '%' }}></div></div>

            {READING.map((b, i) => {
              if (b.kind === 'h') return <h3 key={i}>{b.text}</h3>;
              if (b.kind === 'dim') return <p key={i} className="dimmed">{b.text}</p>;
              if (b.kind === 'hl') return <p key={i}><mark className="hl">{b.text}</mark>{b.tail}</p>;
              if (b.kind === 'extracted') return (
                <div key={i} style={{ position: 'relative', borderRadius: 'var(--r-md)', transition: 'box-shadow var(--med)', boxShadow: jumped ? '0 0 0 2px var(--accent), 0 0 0 7px var(--accent-soft)' : 'none', margin: jumped ? '4px -8px 20px' : '0 0 0', padding: jumped ? '6px 8px' : 0 }}>
                  <p style={{ margin: 0 }}><mark className="extracted" title={b.note}>{b.text}</mark></p>
                  <div className="row" style={{ gap: 6, margin: '6px 0 20px', fontSize: 'var(--t-2xs)', color: 'var(--el-extract)', fontFamily: 'var(--font-mono)' }}><Icon name="extract" size={12} />{b.note}{jumped && <span style={{ color: 'var(--accent-text)' }}> · card lives here</span>}</div>
                </div>);

              // body paragraph with mark-processed affordance
              const isProc = processed.includes(i);
              return (
                <div key={i} className="readpara" style={{ position: 'relative' }}>
                  <p className={isProc ? 'dimmed' : ''} style={{ marginBottom: isProc ? 6 : 20 }}>{b.text}</p>
                  <button className="readpara__mark" title={isProc ? 'Processed — click to restore' : 'Mark processed (dim)'} onClick={() => setProcessed(p => isProc ? p.filter(x => x !== i) : [...p, i])}>
                    <Icon name={isProc ? 'restore' : 'check'} size={13} />
                  </button>
                </div>);
            })}

            <div className="readpoint"><span className="readpoint__hint">↓ unread from here</span></div>
            <p className="dimmed">The remainder of this chapter explores the role of REM sleep in emotional memory and creative problem-solving — material scheduled to surface in a later session.</p>
          </div>
        </div>
      </div>

      <SelToolbar pos={pos} onAction={action} />
      {flash && <div className="fade-up" style={{ position: 'fixed', bottom: 24, left: 'calc(50% + 50px)', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--canvas)', padding: '9px 16px', borderRadius: 'var(--r-full)', fontSize: 'var(--t-sm)', fontWeight: 500, boxShadow: 'var(--shadow-lg)', zIndex: 90, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="check" size={14} />{flash}</div>}

      {/* inspector */}
      <aside className="inspector">
        <div className="inspector__head"><span className="inspector__title">Source</span><Btn variant="ghost" size="sm"><Icon name="more" size={15} /></Btn></div>
        <div className="inspector__body">
          <div className="insp-sec">
            <div className="insp-sec__title">Metadata</div>
            <div className="meta-list">
              <MetaRow k="Type">{src.kind}</MetaRow>
              <MetaRow k="Reliability"><span className="badge badge--done">{src.reliability}</span></MetaRow>
              <MetaRow k="Added">{src.added}</MetaRow>
              <MetaRow k="Progress">{Math.round(src.progress * 100)}% · {src.read}</MetaRow>
              <MetaRow k="Reason"><span className="muted">{src.reason}</span></MetaRow>
            </div>
          </div>

          <div className="insp-sec">
            <div className="insp-sec__title"><span>Extracts from this source</span><span className="mono faint">{extracts.length}</span></div>
            {extracts.map((e) =>
            <div key={e.id} className="result" style={{ padding: '8px 10px', border: '1px solid var(--border)', marginBottom: 4 }} onClick={() => onOpen(null, e)}>
                <TypeIcon type="extract" />
                <div style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>{e.title}</div>
                  <div className="row" style={{ gap: 6, marginTop: 2 }}><Stage stage={e.stage} />{(e.yieldCards || 0) > 0 && <span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>· {e.yieldCards} card{e.yieldCards > 1 ? 's' : ''}</span>}</div>
                </div>
                <Icon name="chevronRight" size={14} />
              </div>
            )}
            {extracts.length === 0 && <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>No extracts yet — select text to create one.</span>}
          </div>

          <div className="insp-sec">
            <div className="insp-sec__title">Lineage</div>
            <LineageTree
              activeId={src.id}
              onPick={(n) => { if (n.id !== src.id) onOpen(null, D.byId(n.id)); }}
              nodes={[
                src.topic ? { id: src.topic, type: 'topic', title: (D.byId(src.topic) || {}).title || 'Topic', depth: 0, meta: 'topic' } : null,
                { id: src.id, type: 'source', title: src.title.split('—')[0].trim(), depth: src.topic ? 1 : 0, meta: 'source' },
                ...D.extracts.filter(e => e.sourceId === src.id && !e.parentExtractId).flatMap(e => [
                  { id: e.id, type: 'extract', title: e.title, depth: src.topic ? 2 : 1, meta: e.stage },
                  ...D.extracts.filter(se => se.parentExtractId === e.id).map(se => ({ id: se.id, type: 'extract', title: se.title, depth: src.topic ? 3 : 2, meta: 'sub-extract' })),
                  ...D.cards.filter(c => c.extractId === e.id).map(c => ({ id: c.id, type: 'card', title: titleFor(c), depth: src.topic ? 3 : 2, meta: c.cardType })),
                ]),
              ].filter(Boolean)}
            />
          </div>

          <div className="insp-sec">
            <div className="insp-sec__title">References cited</div>
            <div className="refblock">Walker, M. (2017). Sleep and memory consolidation. <em>Nature Reviews Neuroscience.</em><div className="refblock__src"><Icon name="link" size={12} /> 3 outgoing references</div></div>
          </div>

          <div className="insp-sec">
            <div className="insp-sec__title">Notes</div>
            <textarea className="textarea" rows="3" placeholder="Private notes on this source…" defaultValue="Cross-check the saturation claim against Yoo et al. 2007."></textarea>
          </div>
        </div>
      </aside>
    </>);

}

Object.assign(window, { ReaderScreen });