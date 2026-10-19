import { acquireLeaseLock, releaseLeaseLock } from "../../lib/storage/lease-lock.mjs";
import { readSftpPrivateKeyFile, createSftpStorageAdapter } from "../../lib/storage/sftp-adapter.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const cfg = JSON.parse(String(process.env.IC_SFTP_EMU_JSON ?? "{}"));
const round = String(process.env.IC_LEASE_ROUND ?? "0");
const TEST_DEK = new Uint8Array(32).fill(5);
const LAYOUT = "accounts/sftp-lease";
const DEVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const { key } = readSftpPrivateKeyFile(cfg.privateKeyPath);
const adapter = createSftpStorageAdapter({
  host: cfg.host,
  port: cfg.port,
  username: cfg.username,
  root: cfg.root,
  hostKeySha256: cfg.hostKeySha256,
  privateKey: key,
});
await adapter.init();
const handle = await acquireLeaseLock({
  adapter,
  dek: TEST_DEK,
  layoutPrefix: LAYOUT,
  lockName: `worker-${round}`,
  ownerDevH: deriveDevH(DEVICE),
  settleMs: 200,
});
await releaseLeaseLock({
  adapter,
  dek: TEST_DEK,
  layoutPrefix: LAYOUT,
  lockName: `worker-${round}`,
  ownerDevH: deriveDevH(DEVICE),
  nonce: handle.nonce,
});
await adapter.close();
process.exit(0);
