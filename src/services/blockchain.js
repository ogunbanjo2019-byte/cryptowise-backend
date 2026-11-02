import { ethers } from "ethers";

// Initialize provider
const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);

// USDT Contract Address on Ethereum Mainnet 
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// Standard ERC-20 ABI for checking transfers and balances
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);

/**
 * Generate a new crypto deposit wallet for a user
 */
export function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey, 
  };
}

/**
 * Check ETH balance of an address
 */
export async function getEthBalance(address) {
  const balanceWei = await provider.getBalance(address);
  return ethers.formatEther(balanceWei);
}

/**
 * Check USDT balance of an address
 */
export async function getUsdtBalance(address) {
  const balance = await usdtContract.balanceOf(address);
  const decimals = await usdtContract.decimals();
  return ethers.formatUnits(balance, decimals);
}

/**
 * Verify if a specific transaction hash successfully transferred funds
 */
export async function verifyTransaction(txHash, expectedRecipient, expectedAmount, tokenType = "ETH") {
  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!tx || !receipt || receipt.status !== 1) {
    return { success: false, message: "Transaction pending, failed, or not found." };
  }

  if (tokenType === "ETH") {
    if (
      tx.to.toLowerCase() === expectedRecipient.toLowerCase() &&
      ethers.formatEther(tx.value) >= expectedAmount
    ) {
      return { success: true, tx };
    }
  } else if (tokenType === "USDT") {
    const parsedLogs = receipt.logs.map(log => {
      try {
        return usdtContract.interface.parseLog(log);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    for (const log of parsedLogs) {
      if (
        log.name === "Transfer" &&
        log.args.to.toLowerCase() === expectedRecipient.toLowerCase()
      ) {
        const decimals = await usdtContract.decimals();
        const transferredAmount = ethers.formatUnits(log.args.value, decimals);
        if (parseFloat(transferredAmount) >= parseFloat(expectedAmount)) {
          return { success: true, tx };
        }
      }
    }
  }

  return { success: false, message: "Transaction details do not match requirements." };
}