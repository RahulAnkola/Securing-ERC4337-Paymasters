import hre from "hardhat";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { IEntryPoint__factory } from "../typechain-types/factories/@account-abstraction/contracts/interfaces/IEntryPoint__factory";
import type { PackedUserOperationStruct } from "../typechain-types/@account-abstraction/contracts/interfaces/IEntryPoint";
import { BaselineAccount__factory } from "../typechain-types/factories/contracts/BaselineAccount__factory";
import { BaselinePaymaster__factory } from "../typechain-types/factories/contracts/BaselinePaymaster__factory";
import { ensurePaymasterDepositForPackedUserOp } from "./entryPointPrefund";

const deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8")
);

dotenv.config();

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

async function main() {
  const network = hre.network.name;

  const netDeployments = (deployments as any)[network];
  if (!netDeployments) {
    throw new Error(`No deployments found for network "${network}" in deployments.json`);
  }

  const entryPointAddress: string | undefined =
    netDeployments.EntryPoint?.address ?? process.env.ENTRYPOINT_ADDRESS;
  const paymasterAddress: string | undefined = netDeployments.BaselinePaymaster?.address;
  const accountAddress: string | undefined = netDeployments.BaselineAccount?.address;

  if (!entryPointAddress || !paymasterAddress || !accountAddress) {
    throw new Error("EntryPoint, BaselinePaymaster, or BaselineAccount missing in deployments.json or .env");
  }

  console.log(`Using network: ${network}`);
  console.log("EntryPoint:", entryPointAddress);
  console.log("BaselinePaymaster:", paymasterAddress);
  console.log("BaselineAccount:", accountAddress);

  const [signer] = await hre.ethers.getSigners();
  console.log("EOA signer:", signer.address);

  const entryPoint = IEntryPoint__factory.connect(entryPointAddress, signer);
  const account = BaselineAccount__factory.connect(accountAddress, signer);
  const paymaster = BaselinePaymaster__factory.connect(paymasterAddress, signer);

  const existingDeposit = await entryPoint.balanceOf(paymasterAddress);
  console.log("Existing paymaster deposit:", ethers.formatEther(existingDeposit), "ETH");

  // Prepare a simple call: BaselineAccount.execute(send 0 ETH to signer)
  const target = await signer.getAddress();
  const value = 0n;
  const data = "0x";

  const callData = account.interface.encodeFunctionData("execute", [target, value, data]);

  // Build a minimal PackedUserOperation
  const nonce = await entryPoint.getNonce(accountAddress, 0);

  const maxFeePerGas = ethers.parseUnits("2", "gwei");
  const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");

  const verificationGasLimit = 300_000n;
  const callGasLimit = 200_000n;
  const preVerificationGas = 80_000n;
  const paymasterVerificationGasLimit = 100_000n;
  const paymasterPostOpGasLimit = 50_000n;

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

  const paymasterAndData = ethers.solidityPacked(
    ["address", "uint128", "uint128"],
    [paymasterAddress, paymasterVerificationGasLimit, paymasterPostOpGasLimit]
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

  const epAny = entryPoint as any;
  if (typeof epAny.simulateValidation === "function") {
    try {
      await epAny.simulateValidation(userOp);
      console.log("simulateValidation passed");
    } catch (e) {
      console.error("simulateValidation failed:", e);
      throw e;
    }
  }

  const beneficiary = signer.address;

  try {
    await entryPoint.handleOps.staticCall([userOp], beneficiary);
    console.log("staticCall (simulation) passed");
  } catch (e: unknown) {
    const err = e as { data?: string; error?: { data?: string } };
    const data = err.data ?? err.error?.data;
    if (data) {
      const hex = typeof data === "string" ? data : String(data);
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256", "string", "bytes"],
          "0x" + hex.slice(10)
        );
        console.error("FailedOpWithRevert:", decoded[1], "\nInner:", decoded[2].slice(0, 200));
      } catch {
        console.error("Revert data:", hex.slice(0, 200));
      }
    }
    throw e;
  }

  console.log("Sending UserOperation via EntryPoint.handleOps...");
  const tx = await entryPoint.handleOps([userOp], beneficiary);
  console.log("handleOps tx hash:", tx.hash);
  const receipt = await tx.wait();
  if (receipt) {
    console.log("handleOps confirmed in block:", receipt.blockNumber);
  } else {
    console.log("handleOps mined but receipt missing");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

