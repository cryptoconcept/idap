import { z } from "zod";
import { API_PERMISSIONS } from "@/lib/constants";
import { requiredText } from "./common";

export const createApiClientSchema = z.object({
  name: requiredText("API key name", 80),
  permissions: z.array(z.enum(API_PERMISSIONS)).min(1, "Select at least one permission"),
});
