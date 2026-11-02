import { Router } from 'express';
import { generateWallet, verifyTransaction } from "../services/blockchain.js";
import { db } from "../firebase.js";
import { requireUser } from "../middleware/auth.js";

const router = Router();

// 1. Endpoint to generate a deposit address for a user
router.post("/wallet/generate", requireUser, async (req, res) => {
  try {
    const userId = req.user.uid; 

    const wallet = generateWallet();
    const depositAddressLower = wallet.address.toLowerCase();

    await db.collection('user_wallets').doc(depositAddressLower).set({
      userId: userId,
      depositAddress: wallet.address,
      privateKey: wallet.privateKey, 
      createdAt: new Date().toISOString()
    });
    
    return res.status(200).json({
      success: true,
      depositAddress: wallet.address,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Endpoint to verify a user's transaction submission manually
router.post("/payment/verify", requireUser, async (req, res) => {
  const { txHash, recipientAddress, expectedAmount, tokenType } = req.body;

  if (!txHash || !recipientAddress || !expectedAmount || !tokenType) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  try {
    const verification = await verifyTransaction(txHash, recipientAddress, expectedAmount, tokenType);
    
    if (verification.success) {
      return res.status(200).json({ success: true, message: "Payment verified successfully!" });
    } else {
      return res.status(400).json({ success: false, message: verification.message });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;