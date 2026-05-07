// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

/**
 * @dev Minimal ERC-4337 paymaster for baseline experiments.
 *      - Anyone can sponsor UserOperations as long as this contract has ETH.
 *      - No signature or whitelist checks on the UserOperation.
 *      - This is intentionally insecure and should only be used on testnets.
 */
contract BaselinePaymaster is BasePaymaster {
    constructor(IEntryPoint _entryPoint) BasePaymaster(_entryPoint) {}

    /**
     * @dev Override the BasePaymaster EntryPoint interface check for compatibility
     *      with EntryPoint deployments that don't implement ERC-165.
     */
    function _validateEntryPointInterface(IEntryPoint _entryPoint) internal pure override {
        // Silence unused variable warning without performing an interface check.
        _entryPoint;
    }

    /**
     * @dev Accept all UserOperations as long as the paymaster has balance.
     *      `context` is empty and `validationData` is zero (no signature validation).
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata,
        bytes32,
        uint256
    )
        internal
        pure
        override
        returns (bytes memory context, uint256 validationData)
    {
        // EntryPoint prefund is reserved before this hook; balanceOf is already net of requiredPreFund.

        return ("", 0);
    }

    /**
     * @dev No postOp logic for the baseline; just a no-op.
     */
    function _postOp(
        PostOpMode /* mode */,
        bytes calldata /* context */,
        uint256 /* actualGasCost */,
        uint256 /* actualUserOpFeePerGas */
    ) internal pure override {}

    /**
     * @dev Allow the owner to withdraw ETH from the paymaster.
     */
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "BaselinePaymaster: zero address");
        (bool success, ) = to.call{value: amount}("");
        require(success, "BaselinePaymaster: withdraw failed");
    }

    /**
     * @dev Allow funding the paymaster via plain ETH transfers.
     */
    receive() external payable {}
}

