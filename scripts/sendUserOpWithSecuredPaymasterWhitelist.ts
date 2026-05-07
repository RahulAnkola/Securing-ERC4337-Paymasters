import hre from "hardhat";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { IEntryPoint__factory } from "../typechain-types/factories/@account-abstraction/contracts/interfaces/IEntryPoint__factory";
import type { PackedUserOperationStruct } from "../typechain-types/@account-abstraction/contracts/interfaces/IEntryPoint";
import { BaselineAccount__factory } from "../typechain-types/factories/contracts/BaselineAccount__factory";
import { SecuredPaymaster__factory } from "../typechain-types/factories/contracts/SecuredPaymaster__factory";
import { MockTarget__factory } from "../typechain-types/factories/contracts/MockTarget__factory";
import { ensurePaymasterDepositForPackedUserOp } from "./entryPointPrefund";

const deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8")
);

dotenv.config({ quiet: true });

// UserOperationLib: high128=verificationGasLimit, low128=callGasLimit
function packAccountGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): string {
  const mask = (1n << 128n) - 1n;
  const packed = ((verificationGasLimit & mask) << 128n) | (callGasLimit & mask);
  return ethers.toBeHex(packed, 32);
}

// UserOperationLib: high128=maxPriorityFeePerGas, low128=maxFeePerGas
function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): string {
  const mask = (1n << 128n) - 1n;
  const packed = ((maxPriorityFeePerGas & mask) << 128n) | (maxFeePerGas & mask);
  return ethers.toBeHex(packed, 32);
}

function getVirtualUserPool(): string[] {
  return Array.from({ length: 10 }, (_, i) => ethers.id(`SIM_USER_${i + 1}`));
}

function pickVirtualUserId(): string {
  const pool = getVirtualUserPool();
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

function printEndSpacing() {
  console.log("");
  console.log("");
}

async function main() {
  const network = hre.network.name;

  const rejectMode = process.env.REJECT_WHITELIST === "1";

  const netDeployments = (deployments as any)[network];
  if (!netDeployments) {
    throw new Error(`No deployments found for network "${network}" in deployments.json`);
  }

  const entryPointAddress: string | undefined =
    netDeployments.EntryPoint?.address ?? process.env.ENTRYPOINT_ADDRESS;
  const paymasterAddress: string | undefined = netDeployments.SecuredPaymaster?.address;
  const accountAddress: string | undefined = netDeployments.BaselineAccount?.address;
  const mockTargetAddress: string | undefined = netDeployments.MockTarget?.address;

  if (!entryPointAddress || !paymasterAddress || !accountAddress || !mockTargetAddress) {
    throw new Error("Missing EntryPoint/SecuredPaymaster/BaselineAccount/MockTarget in deployments.json or .env");
  }

  console.log(`Test: Whitelist (${network})`);
  console.log("Whitelist:", rejectMode ? "rejected" : "accepted");
  console.log("Over-cap exceeded:", "no");
  console.log("Expected output:", rejectMode ? "revert" : "success");

  const [signer] = await hre.ethers.getSigners();
  console.log("EOA signer:", signer.address);

  const entryPoint = IEntryPoint__factory.connect(entryPointAddress, signer);
  const account = BaselineAccount__factory.connect(accountAddress, signer);
  const paymaster = SecuredPaymaster__factory.connect(paymasterAddress, signer);
  const mockTarget = MockTarget__factory.connect(mockTargetAddress, signer);

  const existingDeposit = await entryPoint.balanceOf(paymasterAddress);
  console.log("Existing deposit:", `${ethers.formatEther(existingDeposit)} ETH`);

  // Ensure whitelist is set to ONLY the MockTarget for consistent Mod-2 testing.
  const isAllowed = await paymaster.allowedTargets(mockTargetAddress);
  if (!isAllowed) {
    const tx = await paymaster.setAllowedTarget(mockTargetAddress, true);
    await tx.wait();
  }

  const currentSponsorSigner = await paymaster.sponsorSigner();
  if (currentSponsorSigner.toLowerCase() !== signer.address.toLowerCase()) {
    const tx = await paymaster.setSponsorSigner(signer.address);
    await tx.wait();
  }

  // Fetch caps and keep within them (so only whitelist can cause failure).
  const capVerification = await paymaster.maxVerificationGasLimit();
  const capCall = await paymaster.maxCallGasLimit();
  const capPaymasterVerification = await paymaster.maxPaymasterVerificationGasLimit();
  const capPostOp = await paymaster.maxPaymasterPostOpGasLimit();
  const capPreVerification = await paymaster.maxPreVerificationGas();

  const verificationGasLimit = capVerification > 0n ? capVerification : 300_000n;
  const callGasLimit = capCall > 0n ? capCall : 200_000n;
  const preVerificationGas = capPreVerification > 0n ? capPreVerification : 80_000n;
  const paymasterVerificationGasLimit =
    capPaymasterVerification > 0n ? capPaymasterVerification : 100_000n;
  const paymasterPostOpGasLimit = capPostOp > 0n ? capPostOp : 50_000n;

  const maxFeePerGas = ethers.parseUnits("2", "gwei");
  const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");

  await ensurePaymasterDepositForPackedUserOp(
    entryPoint,
    paymaster,
    paymasterAddress,
    {
      verificationGasLimit,
      callGasLimit,
      paymasterVerificationGasLimit,
      paymasterPostOpGasLimit,
      preVerificationGas,
      maxFeePerGas,
    },
    {
      maintenanceThresholdWei: ethers.parseEther("0.001"),
      maintenanceTargetWei: ethers.parseEther("0.005"),
    }
  );

  const target = rejectMode ? signer.address : mockTargetAddress;
  const value = 0n;
  const innerCallData = rejectMode
    ? "0x"
    : mockTarget.interface.encodeFunctionData("ping");

  const callData = account.interface.encodeFunctionData("execute", [target, value, innerCallData]);

  const nonce = await entryPoint.getNonce(accountAddress, 0);

  const virtualUserId = pickVirtualUserId();
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3 * 60); // 3 minutes
  const sponsorshipNonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const sponsoredMaxCostWei = ethers.parseEther("0.01");

  const sponsorshipEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "uint256",
      "bytes32",
      "uint48",
      "uint256",
      "uint256",
    ],
    [
      paymasterAddress,
      (await hre.ethers.provider.getNetwork()).chainId,
      virtualUserId,
      validUntil,
      sponsorshipNonce,
      sponsoredMaxCostWei,
    ]
  );
  const sponsorshipMessage = ethers.keccak256(sponsorshipEncoded);
  const sponsorshipSignature = await signer.signMessage(ethers.getBytes(sponsorshipMessage));
  const parsedSig = ethers.Signature.from(sponsorshipSignature);
  const sponsorshipData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint48", "uint256", "uint256", "uint8", "bytes32", "bytes32"],
    [virtualUserId, validUntil, sponsorshipNonce, sponsoredMaxCostWei, parsedSig.v, parsedSig.r, parsedSig.s]
  );

  console.log("Virtual user ID:", virtualUserId);
  const userQuota = await paymaster.userDailyQuota(virtualUserId);
  const userDailyLimitWei = await paymaster.userDailyLimitWei();
  const userSpentWei = userQuota[1];
  const userRemainingWei = userDailyLimitWei > userSpentWei ? userDailyLimitWei - userSpentWei : 0n;
  const dappDailyLimitWei = await paymaster.dappDailyLimitWei();
  const dappSpentWei = await paymaster.dappSpentWei();
  const dappRemainingWei = dappDailyLimitWei > dappSpentWei ? dappDailyLimitWei - dappSpentWei : 0n;
  console.log("Remaining daily quota (user):", `${ethers.formatEther(userRemainingWei)} ETH`);
  console.log("Remaining daily quota (dapp):", `${ethers.formatEther(dappRemainingWei)} ETH`);

  const paymasterAndData = ethers.solidityPacked(
    ["address", "uint128", "uint128", "bytes"],
    [paymasterAddress, paymasterVerificationGasLimit, paymasterPostOpGasLimit, sponsorshipData]
  );

  const userOp: PackedUserOperationStruct = {
    sender: accountAddress,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits: packAccountGasLimits(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData,
    signature: "0x",
  };

  const beneficiary = signer.address;

  let staticCallReverted = false;
  try {
    await entryPoint.handleOps.staticCall([userOp], beneficiary);
  } catch (e) {
    staticCallReverted = true;
  }

  const tx = await entryPoint.handleOps([userOp], beneficiary, { gasLimit: 15_000_000n });
  console.log("Txn hash:", tx.hash);
  let revertedAsExpected = false;

  try {
    await tx.wait();
    revertedAsExpected = !rejectMode;
  } catch (e) {
    if (rejectMode) {
      revertedAsExpected = true;
      console.log("reverted as expected?: yes");
      console.log("Final result:", "revert");
      printEndSpacing();
      return;
    }
    console.log("Final result:", "revert");
    process.exitCode = 1;
    printEndSpacing();
    return;
  }
  if (!revertedAsExpected) {
    process.exitCode = 1;
  } else if (rejectMode) {
    console.log("reverted as expected?: yes");
  }
  console.log("Final result:", "success");
  printEndSpacing();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Test failed:", message);
  process.exitCode = 1;
});

