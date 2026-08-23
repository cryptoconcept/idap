import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/*
        The brand panel shows the artifact the product exists to issue: a
        sequence of admission numbers, set as data.
      */}
      <aside className="relative hidden flex-col justify-between border-r border-border bg-mist p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-6 items-center justify-center rounded bg-foreground text-[11px] font-semibold text-background"
            aria-hidden
          >
            L
          </span>
          <span className="text-[11px] font-semibold tracking-[0.14em] uppercase">
            Lead Platform
          </span>
        </div>

        <div className="space-y-8">
          <h1 className="max-w-md text-3xl leading-tight font-semibold tracking-tight text-balance">
            Every enquiry and application your institution receives, in one place.
          </h1>

          <ul className="space-y-2 font-mono text-[13px] tabular text-muted-foreground">
            {[
              ["INS0001-LD000128", "Enquiry"],
              ["INS0001-APP-000124", "Application"],
              ["INS0002-APP-000031", "Application"],
            ].map(([reference, kind]) => (
              <li key={reference} className="flex items-center gap-3">
                <span className="h-px w-6 bg-border" aria-hidden />
                <span className="text-foreground">{reference}</span>
                <span className="text-[11px] tracking-wide uppercase">{kind}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="max-w-sm text-xs text-muted-foreground">
          Enquiries and applications arrive over the API from your website. Every record stays
          scoped to the institution that received it.
        </p>
      </aside>

      <main className="flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-[360px] space-y-7">
          <div className="space-y-1.5 lg:hidden">
            <span className="flex size-7 items-center justify-center rounded bg-foreground text-xs font-semibold text-background">
              L
            </span>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Use the credentials issued to your institution.
            </p>
          </div>

          <Suspense fallback={<Skeleton className="h-[248px] w-full rounded-lg" />}>
            <LoginForm />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
