// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/contracts/core/BaseAccount.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/core/Helpers.sol";

/**
 * @dev Extremely simple ERC-4337 account used for baseline experiments.
 *      - No signatures or owner checks: any UserOperation is accepted.
 *      - Only the configured EntryPoint can trigger execution.
 *      - This is intentionally insecure and only for testnet use.
 */
contract BaselineAccount is BaseAccount {
    IEntryPoint private immutable _entryPoint;

    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
    }

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    // Accept every signature (no authentication).
    function _validateSignature(
        PackedUserOperation calldata,
        bytes32
    ) internal pure override returns (uint256) {
        return SIG_VALIDATION_SUCCESS;
    }

    // Only allow calls from the EntryPoint.
    function _requireForExecute() internal view override {
        require(msg.sender == address(entryPoint()), "BaselineAccount: not EntryPoint");
    }
}

