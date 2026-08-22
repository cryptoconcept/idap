import { cn } from "@/lib/utils";

/**
 * Identifiers — institution ids, lead numbers, application numbers — are the
 * artifacts this product issues, so they get one consistent typographic
 * treatment everywhere they appear.
 */
export function Ref({
  children,
  className,
  size = "sm",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "font-mono tabular tracking-tight text-foreground",
        size === "sm" && "text-[12.5px]",
        size === "md" && "text-sm",
        size === "lg" && "text-lg tracking-tight",
        className,
      )}
    >
      {children}
    </span>
  );
}
