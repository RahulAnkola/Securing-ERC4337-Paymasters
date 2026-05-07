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
  const overCap = process.env.OVER_CAP === "1";

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
    throw new Error("EntryPoint, SecuredPaymaster, BaselineAccount, or MockTarget missing in deployments.json or .env");
  }

  console.log(`Test: Secured (${network})`);
  console.log("Whitelist:", "accepted");
  console.log("Over-cap exceeded:", overCap ? "yes" : "no");
  console.log("Expected output:", overCap ? "revert" : "success");

  const [signer] = await hre.ethers.getSigners();
  console.log("EOA signer:", signer.address);

  const entryPoint = IEntryPoint__factory.connect(entryPointAddress, signer);
  const account = BaselineAccount__factory.connect(accountAddress, signer);
  const paymaster = SecuredPaymaster__factory.connect(paymasterAddress, signer);
  const mockTarget = MockTarget__factory.connect(mockTargetAddress, signer);

  const existingDeposit = await entryPoint.balanceOf(paymasterAddress);
  console.log("Existing deposit:", `${ethers.formatEther(existingDeposit)} ETH`);

  // Read current caps so test values are always derived from contract config.
  const capVerification = await paymaster.maxVerificationGasLimit();
  const capCall = await paymaster.maxCallGasLimit();
  const capPaymasterVerification = await paymaster.maxPaymasterVerificationGasLimit();
  const capPostOp = await paymaster.maxPaymasterPostOpGasLimit();
  const capPreVerification = await paymaster.maxPreVerificationGas();

  const verificationGasLimit = overCap
    ? (capVerification > 0n ? capVerification * 5n : 300_000n * 5n)
    : (capVerification > 0n ? capVerification : 300_000n);
  const callGasLimit = overCap
    ? (capCall > 0n ? capCall * 5n : 200_000n * 5n)
    : (capCall > 0n ? capCall : 200_000n);
  const preVerificationGas = overCap
    ? (capPreVerification > 0n ? capPreVerification * 5n : 80_000n * 5n)
    : (capPreVerification > 0n ? capPreVerification : 80_000n);
  const paymasterVerificationGasLimit =
    overCap
      ? (capPaymasterVerification > 0n ? capPaymasterVerification * 5n : 100_000n * 5n)
      : (capPaymasterVerification > 0n ? capPaymasterVerification : 100_000n);
  const paymasterPostOpGasLimit = overCap
    ? (capPostOp > 0n ? capPostOp * 5n : 50_000n * 5n)
    : (capPostOp > 0n ? capPostOp : 50_000n);

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

  // Prepare a simple call: BaselineAccount.execute(mockTarget, 0, ping())
  // Mod 2 requires this exact target to be whitelisted on-chain.
  const currentlyAllowed = await paymaster.allowedTargets(mockTargetAddress);
  if (!currentlyAllowed) {
    const tx = await paymaster.setAllowedTarget(mockTargetAddress, true);
    await tx.wait();
  }

  const currentSponsorSigner = await paymaster.sponsorSigner();
  if (currentSponsorSigner.toLowerCase() !== signer.address.toLowerCase()) {
    const tx = await paymaster.setSponsorSigner(signer.address);
    await tx.wait();
  }

  const value = 0n;
  const innerCallData = mockTarget.interface.encodeFunctionData("ping");
  const callData = account.interface.encodeFunctionData("execute", [
    mockTargetAddress,
    value,
    innerCallData,
  ]);

  // Build a minimal PackedUserOperation
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
  } catch (e: unknown) {
    staticCallReverted = true;
  }

  if (overCap && !staticCallReverted) {
    throw new Error("OVER_CAP=1 was set but staticCall passed unexpectedly.");
  }

  const tx = await entryPoint.handleOps([userOp], beneficiary, { gasLimit: 15_000_000n });
  console.log("Txn hash:", tx.hash);
  let revertedAsExpected = false;
  try {
    await tx.wait();
    revertedAsExpected = !overCap;
  } catch (e: unknown) {
    if (overCap) {
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
  } else if (overCap) {
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

