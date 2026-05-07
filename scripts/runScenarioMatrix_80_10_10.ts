import hre from "hardhat";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { IEntryPoint__factory } from "../typechain-types/factories/@account-abstraction/contracts/interfaces/IEntryPoint__factory";
import type { PackedUserOperationStruct } from "../typechain-types/@account-abstraction/contracts/interfaces/IEntryPoint";
import { BaselineAccount__factory } from "../typechain-types/factories/contracts/BaselineAccount__factory";
import { BaselinePaymaster__factory } from "../typechain-types/factories/contracts/BaselinePaymaster__factory";
import { SecuredPaymaster__factory } from "../typechain-types/factories/contracts/SecuredPaymaster__factory";
import { MockTarget__factory } from "../typechain-types/factories/contracts/MockTarget__factory";
import { entryPointRequiredPrefundWei } from "./entryPointPrefund";

dotenv.config({ quiet: true });

const deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8"),
);

type PaymasterKind = "baseline" | "secured";
type CaseId = string;
type TargetMode = "mock" | "signer";

type Scenario = {
  caseId: CaseId;
  targetMode: TargetMode;
  overCap: boolean;
};

const SCENARIO_TEMPLATES: Scenario[] = [
  { caseId: "valid", targetMode: "mock", overCap: false },
  { caseId: "overcap", targetMode: "mock", overCap: true },
  { caseId: "non-whitelist", targetMode: "signer", overCap: false },
];

const TOTAL_MATRIX_TXNS = 100;
const VALID_TXNS = 80;
const OVERCAP_TXNS = 10;
const NON_WHITELIST_TXNS = 10;
const USER1_VALID_TXNS = 40;

function packAccountGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): string {
  const mask = (1n << 128n) - 1n;
  const packed = ((verificationGasLimit & mask) << 128n) | (callGasLimit & mask);
  return ethers.toBeHex(packed, 32);
}

function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): string {
  const mask = (1n << 128n) - 1n;
  const packed = ((maxPriorityFeePerGas & mask) << 128n) | (maxFeePerGas & mask);
  return ethers.toBeHex(packed, 32);
}

function pickRandom<T>(items: T[]): T {
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

async function topUpIfNeeded(args: {
  entryPoint: { balanceOf: (addr: string) => Promise<bigint> };
  paymaster: { deposit: (overrides: { value: bigint }) => Promise<{ wait: () => Promise<unknown> }> };
  paymasterAddress: string;
  requiredPrefundWei: bigint;
  hasDepositedBefore: boolean;
}) {
  const maintenanceThresholdWei = ethers.parseEther("0.001");
  const maintenanceTargetWei = args.hasDepositedBefore
    ? ethers.parseEther("0.005")
    : ethers.parseEther("0.1");
  let balance = await args.entryPoint.balanceOf(args.paymasterAddress);
  console.log(`Existing deposit: ${ethers.formatEther(balance)} ETH`);

  let depositAmount = 0n;
  if (balance < maintenanceThresholdWei) {
    depositAmount = maintenanceTargetWei - balance;
  }
  const targetByPrefund =
    args.requiredPrefundWei > maintenanceTargetWei ? args.requiredPrefundWei : maintenanceTargetWei;
  if (balance + depositAmount < args.requiredPrefundWei) {
    depositAmount = targetByPrefund - balance;
  }
  if (depositAmount > 0n) {
    console.log(`Depositing: ${ethers.formatEther(depositAmount)} ETH`);
    await (await args.paymaster.deposit({ value: depositAmount })).wait();
    return true;
  }
  return false;
}

type MatrixPlanItem = {
  scenario: Scenario;
  virtualUserId: string;
};

function shuffleInPlace<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildMatrixPlan(): MatrixPlanItem[] {
  const validTemplate = SCENARIO_TEMPLATES[0];
  const overcapTemplate = SCENARIO_TEMPLATES[1];
  const nonWhitelistTemplate = SCENARIO_TEMPLATES[2];
  const users = Array.from({ length: 10 }, (_, i) => ethers.id(`SIM_USER_${i + 1}`));
  const user1 = users[0];

  const plan: MatrixPlanItem[] = [];

  for (let i = 0; i < USER1_VALID_TXNS; i += 1) {
    plan.push({ scenario: validTemplate, virtualUserId: user1 });
  }
  for (let i = USER1_VALID_TXNS; i < VALID_TXNS; i += 1) {
    plan.push({ scenario: validTemplate, virtualUserId: pickRandom(users) });
  }
  for (let i = 0; i < OVERCAP_TXNS; i += 1) {
    plan.push({ scenario: overcapTemplate, virtualUserId: pickRandom(users) });
  }
  for (let i = 0; i < NON_WHITELIST_TXNS; i += 1) {
    plan.push({ scenario: nonWhitelistTemplate, virtualUserId: pickRandom(users) });
  }

  if (plan.length !== TOTAL_MATRIX_TXNS) {
    throw new Error(`Matrix plan count mismatch: expected ${TOTAL_MATRIX_TXNS}, got ${plan.length}`);
  }

  shuffleInPlace(plan);
  return plan;
}

async function buildSecuredPaymasterAndData(args: {
  paymasterAddress: string;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  virtualUserId: string;
  sponsoredMaxCostWei: bigint;
  signer: { signMessage: (bytes: Uint8Array) => Promise<string> };
}) {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3 * 60);
  const sponsorshipNonce =
    BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes32", "uint48", "uint256", "uint256"],
    [args.paymasterAddress, chainId, args.virtualUserId, validUntil, sponsorshipNonce, args.sponsoredMaxCostWei],
  );
  const digest = ethers.keccak256(encoded);
  const signature = await args.signer.signMessage(ethers.getBytes(digest));
  const parsed = ethers.Signature.from(signature);
  const sponsorshipData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint48", "uint256", "uint256", "uint8", "bytes32", "bytes32"],
    [args.virtualUserId, validUntil, sponsorshipNonce, args.sponsoredMaxCostWei, parsed.v, parsed.r, parsed.s],
  );
  return ethers.solidityPacked(
    ["address", "uint128", "uint128", "bytes"],
    [args.paymasterAddress, args.paymasterVerificationGasLimit, args.paymasterPostOpGasLimit, sponsorshipData],
  );
}

async function main() {
  const network = hre.network.name;
  const net = (deployments as Record<string, any>)[network];
  if (!net) throw new Error(`No deployments for network ${network}`);

  const entryPointAddress = net.EntryPoint?.address ?? process.env.ENTRYPOINT_ADDRESS;
  const accountAddress = net.BaselineAccount?.address;
  const baselinePaymasterAddress = net.BaselinePaymaster?.address;
  const securedPaymasterAddress = net.SecuredPaymaster?.address;
  const mockTargetAddress = net.MockTarget?.address;
  if (!entryPointAddress || !accountAddress || !baselinePaymasterAddress || !securedPaymasterAddress || !mockTargetAddress) {
    throw new Error("Missing EntryPoint/BaselineAccount/BaselinePaymaster/SecuredPaymaster/MockTarget");
  }

  const [signer] = await hre.ethers.getSigners();
  const entryPoint = IEntryPoint__factory.connect(entryPointAddress, signer);
  const account = BaselineAccount__factory.connect(accountAddress, signer);
  const baselinePm = BaselinePaymaster__factory.connect(baselinePaymasterAddress, signer);
  const securedPm = SecuredPaymaster__factory.connect(securedPaymasterAddress, signer);
  const mockTarget = MockTarget__factory.connect(mockTargetAddress, signer);
  const beneficiary = signer.address;

  if (!(await securedPm.allowedTargets(mockTargetAddress))) {
    await (await securedPm.setAllowedTarget(mockTargetAddress, true)).wait();
  }
  if ((await securedPm.sponsorSigner()).toLowerCase() !== signer.address.toLowerCase()) {
    await (await securedPm.setSponsorSigner(signer.address)).wait();
  }

  const capVerification = await securedPm.maxVerificationGasLimit();
  const capCall = await securedPm.maxCallGasLimit();
  const capPmVerification = await securedPm.maxPaymasterVerificationGasLimit();
  const capPostOp = await securedPm.maxPaymasterPostOpGasLimit();
  const capPreVerification = await securedPm.maxPreVerificationGas();

  const normalGas = {
    verificationGasLimit: 300_000n,
    callGasLimit: 200_000n,
    preVerificationGas: 80_000n,
    paymasterVerificationGasLimit: 250_000n,
    paymasterPostOpGasLimit: 120_000n,
  };
  if (
    normalGas.verificationGasLimit > capVerification ||
    normalGas.callGasLimit > capCall ||
    normalGas.preVerificationGas > capPreVerification ||
    normalGas.paymasterVerificationGasLimit > capPmVerification ||
    normalGas.paymasterPostOpGasLimit > capPostOp
  ) {
    throw new Error("runScenarioMatrix normal gas exceeds deployed secured paymaster caps");
  }
  const overCapGas = {
    verificationGasLimit: normalGas.verificationGasLimit * 5n,
    callGasLimit: normalGas.callGasLimit * 5n,
    preVerificationGas: normalGas.preVerificationGas * 5n,
    paymasterVerificationGasLimit: normalGas.paymasterVerificationGasLimit * 5n,
    paymasterPostOpGasLimit: normalGas.paymasterPostOpGasLimit * 5n,
  };

  const maxFeePerGas = ethers.parseUnits("1", "gwei");
  const maxPriorityFeePerGas = ethers.parseUnits("0.5", "gwei");
  const matrixPlan = buildMatrixPlan();
  const paymasterHasDeposited: Record<PaymasterKind, boolean> = {
    secured: false,
    baseline: false,
  };
  const totalSecondsByKind: Partial<Record<PaymasterKind, number>> = {};

  for (const paymasterKind of ["secured", "baseline"] as PaymasterKind[]) {
    const groupStartMs = Date.now();
    for (let i = 0; i < matrixPlan.length; i += 1) {
      const { scenario, virtualUserId } = matrixPlan[i];
      const gas = scenario.overCap ? overCapGas : normalGas;
      const target = scenario.targetMode === "mock" ? mockTargetAddress : signer.address;
      const innerCallData = scenario.targetMode === "mock" ? mockTarget.interface.encodeFunctionData("ping") : "0x";
      const callData = account.interface.encodeFunctionData("execute", [target, 0n, innerCallData]);
      const nonce = await entryPoint.getNonce(accountAddress, 0);
      const paymasterAddress = paymasterKind === "secured" ? securedPaymasterAddress : baselinePaymasterAddress;
      const paymaster = paymasterKind === "secured" ? securedPm : baselinePm;
      const requiredPrefund = entryPointRequiredPrefundWei({ ...gas, maxFeePerGas });

      console.log(`[${paymasterKind}] case=${scenario.caseId} target=${scenario.targetMode} overcap=${scenario.overCap ? "yes" : "no"}`);
      const didDeposit = await topUpIfNeeded({
        entryPoint,
        paymaster,
        paymasterAddress,
        requiredPrefundWei: requiredPrefund,
        hasDepositedBefore: paymasterHasDeposited[paymasterKind],
      });
      if (didDeposit) paymasterHasDeposited[paymasterKind] = true;
      console.log(`Virtual user id: ${virtualUserId}`);

      let paymasterAndData: string;
      let skipByQuota = false;
      let userQuotaOk = true;
      let dappQuotaOk = true;
      if (paymasterKind === "secured") {
        const userQuota = await securedPm.userDailyQuota(virtualUserId);
        const userDailyLimitWei = await securedPm.userDailyLimitWei();
        const userSpentWei = userQuota[1];
        const userRemainingWei = userDailyLimitWei > userSpentWei ? userDailyLimitWei - userSpentWei : 0n;
        const dappDailyLimitWei = await securedPm.dappDailyLimitWei();
        const dappSpentWei = await securedPm.dappSpentWei();
        const dappRemainingWei = dappDailyLimitWei > dappSpentWei ? dappDailyLimitWei - dappSpentWei : 0n;
        userQuotaOk = userRemainingWei >= requiredPrefund;
        dappQuotaOk = dappRemainingWei >= requiredPrefund;
        console.log(`Remaining daily quota user: ${ethers.formatEther(userRemainingWei)} ETH`);
        console.log(`Remaining daily quota dapp: ${ethers.formatEther(dappRemainingWei)} ETH`);
        skipByQuota = !userQuotaOk || !dappQuotaOk;

        paymasterAndData = await buildSecuredPaymasterAndData({
          paymasterAddress,
          paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit,
          virtualUserId,
          sponsoredMaxCostWei: ethers.parseEther("0.01"),
          signer,
        });
      } else {
        paymasterAndData = ethers.solidityPacked(
          ["address", "uint128", "uint128"],
          [paymasterAddress, gas.paymasterVerificationGasLimit, gas.paymasterPostOpGasLimit],
        );
      }

      const userOp: PackedUserOperationStruct = {
        sender: accountAddress,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits: packAccountGasLimits(gas.verificationGasLimit, gas.callGasLimit),
        preVerificationGas: gas.preVerificationGas,
        gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
        paymasterAndData,
        signature: "0x",
      };

      let result = "success";
      let txHash = "";
      if (!skipByQuota) {
        try {
          const tx = await entryPoint.handleOps([userOp], beneficiary, { gasLimit: 15_000_000n });
          txHash = tx.hash;
          try {
            await tx.wait();
          } catch {
            result = "revert";
          }
        } catch (e: unknown) {
          result = "revert";
          const err = e as { transactionHash?: string; hash?: string; receipt?: { hash?: string } };
          txHash = err.transactionHash ?? err.hash ?? err.receipt?.hash ?? "";
        }
      } else {
        result = "revert";
      }
      console.log(
        `result=${result} txn hash=${txHash} user_quota=${userQuotaOk ? "true" : "false"} dapp_quota=${dappQuotaOk ? "true" : "false"}`,
      );
      console.log("");
    }
    const totalMs = Date.now() - groupStartMs;
    totalSecondsByKind[paymasterKind] = totalMs / 1000;
    console.log(`[${paymasterKind}] total time: ${(totalMs / 1000).toFixed(2)}s`);
    console.log("");
    if (paymasterKind === "secured") {
      console.log("");
      console.log("");
      console.log("");
      console.log("");
    }
  }
  console.log(
    `[matrix] total secured=${(totalSecondsByKind.secured ?? 0).toFixed(2)}s baseline=${(totalSecondsByKind.baseline ?? 0).toFixed(2)}s`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

