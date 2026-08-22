import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/** Burn roughly the same time as a real comparison so failures do not leak whether an email exists. */
export async function fakeVerify(): Promise<void> {
  await bcrypt.compare("dummy-password", "$2a$12$C6UzMDM.H6dfI/f/IKcEe.aQnbf1uUUNPnQF3vLhLTk8fWKQyLzzC");
}
