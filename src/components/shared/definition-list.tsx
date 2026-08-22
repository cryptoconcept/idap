import { cn } from "@/lib/utils";

export function Section({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="eyebrow">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const isEmpty =
    value === undefined || value === null || value === "" || value === "—";

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm break-words",
          mono && "font-mono tabular text-[13px]",
          isEmpty ? "text-silver" : "text-foreground",
        )}
      >
        {isEmpty ? "—" : value}
      </dd>
    </div>
  );
}

export function FieldGrid({
  columns = 3,
  children,
}: {
  columns?: 2 | 3 | 4;
  children: React.ReactNode;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-4",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        columns === 4 && "grid-cols-2 lg:grid-cols-4",
      )}
    >
      {children}
    </dl>
  );
}
