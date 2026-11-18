import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

let serviceAccount = {};

try {
  // 1. Try loading from the local serviceAccountKey.json file first (local dev)
  const keyPath = path.resolve('./src/serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    const fileContent = fs.readFileSync(keyPath, 'utf8');
    serviceAccount = JSON.parse(fileContent);
  }

  // 2. Fall back to FIREBASE_SERVICE_ACCOUNT_JSON environment variable
  if ((!serviceAccount || !serviceAccount.client_email) && config.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let rawJson = config.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
    if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
      rawJson = rawJson.slice(1, -1);
    }
    serviceAccount = JSON.parse(rawJson);
  }

  // 3. Fallback to individual project keys if JSON string parsing failed
  if (!serviceAccount || !serviceAccount.client_email) {
    serviceAccount = {
      project_id: config.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY,
    };
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Missing Firebase credentials: client_email and private_key must be configured.');
  }

  // Ensure private key newlines are properly unescaped
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