import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from './serviceAccountKey.json' with { type: 'json' };
import { config } from './config.js';

const app = getApps()[0] ?? initializeApp({
  credential: cert(serviceAccount),
  projectId: config.FIREBASE_PROJECT_ID || serviceAccount.project_id,
});

export const auth = getAuth(app);
export const db = getFirestore(app);