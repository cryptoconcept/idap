import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="max-w-[400px] space-y-4 text-center">
        <p className="eyebrow">Not found</p>
        <h1 className="text-xl font-semibold tracking-tight">
          This page or record does not exist.
        </h1>
        <p className="text-sm text-muted-foreground">
          It may have been removed, or it belongs to a different institution.
        </p>
        <div className="flex justify-center pt-1">
          <Button asChild size="sm">
            <Link href="/">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
