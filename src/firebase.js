import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

const serviceAccount = JSON.parse(fs.readFileSync(path.resolve('serviceAccountKey.json'), 'utf8'));

const app = getApps()[0] ?? initializeApp({ 
  credential: cert(serviceAccount), 
  projectId: serviceAccount.project_id 
});

export const auth = getAuth(app);
export const db = getFirestore(app);  