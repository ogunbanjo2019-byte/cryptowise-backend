import { ethers } from "ethers";
import { db } from "../firebase.js";
import { config } from "../config.js"; // <-- Import config

const provider = new ethers.JsonRpcProvider(config.RPC_URL); // <-- Use config.RPC_URL
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);

export function startDepositMonitor() {
  console.log("Starting automated blockchain deposit monitor...");

  usdtContract.on("Transfer", async (from, to, value, event) => {
    try {
      const recipientLower = to.toLowerCase();
      
      const walletRef = db.collection('user_wallets').doc(recipientLower);
      const walletDoc = await walletRef.get();

      if (walletDoc.exists) {
        const userData = walletDoc.data();
        const decimals = 6;
        const formattedAmount = ethers.formatUnits(value, decimals);
        const txHash = event.log.transactionHash;

        console.log(`Deposit found for User ${userData.userId}: ${formattedAmount} USDT (Tx: ${txHash})`);

        await db.runTransaction(async (transaction) => {
          const userRef = db.collection('users').doc(userData.userId);
          const userDoc = await transaction.get(userRef);

          if (!userDoc.exists) throw new Error("User does not exist!");

          const currentBalance = userDoc.data().usdtBalance || 0;
          const newBalance = currentBalance + parseFloat(formattedAmount);

          transaction.update(userRef, { usdtBalance: newBalance });

          const txRef = db.collection('transactions').doc(txHash);
          transaction.set(txRef, {
            userId: userData.userId,
            amount: parseFloat(formattedAmount),
            token: 'USDT',
            txHash: txHash,
            status: 'completed',
            timestamp: new Date().toISOString()
          });
        });

        console.log(`Successfully credited ${formattedAmount} USDT to user ${userData.userId}`);
      }
    } catch (error) {
      console.error("Error processing automated deposit event:", error);
    }
  });
}