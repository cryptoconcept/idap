import {
  RESULT_BOARD_LABELS,
  RESULT_LEVEL_LABELS,
  RESULT_STREAM_LABELS,
  type ResultBoard,
  type ResultLevel,
  type ResultStream,
} from "@/lib/constants";

/**
 * The one place a cycle's human label is built. The list, the editor header and
 * the publish dialog all read from here, so a cycle never reads one way in the
 * table and another in the dialog that publishes it.
 */
export function describeCycle(result: {
  board: string;
  boardName?: string | null;
  level: string;
  stream?: string | null;
  academicYear: string;
  examLabel?: string | null;
}): string {
  const custom = result.examLabel?.trim();
  if (custom) return custom;

  const board =
    result.boardName?.trim() ||
    RESULT_BOARD_LABELS[result.board as ResultBoard] ||
    result.board;
  const level = RESULT_LEVEL_LABELS[result.level as ResultLevel] || result.level;
  const stream = result.stream
    ? RESULT_STREAM_LABELS[result.stream as ResultStream] || result.stream
    : null;

  return [board, level, stream, result.academicYear].filter(Boolean).join(" · ");
}
