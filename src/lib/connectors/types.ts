import type { Platform, SyncStatus } from "@/lib/constants";
import type { ConnectorHttp } from "./http";

export type ConnectMode = "REQUEST_APPROVE_REDEEM" | "PASTE_KEY";

export type SyncStep = { step: string; ok: boolean; detail?: string };

export type SyncOutcome = {
  status: SyncStatus;
  steps: SyncStep[];
  warnings: string[];
  error?: string;
};

export type InitiateResult = { remoteRequestId: string; remoteStatus: string };

export type RefreshResult =
  | { kind: "PENDING" | "AWAITING_APPROVAL" | "REJECTED"; remoteStatus: string; detail?: string }
  | {
      kind: "CONNECTED";
      remoteStatus: string;
      grantToken: string;
      scopes: string[];
      remoteInstitution?: { name?: string; city?: string; slug?: string };
    };

export type ConnectResult = {
  scopes: string[];
  remoteInstitution?: { name?: string; city?: string; slug?: string };
};

export type InstitutionSummary = {
  institutionId: string;
  name: string;
  city?: string;
  address?: {
    addressLine?: string;
    area?: string;
    district?: string;
    state?: string;
    pincode?: string;
  };
  phone?: string;
  website?: string;
  contactName?: string;
  contactEmail?: string;
};

export type ConnectionState = {
  institutionId: string;
  externalRef: string;
  remoteRequestId?: string;
  grantToken?: string;
  scopes?: string[];
};

export type AdapterContext = { baseUrl: string; platformKey: string; http: ConnectorHttp };

export interface PlatformAdapter {
  platform: Platform;
  connectMode: ConnectMode;
  initiate?(ctx: AdapterContext, institution: InstitutionSummary): Promise<InitiateResult>;
  refresh?(ctx: AdapterContext, connection: ConnectionState): Promise<RefreshResult>;
  connectWithKey?(ctx: AdapterContext, institutionId: string, key: string): Promise<ConnectResult>;
  sync(ctx: AdapterContext, connection: ConnectionState, data: SyncSourceData): Promise<SyncOutcome>;
}

/** Everything an adapter may push, loaded by the service so adapters never touch models. */
export type SyncSourceData = {
  institution: Record<string, unknown>;
  results: Record<string, unknown>[]; // PUBLISHED only, full internal DTO shape
  readPublicMedia: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
};

/**
 * Thrown by a platform adapter when a per-institution grant token the remote
 * platform previously issued is rejected (HTTP 401) — i.e. the credential
 * IDAP is holding is no longer honoured by the remote side, as distinct from
 * any other request-shaped failure. The PassPercent adapter throws this from
 * `sync`/`refresh`; the connection service catches it to flip the connection
 * to an error state that means "needs reconnection" rather than treating it
 * as an ordinary sync failure.
 *
 * `steps`/`warnings` (fix round 2, F3) carry whatever `sync` had already
 * accumulated before the 401 — results are pushed one year at a time, so a
 * mid-run auth failure must not discard the record of which years already
 * reached the (public) listing. Both default to `[]` so existing call sites
 * that construct this with just a message keep working unchanged.
 */
export class ConnectorAuthError extends Error {
  constructor(
    message: string,
    public readonly steps: SyncStep[] = [],
    public readonly warnings: string[] = [],
  ) {
    super(message);
  }
}
