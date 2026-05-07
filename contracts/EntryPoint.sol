// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/contracts/core/EntryPoint.sol";

/// @dev Thin wrapper so we can deploy EntryPoint (PackedUserOperation format) for our scripts.
contract EntryPointWrapper is EntryPoint {}
