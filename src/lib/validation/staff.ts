import { z } from "zod";
import { requiredText, emailSchema } from "./common";

export const createStaffSchema = z.object({
  name: requiredText("Name", 120),
  email: emailSchema,
  password: z.string().min(10, "Password must be at least 10 characters").max(128),
  role: z.enum(["COUNSELOR", "FRONT_DESK"]),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
