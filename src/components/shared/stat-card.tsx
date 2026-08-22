import Link from "next/link";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  href,
  emphasis = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  emphasis?: boolean;
}) {
  const body = (
    <>
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "tabular text-[32px] leading-none font-semibold tracking-tight",
          emphasis ? "text-foreground" : "text-foreground",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </>
  );

  const className = cn(
    "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors",
    href && "hover:border-foreground/30 hover:bg-muted/40",
    emphasis && "border-foreground/25",
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}
