// Deterministic environment for every test file. Set before any module that
// reads `env` is imported.
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-do-not-use-in-production-0123456789abcdef";
process.env.NEXT_PUBLIC_APP_URL = "https://admissions.test";
process.env.SESSION_TTL_HOURS = "12";
