import { Section } from "@/components/shared/definition-list";
import { formatDateTime } from "@/lib/utils/format";
import type { ActivityDTO } from "@/services/activity.service";

export function ActivityTimeline({ activities }: { activities: ActivityDTO[] }) {
  return (
    <Section title="Activity">
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <ol className="relative space-y-4 pl-4">
          {/* A single hairline runs the length of the trail. */}
          <span className="absolute top-1.5 bottom-1.5 left-[3px] w-px bg-border" aria-hidden />
          {activities.map((activity) => (
            <li key={activity.id} className="relative space-y-0.5">
              <span
                className="absolute top-1.5 -left-4 size-[7px] rounded-full border border-foreground bg-background"
                aria-hidden
              />
              <p className="text-sm text-foreground">{activity.action}</p>
              {activity.description && activity.description !== activity.action ? (
                <p className="text-xs text-muted-foreground">{activity.description}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {activity.performedByName ? `${activity.performedByName} · ` : ""}
                {formatDateTime(activity.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
