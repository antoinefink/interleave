/* ============================================================
   SCREEN 5 — Active Recall Review Session
   ============================================================ */

function SessionClock({ startTime }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000); return () => clearInterval(t); }, [startTime]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0');
  return <span className="mono" style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-3)' }}>{mm}:{ss}</span>;
}

function ReviewScreen({ onOpenCmd, onNav, ctx, setCtx }) {
  const D = window.IR_DATA;
  const deck = useMemo(() => {
    const base = D.cards.slice();
    if (ctx && ctx.type === 'card') { base.sort((a, b) => (a.id === ctx.id ? -1 : 1)); }
    return base;
  }, []);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [startTime] = useState(Date.now());
  const [drawer, setDrawer] = useState(false);
  const [graded, setGraded] = useState([]);
  const card = deck[idx];
  const total = deck.length;
  const done = idx >= total;

  function jumpToSource() {
    if (!card) return;
    const src = D.sources.find(s => s.id === card.sourceId);
    if (src) { setCtx && setCtx({ ...src, jumpHighlight: card.extractId, jumpLoc: card.sourceLoc }); onNav('reader'); }
  }

  function grade(g) {
    if (!revealed) return;
    setGraded(x => [...x, { id: card.id, g }]);
    setReviewed(r => r + 1);
    setRevealed(false);
    setIdx(i => i + 1);
  }

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (done) return;
      if (e.code === 'Space') { e.preventDefault(); if (!revealed) setRevealed(true); }
      else if (revealed && ['1', '2', '3', '4'].indexOf(e.key) >= 0) { e.preventDefault(); grade(['again', 'hard', 'good', 'easy'][+e.key - 1]); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function renderFront(c, reveal) {
    if (c.cardType === 'cloze') {
      const parts = c.front.split(/(\{\{.+?\}\})/g);
      return parts.map((p, i) => {
        const m = p.match(/\{\{(.+?)\}\}/);
        if (m) return <span key={i} className={cx('cloze', reveal && 'cloze--revealed')}>{reveal ? m[1] : '[ … ]'}</span>;
        return <React.Fragment key={i}>{p}</React.Fragment>;
      });
    }
    return c.front;
  }

  const totalSec = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0'), ss = String(totalSec % 60).padStart(2, '0');

  return (
    <div className="main" style={{ position: 'relative' }}>
      <Topbar onOpenCmd={onOpenCmd} right={<Btn variant="ghost" icon="x" onClick={() => onNav('queue')}>End session</Btn>}>
        <div className="row" style={{ gap: 16, flex: 1 }}>
          <div style={{ flex: 1, maxWidth: 320 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
              <span className="mono" style={{ fontSize: 'var(--t-2xs)', color: 'var(--text-2)' }}>{reviewed} reviewed · {Math.max(0, total - reviewed)} left</span>
              <SessionClock startTime={startTime} />
            </div>
            <div className="pbar"><div className="pbar__fill" style={{ width: (reviewed / total * 100) + '%' }}></div></div>
          </div>
        </div>
      </Topbar>

      <div className="page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {done ? (
          <div className="panel" style={{ maxWidth: 520, width: '100%' }}>
            <EmptyState icon="checkCircle" title="Session complete" body={reviewed + ' cards reviewed in ' + mm + ':' + ss + '. Retention is tracking at 94% this week — your protected cards are all current.'}>
              <Btn onClick={() => { setIdx(0); setReviewed(0); setGraded([]); }}>Review again</Btn>
              <Btn variant="primary" onClick={() => onNav('queue')}>Back to queue</Btn>
            </EmptyState>
            <div style={{ padding: '0 24px 24px' }}>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
                {[['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']].map(([g, l]) => (
                  <Metric key={g} value={graded.filter(x => x.g === g).length} label={l} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="fade-up" style={{ width: '100%', maxWidth: 620 }} key={card.id}>
            {/* metadata row */}
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="badge badge--soft">{card.cardType === 'cloze' ? 'Cloze' : 'Q&A'}</span>
                <ConceptTag name={card.concept} />
                <Prio p={card.prio} />
                <Stage stage={card.stage} />
                {card.leech && <span className="badge badge--leech">Leech · {card.lapses} lapses</span>}
              </div>
              <SchedulerChip item={card} />
            </div>

            {card.leech && <div style={{ marginBottom: 12 }}><Banner icon="leech" title="This card keeps lapsing" body="Consider rewriting it, adding context, or splitting the fact." actions={<Btn size="sm" icon="context">Add context</Btn>} /></div>}

            {/* the card */}
            <div className="rcard" style={{ maxWidth: '100%' }}>
              <div className="rcard__face">
                <div className="rcard__prompt">{renderFront(card, false)}</div>
                {revealed && (
                  <div className="fade-up" style={{ marginTop: 22, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
                    {card.cardType === 'cloze' ? <div className="rcard__answer serif">{renderFront(card, true)}</div> : <div className="rcard__answer serif">{card.back}</div>}
                    <div className="refblock serif" style={{ marginTop: 16 }}>{card.ref}
                      <button className="refblock__src" onClick={jumpToSource} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontFamily: 'var(--font-ui)', marginTop: 8 }}>
                        <Icon name="external" size={12} /> Open source at this location · {card.sourceTitle} {card.sourceLoc}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <hr className="card-sep" />
              <div className="panel-pad">
                {!revealed ? (
                  <Btn variant="primary" size="lg" className="btn--block" icon="eye" onClick={() => setRevealed(true)}>Reveal answer <Kbd k="␣" /></Btn>
                ) : (
                  <>
                    <div className="grades">
                      {[['again', 'Again', 1], ['hard', 'Hard', 2], ['good', 'Good', 3], ['easy', 'Easy', 4]].map(([g, l, n]) => (
                        <button key={g} className={'grade grade--' + g} onClick={() => grade(g)}>
                          <span className="grade__label">{l}</span>
                          <span className="grade__int">{card.intervals[g]}</span>
                          <span className="kbd" style={{ marginTop: 2 }}>{n}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ marginTop: 14 }}><FsrsStats card={card} /></div>
                  </>
                )}
              </div>
            </div>

            {/* repair actions */}
            <div className="row" style={{ gap: 6, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
              <Btn size="sm" variant="ghost" icon="edit">Edit</Btn>
              <Btn size="sm" variant="ghost" icon="source" onClick={() => setDrawer(true)}>Open source</Btn>
              <Btn size="sm" variant="ghost" icon="context">Add context</Btn>
              <Btn size="sm" variant="ghost" icon="pause">Suspend</Btn>
              <Btn size="sm" variant="ghost" icon="leech">Mark leech</Btn>
              <Btn size="sm" variant="ghost" icon="trash">Delete</Btn>
            </div>
          </div>
        )}
      </div>

      {/* context drawer */}
      {drawer && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawer(false)}></div>
          <div className="drawer">
            <div className="inspector__head"><span className="inspector__title">Source context</span><Btn variant="ghost" size="sm" onClick={() => setDrawer(false)}><Icon name="x" size={15} /></Btn></div>
            <div className="inspector__body">
              <div className="row" style={{ gap: 9 }}><TypeIcon type="source" lg /><div className="col" style={{ gap: 0 }}><span style={{ fontWeight: 600, fontSize: 'var(--t-sm)' }}>{card.sourceTitle}</span><span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>{card.sourceLoc}</span></div></div>
              <div className="refblock serif">{card.ref}</div>
              <p className="serif" style={{ fontSize: 'var(--t-base)', lineHeight: 'var(--lh-read)', color: 'var(--text-2)' }}>The full passage continues to explain how the courier mechanism of slow-wave sleep underlies long-term consolidation — the surrounding context that gave rise to this card.</p>
              <Btn icon="external" className="btn--block" onClick={jumpToSource}>Open source at this location</Btn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

Object.assign(window, { ReviewScreen });
