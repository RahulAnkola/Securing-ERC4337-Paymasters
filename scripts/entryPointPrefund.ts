import { ethers } from "ethers";

/** Matches EntryPoint._getRequiredPrefund (account-abstraction PackedUserOperation). */
export function entryPointRequiredPrefundWei(args: {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
}): bigint {
  const gas =
    args.verificationGasLimit +
    args.callGasLimit +
    args.paymasterVerificationGasLimit +
    args.paymasterPostOpGasLimit +
    args.preVerificationGas;
  return gas * args.maxFeePerGas;
}

type EntryPointBalance = { balanceOf: (addr: string) => Promise<bigint> };

type PaymasterDeposit = {
  deposit: (overrides: { value: bigint }) => Promise<{ wait: () => Promise<unknown> }>;
};

/**
 * 1) If deposit &lt; maintenanceThreshold: top up to maintenanceTarget (e.g. 0.001 → 0.005 ETH).
 * 2) If deposit &lt; EntryPoint required prefund for this UserOp: top up to max(maintenanceTarget, requiredPrefund).
 */
export async function ensurePaymasterDepositForPackedUserOp(
  entryPoint: EntryPointBalance,
  paymaster: PaymasterDeposit,
  paymasterAddress: string,
  gas: {
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    paymasterVerificationGasLimit: bigint;
    paymasterPostOpGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
  },
  opts: { maintenanceThresholdWei: bigint; maintenanceTargetWei: bigint }
): Promise<void> {
  const { maintenanceThresholdWei, maintenanceTargetWei } = opts;
  let balance = await entryPoint.balanceOf(paymasterAddress);

  if (balance < maintenanceThresholdWei) {
    const amount = maintenanceTargetWei - balance;
    console.log("Depositing:", `${ethers.formatEther(amount)} ETH`, "(maintenance: below threshold)");
    await (await paymaster.deposit({ value: amount })).wait();
    balance = await entryPoint.balanceOf(paymasterAddress);
  }

  const requiredPrefund = entryPointRequiredPrefundWei(gas);
  if (balance < requiredPrefund) {
    const target = maintenanceTargetWei > requiredPrefund ? maintenanceTargetWei : requiredPrefund;
    const amount = target - balance;
    console.log(
      "Depositing:",
      `${ethers.formatEther(amount)} ETH`,
      `(EntryPoint required prefund ${ethers.formatEther(requiredPrefund)} ETH for this UserOp)`
    );
    await (await paymaster.deposit({ value: amount })).wait();
  }
}
