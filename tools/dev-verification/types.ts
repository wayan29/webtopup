export type RolloutConfig = {
  enabled: boolean;
  member: number;
  cs: number;
  admin: number;
  owner: number;
};

export type VerificationPorts = {
  mongo: number;
  node: number;
  rust: number;
  vite: number;
  https: number;
};

export type VerificationConfig = {
  root: string;
  stateDir: string;
  databaseName: string;
  mongoUri: string;
  publicOrigin: string;
  providerMode: 'mock';
  localMarker: boolean;
  rollout: RolloutConfig;
  ports: VerificationPorts;
};

export type VerificationResultStatus =
  | 'LOCAL DEV VERIFIED'
  | 'LOCAL DEV FAILED'
  | 'NOT RUN'
  | 'NOT APPLICABLE';

export type VerificationStatus = {
  commit: string;
  trackedDirty: boolean;
  providerMode: 'mock';
  rollout: RolloutConfig;
  processes: Array<{ name: string; pid: number; startTime: string; executable: string; version: string | null; binarySha256: string }>;
  composeServices: Array<{ service: string; state: string; image: string; imageId?: string; containerId?: string }>;
  replicaSet: { name: string; writablePrimary: boolean; memberCount: number } | null;
  result: VerificationResultStatus;
};
