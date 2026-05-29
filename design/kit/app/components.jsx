/* ============================================================
   INCREMENTAL READING — Shared React components
   ============================================================ */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

function cx() {return Array.prototype.filter.call(arguments, Boolean).join(' ');}

// ---- Type icon chip ----
function TypeIcon({ type, lg }) {
  const map = { source: 'source', extract: 'extract', card: 'card', task: 'task', concept: 'concept', media: 'media', note: 'text', topic: 'topic', synthesis_note: 'synthesis' };
  const tone = type === 'note' ? 'extract' : type;
  return (
    <span className={cx('tico', 'tico--' + tone, lg && 'tico--lg')}>
      <Icon name={map[type] || 'source'} size={lg ? 17 : 14} />
    </span>);

}

// ---- Priority ----
function Prio({ p, dot }) {
  if (!p) return null;
  const c = p.toLowerCase();
  if (dot) return <span className={'prio-dot prio-dot--' + c} title={'Priority ' + p}></span>;
  return <span className={'badge prio prio--' + c}>{p}</span>;
}

// ---- Status badge ----
function Status({ due, label }) {
  if (!due) return null;
  const cls = due === 'overdue' ? 'badge--overdue' : due === 'today' ? 'badge--due' : due === 'done' ? 'badge--done' :
    due === 'suspended' ? 'badge--suspended' : due === 'dismissed' ? 'badge--dismissed' : due === 'trashed' ? 'badge--trashed' : 'badge--soft';
  return <span className={'badge ' + cls}>{label || due}</span>;
}

// ---- Stage badge ----
const STAGE_DOT = {
  'Inbox': 'var(--text-3)', 'Topic': 'var(--el-topic)', 'Reading': 'var(--el-source)',
  'Raw extract': 'var(--text-3)', 'Clean extract': 'var(--el-extract)', 'Atomic statement': 'var(--accent)',
  'Card draft': 'var(--el-card)', 'Active card': 'var(--el-card)', 'Mature card': 'var(--ok)', 'Synthesis': 'var(--el-synthesis)',
};
function Stage({ stage }) {
  return <span className="stage"><span className="stage-dot" style={{ background: STAGE_DOT[stage] || 'var(--text-3)' }}></span>{stage}</span>;
}

// ---- Scheduler chip: the visible split between FSRS and attention ----
function retrColor(r) { return r >= 0.85 ? 'var(--ok)' : r >= 0.7 ? 'var(--warn)' : 'var(--danger)'; }
function SchedulerChip({ item }) {
  if (!item) return null;
  if (item.scheduler === 'fsrs') {
    const r = Math.round(item.retrievability * 100);
    return (
      <span className="sched sched--fsrs" title="FSRS · spaced repetition">
        <Icon name="brain" />
        <span><b>{r}%</b> recall</span>
        <span className="sched__sep">·</span>
        <span>S {item.stability}d</span>
      </span>);
  }
  // attention scheduler
  return (
    <span className="sched sched--attn" title="Attention scheduler · when to process again">
      <Icon name="gauge" />
      <span>{item.stage || 'Queued'}</span>
      {item.postponed > 0 && <><span className="sched__sep">·</span><span>postponed ×{item.postponed}</span></>}
    </span>);
}

// retrievability dial
function Retr({ r }) {
  const pct = Math.round(r * 100), col = retrColor(r);
  return <span className="retr" style={{ color: col }}><span className="retr__ring" style={{ background: `conic-gradient(${col} ${pct}%, var(--border) 0)` }}></span>{pct}%</span>;
}

// FSRS three-stat readout
function FsrsStats({ card }) {
  const r = Math.round(card.retrievability * 100);
  return (
    <div className="fsrs-stats">
      <div className="fstat"><span className="fstat__v">{card.stability}<span style={{ fontSize: 'var(--t-xs)', color: 'var(--text-3)' }}>d</span></span><span className="fstat__l">Stability</span><span className="fstat__bar"><i style={{ width: Math.min(100, card.stability / 60 * 100) + '%', background: 'var(--accent)' }}></i></span></div>
      <div className="fstat"><span className="fstat__v">{card.difficulty}<span style={{ fontSize: 'var(--t-xs)', color: 'var(--text-3)' }}>/10</span></span><span className="fstat__l">Difficulty</span><span className="fstat__bar"><i style={{ width: card.difficulty * 10 + '%', background: card.difficulty > 6 ? 'var(--warn)' : 'var(--text-3)' }}></i></span></div>
      <div className="fstat"><span className="fstat__v" style={{ color: retrColor(card.retrievability) }}>{r}%</span><span className="fstat__l">Retrievability</span><span className="fstat__bar"><i style={{ width: r + '%', background: retrColor(card.retrievability) }}></i></span></div>
    </div>);
}

// ---- Concept tag ----
function ConceptTag({ name, onClick }) {
  if (!name) return null;
  return <span className="concept-tag" onClick={onClick} style={onClick ? { cursor: 'pointer' } : null}>{name}</span>;
}
function Tag({ name }) {return <span className="tag">{name}</span>;}

// ---- Keyboard hint ----
function Kbd({ k }) {
  const keys = Array.isArray(k) ? k : [k];
  return <span className="kbd-group">{keys.map((x, i) => <span className="kbd" key={i}>{x}</span>)}</span>;
}

// ---- dot separator ----
function Dot() {return <span className="dot-sep"></span>;}

// ---- next action pill ----
function NextAction({ icon, children }) {
  return <span className="next-action">{icon && <Icon name={icon} size={12} />}{children}</span>;
}

// ---- Banner ----
function Banner({ variant, icon, title, body, actions }) {
  return (
    <div className={cx('banner', variant && 'banner--' + variant)}>
      <Icon name={icon || 'warning'} size={16} />
      <div className="grow">
        <div className="banner__title" data-comment-anchor="1972907921-div-66-9">{title}</div>
        {body && <div className="banner__body">{body}</div>}
      </div>
      {actions && <div className="banner__actions">{actions}</div>}
    </div>);

}

// ---- Empty state ----
function EmptyState({ icon, title, body, children }) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon || 'checkCircle'} size={26} /></div>
      <div className="empty__title">{title}</div>
      {body && <div className="empty__body">{body}</div>}
      {children && <div className="row" style={{ marginTop: 6 }}>{children}</div>}
    </div>);

}

// ---- Metric mini-card ----
function Metric({ value, label, sub, variant, suffix, sm }) {
  return (
    <div className={cx('metric', sm && 'metric--sm', variant && 'metric--' + variant)}>
      <span className="metric__val">{value}{suffix && <span style={{ fontSize: 'var(--t-md)' }}>{suffix}</span>}</span>
      <span className="metric__label">{label}</span>
      {sub && <span className="metric__sub">{sub}</span>}
    </div>);

}

// ---- Sparkline (bars) ----
function Spark({ data, hotLast }) {
  const max = Math.max.apply(null, data);
  return (
    <div className="spark">
      {data.map((v, i) => <span key={i} className={hotLast && i === data.length - 1 ? 'hot' : ''} style={{ height: v / max * 100 + '%' }}></span>)}
    </div>);

}

// ---- Meta row ----
function MetaRow({ k, children }) {
  return <div className="meta-row"><span className="meta-key">{k}</span><span className="meta-val">{children}</span></div>;
}

// ---- Button (thin wrapper, mostly use className directly) ----
function Btn({ variant, size, icon, iconRight, children, className, ...rest }) {
  return (
    <button className={cx('btn', variant && 'btn--' + variant, size && 'btn--' + size, !children && 'btn--icon', className)} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children}
      {iconRight && <Icon name={iconRight} size={14} />}
    </button>);

}

// ---- Segmented control ----
function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) =>
      <button key={o.value} className={cx('seg', value === o.value && 'seg--on')} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={13} />}{o.label}
        </button>
      )}
    </div>);

}

// ---- Toggle switch ----
function Toggle({ on, onChange, label }) {
  return (
    <button className={cx('toggle', on && 'toggle--on')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="toggle__knob"></span>
      {label && <span className="toggle__label">{label}</span>}
    </button>);

}

// ---- Small popover menu ----
function Menu({ items, onPick, align }) {
  return (
    <div className={cx('menu', align === 'right' && 'menu--right')}>
      {items.map((it, i) => it.sep ? <hr key={i} className="card-sep" /> :
      <button key={i} className={cx('menu__item', it.danger && 'menu__item--danger')} onClick={() => onPick && onPick(it)}>
          {it.icon && <Icon name={it.icon} size={14} />}<span className="grow" style={{ textAlign: 'left' }}>{it.label}</span>
          {it.kbd && <Kbd k={it.kbd} />}
        </button>
      )}
    </div>);

}

// ---- The distillation pipeline (north star): Source → Extract → Clean → Atomic → Card → Mature ----
const PIPELINE_STEPS = [
  { key: 'source', icon: 'source', label: 'Source' },
  { key: 'extract', icon: 'extract', label: 'Extract' },
  { key: 'clean', icon: 'highlight', label: 'Clean' },
  { key: 'atomic', icon: 'target', label: 'Atomic' },
  { key: 'card', icon: 'card', label: 'Card' },
  { key: 'mature', icon: 'brain', label: 'Mature' },
];
function Pipeline({ active, counts }) {
  const ai = Math.max(0, PIPELINE_STEPS.findIndex(s => s.key === active));
  return (
    <div className="pipeline">
      {PIPELINE_STEPS.map((s, i) => (
        <div key={s.key} className={cx('pipe-step', i < ai && 'pipe-step--done', i === ai && 'pipe-step--on')}>
          <span className="pipe-step__dot"><Icon name={s.icon} size={14} /></span>
          <span className="pipe-step__lbl">{s.label}</span>
          {counts && counts[s.key] != null && <span className="pipe-step__n">{counts[s.key]}</span>}
        </div>
      ))}
    </div>);
}

// ---- Lineage tree (navigable both ways) ----
function LineageTree({ nodes, activeId, onPick }) {
  return (
    <div className="tree">
      {nodes.map((n, i) => (
        <div className="tree-row" key={n.id || i}>
          {Array.from({ length: n.depth || 0 }).map((_, d) => <span className="tree-indent" key={d}></span>)}
          <div className={cx('tree-node', n.id === activeId && 'tree-node--on', 'grow')} onClick={() => onPick && onPick(n)}>
            <TypeIcon type={n.type} />
            <span className="tree-node__title truncate">{n.title}</span>
            {n.meta && <span className="faint mono" style={{ fontSize: 'var(--t-2xs)' }}>{n.meta}</span>}
          </div>
        </div>
      ))}
    </div>);
}

// ---- Daily budget meter ----
function BudgetMeter({ used, target }) {
  const over = Math.max(0, used - target);
  const within = Math.min(used, target);
  return (
    <div className="budget">
      <div className="budget__head">
        <span className="budget__num">{used} <span>/ {target} today</span></span>
        {over > 0 && <span className="badge badge--overdue">{over} over budget</span>}
      </div>
      <div className="budget__bar">
        <span className="budget__used" style={{ width: (within / Math.max(target, used) * 100) + '%' }}></span>
        {over > 0 && <span className="budget__over" style={{ width: (over / Math.max(target, used) * 100) + '%' }}></span>}
      </div>
      <div className="budget__legend">
        <span><i style={{ background: 'var(--accent)' }}></i>Within budget</span>
        {over > 0 && <span><i style={{ background: 'var(--danger)' }}></i>Over budget</span>}
      </div>
    </div>);
}

// ---- Undo snackbar ----
function Snackbar({ message, onUndo, onClose }) {
  useEffect(() => { if (!message) return; const t = setTimeout(onClose, 5000); return () => clearTimeout(t); }, [message]);
  if (!message) return null;
  return (
    <div className="snackbar fade-up">
      <Icon name="trash" size={14} />
      <span>{message}</span>
      {onUndo && <button className="snackbar__undo" onClick={onUndo}><Icon name="undo" size={13} />Undo</button>}
    </div>);
}

// ---- Keyboard cheat-sheet (?) ----
const CHEAT = [
  { group: 'Navigation', rows: [['Command palette', ['⌘', 'K']], ['Go to Queue', ['G', 'Q']], ['Go to Review', ['G', 'R']], ['Go to Library', ['G', 'L']], ['This cheat sheet', ['?']]] },
  { group: 'Reading', rows: [['Extract selection', ['E']], ['Cloze selection', ['C']], ['Highlight', ['H']], ['Set read-point', ['␣']], ['Mark processed', ['M']]] },
  { group: 'Review', rows: [['Reveal answer', ['␣']], ['Grade Again → Easy', ['1', '4']], ['Edit card', ['E']], ['Open source', ['O']], ['Suspend', ['S']]] },
  { group: 'Triage', rows: [['Activate', ['1']], ['Read soon', ['2']], ['Save for later', ['3']], ['Archive', ['4']], ['Delete', ['6']]] },
];
function CheatSheet({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="cheat-overlay" onClick={onClose}>
      <div className="cheat" onClick={e => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--t-lg)', fontWeight: 600 }}>Keyboard shortcuts</h3>
          <Btn variant="ghost" size="sm" onClick={onClose}><Icon name="x" size={15} /></Btn>
        </div>
        <div className="cheat__grid">
          {CHEAT.map(g => (
            <div className="cheat__group" key={g.group}>
              <h4>{g.group}</h4>
              {g.rows.map((r, i) => (
                <div className="cheat__row" key={i}><span>{r[0]}</span><Kbd k={r[1]} /></div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>);
}

Object.assign(window, {
  cx, TypeIcon, Prio, Status, Stage, ConceptTag, Tag, Kbd, Dot, NextAction,
  Banner, EmptyState, Metric, Spark, MetaRow, Btn, Segmented, Toggle, Menu,
  SchedulerChip, Retr, FsrsStats, retrColor,
  Pipeline, LineageTree, BudgetMeter, Snackbar, CheatSheet,
  useState, useEffect, useRef, useMemo, useCallback
});