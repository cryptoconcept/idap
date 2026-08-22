import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, type ApiErrorCode } from "./errors";

export function jsonSuccess<T extends Record<string, unknown>>(
  data: T,
  init?: { status?: number; headers?: Record<string, string> },
) {
  return NextResponse.json(
    { success: true, ...data },
    { status: init?.status ?? 200, headers: init?.headers },
  );
}

export function jsonError(
  code: ApiErrorCode,
  message: string,
  init?: { status?: number; details?: unknown; headers?: Record<string, string> },
) {
  const error = new AppError(code, message, init?.details, init?.status);
  return NextResponse.json(
    {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    { status: error.status, headers: init?.headers },
  );
}

function firstZodMessage(error: ZodError): { message: string; details: unknown } {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  const head = issues[0];
  return {
    message: head ? `${head.field}: ${head.message}` : "Invalid request body",
    details: issues,
  };
}

/**
 * Single translation point from thrown errors to the documented JSON envelope.
 * Unknown errors are logged server-side and reported generically so internals
 * never leak to callers.
 */
export function handleApiError(error: unknown, headers?: Record<string, string>) {
  if (error instanceof ZodError) {
    const { message, details } = firstZodMessage(error);
    return jsonError("VALIDATION_ERROR", message, { details, headers });
  }

  if (error instanceof AppError) {
    return jsonError(error.code, error.message, {
      status: error.status,
      details: error.details,
      headers,
    });
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: number }).code === 11000
  ) {
    return jsonError("CONFLICT", "A record with these details already exists", { headers });
  }

  console.error("[api] unhandled error", error);
  return jsonError("INTERNAL_ERROR", "Something went wrong. Please try again.", { headers });
}
