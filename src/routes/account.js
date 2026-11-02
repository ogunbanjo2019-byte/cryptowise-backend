import { Router } from "express";
import { randomInt } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { config } from "../config.js";
import {
  DEPOSIT_AUTOMATIC_CREDIT_READY,
  DEPOSIT_CHAIN_VERIFICATION_READY,
  DEPOSIT_CUSTOMER_INTAKE_READY,
  WITHDRAWAL_CUSTODY_READY,
} from "../services/deposit-readiness.js";
import { requireUser } from "../middleware/auth.js";
import {
  accountRef,
  reserveWithdrawal,
  zeroBalances,
} from "../services/ledger.js";
import { validAtomic, validEvmAddress } from "../services/validation.js";
import {
  createAccountExport,
  MAX_ROWS_PER_COLLECTION,
} from "../services/account-export.js";

const router = Router();
router.use(requireUser);

const ASSETS = ["ETH", "USDT"];

function usernameCandidate(displayName, email) {
  const seed =
    (displayName || email?.split("@")[0] || "cryptowise")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "cwuser";

  return `${seed}${randomInt(1000, 10000)}`;
}

function customerNumberCandidate() {
  return String(randomInt(1_000_000_000, 10_000_000_000));
}

router.get("/me", async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const ref = db.collection("users").doc(uid);
    const email = req.user.email || null;
    const displayName = req.user.name || null;
    let profile = null;

    for (let attempt = 0; attempt < 10 && !profile; attempt += 1) {
      const candidateUsername = usernameCandidate(displayName, email);
      const candidateCustomerNumber = customerNumberCandidate();

      profile = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const stored = snap.exists ? snap.data() : {};

        const finalEmail = email || stored.email || null;
        const finalDisplayName = displayName || stored.displayName || null;
        const username = stored.username || candidateUsername;
        const customerNumber =
          stored.customerNumber || candidateCustomerNumber;

        const usernameRef = db.collection("usernames").doc(username);
        const numberRef = db
          .collection("customerNumbers")
          .doc(customerNumber);

        // Read both reservations before making any transaction writes.
        const usernameSnap = await transaction.get(usernameRef);
        const numberSnap = await transaction.get(numberRef);

        if (usernameSnap.exists && usernameSnap.data().uid !== uid) {
          if (stored.username) {
            throw Object.assign(
              new Error("Stored username is already reserved."),
              { statusCode: 409 },
            );
          }
          return null;
        }

        if (numberSnap.exists && numberSnap.data().uid !== uid) {
          if (stored.customerNumber) {
            throw Object.assign(
              new Error("Stored customer number is already reserved."),
              { statusCode: 409 },
            );
          }
          return null;
        }

        if (!usernameSnap.exists) {
          transaction.create(usernameRef, {
            uid,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        if (!numberSnap.exists) {
          transaction.create(numberRef, {
            uid,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        transaction.set(
          ref,
          {
            uid,
            email: finalEmail,
            displayName: finalDisplayName,
            username,
            customerNumber,
            kycStatus: stored.kycStatus || "not_started",
            ...(snap.exists
              ? {}
              : { createdAt: FieldValue.serverTimestamp() }),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return {
          email: finalEmail,
          displayName: finalDisplayName,
          username,
          customerNumber,
          kycStatus: stored.kycStatus || "not_started",
        };
      });
    }

    if (!profile) {
      return res.status(503).json({
        error:
          "Could not allocate a unique username and customer number. Please retry shortly.",
      });
    }

    return res.json({
      uid,
      email: profile.email,
      displayName: profile.displayName,
      username: profile.username,
      customerNumber: profile.customerNumber,
      role: req.user.role || "customer",
      kycStatus: profile.kycStatus,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/export", async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);

    const [userSnap, accountSnap, ledgerSnap, depositsSnap, withdrawalsSnap] =
      await Promise.all([
        userRef.get(),
        accountRef(uid).get(),
        userRef
          .collection("ledger")
          .orderBy("createdAt", "desc")
          .limit(MAX_ROWS_PER_COLLECTION)
          .get(),
        db
          .collection("depositRequests")
          .where("uid", "==", uid)
          .limit(MAX_ROWS_PER_COLLECTION)
          .get(),
        db
          .collection("withdrawalRequests")
          .where("uid", "==", uid)
          .limit(MAX_ROWS_PER_COLLECTION)
          .get(),
      ]);

    const user = userSnap.exists ? userSnap.data() : {};
    const account = accountSnap.exists ? accountSnap.data() : {};

    const result = createAccountExport({
      uid,
      profile: {
        email: req.user.email || user.email || null,
        displayName: req.user.name || user.displayName || null,
        username: user.username || null,
        customerNumber: user.customerNumber || null,
        kycStatus: user.kycStatus || "not_started",
      },
      account,
      ledger: ledgerSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
      deposits: depositsSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
      withdrawals: withdrawalsSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
      truncated: {
        ledger: ledgerSnap.size === MAX_ROWS_PER_COLLECTION,
        deposits: depositsSnap.size === MAX_ROWS_PER_COLLECTION,
        withdrawals: withdrawalsSnap.size === MAX_ROWS_PER_COLLECTION,
      },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="cryptowise-account-export.csv"',
    );
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "X-Export-Truncated",
      Object.values(result.truncated).some(Boolean) ? "true" : "false",
    );

    return res.status(200).send(result.csv);
  } catch (error) {
    next(error);
  }
});

router.get("/wallet", async (req, res, next) => {
  try {
    const [accountSnapshot, ledgerSnapshot] = await Promise.all([
      accountRef(req.user.uid).get(),
      db
        .collection("users")
        .doc(req.user.uid)
        .collection("ledger")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get(),
    ]);

    const data = accountSnapshot.exists ? accountSnapshot.data() : {};

    res.json({
      availableAtomic: {
        ...zeroBalances(),
        ...(data.availableAtomic || {}),
      },
      reservedAtomic: {
        ...zeroBalances(),
        ...(data.reservedAtomic || {}),
      },
      decimals: { ETH: 18, USDT: 6 },
      transactions: ledgerSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/deposit-instructions", (_req, res) => {
  const network =
    config.CHAIN_MODE === "mainnet"
      ? "Ethereum mainnet"
      : "Ethereum Sepolia testnet";

  const enabled =
    DEPOSIT_CUSTOMER_INTAKE_READY &&
    DEPOSIT_CHAIN_VERIFICATION_READY &&
    DEPOSIT_AUTOMATIC_CREDIT_READY &&
    config.liveFundsEnabled;

  res.json({
    enabled,
    mode: config.CHAIN_MODE,
    network,
    intendedNetwork: "Ethereum mainnet",
    assets: [
      {
        asset: "ETH",
        address: enabled ? config.ETH_DEPOSIT_ADDRESS : null,
        tokenContract: null,
        decimals: 18,
      },
      {
        asset: "USDT",
        address: enabled ? config.USDT_DEPOSIT_ADDRESS : null,
        tokenContract:
          config.CHAIN_MODE === "mainnet"
            ? "0xdAC17F958D2ee523a2206206994597C13D831ec7"
            : null,
        decimals: 6,
      },
    ],
    verification: {
      status: DEPOSIT_CHAIN_VERIFICATION_READY ? "ready" : "not_implemented",
      automaticCrediting: DEPOSIT_AUTOMATIC_CREDIT_READY,
      reconciliation: false,
    },
    reason: enabled
      ? null
      : "Deposits are paused. Independent chain monitoring, confirmation and reorg handling, and verified crediting are not deployed.",
    notice: enabled
      ? "Send only the selected asset over the displayed Ethereum network to the displayed address."
      : "Do not send funds. No receiving instructions are active, and no balance is credited from a customer-submitted transaction hash.",
  });
});

router.get("/deposit-requests", async (req, res, next) => {
  try {
    const snapshot = await db
      .collection("depositRequests")
      .where("uid", "==", req.user.uid)
      .limit(50)
      .get();

    const requests = snapshot.docs
      .map((doc) => {
        const data = doc.data();

        return {
          id: doc.id,
          asset: data.asset || null,
          txHash: data.txHash || null,
          network: data.network || null,
          status: data.status || "unknown",
          amountAtomic: data.verifiedAmountAtomic || data.amountAtomic || null,
          createdAt: data.createdAt || null,
          updatedAt: data.updatedAt || null,
        };
      })
      .sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() ?? 0;
        const bTime = b.createdAt?.toMillis?.() ?? 0;
        return bTime - aTime;
      });

    res.json({ requests });
  } catch (error) {
    next(error);
  }
});

const depositSchema = z
  .object({
    asset: z.enum(["ETH", "USDT"]),
    txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    network: z.literal("ethereum"),
  })
  .strict();

router.post("/deposit-requests", async (req, res, next) => {
  try {
    if (
      !DEPOSIT_CUSTOMER_INTAKE_READY ||
      !DEPOSIT_CHAIN_VERIFICATION_READY ||
      !DEPOSIT_AUTOMATIC_CREDIT_READY ||
      !config.liveFundsEnabled
    ) {
      return res.status(503).json({
        error:
          "Deposits are paused until independently verified chain monitoring and operational controls are deployed.",
      });
    }

    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid deposit request." });
    }

    const { asset, txHash, network } = parsed.data;
    const requestRef = db.collection("depositRequests").doc();
    const hashRef = db
      .collection("depositTxHashes")
      .doc(txHash.toLowerCase());

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(hashRef);

      if (existing.exists) {
        throw Object.assign(
          new Error("Transaction hash has already been submitted."),
          { statusCode: 409 },
        );
      }

      transaction.create(requestRef, {
        uid: req.user.uid,
        asset,
        txHash: txHash.toLowerCase(),
        network,
        status: "pending_manual_review",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.create(hashRef, {
        requestId: requestRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    res.status(202).json({
      id: requestRef.id,
      status: "pending_manual_review",
      message:
        "Submitted for manual review. No balance is credited until the deposit is independently verified and approved.",
    });
  } catch (error) {
    next(error);
  }
});

const withdrawalSchema = z
  .object({
    asset: z.enum(["ETH", "USDT"]),
    amountAtomic: z.string().regex(/^[1-9][0-9]{0,77}$/),
    destination: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    network: z.literal("ethereum"),
  })
  .strict();

router.post("/withdrawal-requests", async (req, res, next) => {
  try {
    if (!config.liveFundsEnabled || !WITHDRAWAL_CUSTODY_READY) {
      return res.status(503).json({
        error:
          "Withdrawals are disabled until custody, signing, compliance, and operational controls are configured.",
      });
    }

    const parsed = withdrawalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid withdrawal request." });
    }

    const withdrawal = parsed.data;

    if (
      !validEvmAddress(withdrawal.destination) ||
      !validAtomic(withdrawal.amountAtomic)
    ) {
      return res.status(400).json({ error: "Invalid amount or destination." });
    }

    const ref = db.collection("withdrawalRequests").doc();

    await reserveWithdrawal({
      uid: req.user.uid,
      withdrawalRef: ref,
      ...withdrawal,
    });

    res.status(202).json({
      id: ref.id,
      status: "pending_review",
      message:
        "Request reserved for administrator review. No on-chain transfer is performed by this API.",
    });
  } catch (error) {
    next(error);
  }
});

const supportedCurrencies = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "INR",
  "NGN",
  "GHS",
  "ZAR",
  "KES",
];

const preferencesSchema = z
  .object({
    displayCurrency: z.enum(supportedCurrencies).optional(),
    timeZone: z.string().min(1).max(64).optional(),
    notifications: z
      .object({
        email: z.boolean().optional(),
        product: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one preference is required.",
  });

router.get("/preferences", async (req, res, next) => {
  try {
    const snapshot = await db.collection("users").doc(req.user.uid).get();
    const saved = snapshot.exists ? snapshot.data().preferences || {} : {};

    res.set("Cache-Control", "private, no-store").json({
      preferences: {
        displayCurrency: saved.displayCurrency || "USD",
        timeZone: saved.timeZone || "UTC",
        notifications: {
          email: saved.notifications?.email ?? true,
          product: saved.notifications?.product ?? true,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/preferences", async (req, res, next) => {
  try {
    const parsed = preferencesSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid preferences." });
    }

    if (parsed.data.timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: parsed.data.timeZone,
        }).format();
      } catch {
        return res.status(400).json({ error: "Invalid time zone." });
      }
    }

    const ref = db.collection("users").doc(req.user.uid);

    const preferences = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const user = snapshot.exists ? snapshot.data() : {};
      const current = user.preferences || {};

      const next = {
        ...current,
        ...parsed.data,
        notifications: {
          ...(current.notifications || {}),
          ...(parsed.data.notifications || {}),
        },
      };

      transaction.set(
        ref,
        {
          uid: req.user.uid,
          preferences: next,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return next;
    });

    return res.set("Cache-Control", "private, no-store").json({ preferences });
  } catch (error) {
    next(error);
  }
});

router.get("/notifications", async (req, res, next) => {
  try {
    const snapshot = await db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    res.json({
      notifications: snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/notifications/:id/read", async (req, res, next) => {
  try {
    const parsedId = z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .safeParse(req.params.id);

    if (!parsedId.success) {
      return res.status(400).json({ error: "Invalid notification id." });
    }

    const ref = db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .doc(parsedId.data);

    await ref.set(
      { readAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
