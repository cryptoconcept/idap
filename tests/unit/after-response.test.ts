import { afterEach, describe, expect, it, vi } from "vitest";
import { afterResponse } from "@/lib/after-response";
import { after } from "next/server";

// `after()` reads the request's async context via AsyncLocalStorage, which no
// unit test can enter. Replacing it is the only way to tell "handed to the
// platform" apart from "awaited inline", which is the whole point of the
// helper: an awaited call and a registered one look identical from outside.
vi.mock("next/server", () => ({ after: vi.fn() }));

const mockedAfter = vi.mocked(after);

const OUT_OF_SCOPE = new Error(
  "`after` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context",
);

describe("afterResponse", () => {
  afterEach(() => {
    mockedAfter.mockReset();
  });

  it("hands the task to the platform instead of running it, inside a request", async () => {
    // The regression this guards is the opposite: work left running as a
    // floating promise after the handler returns, which Vercel may drop.
    let ran = false;
    const task = async () => {
      ran = true;
    };

    await afterResponse(task);

    expect(mockedAfter).toHaveBeenCalledTimes(1);
    expect(mockedAfter).toHaveBeenCalledWith(task);
    // Deliberately *not* run here: the platform runs it after the response.
    expect(ran).toBe(false);
  });

  it("runs the task inline when there is no request scope", async () => {
    // Scripts and tests call the services directly. There is nothing to defer
    // to, so the work must still happen rather than be silently dropped.
    mockedAfter.mockImplementation(() => {
      throw OUT_OF_SCOPE;
    });

    let ran = false;
    await afterResponse(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("waits for the inline task before resolving", async () => {
    mockedAfter.mockImplementation(() => {
      throw OUT_OF_SCOPE;
    });

    let finished = false;
    await afterResponse(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve();
          }, 10);
        }),
    );

    expect(finished).toBe(true);
  });
});
