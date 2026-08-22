import { z } from "zod";
import { USER_ROLES } from "@/lib/constants";
import { emailSchema, optionalText, requiredText } from "./common";

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(128),
});

export const createUserSchema = z.object({
  name: requiredText("Name", 120),
  email: emailSchema,
  password: z.string().min(10, "Password must be at least 10 characters").max(128),
  role: z.enum(USER_ROLES).default("INSTITUTION_ADMIN"),
  institutionId: optionalText(40),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(10, "New password must be at least 10 characters").max(128),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "New password must be different from the current password",
    path: ["newPassword"],
  });
