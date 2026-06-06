/**
 * QueueSnackbar — the queue-scoped undo snackbar.
 *
 * Now a thin wrapper over the shared {@link Snackbar} (generalized in T044) so the
 * queue keeps its `queue-snackbar` test hooks while the toast presentation lives in
 * one place. The queue now reserves it for larger batch operations such as overload
 * recovery; ordinary per-row advancement stays quiet. Pure presentation: the parent
 * owns the undo call.
 */

import { Snackbar } from "../Snackbar";

export function QueueSnackbar({
  message,
  onUndo,
  onClose,
}: {
  /** The toast message, or `null`/empty to render nothing. */
  message: string | null;
  /** The undo handler; omit to hide the Undo button. */
  onUndo?: (() => void) | undefined;
  /** Called when the toast auto-dismisses or is closed. */
  onClose: () => void;
}) {
  return <Snackbar message={message} onUndo={onUndo} onClose={onClose} testId="queue-snackbar" />;
}
