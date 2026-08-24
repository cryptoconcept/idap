import { BOARD_NAME_REQUIRED, type ResultBoard } from "@/lib/constants";

type Readable = {
  board: string;
  boardName?: string | null;
  appeared: number;
  passed: number;
  /**
   * A topper as the editor holds it. Only the name and the consent flag are
   * read; the identity and score come along because that is the shape the
   * `ResultDTO` hands over, and a narrower type would reject it at the literal.
   */
  toppers?: { id?: string; name: string; percentage?: number; consentAcknowledged: boolean }[];
};

/**
 * Why the publish button is disabled, in the institution's own words. The
 * server enforces these same rules in `assertPublishable`; this exists so the
 * UI can say WHICH rule is unmet instead of failing on submit.
 *
 * Deliberately mirrors the server's rules rather than replacing them — the
 * server remains the authority, and a disagreement shows up as a rejected
 * publish rather than a silently permitted one.
 */
export function blockingPublishReasons(result: Readable): string[] {
  const reasons: string[] = [];

  if (result.appeared <= 0) {
    reasons.push("Enter how many students appeared.");
  }

  if (result.passed > result.appeared) {
    reasons.push("The number who passed cannot exceed the number who appeared.");
  }

  if (BOARD_NAME_REQUIRED.has(result.board as ResultBoard) && !result.boardName?.trim()) {
    reasons.push("Name the board that awarded these results.");
  }

  const unconsented = (result.toppers ?? []).filter((topper) => !topper.consentAcknowledged);
  if (unconsented.length > 0) {
    reasons.push(
      `Confirm consent to publish for ${unconsented.map((topper) => topper.name).join(", ")}.`,
    );
  }

  return reasons;
}
