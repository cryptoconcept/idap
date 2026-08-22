const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const env = {
  get MONGODB_URI() {
    return required("MONGODB_URI", "mongodb://127.0.0.1:27017/aem_platform");
  },
  get AUTH_SECRET() {
    return required("AUTH_SECRET");
  },
  get APP_URL() {
    return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },
  get SESSION_TTL_HOURS() {
    return Number(process.env.SESSION_TTL_HOURS ?? 12);
  },
  get NODE_ENV() {
    return process.env.NODE_ENV ?? "development";
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
