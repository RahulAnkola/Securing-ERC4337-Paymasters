import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

type AccountDeploymentInfo = {
  address: string;
  deployer: string;
  txHash: string;
  blockNumber: number | null;
};

type DeploymentsFile = {
  [network: string]: {
    EntryPoint?: {
      address: string;
      blockNumber: number | null;
    };
    BaselinePaymaster?: AccountDeploymentInfo;
    BaselineAccount?: AccountDeploymentInfo;
  };
};

const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");

function loadDeployments(): DeploymentsFile {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(DEPLOYMENTS_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveDeployments(data: DeploymentsFile) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
}

async function main() {
  const deployments = loadDeployments();
  const network = hre.network.name;
  const entryPointAddress =
    (deployments[network] as any)?.EntryPoint?.address ?? process.env.ENTRYPOINT_ADDRESS;

  if (!entryPointAddress) {
    throw new Error("EntryPoint not found. Run deploy:entrypoint:sepolia first or set ENTRYPOINT_ADDRESS in .env");
  }

  console.log(`Deploying BaselineAccount to network: ${network}`);
  console.log("Using EntryPoint:", entryPointAddress);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const BaselineAccount = await hre.ethers.getContractFactory("BaselineAccount");
  const account = await BaselineAccount.deploy(entryPointAddress);

  const deployTx = account.deploymentTransaction();
  await account.waitForDeployment();

  const address = await account.getAddress();
  const receipt = deployTx ? await deployTx.wait() : undefined;

  console.log("BaselineAccount deployed at:", address);
  if (receipt) {
    console.log("Tx hash:", receipt.hash);
    console.log("Block number:", receipt.blockNumber);
  }

  if (!deployments[network]) {
    deployments[network] = {};
  }

  deployments[network].BaselineAccount = {
    address,
    deployer: deployer.address,
    txHash: receipt ? receipt.hash : "",
    blockNumber: receipt ? receipt.blockNumber : null,
  };

  saveDeployments(deployments);

  console.log(`deployments.json updated for network "${network}" (BaselineAccount).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

