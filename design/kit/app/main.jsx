/* ============================================================
   INCREMENTAL READING — App root, routing, theme
   ============================================================ */

function PlaceholderScreen({ name, onOpenCmd }) {
  return (
    <div className="main">
      <Topbar onOpenCmd={onOpenCmd} />
      <div className="page"><div className="page-pad"><EmptyState icon="layers" title={name} body="This screen is being built." /></div></div>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState('queue');
  const [theme, setTheme] = useState(localStorage.getItem('ir-theme') || 'light');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [snack, setSnack] = useState(null);
  const [ctx, setCtx] = useState(null); // currently-open entity (for reader/builder/review)

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('ir-theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('ir-route', route); }, [route]);

  const nav = useCallback((r) => { if (r === '__theme') { setTheme(t => t === 'dark' ? 'light' : 'dark'); return; } setRoute(r); }, []);
  const toggleTheme = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), []);
  const toast = useCallback((message, onUndo) => { setSnack({ message, onUndo: onUndo ? () => { onUndo(); setSnack(null); } : null }); }, []);

  // open an entity from the queue/library → route to the right workspace
  const openEntity = useCallback((item, data) => {
    const d = data || (item && item.data) || item;
    if (!d) return;
    setCtx(d);
    if (d.type === 'source') setRoute('reader');
    else if (d.type === 'extract') setRoute('builder');
    else if (d.type === 'card') setRoute('review');
    else if (d.type === 'task') setRoute('task');
    else if (d.type === 'synthesis_note') setRoute('synthesis');
    else if (d.type === 'topic') setRoute('library');
  }, []);

  // global shortcuts
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdOpen(o => !o); return; }
      if (typing) return;
      if (e.key === '?') { e.preventDefault(); setCheatOpen(o => !o); return; }
      if (e.key === 'g') { window.__g = true; setTimeout(() => window.__g = false, 700); return; }
      if (window.__g) {
        const m = { q: 'queue', i: 'inbox', r: 'review', l: 'library', c: 'concepts', a: 'analytics', s: 'settings' };
        if (m[e.key]) { setRoute(m[e.key]); window.__g = false; }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shared = { onNav: nav, onOpenCmd: () => setCmdOpen(true), onOpen: openEntity, onToast: toast, theme, ctx, setCtx };

  let screen;
  switch (route) {
    case 'queue': screen = <QueueScreen {...shared} />; break;
    case 'inbox': screen = window.InboxScreen ? <InboxScreen {...shared} /> : <PlaceholderScreen name="Inbox" onOpenCmd={shared.onOpenCmd} />; break;
    case 'reader': screen = window.ReaderScreen ? <ReaderScreen {...shared} /> : <PlaceholderScreen name="Reader" onOpenCmd={shared.onOpenCmd} />; break;
    case 'builder': screen = window.BuilderScreen ? <BuilderScreen {...shared} /> : <PlaceholderScreen name="Builder" onOpenCmd={shared.onOpenCmd} />; break;
    case 'review': screen = window.ReviewScreen ? <ReviewScreen {...shared} /> : <PlaceholderScreen name="Review" onOpenCmd={shared.onOpenCmd} />; break;
    case 'library': case 'search': screen = window.LibraryScreen ? <LibraryScreen {...shared} /> : <PlaceholderScreen name="Library" onOpenCmd={shared.onOpenCmd} />; break;
    case 'concepts': screen = window.LibraryScreen ? <LibraryScreen {...shared} initialTab="map" /> : <PlaceholderScreen name="Concepts" onOpenCmd={shared.onOpenCmd} />; break;
    case 'analytics': screen = window.AnalyticsScreen ? <AnalyticsScreen {...shared} /> : <PlaceholderScreen name="Analytics" onOpenCmd={shared.onOpenCmd} />; break;
    case 'settings': screen = window.SettingsScreen ? <SettingsScreen {...shared} /> : <PlaceholderScreen name="Settings" onOpenCmd={shared.onOpenCmd} />; break;
    case 'trash': screen = window.TrashScreen ? <TrashScreen {...shared} /> : <PlaceholderScreen name="Trash" onOpenCmd={shared.onOpenCmd} />; break;
    case 'synthesis': screen = window.SynthesisScreen ? <SynthesisScreen {...shared} /> : <PlaceholderScreen name="Synthesis" onOpenCmd={shared.onOpenCmd} />; break;
    case 'task': screen = window.TaskScreen ? <TaskScreen {...shared} /> : <PlaceholderScreen name="Task" onOpenCmd={shared.onOpenCmd} />; break;
    default: screen = <QueueScreen {...shared} />;
  }

  const navHighlight = ['reader', 'builder', 'task', 'synthesis'].includes(route) ? 'queue' : route === 'trash' ? 'settings' : route;

  return (
    <div className="app">
      <Sidebar route={navHighlight} onNav={nav} theme={theme} onTheme={toggleTheme} onCheat={() => setCheatOpen(true)} />
      {screen}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} onNav={nav} />
      <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />
      {snack && <Snackbar message={snack.message} onUndo={snack.onUndo} onClose={() => setSnack(null)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
