/**
 * Thin Icon wrapper over `lucide-react` (T003).
 *
 * The design prototype calls icons by short semantic names (`<Icon name="brain"/>`).
 * This wrapper maps those names onto the current `lucide-react` components (per
 * `design/icon-map.md`) and enforces the prototype's thin "pro-tool" weight:
 * `strokeWidth` 1.75 (Lucide defaults to 2, which reads heavier than the design).
 *
 * Keeping the mapping in one place means call sites stay stable even if Lucide
 * renames an icon again. UI-only concern — no domain logic lives here.
 *
 * NOTE: this lives in `apps/web` for now; it moves to `packages/ui` when the
 * shared component library is built out (T004/T010+).
 */
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bookmark,
  Brackets,
  Brain,
  Bug,
  Calendar,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CirclePause,
  ClipboardPaste,
  Clock,
  Code,
  Command,
  Copy,
  CornerDownLeft,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  Files,
  FileText,
  Filter,
  Flag,
  Flame,
  Folder,
  Gauge,
  GitMerge,
  Globe,
  GripVertical,
  Highlighter,
  Hourglass,
  Image,
  Inbox,
  Info,
  Keyboard,
  Layers,
  Library,
  Link,
  ListEnd,
  type LucideIcon,
  Map as MapIcon,
  MessageSquarePlus,
  Moon,
  Network,
  NotebookPen,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Quote,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Split,
  SquareCheckBig,
  SquarePlay,
  SquareStack,
  Star,
  Sun,
  Target,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Upload,
  User,
  X,
  Zap,
} from "lucide-react";
import type { ComponentProps } from "react";

/** Prototype icon name → `lucide-react` component (from design/icon-map.md). */
const ICONS = {
  // Navigation
  queue: ListEnd,
  inbox: Inbox,
  library: Library,
  review: RefreshCw,
  search: Search,
  analytics: BarChart3,
  settings: Settings,
  // Element types
  source: FileText,
  extract: Quote,
  card: SquareStack,
  task: SquareCheckBig,
  concept: Share2,
  concepts: Share2,
  media: SquarePlay,
  image: Image,
  topic: Folder,
  synthesis: NotebookPen,
  // Actions / status
  highlight: Highlighter,
  bookmark: Bookmark,
  cloze: Brackets,
  // T072: code-card affordances (predict-output template, code cloze).
  code: Code,
  edit: Pencil,
  copy: Copy,
  pause: Pause,
  split: Split,
  play: Play,
  trim: Scissors,
  leech: Bug,
  flag: Flag,
  clock: Clock,
  context: MessageSquarePlus,
  postpone: CalendarClock,
  merge: GitMerge,
  check: Check,
  archive: Archive,
  checkCircle: CircleCheck,
  star: Star,
  trash: Trash2,
  more: Ellipsis,
  arrowDown: ArrowDown,
  restore: ArchiveRestore,
  arrowUp: ArrowUp,
  undo: Undo2,
  external: ExternalLink,
  download: Download,
  // UI / chrome
  chevronRight: ChevronRight,
  globe: Globe,
  chevronDown: ChevronDown,
  user: User,
  chevronLeft: ChevronLeft,
  warning: TriangleAlert,
  x: X,
  info: Info,
  command: Command,
  upload: Upload,
  return: CornerDownLeft,
  paste: ClipboardPaste,
  sun: Sun,
  plus: Plus,
  moon: Moon,
  sparkle: Sparkles,
  filter: Filter,
  grip: GripVertical,
  calendar: Calendar,
  text: Type,
  link: Link,
  eye: Eye,
  // Domain / decorative
  layers: Layers,
  pin: Pin,
  flame: Flame,
  map: MapIcon,
  zap: Zap,
  hourglass: Hourglass,
  shield: ShieldCheck,
  dup: Files,
  gauge: Gauge,
  keyboard: Keyboard,
  brain: Brain,
  target: Target,
  pause2: CirclePause,
  treeBranch: Network,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The set of mapped icon names (handy for tests / completeness checks). */
export const iconNames = Object.keys(ICONS) as IconName[];

export type IconProps = {
  name: IconName;
  size?: number;
} & Omit<ComponentProps<LucideIcon>, "size" | "ref">;

/** Render a design-kit icon by name at the prototype's thin stroke weight. */
export function Icon({ name, size = 16, strokeWidth = 1.75, ...rest }: IconProps) {
  const Glyph = ICONS[name] ?? FileText;
  return <Glyph size={size} strokeWidth={strokeWidth} {...rest} />;
}
