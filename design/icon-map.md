# Icon library & mapping

The prototype ships a hand-rolled set of ~70 line icons (`kit/app/icons.js`): 24×24,
`currentColor` stroke, `stroke-width: 1.6`, round caps/joins. That is exactly the
[**Lucide**](https://lucide.dev) aesthetic, so we adopt **`lucide-react`** as the icon
library and map prototype names onto it.

## Integration approach

Keep a thin `Icon` wrapper so the design's call sites (`<Icon name="brain" size={16}/>`)
translate with near-zero churn and we keep one place to enforce defaults:

```tsx
// packages/ui/src/Icon.tsx  (created during the UI build, not now)
import * as L from "lucide-react";
const MAP = { brain: L.Brain, extract: L.Quote, /* …from the table below… */ } as const;

export function Icon({ name, size = 16, ...rest }: { name: keyof typeof MAP; size?: number }) {
  const C = MAP[name] ?? L.FileText;
  // strokeWidth 1.75 ≈ the prototype's 1.6 "thin pro-tool" weight (Lucide default is 2)
  return <C size={size} strokeWidth={1.75} {...rest} />;
}
```

Set `strokeWidth ≈ 1.75` globally to match the prototype's thin weight (Lucide defaults to
`2`, which reads heavier than the design).

## Name → `lucide-react` component

Lucide renamed several icons recently; current names are listed (legacy alias in parens).

### Navigation
| prototype | lucide-react |
|-----------|--------------|
| `queue` | `ListEnd` |
| `inbox` | `Inbox` |
| `library` | `Library` |
| `review` | `RefreshCw` |
| `search` | `Search` |
| `concepts` | `Share2` |
| `analytics` | `BarChart3` |
| `settings` | `Settings` |

### Element types
| prototype | lucide-react |
|-----------|--------------|
| `source` | `FileText` |
| `extract` | `Quote` |
| `card` | `SquareStack` |
| `task` | `SquareCheckBig` (was `CheckSquare`) |
| `concept` | `Share2` |
| `media` | `SquarePlay` (was `PlaySquare`) |
| `topic` | `Folder` |
| `synthesis` | `NotebookPen` |

### Actions / status
| prototype | lucide-react | · | prototype | lucide-react |
|-----------|--------------|---|-----------|--------------|
| `highlight` | `Highlighter` | · | `bookmark` | `Bookmark` |
| `cloze` | `Brackets` | · | `edit` | `Pencil` |
| `copy` | `Copy` | · | `pause` | `Pause` |
| `split` | `Split` | · | `play` | `Play` |
| `trim` | `Scissors` | · | `leech` | `Bug` |
| `clock` | `Clock` | · | `context` | `MessageSquarePlus` |
| `postpone` | `CalendarClock` | · | `merge` | `GitMerge` |
| `check` | `Check` | · | `archive` | `Archive` |
| `checkCircle` | `CircleCheck` (was `CheckCircle2`) | · | `star` | `Star` |
| `trash` | `Trash2` | · | `more` | `Ellipsis` (was `MoreHorizontal`) |
| `arrowDown` | `ArrowDown` | · | `restore` | `ArchiveRestore` |
| `arrowUp` | `ArrowUp` | · | `undo` | `Undo2` |
| `external` | `ExternalLink` | · | `download` | `Download` |

### UI / chrome
| prototype | lucide-react | · | prototype | lucide-react |
|-----------|--------------|---|-----------|--------------|
| `chevronRight` | `ChevronRight` | · | `globe` | `Globe` |
| `chevronDown` | `ChevronDown` | · | `user` | `User` |
| `chevronLeft` | `ChevronLeft` | · | `warning` | `TriangleAlert` (was `AlertTriangle`) |
| `x` | `X` | · | `info` | `Info` |
| `command` | `Command` | · | `upload` | `Upload` |
| `return` | `CornerDownLeft` | · | `paste` | `ClipboardPaste` |
| `sun` | `Sun` | · | `plus` | `Plus` |
| `moon` | `Moon` | · | `sparkle` | `Sparkles` |
| `filter` | `Filter` | · | `grip` | `GripVertical` |
| `calendar` | `Calendar` | · | `text` | `Type` |
| `link` | `Link` | · | `eye` | `Eye` |

### Domain / decorative
| prototype | lucide-react | · | prototype | lucide-react |
|-----------|--------------|---|-----------|--------------|
| `layers` | `Layers` (brand mark) | · | `pin` | `Pin` |
| `flame` | `Flame` (streak) | · | `map` | `Map` |
| `zap` | `Zap` | · | `hourglass` | `Hourglass` |
| `shield` | `ShieldCheck` | · | `dup` | `Files` (duplicate-detected) |
| `gauge` | `Gauge` (attention scheduler) | · | `keyboard` | `Keyboard` |
| `brain` | `Brain` (FSRS scheduler) | · | `target` | `Target` (atomic stage) |
| `pause2` | `CirclePause` (was `PauseCircle`) | · | `treeBranch` | `Network` (lineage) |

> Two scheduler icons are load-bearing: **`brain` (FSRS / memory)** vs **`gauge` (attention /
> when-to-process)**. Keep them visually distinct — see `SchedulerChip` in the kit and the
> FSRS/attention split in [`../docs/design-system.md`](../docs/design-system.md).

If a prototype icon has no exact Lucide match, prefer the closest semantic icon over a custom
SVG; only hand-roll an icon if Lucide genuinely lacks the concept.
</content>
