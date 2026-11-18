import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

let serviceAccount;

try {
  // 1. Try loading from the local serviceAccountKey.json file first (ideal for local dev)
  const keyPath = path.resolve('./src/serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    const fileContent = fs.readFileSync(keyPath, 'utf8');
    serviceAccount = JSON.parse(fileContent);
  }

  // 2. If local file doesn't exist, fall back to the environment variable (ideal for Render)
  if ((!serviceAccount || !serviceAccount.client_email) && config.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let rawJson = config.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
      rawJson = rawJson.slice(1, -1);
    }
    serviceAccount = JSON.parse(rawJson);
  }

  if (!serviceAccount || !serviceAccount.client_email) {
    throw new Error('Service account object is missing client_email.');
  }

  // Ensure private key newlines are properly unescaped
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .trim();
  }
} catch (error) {
  throw new Error('Failed to parse Firebase credentials: ' + error.message);
}

const app = getApps()[0] ?? initializeApp({
  credential: cert(serviceAccount),
  projectId: config.FIREBASE_PROJECT_ID || serviceAccount.project_id,
});

export const auth = getAuth(app);
export const db = getFirestore(app);