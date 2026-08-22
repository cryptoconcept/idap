import Link from "next/link";
import { Button } from "@/components/ui/button";

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  icon: Icon,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      {Icon ? (
        <span className="flex size-9 items-center justify-center rounded-full border border-border bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </span>
      ) : null}
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-sm text-sm text-balance text-muted-foreground">{description}</p>
      {actionLabel && actionHref ? (
        <Button asChild variant="outline" size="sm" className="mt-2">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}
