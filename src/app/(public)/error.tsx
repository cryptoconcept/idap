"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the public apply/enquiry flow (audit flows-L2). The root
 * boundary's recovery CTA is "Go to dashboard", which is meaningless to an
 * unauthenticated visitor mid-application — this one speaks to them and offers
 * a real retry.
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] public flow error", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="max-w-[420px] space-y-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight">This page didn&apos;t load</h1>
        <p className="text-sm text-muted-foreground">
          Something went wrong on our side. Your details were not submitted — please try again in a
          moment.
        </p>
        {error.digest ? (
          <p className="font-mono text-[11px] text-muted-foreground">Reference {error.digest}</p>
        ) : null}
        <div className="flex justify-center pt-1">
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
