import { db } from "../firebase.js";
import { requireUser } from "../middleware/auth.js";

async function accountRoutes(fastify, options) {

  // 1. Get User Profile and Balance
  fastify.get("/api/user/balance", { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const userId = request.user.uid;
      
      const userDocRef = db.collection("users").doc(userId);
      const userDoc = await userDocRef.get();

      if (!userDoc.exists) {
        // If user document doesn't exist yet, return a default zero balance
        return reply.send({
          success: true,
          balance: {
            usdt: 0,
            eth: 0
          }
        });
      }

      const userData = userDoc.data();
      return reply.send({
        success: true,
        balance: {
          usdt: userData.usdtBalance || 0,
          eth: userData.ethBalance || 0
        }
      });
    } catch (error) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // 2. Get User Transaction History (Deposits & Trades)
  fastify.get("/api/user/transactions", { preHandler: [requireUser] }, async (request, reply) => {
    try {
      const userId = request.user.uid;

      // Query the transactions collection for this user
      const txSnapshot = await db.collection("transactions")
        .where("userId", "==", userId)
        .orderBy("timestamp", "desc")
        .get();

      const transactions = [];
      txSnapshot.forEach(doc => {
        transactions.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return reply.send({
        success: true,
        transactions
      });
    } catch (error) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

}

export default accountRoutes;