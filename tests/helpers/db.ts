import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

let server: MongoMemoryServer | null = null;

/**
 * Starts a throwaway MongoDB for one test file and points the app's connection
 * cache at it. Real Mongo is used rather than a mock so the behaviour that
 * actually matters — atomic `$inc`, unique indexes, TTL — is exercised.
 *
 * Falls back to a locally running mongod when the in-memory binary is not
 * available, so the suite still runs on a machine that cannot download it.
 */
export async function startTestDatabase(dbName: string): Promise<string> {
  if (process.env.TEST_MONGODB_URI) {
    const uri = `${process.env.TEST_MONGODB_URI.replace(/\/$/, "")}/${dbName}`;
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri);
    primeAppConnectionCache();
    return uri;
  }

  server = await MongoMemoryServer.create({ instance: { dbName } });
  const uri = server.getUri(dbName);
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  primeAppConnectionCache();
  return uri;
}

/**
 * The app caches its connection on globalThis to survive hot reload. Priming it
 * with the test connection stops `connectToDatabase()` from opening a second
 * one against the real MONGODB_URI.
 */
function primeAppConnectionCache(): void {
  (globalThis as unknown as Record<string, unknown>).__aemMongoose = {
    conn: mongoose,
    promise: Promise.resolve(mongoose),
  };
}

export async function stopTestDatabase(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect().catch(() => undefined);
  if (server) {
    await server.stop();
    server = null;
  }
  delete (globalThis as unknown as Record<string, unknown>).__aemMongoose;
}

/** Wipes every collection between tests without paying to restart the server. */
export async function clearDatabase(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  );
}
