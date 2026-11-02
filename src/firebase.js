import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';

let serviceAccount;
try { serviceAccount = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON); }
catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON.'); }
if (serviceAccount.project_id !== config.FIREBASE_PROJECT_ID) {
  throw new Error('Firebase service account project_id does not match FIREBASE_PROJECT_ID.');
}
const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount), projectId: config.FIREBASE_PROJECT_ID });
export const auth = getAuth(app);
export const db = getFirestore(app);
