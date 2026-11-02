import 'dotenv/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const uid=process.env.ADMIN_UID;
const role=process.env.ADMIN_ROLE||'owner';
const projectId=process.env.FIREBASE_PROJECT_ID;
const key=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if(!uid||!projectId||!key){console.error('Set ADMIN_UID, FIREBASE_PROJECT_ID, and FIREBASE_SERVICE_ACCOUNT_JSON in a private environment.');process.exit(1)}
if(!['owner','admin','finance','compliance','support'].includes(role)){console.error('Invalid ADMIN_ROLE.');process.exit(1)}
try{
 const serviceAccount=JSON.parse(key);
 const app=getApps()[0]||initializeApp({credential:cert(serviceAccount),projectId});
 const auth=getAuth(app);
 const user=await auth.getUser(uid);
 await auth.setCustomUserClaims(uid,{...(user.customClaims||{}),admin:true,role});
 console.log(`Role ${role} assigned to UID ${uid}. The user must refresh their Firebase ID token before claims apply.`);
 process.exit(0);
}catch(error){console.error('Could not assign admin role:',error.code||error.name);process.exit(1)}
