/* ============================================================
   SCREEN 4 — Extract Distillation & Card Builder
   ============================================================ */

function QualityCheck({ ok, text }) {
  return <div className={cx('qc', ok ? 'qc--ok' : 'qc--warn')}><Icon name={ok ? 'checkCircle' : 'warning'} size={14} />{text}</div>;
}

function BuilderScreen({ onOpenCmd, onNav, ctx }) {
  const D = window.IR_DATA;
  const ex = (ctx && ctx.type === 'extract') ? ctx : D.extracts[1];
  const src = D.sources.find(s => s.id === ex.sourceId) || D.sources[0];
  const STAGES = ['Raw extract', 'Clean extract', 'Atomic statement', 'Card draft'];

  const [draft, setDraft] = useState(ex.text);
  const [stageIdx, setStageIdx] = useState(Math.max(0, STAGES.indexOf(ex.stage)));
  const [tab, setTab] = useState('cloze');
  const [revealed, setRevealed] = useState(false);
  const [front, setFront] = useState('During deep NREM sleep, slow brainwaves transport memory packets from the {{hippocampus}} to the {{neocortex}}.');
  const [qaFront, setQaFront] = useState('During which sleep stage are memories transported from the hippocampus to the neocortex?');
  const [qaBack, setQaBack] = useState('Deep NREM (slow-wave) sleep.');
  const [prio, setPrio] = useState(ex.prio);
  const [flash, setFlash] = useState(null);
  function toast(t) { setFlash(t); setTimeout(() => setFlash(null), 1500); }

  const words = draft.trim().split(/\s+/).length;
  const clozeCount = (front.match(/\{\{.+?\}\}/g) || []).length;
  const checks = tab === 'cloze' ? [
    { ok: words < 40, text: words < 40 ? 'Concise (' + words + ' words)' : 'Too long — ' + words + ' words, aim for one idea' },
    { ok: clozeCount > 0 && clozeCount <= 2, text: clozeCount === 0 ? 'No cloze deletion yet — wrap a phrase in {{ }}' : clozeCount <= 2 ? clozeCount + ' cloze deletion' + (clozeCount > 1 ? 's' : '') : 'Too many deletions (' + clozeCount + ') — split the card' },
    { ok: true, text: 'Source attached · Why We Sleep p. 112' },
  ] : [
    { ok: qaFront.length < 110, text: qaFront.length < 110 ? 'Clear, single-fact question' : 'Question too broad — narrow it' },
    { ok: qaBack.length < 90, text: qaBack.length < 90 ? 'Atomic answer' : 'Answer holds multiple facts — split' },
    { ok: true, text: 'Source attached · Why We Sleep p. 112' },
  ];

  function renderCloze(txt, reveal) {
    const parts = txt.split(/(\{\{.+?\}\})/g);
    return parts.map((p, i) => {
      const m = p.match(/\{\{(.+?)\}\}/);
      if (m) return <span key={i} className={cx('cloze', reveal && 'cloze--revealed')}>{reveal ? m[1] : '[ … ]'}</span>;
      return <React.Fragment key={i}>{p}</React.Fragment>;
    });
  }

  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd}>
        <div className="crumbs">
          <span className="crumb" onClick={() => onNav('reader')}><TypeIcon type="source" /> {src.title.split('—')[0].trim()}</span>
          <span className="crumb-sep"><Icon name="chevronRight" size={13} /></span>
          <span className="crumb"><TypeIcon type="extract" /> Extract</span>
          <span className="crumb-sep"><Icon name="chevronRight" size={13} /></span>
          <span className="crumb crumb--current">Card builder</span>
        </div>
      </Topbar>

      <div className="split3" style={{ flex: 1 }}>
        {/* LEFT — parent / source context */}
        <div className="split-col split-col--bd">
          <div className="sec-head"><span className="sec-title">Source context</span></div>
          <div style={{ padding: '0 16px 16px' }}>
            <div className="panel panel-pad" style={{ padding: 14, marginBottom: 14 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}><TypeIcon type="source" /><span style={{ fontSize: 'var(--t-sm)', fontWeight: 600 }} className="truncate">{src.title}</span></div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><ConceptTag name={src.concept} /><Prio p={src.prio} /></div>
            </div>
            <div className="insp-sec__title" style={{ marginBottom: 8 }}>Surrounding passage</div>
            <div className="refblock serif" style={{ fontSize: 'var(--t-base)', lineHeight: 'var(--lh-normal)' }}>
              …it clears the hippocampus, freeing space. <mark className="extracted">{ex.text}</mark> This nightly transfer accomplishes two things at once.
              <div className="refblock__src"><Icon name="source" size={12} /> {ex.page}</div>
            </div>

            <div className="insp-sec__title" style={{ margin: '18px 0 8px' }}>Lineage</div>
            <LineageTree
              activeId={ex.id}
              onPick={(n) => { const d = D.byId(n.id); if (d && d.type === 'source') onNav('reader'); }}
              nodes={[
                src.topic ? { id: src.topic, type: 'topic', title: (D.byId(src.topic) || {}).title || 'Topic', depth: 0, meta: 'topic' } : null,
                { id: src.id, type: 'source', title: src.title.split('—')[0].trim(), depth: src.topic ? 1 : 0, meta: 'source' },
                { id: ex.parentExtractId || ex.id, type: 'extract', title: ex.parentExtractId ? (D.byId(ex.parentExtractId) || {}).title : ex.title, depth: src.topic ? 2 : 1, meta: ex.parentExtractId ? 'parent' : ex.stage },
                ex.parentExtractId ? { id: ex.id, type: 'extract', title: ex.title, depth: src.topic ? 3 : 2, meta: 'this · sub-extract' } : null,
                ...D.cards.filter(c => c.extractId === ex.id).map(c => ({ id: c.id, type: 'card', title: titleFor(c), depth: (src.topic ? 2 : 1) + (ex.parentExtractId ? 2 : 1), meta: c.cardType })),
              ].filter(Boolean)}
            />
          </div>
        </div>

        {/* CENTER — extract editor */}
        <div className="split-col">
          <div className="sec-head">
            <div className="row" style={{ gap: 10 }}>
              <span className="sec-title">Distill extract</span>
              <Stage stage={STAGES[stageIdx]} />
            </div>
            <div className="row" style={{ gap: 6 }}>
              {stageIdx < STAGES.length - 1 && <Btn size="sm" variant="soft" icon="sparkle" onClick={() => { setStageIdx(i => Math.min(i + 1, STAGES.length - 1)); toast('Advanced to ' + STAGES[Math.min(stageIdx + 1, 3)]); }}>Advance stage</Btn>}
            </div>
          </div>

          <div style={{ padding: '0 24px 24px', overflowY: 'auto' }}>
            {/* distillation pipeline — the north star */}
            <div className="panel panel-pad" style={{ padding: '14px 16px', marginBottom: 16 }}>
              <Pipeline active={['extract', 'clean', 'atomic', 'card'][stageIdx] || 'extract'} counts={{ source: 1, extract: 1, card: D.cards.filter(c => c.extractId === ex.id).length, mature: D.cards.filter(c => c.extractId === ex.id && c.stage === 'Mature card').length }} />
            </div>

            {/* stage stepper */}
            <div className="row" style={{ gap: 0, marginBottom: 18 }}>
              {STAGES.map((s, i) => (
                <React.Fragment key={s}>
                  <button onClick={() => setStageIdx(i)} className="row" style={{ gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', background: i <= stageIdx ? 'var(--accent)' : 'var(--surface-2)', color: i <= stageIdx ? '#fff' : 'var(--text-3)', border: '1px solid ' + (i <= stageIdx ? 'var(--accent)' : 'var(--border)') }}>{i + 1}</span>
                    <span style={{ fontSize: 'var(--t-xs)', color: i === stageIdx ? 'var(--text)' : 'var(--text-3)', fontWeight: i === stageIdx ? 600 : 400 }}>{s}</span>
                  </button>
                  {i < STAGES.length - 1 && <div style={{ flex: 1, height: 1, background: i < stageIdx ? 'var(--accent)' : 'var(--border)', margin: '0 8px' }}></div>}
                </React.Fragment>
              ))}
            </div>

            <textarea className="editor" style={{ width: '100%', minHeight: 160 }} value={draft} onChange={e => setDraft(e.target.value)}></textarea>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="mono faint" style={{ fontSize: 'var(--t-2xs)' }}>{words} words · {draft.length} chars</span>
              <span className="faint" style={{ fontSize: 'var(--t-2xs)' }}>aim for a single, self-contained idea</span>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <Btn size="sm" icon="trim" onClick={() => toast('Trimmed whitespace & filler')}>Trim</Btn>
              <Btn size="sm" icon="split" onClick={() => toast('Split into 2 sub-extracts')}>Split extract</Btn>
              <Btn size="sm" icon="plus" onClick={() => toast('Sub-extract created')}>Sub-extract</Btn>
              <div className="vdiv" style={{ height: 22 }}></div>
              <Btn size="sm" icon="postpone" onClick={() => toast('Postponed')}>Postpone</Btn>
              <Btn size="sm" variant="danger" icon="trash"></Btn>
            </div>
          </div>
        </div>

        {/* RIGHT — card builder */}
        <div className="split-col split-col--bd-l" style={{ background: 'var(--surface)' }}>
          <div className="tabs">
            <button className={cx('tab', tab === 'cloze' && 'tab--on')} onClick={() => setTab('cloze')}>Cloze</button>
            <button className={cx('tab', tab === 'qa' && 'tab--on')} onClick={() => setTab('qa')}>Q&A</button>
            <button className="tab" disabled style={{ opacity: 0.4, cursor: 'not-allowed' }} title="Coming later">Image occlusion</button>
          </div>

          <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {tab === 'cloze' ? (
              <>
                <div className="field"><label className="field-label">Cloze text · wrap answers in {'{{ }}'}</label>
                  <textarea className="textarea" rows="4" value={front} onChange={e => setFront(e.target.value)}></textarea>
                </div>
                <div>
                  <div className="cardprev__label">Preview · {revealed ? 'revealed' : 'prompt'}</div>
                  <div className="cardprev">
                    <div className="cardprev__face serif">{renderCloze(front, revealed)}</div>
                  </div>
                  <Btn size="sm" variant="ghost" icon="eye" className="btn--block" style={{ marginTop: 8 }} onClick={() => setRevealed(r => !r)}>{revealed ? 'Hide answers' : 'Reveal answers'} <Kbd k="␣" /></Btn>
                </div>
              </>
            ) : (
              <>
                <div className="field"><label className="field-label">Front · question</label><textarea className="textarea" rows="2" value={qaFront} onChange={e => setQaFront(e.target.value)}></textarea></div>
                <div className="field"><label className="field-label">Back · answer</label><textarea className="textarea" rows="2" value={qaBack} onChange={e => setQaBack(e.target.value)}></textarea></div>
                <div>
                  <div className="cardprev__label">Preview</div>
                  <div className="cardprev">
                    <div className="cardprev__face serif">{revealed ? qaBack : qaFront}</div>
                  </div>
                  <Btn size="sm" variant="ghost" icon="eye" className="btn--block" style={{ marginTop: 8 }} onClick={() => setRevealed(r => !r)}>{revealed ? 'Show front' : 'Show back'}</Btn>
                </div>
              </>
            )}

            <div className="insp-sec">
              <div className="insp-sec__title">Quality checks</div>
              <div className="col" style={{ gap: 5 }}>{checks.map((c, i) => <QualityCheck key={i} ok={c.ok} text={c.text} />)}</div>
            </div>

            <div className="insp-sec">
              <div className="insp-sec__title">Priority & schedule</div>
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                {['A', 'B', 'C', 'D'].map(p => <button key={p} className={cx('chip', prio === p && 'chip--active')} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setPrio(p)}><span className={'prio-dot prio-dot--' + p.toLowerCase()}></span>{p}</button>)}
              </div>
              <div className="meta-list">
                <MetaRow k="First due"><span className="mono">Tomorrow</span></MetaRow>
                <MetaRow k="Target retention"><span className="mono">90%</span></MetaRow>
                <MetaRow k="Initial stability"><span className="mono">~3d</span></MetaRow>
                <MetaRow k="Scheduler"><span className="sched sched--fsrs"><Icon name="brain" /> FSRS</span></MetaRow>
              </div>
            </div>

            <Btn variant="primary" icon="card" className="btn--block" onClick={() => { toast(tab === 'cloze' ? 'Cloze card created' : 'Q&A card created'); onNav('review'); }}>Create {tab === 'cloze' ? 'cloze' : 'Q&A'} card</Btn>
          </div>
        </div>
      </div>

      {flash && <div className="fade-up" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--canvas)', padding: '9px 16px', borderRadius: 'var(--r-full)', fontSize: 'var(--t-sm)', fontWeight: 500, boxShadow: 'var(--shadow-lg)', zIndex: 90, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="check" size={14} />{flash}</div>}
    </div>
  );
}

Object.assign(window, { BuilderScreen });
