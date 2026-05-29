/* ============================================================
   ANALYTICS — review health overview
   ============================================================ */

function AnalyticsScreen({ onOpenCmd, onNav }) {
  const D = window.IR_DATA;
  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} />
      <div className="page">
        <div className="page-pad" style={{ maxWidth: 940, margin: '0 auto' }}>
          <div className="page-head"><div><h1 className="page-title">Analytics</h1><p className="page-sub">Your learning system at a glance · last 30 days</p></div></div>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
            <Metric value="94" suffix="%" label="Retention" sub="↑ 2% vs prior 30d" />
            <Metric value="1,284" label="Reviews" sub="≈ 43 / day" />
            <Metric value="128" label="Day streak" sub="best: 211" />
            <Metric value="7" label="Overdue" variant="danger" sub="oldest 5d" />
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="panel panel-pad">
              <div className="spread" style={{ marginBottom: 14 }}><span className="sec-title">Reviews per day</span><span className="faint mono" style={{ fontSize: 'var(--t-2xs)' }}>12 days</span></div>
              <div className="spark" style={{ height: 90 }}>{D.reviewHistory.map((v, i) => <span key={i} className={i === D.reviewHistory.length - 1 ? 'hot' : ''} style={{ height: (v / Math.max.apply(null, D.reviewHistory) * 100) + '%' }}></span>)}</div>
            </div>
            <div className="panel panel-pad">
              <div className="spread" style={{ marginBottom: 14 }}><span className="sec-title">7-day forecast</span><span className="faint mono" style={{ fontSize: 'var(--t-2xs)' }}>{D.forecast.reduce((a, b) => a + b, 0)} upcoming</span></div>
              <div className="spark" style={{ height: 90 }}>{D.forecast.map((v, i) => <span key={i} style={{ height: (v / Math.max.apply(null, D.forecast) * 100) + '%' }}></span>)}</div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d} className="mono faint" style={{ fontSize: 9 }}>{d}</span>)}</div>
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
            <div className="panel panel-pad">
              <div className="sec-title" style={{ marginBottom: 14 }}>Retention by concept</div>
              <div className="col" style={{ gap: 12 }}>
                {D.concepts.map((c, i) => {
                  const ret = [97, 95, 91, 88, 93, 84][i] || 90;
                  return (
                    <div key={c.id} className="row" style={{ gap: 12 }}>
                      <span className="concept-tag" style={{ width: 150, justifyContent: 'flex-start' }}>{c.name}</span>
                      <div className="pbar grow" style={{ height: 6 }}><div className="pbar__fill" style={{ width: ret + '%', background: ret < 90 ? 'var(--warn)' : 'var(--accent)' }}></div></div>
                      <span className="mono" style={{ fontSize: 'var(--t-xs)', width: 32, textAlign: 'right', color: ret < 90 ? 'var(--warn)' : 'var(--text-2)' }}>{ret}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="panel panel-pad">
              <div className="sec-title" style={{ marginBottom: 14 }}>System health</div>
              <div className="col" style={{ gap: 8 }}>
                <Banner icon="leech" title="1 leech to repair" />
                <Banner variant="danger" icon="warning" title="12 orphan cards" />
                <Banner variant="info" icon="hourglass" title="5 stale facts to verify" />
              </div>
              <Btn variant="soft" className="btn--block" icon="shield" style={{ marginTop: 12 }} onClick={() => onNav('library')}>Open maintenance</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AnalyticsScreen });
