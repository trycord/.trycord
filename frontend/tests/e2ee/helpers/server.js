// The server's own modules, as the client sees them.
//
// The client's half of the protocol is in frontend/packages/e2ee/. The
// server's half is in backend/src/services/e2ee/. A check that wants to know
// whether the two agree needs both, and the server's are the specification:
// this client is a port, not a design.
//
// The server's modules are CommonJS, so they are reached through require.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '..', '..', '..', '..', 'backend');

export const server = {
  primitives: require(path.join(BACKEND, 'src/services/e2ee/primitives.js')),
  protocol: require(path.join(BACKEND, 'src/services/e2ee/protocol.js')),
  envelope: require(path.join(BACKEND, 'src/services/e2ee/envelope.js')),
  x3dh: require(path.join(BACKEND, 'src/services/e2ee/x3dh.js')),
  ratchet: require(path.join(BACKEND, 'src/services/e2ee/ratchet.js')),
  sealing: require(path.join(BACKEND, 'src/services/e2ee/sealing.js')),
  deviceKeys: require(path.join(BACKEND, 'src/services/e2ee/deviceKeys.js')),
  prekeys: require(path.join(BACKEND, 'src/services/e2ee/prekeys.js')),
  group: require(path.join(BACKEND, 'src/services/e2ee/group.js')),
  attachments: require(path.join(BACKEND, 'src/services/e2ee/attachments.js')),
  recovery: require(path.join(BACKEND, 'src/services/e2ee/recovery.js')),
  bodies: require(path.join(BACKEND, 'src/services/e2ee/bodies.js')),
  client: require(path.join(BACKEND, 'tests/e2ee/client.js')),
};

export const BACKEND_ROOT = BACKEND;
