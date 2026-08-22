import "server-only";
import { SignJWT, importPKCS8 } from "jose";

export type PushMessage = {
  pushToken: string;
  title: string;
  body: string;
  data: Record<string, string>;
};

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    console.error("[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    return null;
  }
}

/** Google OAuth access token for the FCM HTTP v1 API. */
async function accessToken(account: ServiceAccount): Promise<string> {
  const key = await importPKCS8(account.private_key.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Could not obtain an FCM access token");
  return payload.access_token;
}

/**
 * Sends one message per device and reports tokens FCM no longer recognises so
 * the caller can prune them. A missing service account disables push rather than
 * throwing: the platform stays usable without Firebase configured.
 */
export async function sendPush(messages: PushMessage[]): Promise<{ deadTokens: string[] }> {
  const account = serviceAccount();
  if (!account || messages.length === 0) return { deadTokens: [] };

  const token = await accessToken(account);
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const deadTokens: string[] = [];

  await Promise.all(
    messages.map(async (message) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: message.pushToken,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: "high" },
          },
        }),
      });

      if (response.status === 404 || response.status === 400) {
        deadTokens.push(message.pushToken);
      }
    }),
  );

  return { deadTokens };
}
