import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function FieldRow({
  columns = 2,
  children,
}: {
  columns?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const className =
    columns === 1
      ? "grid gap-4"
      : columns === 2
        ? "grid gap-4 sm:grid-cols-2"
        : "grid gap-4 sm:grid-cols-3";
  return <div className={className}>{children}</div>;
}

/** Public forms are filled in by parents, often on a phone: bigger targets. */
export const PUBLIC_CONTROL =
  "h-10 rounded-lg text-[15px] sm:text-sm";

/**
 * Labelled input used across the public forms. `ref` arrives through the spread
 * (React 19 treats it as a normal prop), so react-hook-form's `register` works.
 */
export function TextField({
  id,
  label,
  error,
  required,
  hint,
  className,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-muted-foreground"> *</span> : null}
      </Label>
      <Input id={id} aria-invalid={Boolean(error)} className={cn(PUBLIC_CONTROL, className)} {...props} />
      {error ? (
        <p className="text-xs text-foreground">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
