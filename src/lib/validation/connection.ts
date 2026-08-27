import { z } from "zod";

/** FeesBasket's paste-key flow (Plan 9b) — validated generically here since
 * the route itself doesn't know which platforms will eventually support it. */
export const connectWithKeySchema = z.object({
  key: z.string().trim().min(1, "Key cannot be blank").max(500, "Key is too long"),
});
export type ConnectWithKeyInput = z.infer<typeof connectWithKeySchema>;
