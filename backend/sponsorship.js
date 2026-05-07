/**
 * Sponsorship & rate-limiting (Mod 1) – off-chain service.
 * Used by SecuredPaymaster for quota and sponsorship signatures.
 *
 * Planned:
 * - issueSponsorshipSignature(userAddr, maxGas, chainId, dAppId?) → { signature, expiry, nonce }
 * - checkPerUserDailyBudget(userAddr) → boolean (under cap)
 * - checkPerDAppAggregateBudget(dAppId) → boolean (under cap)
 * - enforce short-lived expiry (e.g. 5–10 min) in issued signatures
 */

/**
 * Placeholder: issue a sponsorship signature (Mod 1).
 * @param {object} params - { userAddr, maxGas, chainId, dAppId? }
 * @returns {Promise<{ signature: string, expiry: number, nonce: string }>}
 */
export async function issueSponsorshipSignature(params) {
  const { userAddr, maxGas, chainId } = params;
  if (!userAddr || maxGas == null || chainId == null) {
    throw new Error("Missing userAddr, maxGas, or chainId");
  }
  // TODO: enforce per-user daily budget, per-dApp budget, then sign
  return {
    signature: "0x",
    expiry: Math.floor(Date.now() / 1000) + 600,
    nonce: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
  };
}

/**
 * Placeholder: check whether user is under daily budget (Mod 1).
 * @param {string} userAddr - User/sender address
 * @returns {Promise<boolean>} true if under cap
 */
export async function checkPerUserDailyBudget(userAddr) {
  if (!userAddr) return false;
  // TODO: read from store (e.g. spent per user per day), compare to cap (e.g. 0.01 ETH)
  return true;
}

/**
 * Placeholder: check whether dApp is under aggregate budget (Mod 1).
 * @param {string} dAppId - dApp identifier (e.g. target contract address)
 * @returns {Promise<boolean>} true if under cap
 */
export async function checkPerDAppAggregateBudget(dAppId) {
  if (!dAppId) return true;
  // TODO: read from store (spent per dApp), compare to cap
  return true;
}
