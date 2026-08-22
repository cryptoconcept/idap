"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Users never see stack traces or database messages — the detail is logged
 * server-side and the digest is the only reference shown.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] unhandled error", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="max-w-[400px] space-y-4 text-center">
        <p className="eyebrow">Error</p>
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong.</h1>
        <p className="text-sm text-muted-foreground">
          The page could not be loaded. Try again, and if it keeps happening contact your platform
          administrator.
        </p>
        {error.digest ? (
          <p className="font-mono text-[11px] text-muted-foreground">Reference {error.digest}</p>
        ) : null}
        <div className="flex justify-center gap-2 pt-1">
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
