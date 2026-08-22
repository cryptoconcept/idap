import mongoose from "mongoose";
import { env } from "@/lib/env";

/**
 * Mongoose keeps a single connection per Node process. Next.js dev mode reloads
 * modules on every change, so the connection promise is cached on globalThis to
 * avoid exhausting the connection pool.
 */
type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as {
  __aemMongoose?: MongooseCache;
};

const cache: MongooseCache = globalForMongoose.__aemMongoose ?? {
  conn: null,
  promise: null,
};

globalForMongoose.__aemMongoose = cache;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = mongoose.connect(env.MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
    });
  }

  try {
    cache.conn = await cache.promise;
  } catch (error) {
    cache.promise = null;
    throw error;
  }

  return cache.conn;
}

export { mongoose };
