import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

let serviceAccount = {};

try {
  // 1. Local development fallback file
  const keyPath = path.resolve('./src/serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }

  // 2. Production: Use individual environment variables (cleanest and bulletproof on Render)
  if (!serviceAccount.client_email) {
    serviceAccount = {
      project_id: config.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY,
    };
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Missing Firebase credentials: client_email and private_key must be configured.');
  }

  serviceAccount.private_key = serviceAccount.private_key
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .trim();

} catch (error) {
  throw new Error('Failed to parse Firebase credentials: ' + error.message);
}

const app = getApps()[0] ?? initializeApp({
  credential: cert(serviceAccount),
  projectId: config.FIREBASE_PROJECT_ID || serviceAccount.project_id,
});

export const auth = getAuth(app);
export const db = getFirestore(app);