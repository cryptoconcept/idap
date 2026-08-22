import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-4 pb-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
