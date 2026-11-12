import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';

let serviceAccount;
try {
  if (!config.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing from environment variables.');
  }

  // Parse the JSON string configuration
  serviceAccount = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);

  // Convert literal string newlines into true newline control characters for Node/OpenSSL
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
} catch (error) {
  throw new Error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ' + error.message);
}

const app = getApps()[0] ?? initializeApp({
  credential: cert(serviceAccount),
  projectId: config.FIREBASE_PROJECT_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);