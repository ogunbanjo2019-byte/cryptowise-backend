import { getAppCheck } from 'firebase-admin/app-check';
import { auth } from '../firebase.js';
import { config } from '../config.js';
import { isAuthorizedAdminClaims } from '../services/admin-claims.js';

export async function requireUser(request, reply) {
  try {
    const header = request.headers['authorization'] || '';
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
    if (!match) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    request.user = await auth.verifyIdToken(match[1], true);
    if (request.user.email && request.user.email_verified !== true) {
      return reply.status(403).send({ error: 'Verify your email before using CryptoWise.' });
    }

    if (config.appCheckRequired) {
      const appCheck = request.headers['x-firebase-appcheck'];
      if (!appCheck) {
        return reply.status(401).send({ error: 'App attestation required.' });
      }
      await getAppCheck().verifyToken(appCheck);
    }
  } catch (error) {
    return reply.status(401).send({ error: 'Invalid or expired authentication token.' });
  }
}

export async function requireAdmin(request, reply) {
  const role = request.user?.role;
  if (!isAuthorizedAdminClaims(request.user)) {
    return reply.status(403).send({ error: 'Administrator access required.' });
  }
  request.adminRole = role;
}

export function requireRole(...roles) {
  return async (request, reply) => {
    if (!roles.includes(request.adminRole)) {
      return reply.status(403).send({ error: 'Insufficient permissions.' });
    }
  };
}