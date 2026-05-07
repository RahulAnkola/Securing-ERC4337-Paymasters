// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockTarget {
    event Ping(address indexed sender);

    function ping() external {
        emit Ping(msg.sender);
    }
}

