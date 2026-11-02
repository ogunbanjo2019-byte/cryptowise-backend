import { getAppCheck } from 'firebase-admin/app-check';
import { auth } from '../firebase.js';
import { config } from '../config.js';
import { isAuthorizedAdminClaims } from '../services/admin-claims.js';

export async function requireUser(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
    if (!match) return res.status(401).json({ error: 'Authentication required.' });

    req.user = await auth.verifyIdToken(match[1], true);
    if (req.user.email && req.user.email_verified !== true) {
      return res.status(403).json({ error: 'Verify your email before using CryptoWise.' });
    }

    if (config.appCheckRequired) {
      const appCheck = req.get('x-firebase-appcheck');
      if (!appCheck) return res.status(401).json({ error: 'App attestation required.' });
      await getAppCheck().verifyToken(appCheck);
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
}

export function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (!isAuthorizedAdminClaims(req.user)) {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  req.adminRole = role;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.adminRole)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}
