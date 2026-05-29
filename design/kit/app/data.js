/* ============================================================
   INCREMENTAL READING — Mock data (v2)
   Two schedulers:
     • Cards run on FSRS (Stability / Difficulty / Retrievability)
     • Sources / Extracts / Topics run on an attention scheduler
       (priority + stage + last-processed + postponed×N + yield)
   Lineage: topic → source → extract → sub-extract → card → synthesis
   ============================================================ */
(function () {
  const concepts = [
    { id: 'c-learn', name: 'Learning science', parent: null, cards: 71, sources: 14, due: 18 },
    { id: 'c-mem', name: 'Sleep & memory', parent: 'c-learn', color: 'var(--el-concept)', cards: 38, sources: 6, due: 9 },
    { id: 'c-sr', name: 'Spaced repetition', parent: 'c-learn', cards: 52, sources: 9, due: 14 },
    { id: 'c-att', name: 'Attention', parent: 'c-learn', cards: 21, sources: 4, due: 3 },
    { id: 'c-habit', name: 'Habit formation', parent: null, cards: 17, sources: 3, due: 5 },
    { id: 'c-sys', name: 'Systems thinking', parent: null, cards: 12, sources: 5, due: 2 },
    { id: 'c-write', name: 'Writing & notes', parent: null, cards: 9, sources: 4, due: 1 },
  ];

  // ---- Topics: the incremental-reading "container" you keep returning to ----
  const topics = [
    {
      id: 'tp-mem', type: 'topic', scheduler: 'attention', title: 'How memory consolidation works',
      concept: 'Sleep & memory', prio: 'A', status: 'active', stage: 'Topic',
      sources: 4, extracts: 9, cards: 14, lastProcessed: '2 days ago', next: 'today',
      due: 'today', dueLabel: 'Due today', postponed: 0, stagnant: false, protected: true,
      desc: 'A living topic gathering everything on how the brain stabilises memories — sources, extracts, and cards collected over months.',
    },
    {
      id: 'tp-sr', type: 'topic', scheduler: 'attention', title: 'Designing a review algorithm',
      concept: 'Spaced repetition', prio: 'B', status: 'active', stage: 'Topic',
      sources: 6, extracts: 12, cards: 22, lastProcessed: '5 days ago', next: 'in 1d',
      due: 'soon', dueLabel: 'In 1d', postponed: 2, stagnant: false,
      desc: 'From SM-2 through FSRS — comparing scheduling models.',
    },
  ];

  const sources = [
    {
      id: 's-sleep', type: 'source', scheduler: 'attention', title: 'Why We Sleep — The Memory Benefits of Sleep',
      author: 'Matthew Walker', url: 'sleepfoundation.org/why-we-sleep-ch4', kind: 'Book chapter',
      concept: 'Sleep & memory', topic: 'tp-mem', tags: ['memory', 'neuroscience', 'sleep'], prio: 'A',
      reliability: 'High', status: 'active', stage: 'Reading', progress: 0.42, length: '28 min', read: '18 min',
      due: 'today', dueLabel: 'Due today', added: 'Apr 2', lastProcessed: '2 days ago', next: 'May 31',
      reason: 'Core mechanism for the consolidation argument in my essay on learning.',
      yieldExtracts: 4, yieldCards: 6, postponed: 1, stagnant: false, protected: true,
    },
    {
      id: 's-sm2071', type: 'source', scheduler: 'attention', title: 'SuperMemo — From SM-2 to FSRS',
      author: 'P. Wozniak', url: 'supermemo.com/en/archives/sm2', kind: 'Article',
      concept: 'Spaced repetition', topic: 'tp-sr', tags: ['algorithm', 'memory'], prio: 'B',
      reliability: 'High', status: 'active', stage: 'Reading', progress: 0.7, length: '15 min', read: '11 min',
      due: 'today', dueLabel: 'Due today', added: 'Mar 28', lastProcessed: 'yesterday', next: 'May 30',
      reason: 'Need the exact stability/difficulty update rules.', yieldExtracts: 3, yieldCards: 5, postponed: 0, stagnant: false,
    },
    {
      id: 's-deep', type: 'source', scheduler: 'attention', title: 'Deep Work — Rules for Focused Success',
      author: 'Cal Newport', url: 'calnewport.com/deep-work', kind: 'Book',
      concept: 'Attention', topic: null, tags: ['focus', 'productivity'], prio: 'B',
      reliability: 'Medium', status: 'active', stage: 'Reading', progress: 0.15, length: '3h 20m', read: '30 min',
      due: 'overdue', dueLabel: '1d overdue', added: 'Feb 11', lastProcessed: '4 days ago', next: 'May 28',
      reason: 'Attention-residue concept for the focus chapter.', yieldExtracts: 2, yieldCards: 3, postponed: 4, stagnant: true,
    },
    {
      id: 's-atomic', type: 'source', scheduler: 'attention', title: 'Atomic Habits — The Plateau of Latent Potential',
      author: 'James Clear', url: 'jamesclear.com/atomic-habits', kind: 'Book chapter',
      concept: 'Habit formation', topic: null, tags: ['habits', 'behavior'], prio: 'C',
      reliability: 'Medium', status: 'active', stage: 'Reading', progress: 0.55, length: '22 min', read: '12 min',
      due: 'soon', dueLabel: 'In 3d', added: 'Jan 30', lastProcessed: '1 week ago', next: 'Jun 1',
      reason: 'The compounding curve metaphor.', yieldExtracts: 2, yieldCards: 2, postponed: 1, stagnant: false,
    },
    {
      id: 's-thinking', type: 'source', scheduler: 'attention', title: 'Thinking in Systems — Stocks and Flows',
      author: 'Donella Meadows', url: 'donellameadows.org/systems', kind: 'Book chapter',
      concept: 'Systems thinking', topic: null, tags: ['systems', 'modeling'], prio: 'C',
      reliability: 'High', status: 'active', stage: 'Inbox', progress: 0.0, length: '40 min', read: '0 min',
      due: 'soon', dueLabel: 'In 5d', added: 'May 20', lastProcessed: 'never', next: 'Jun 3',
      reason: 'Foundational mental model.', yieldExtracts: 0, yieldCards: 0, postponed: 0, stagnant: false,
    },
  ];

  const extracts = [
    {
      id: 'e-1', type: 'extract', scheduler: 'attention', sourceId: 's-sleep', sourceTitle: 'Why We Sleep', parentExtractId: null,
      title: 'Sleep before learning refreshes our ability to make new memories',
      text: 'Sleep before learning refreshes our ability to make new memories. It does so each and every night. While we are awake we are busily acquiring new memories, the hippocampus accumulating information throughout the day. Without sufficient sleep, this short-term reservoir saturates and we lose the ability to take on more.',
      stage: 'Raw extract', prio: 'C', concept: 'Sleep & memory', topic: 'tp-mem', status: 'active', due: 'today', dueLabel: 'Due today',
      page: 'p. 108', yieldCards: 0, lastProcessed: '2 days ago', postponed: 0, stagnant: false,
    },
    {
      id: 'e-2', type: 'extract', scheduler: 'attention', sourceId: 's-sleep', sourceTitle: 'Why We Sleep', parentExtractId: null,
      title: 'Deep NREM sleep drives hippocampal-to-neocortical transfer',
      text: 'During deep NREM sleep, slow brainwaves serve as a courier service, transporting memory packets from the short-term storage of the hippocampus to the long-term storage site of the neocortex.',
      stage: 'Clean extract', prio: 'B', concept: 'Sleep & memory', topic: 'tp-mem', status: 'active', due: 'today', dueLabel: 'Due today',
      page: 'p. 112', yieldCards: 2, lastProcessed: 'yesterday', postponed: 0, stagnant: false,
    },
    {
      id: 'e-2a', type: 'extract', scheduler: 'attention', sourceId: 's-sleep', sourceTitle: 'Why We Sleep', parentExtractId: 'e-2',
      title: 'Slow brainwaves act as the "courier"',
      text: 'The slow oscillations of deep NREM act as a courier, timing the hand-off between hippocampus and neocortex.',
      stage: 'Atomic statement', prio: 'B', concept: 'Sleep & memory', topic: 'tp-mem', status: 'active', due: 'soon', dueLabel: 'In 2d',
      page: 'p. 112', yieldCards: 1, lastProcessed: 'yesterday', postponed: 0, stagnant: false,
    },
    {
      id: 'e-3', type: 'extract', scheduler: 'attention', sourceId: 's-sm2071', sourceTitle: 'SM-2 → FSRS', parentExtractId: null,
      title: 'FSRS models memory with stability and difficulty',
      text: 'FSRS represents each memory with two latent variables: stability (how many days until recall probability falls to the desired retention) and difficulty (how hard the item is to stabilise, 0–10). Each review updates both.',
      stage: 'Atomic statement', prio: 'B', concept: 'Spaced repetition', topic: 'tp-sr', status: 'active', due: 'overdue', dueLabel: '1d overdue',
      page: '§3', yieldCards: 3, lastProcessed: '3 days ago', postponed: 2, stagnant: true,
    },
    {
      id: 'e-4', type: 'extract', scheduler: 'attention', sourceId: 's-deep', sourceTitle: 'Deep Work', parentExtractId: null,
      title: 'Attention residue degrades performance on the next task',
      text: 'When you switch from task A to task B, your attention does not immediately follow — a residue of your attention remains stuck thinking about the original task.',
      stage: 'Raw extract', prio: 'B', concept: 'Attention', topic: null, status: 'active', due: 'soon', dueLabel: 'In 2d',
      page: 'p. 42', yieldCards: 0, lastProcessed: '4 days ago', postponed: 3, stagnant: true,
    },
  ];

  // ---- Cards run on FSRS ----
  const cards = [
    {
      id: 'k-1', type: 'card', scheduler: 'fsrs', cardType: 'cloze', extractId: 'e-2', sourceId: 's-sleep',
      sourceTitle: 'Why We Sleep', sourceLoc: 'p. 112', concept: 'Sleep & memory', topic: 'tp-mem', prio: 'B', status: 'active',
      front: 'The hippocampus transfers memories to the neocortex primarily during {{deep NREM}} sleep.',
      clozeAnswer: 'deep NREM',
      back: 'During deep NREM sleep, slow brainwaves transport memory packets from the hippocampus to the neocortex.',
      ref: '"Slow-wave sleep provides the conditions for hippocampal-neocortical dialogue."',
      stability: 18.4, difficulty: 4.2, retrievability: 0.91, reps: 5, lapses: 0, due: 'today', dueLabel: 'Due today',
      intervals: { again: '<10m', hard: '9d', good: '24d', easy: '47d' }, siblings: 1, stage: 'Active card',
    },
    {
      id: 'k-2', type: 'card', scheduler: 'fsrs', cardType: 'qa', extractId: 'e-3', sourceId: 's-sm2071',
      sourceTitle: 'SM-2 → FSRS', sourceLoc: '§3', concept: 'Spaced repetition', topic: 'tp-sr', prio: 'B', status: 'active',
      front: 'In FSRS, what does the Stability of a memory represent?',
      back: 'The number of days until recall probability decays to the desired-retention threshold (e.g. 90%). Higher stability = longer interval.',
      ref: '"Stability is the interval at which retrievability reaches the target."',
      stability: 41.0, difficulty: 5.8, retrievability: 0.82, reps: 7, lapses: 1, due: 'overdue', dueLabel: '2d overdue',
      intervals: { again: '<10m', hard: '15d', good: '38d', easy: '72d' }, siblings: 2, stage: 'Mature card',
    },
    {
      id: 'k-3', type: 'card', scheduler: 'fsrs', cardType: 'cloze', extractId: 'e-3', sourceId: 's-sm2071',
      sourceTitle: 'SM-2 → FSRS', sourceLoc: '§3', concept: 'Spaced repetition', topic: 'tp-sr', prio: 'C', status: 'active',
      front: 'FSRS difficulty is bounded on a scale from 1 to {{10}}, where higher means harder to stabilise.',
      clozeAnswer: '10',
      back: 'Difficulty ranges 1–10; it nudges up after lapses and slowly reverts toward the mean.',
      ref: '"Difficulty D ∈ [1,10] modulates the stability increase."',
      stability: 6.3, difficulty: 3.1, retrievability: 0.94, reps: 3, lapses: 0, due: 'today', dueLabel: 'Due today',
      intervals: { again: '<10m', hard: '5d', good: '14d', easy: '29d' }, siblings: 2, stage: 'Active card',
    },
    {
      id: 'k-4', type: 'card', scheduler: 'fsrs', cardType: 'qa', extractId: 'e-1', sourceId: 's-sleep',
      sourceTitle: 'Why We Sleep', sourceLoc: 'p. 108', concept: 'Sleep & memory', topic: 'tp-mem', prio: 'A', status: 'active',
      front: 'Why does insufficient sleep impair our ability to form new memories the next day?',
      back: 'The hippocampus is a short-term reservoir that saturates; sleep clears it, restoring capacity to acquire new memories.',
      ref: '"Without sufficient sleep, this short-term reservoir saturates."',
      stability: 2.1, difficulty: 8.6, retrievability: 0.58, reps: 9, lapses: 8, due: 'overdue', dueLabel: '5d overdue', leech: true,
      intervals: { again: '<10m', hard: '2d', good: '4d', easy: '9d' }, siblings: 1, stage: 'Active card',
    },
  ];

  const tasks = [
    { id: 't-1', type: 'task', scheduler: 'attention', title: 'Verify: does FSRS difficulty revert toward the mean, or stay sticky?', concept: 'Spaced repetition', topic: 'tp-sr', prio: 'B', status: 'active', due: 'today', dueLabel: 'Due today', linked: 's-sm2071', kind: 'Verification' },
    { id: 't-2', type: 'task', scheduler: 'attention', title: 'Reconcile two conflicting extracts on REM vs NREM consolidation', concept: 'Sleep & memory', topic: 'tp-mem', prio: 'A', status: 'active', due: 'overdue', dueLabel: '1d overdue', linked: 's-sleep', kind: 'Reconcile' },
  ];

  // ---- Synthesis notes (incremental writing) ----
  const synthesis = [
    {
      id: 'sy-1', type: 'synthesis_note', scheduler: 'attention', title: 'Essay draft — Why sleep is the price of plasticity',
      concept: 'Sleep & memory', topic: 'tp-mem', prio: 'A', status: 'active', stage: 'Synthesis', due: 'soon', dueLabel: 'In 2d',
      words: 740, sources: 3, extracts: 5, lastProcessed: 'yesterday',
      text: 'Consolidation is not a side-effect of sleep but one of its central purposes. Drawing the hippocampus-saturation argument (e-1) together with the courier mechanism (e-2) suggests…',
    },
    {
      id: 'sy-2', type: 'synthesis_note', scheduler: 'attention', title: 'Note — FSRS vs SM-2: what actually changed',
      concept: 'Spaced repetition', topic: 'tp-sr', prio: 'B', status: 'active', stage: 'Synthesis', due: 'soon', dueLabel: 'In 4d',
      words: 320, sources: 2, extracts: 3, lastProcessed: '3 days ago',
      text: 'SM-2 tracked a single ease factor; FSRS separates stability from difficulty and predicts retrievability directly…',
    },
  ];

  // ---- Trash (local-first: recoverable) ----
  const trash = [
    { id: 'tr-1', type: 'card', title: 'Cloze · The forgetting curve is {{exponential}}', deleted: '2 hours ago', from: 'Spaced repetition' },
    { id: 'tr-2', type: 'extract', title: 'Extract · "Massed practice produces fast but fragile learning"', deleted: 'yesterday', from: 'Deep Work' },
    { id: 'tr-3', type: 'source', title: 'Old draft — Memory palace techniques', deleted: '3 days ago', from: 'Learning science' },
  ];

  const forecast = [42, 31, 55, 28, 64, 19, 47];
  const reviewHistory = [38, 52, 41, 60, 44, 58, 49, 63, 51, 47, 55, 42];

  const all = function () { return [...topics, ...sources, ...extracts, ...cards, ...tasks, ...synthesis]; };

  window.IR_DATA = {
    concepts, topics, sources, extracts, cards, tasks, synthesis, trash, forecast, reviewHistory,
    budget: { used: 98, target: 60, overdue: 7, importsToday: 4 },
    settings: {
      reviewBudget: 60, desiredRetention: 0.90, topicInterval: 7, defaultPriority: 'C',
      keyboardLayout: 'QWERTY', autoPostpone: true,
    },
    nav: [
      { id: 'queue', label: 'Queue', icon: 'queue', badge: 42 },
      { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: 4 },
      { id: 'library', label: 'Library', icon: 'library' },
      { id: 'review', label: 'Review', icon: 'review', badge: 28 },
      { id: 'search', label: 'Search', icon: 'search' },
      { id: 'concepts', label: 'Concepts', icon: 'concepts' },
      { id: 'analytics', label: 'Analytics', icon: 'analytics' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
    ],
    inbox: [
      {
        id: 'i-1', type: 'source', srcType: 'URL', title: 'The Forgetting Curve and How to Beat It',
        url: 'ncase.me/remember', author: 'Nicky Case', imported: '8 min ago', length: '12 min read',
        concept: '', tags: [], duplicate: false,
        preview: 'How we forget — and what to do about it. Hermann Ebbinghaus discovered that memory decays exponentially over time, unless interrupted by review. The "forgetting curve" describes this decay. Each time you successfully recall a piece of information, the curve flattens: the rate of forgetting slows, and the memory becomes more durable.\n\nThis is the foundation of spaced repetition. Rather than cramming, you review material at expanding intervals — just before you would have forgotten it.',
      },
      {
        id: 'i-2', type: 'source', srcType: 'PDF', title: 'Roediger & Karpicke (2006) — Test-Enhanced Learning', srcMeta: 'PDF · 14 pages',
        url: 'psych.wustl.edu/roediger-karpicke-2006.pdf', author: 'Roediger, Karpicke', imported: '32 min ago', length: '40 min read',
        concept: 'Spaced repetition', tags: ['retrieval-practice'], duplicate: false,
        preview: 'Taking a memory test not only assesses what one knows, but also enhances later retention, a phenomenon known as the testing effect. In two experiments, students studied prose passages and took one or three immediate free-recall tests.\n\nWhen the final test was given after 5 minutes, repeated studying produced better recall than repeated testing. However, on delayed tests, prior testing produced substantially better retention.',
      },
      {
        id: 'i-3', type: 'source', srcType: 'Capture', title: 'Why We Sleep — Ch. 4 (clipped)', srcMeta: 'Browser capture',
        url: 'sleepfoundation.org/why-we-sleep-ch4', author: 'Matthew Walker', imported: '1 hour ago', length: '26 min read',
        concept: 'Sleep & memory', tags: ['memory'], duplicate: true,
        preview: 'The memory benefits of sleep. We have long known that sleep and memory are connected, but only recently have we understood the mechanism. Sleep before learning prepares the brain for initial formation of memories, and sleep after learning cements those memories, preventing forgetting...',
      },
      {
        id: 'i-4', type: 'note', srcType: 'Note', title: 'Idea: interleave concepts during review, not block them', srcMeta: 'Manual note',
        url: '', author: '', imported: '2 hours ago', length: '1 min read',
        concept: '', tags: ['idea'], duplicate: false,
        preview: 'Blocked practice (AAA BBB CCC) feels easier but interleaved practice (ABC ABC) produces better long-term retention and transfer. The queue should probably interleave concepts by default rather than draining one concept at a time.',
      },
    ],
  };

  window.IR_DATA.byId = function (id) {
    return window.IR_DATA._all.find(function (x) { return x.id === id; });
  };
  window.IR_DATA._all = all();

  // The daily queue — a mix of items on BOTH schedulers
  window.IR_DATA.queue = [
    { ref: 'tp-mem', action: 'Process topic', actionIcon: 'topic' },
    { ref: 's-sleep', action: 'Resume reading', actionIcon: 'bookmark' },
    { ref: 'k-4', action: 'Review card', actionIcon: 'review' },
    { ref: 'e-3', action: 'Distill → card', actionIcon: 'sparkle' },
    { ref: 't-2', action: 'Resolve task', actionIcon: 'checkCircle' },
    { ref: 's-sm2071', action: 'Resume reading', actionIcon: 'bookmark' },
    { ref: 'k-1', action: 'Review card', actionIcon: 'review' },
    { ref: 'sy-1', action: 'Continue writing', actionIcon: 'synthesis' },
    { ref: 'e-1', action: 'Distill → card', actionIcon: 'sparkle' },
    { ref: 's-deep', action: 'Resume reading', actionIcon: 'bookmark' },
    { ref: 'k-2', action: 'Review card', actionIcon: 'review' },
    { ref: 't-1', action: 'Resolve task', actionIcon: 'checkCircle' },
    { ref: 'k-3', action: 'Review card', actionIcon: 'review' },
    { ref: 'e-4', action: 'Distill → card', actionIcon: 'sparkle' },
  ];
})();
