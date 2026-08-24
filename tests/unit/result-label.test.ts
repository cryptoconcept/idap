import { describe, expect, it } from "vitest";
import { describeCycle } from "@/lib/results/label";

describe("describeCycle", () => {
  it("names board, level and year", () => {
    expect(
      describeCycle({ board: "CBSE", level: "CLASS_10", stream: null, academicYear: "2025-26" }),
    ).toBe("CBSE · Class 10 · 2025-26");
  });

  it("includes the stream when there is one", () => {
    expect(
      describeCycle({
        board: "CBSE",
        level: "CLASS_12",
        stream: "SCIENCE",
        academicYear: "2025-26",
      }),
    ).toBe("CBSE · Class 12 · Science · 2025-26");
  });

  it("prefers boardName when the board does not name itself", () => {
    expect(
      describeCycle({
        board: "STATE_BOARD",
        boardName: "Karnataka State Board",
        level: "PUC_2",
        stream: null,
        academicYear: "2025-26",
      }),
    ).toBe("Karnataka State Board · PUC II · 2025-26");
  });

  it("uses examLabel verbatim when the institution supplied one", () => {
    expect(
      describeCycle({
        board: "CBSE",
        level: "CLASS_10",
        stream: null,
        academicYear: "2025-26",
        examLabel: "AISSE 2026",
      }),
    ).toBe("AISSE 2026");
  });
});
