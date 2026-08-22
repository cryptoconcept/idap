import { z } from "zod";
import { requiredText } from "./common";

export const createNoteSchema = z.object({
  note: requiredText("Note", 4000),
});
