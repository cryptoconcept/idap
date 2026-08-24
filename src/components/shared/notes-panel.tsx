import { Section } from "@/components/shared/definition-list";
import { NoteComposer } from "@/components/shared/note-composer";
import { formatDateTime } from "@/lib/utils/format";
import type { NoteDTO } from "@/services/note.service";

export function NotesPanel({
  notes,
  endpoint,
  canAddNote = true,
}: {
  notes: NoteDTO[];
  endpoint: string;
  canAddNote?: boolean;
}) {
  return (
    <Section title={`Notes (${notes.length})`}>
      <div className="space-y-4">
        {canAddNote ? <NoteComposer endpoint={endpoint} /> : null}

        {notes.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No notes yet. Anything you record here stays internal to your institution.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {notes.map((note) => (
              <li key={note.id} className="space-y-1 py-3 first:pt-1">
                <p className="text-sm whitespace-pre-wrap text-foreground">{note.note}</p>
                <p className="text-xs text-muted-foreground">
                  {note.createdByName ?? "Unknown"} · {formatDateTime(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
