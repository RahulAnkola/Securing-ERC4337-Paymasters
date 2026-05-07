// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";

/**
 * @dev ERC-4337 paymaster with gas capping (Mod 3).
 *      Rejects UserOps that exceed configured max gas limits to avoid the 10% penalty
 *      on unused gas. Owner sets caps; validation enforces them.
 */
contract SecuredPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    // BaselineAccount (BaseAccount) uses:
    // execute(address target, uint256 value, bytes data)
    bytes4 internal constant EXECUTE_SELECTOR = bytes4(keccak256("execute(address,uint256,bytes)"));

    uint256 public maxVerificationGasLimit;
    uint256 public maxCallGasLimit;
    uint256 public maxPaymasterVerificationGasLimit;
    uint256 public maxPaymasterPostOpGasLimit;
    uint256 public maxPreVerificationGas;

    // Mod 2: allowed contract targets to sponsor (everything else rejected).
    mapping(address => bool) public allowedTargets;

    struct UserDailyQuota {
        uint48 dayIndex;
        uint256 spentWei;
    }

    // Mod 1: simulated per-user quota using virtual user IDs (bytes32).
    mapping(bytes32 => UserDailyQuota) public userDailyQuota;
    mapping(uint256 => bool) public usedSponsorshipNonce;
    address public sponsorSigner;
    uint256 public userDailyLimitWei;
    uint256 public dappDailyLimitWei;
    uint48 public dappDayIndex;
    uint256 public dappSpentWei;

    event GasCapsUpdated(
        uint256 maxVerificationGasLimit,
        uint256 maxCallGasLimit,
        uint256 maxPaymasterVerificationGasLimit,
        uint256 maxPaymasterPostOpGasLimit,
        uint256 maxPreVerificationGas
    );

    event AllowedTargetUpdated(address indexed target, bool allowed);
    event SponsorSignerUpdated(address indexed sponsorSigner);
    event DailyLimitsUpdated(uint256 userDailyLimitWei, uint256 dappDailyLimitWei);

    constructor(IEntryPoint _entryPoint) BasePaymaster(_entryPoint) {
        maxVerificationGasLimit = 350_000;
        maxCallGasLimit = 250_000;
        maxPaymasterVerificationGasLimit = 350_000;
        maxPaymasterPostOpGasLimit = 120_000;
        maxPreVerificationGas = 100_000;
        sponsorSigner = msg.sender;
        userDailyLimitWei = 0.01 ether;
        dappDailyLimitWei = 0.1 ether;
    }

    function _validateEntryPointInterface(IEntryPoint _entryPoint) internal pure override {
        _entryPoint;
    }

    /**
     * @dev Set gas caps (owner only). Zero means no cap for that field.
     */
    function setGasCaps(
        uint256 _maxVerificationGasLimit,
        uint256 _maxCallGasLimit,
        uint256 _maxPaymasterVerificationGasLimit,
        uint256 _maxPaymasterPostOpGasLimit,
        uint256 _maxPreVerificationGas
    ) external onlyOwner {
        maxVerificationGasLimit = _maxVerificationGasLimit;
        maxCallGasLimit = _maxCallGasLimit;
        maxPaymasterVerificationGasLimit = _maxPaymasterVerificationGasLimit;
        maxPaymasterPostOpGasLimit = _maxPaymasterPostOpGasLimit;
        maxPreVerificationGas = _maxPreVerificationGas;
        emit GasCapsUpdated(
            _maxVerificationGasLimit,
            _maxCallGasLimit,
            _maxPaymasterVerificationGasLimit,
            _maxPaymasterPostOpGasLimit,
            _maxPreVerificationGas
        );
    }

    /// @notice Mod 2: whitelist a target address (owner only).
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit AllowedTargetUpdated(target, allowed);
    }

    /// @notice Mod 1: configure backend signer that authorizes sponsorship payloads.
    function setSponsorSigner(address _sponsorSigner) external onlyOwner {
        require(_sponsorSigner != address(0), "SecuredPaymaster: zero sponsor signer");
        sponsorSigner = _sponsorSigner;
        emit SponsorSignerUpdated(_sponsorSigner);
    }

    /// @notice Mod 1: set daily sponsorship limits.
    function setDailyLimits(uint256 _userDailyLimitWei, uint256 _dappDailyLimitWei) external onlyOwner {
        userDailyLimitWei = _userDailyLimitWei;
        dappDailyLimitWei = _dappDailyLimitWei;
        emit DailyLimitsUpdated(_userDailyLimitWei, _dappDailyLimitWei);
    }

    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recoverSigner(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "SecuredPaymaster: bad signature v");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "SecuredPaymaster: bad signature");
        return recovered;
    }

    function _sponsorshipDigest(
        bytes32 virtualUserId,
        uint48 validUntil,
        uint256 sponsorshipNonce,
        uint256 sponsoredMaxCostWei
    ) internal view returns (bytes32) {
        return _toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    address(this),
                    block.chainid,
                    virtualUserId, // virtual sender identity, not userOp.sender
                    validUntil,
                    sponsorshipNonce,
                    sponsoredMaxCostWei
                )
            )
        );
    }

    /// @dev Extract the `target` parameter from BaselineAccount.execute(...)
    function _extractExecuteTarget(bytes calldata callData) internal pure returns (address target) {
        require(callData.length >= 4, "SecuredPaymaster: invalid callData");

        bytes4 selector;
        assembly {
            selector := calldataload(callData.offset)
        }
        require(selector == EXECUTE_SELECTOR, "SecuredPaymaster: unsupported callData");

        // decode (address target, uint256 value, bytes innerData)
        (address decodedTarget,,) = abi.decode(callData[4:], (address, uint256, bytes));
        return decodedTarget;
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 requiredPreFund
    )
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        // EntryPoint v0.7 already calls _tryDecrementDeposit(paymaster, requiredPreFund) before
        // validatePaymasterUserOp, so balanceOf here is (deposit - requiredPreFund). Do not require
        // balanceOf >= requiredPreFund — that would wrongly demand ~2x prefund (see AA31).

        if (maxVerificationGasLimit != 0) {
            require(
                userOp.unpackVerificationGasLimit() <= maxVerificationGasLimit,
                "SecuredPaymaster: verificationGasLimit exceeds cap"
            );
        }
        if (maxCallGasLimit != 0) {
            require(
                userOp.unpackCallGasLimit() <= maxCallGasLimit,
                "SecuredPaymaster: callGasLimit exceeds cap"
            );
        }
        if (maxPaymasterVerificationGasLimit != 0 && userOp.paymasterAndData.length >= 36) {
            require(
                userOp.unpackPaymasterVerificationGasLimit() <= maxPaymasterVerificationGasLimit,
                "SecuredPaymaster: paymasterVerificationGasLimit exceeds cap"
            );
        }
        if (maxPaymasterPostOpGasLimit != 0 && userOp.paymasterAndData.length >= 52) {
            require(
                userOp.unpackPostOpGasLimit() <= maxPaymasterPostOpGasLimit,
                "SecuredPaymaster: paymasterPostOpGasLimit exceeds cap"
            );
        }
        if (maxPreVerificationGas != 0) {
            require(
                userOp.preVerificationGas <= maxPreVerificationGas,
                "SecuredPaymaster: preVerificationGas exceeds cap"
            );
        }

        // Mod 2: only sponsor whitelisted target contracts.
        address target = _extractExecuteTarget(userOp.callData);
        require(allowedTargets[target], "SecuredPaymaster: target not allowed");

        // Mod 1 sponsorship payload (after first 52 bytes of paymasterAndData):
        // abi.encode(
        //   bytes32 virtualUserId,
        //   uint48 validUntil,
        //   uint256 sponsorshipNonce,
        //   uint256 sponsoredMaxCostWei,
        //   bytes signature
        // )
        require(userOp.paymasterAndData.length > 52, "SecuredPaymaster: missing sponsorship data");
        (
            bytes32 virtualUserId,
            uint48 validUntil,
            uint256 sponsorshipNonce,
            uint256 sponsoredMaxCostWei,
            uint8 v,
            bytes32 r,
            bytes32 s
        ) = abi.decode(userOp.paymasterAndData[52:], (bytes32, uint48, uint256, uint256, uint8, bytes32, bytes32));

        require(block.timestamp <= validUntil, "SecuredPaymaster: sponsorship expired");
        require(!usedSponsorshipNonce[sponsorshipNonce], "SecuredPaymaster: nonce already used");
        require(requiredPreFund <= sponsoredMaxCostWei, "SecuredPaymaster: over sponsored max cost");

        bytes32 digest = _sponsorshipDigest(
            virtualUserId,
            validUntil,
            sponsorshipNonce,
            sponsoredMaxCostWei
        );
        address recoveredSigner = _recoverSigner(digest, v, r, s);
        require(recoveredSigner == sponsorSigner, "SecuredPaymaster: bad sponsor signature");

        uint48 currentDay = uint48(block.timestamp / 1 days);
        UserDailyQuota storage userQuota = userDailyQuota[virtualUserId];
        if (userQuota.dayIndex != currentDay) {
            userQuota.dayIndex = currentDay;
            userQuota.spentWei = 0;
        }
        if (dappDayIndex != currentDay) {
            dappDayIndex = currentDay;
            dappSpentWei = 0;
        }

        require(userQuota.spentWei + requiredPreFund <= userDailyLimitWei, "SecuredPaymaster: user daily quota exceeded");
        require(dappSpentWei + requiredPreFund <= dappDailyLimitWei, "SecuredPaymaster: dapp daily quota exceeded");

        // Reserve pre-fund budget during validation.
        userQuota.spentWei += requiredPreFund;
        dappSpentWei += requiredPreFund;
        usedSponsorshipNonce[sponsorshipNonce] = true;

        // Context used by postOp to rebate quota if actual cost is lower.
        return (abi.encode(virtualUserId, requiredPreFund), 0);
    }

    function _postOp(
        PostOpMode /* mode */,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) internal override {
        (bytes32 virtualUserId, uint256 reservedCostWei) = abi.decode(context, (bytes32, uint256));
        if (actualGasCost >= reservedCostWei) {
            return;
        }

        uint256 refundWei = reservedCostWei - actualGasCost;
        UserDailyQuota storage userQuota = userDailyQuota[virtualUserId];
        if (userQuota.spentWei >= refundWei) {
            userQuota.spentWei -= refundWei;
        } else {
            userQuota.spentWei = 0;
        }
        if (dappSpentWei >= refundWei) {
            dappSpentWei -= refundWei;
        } else {
            dappSpentWei = 0;
        }
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "SecuredPaymaster: zero address");
        (bool success, ) = to.call{value: amount}("");
        require(success, "SecuredPaymaster: withdraw failed");
    }

    receive() external payable {}
}
