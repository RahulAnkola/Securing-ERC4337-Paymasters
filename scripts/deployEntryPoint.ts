import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

type DeploymentsFile = {
  [network: string]: {
    EntryPoint?: {
      address: string;
      deployer?: string;
      txHash?: string;
      blockNumber: number | null;
    };
    BaselinePaymaster?: unknown;
    BaselineAccount?: unknown;
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
  const network = hre.network.name;

  console.log(`Deploying EntryPoint (PackedUserOperation format) to network: ${network}`);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const EntryPointWrapper = await hre.ethers.getContractFactory("EntryPointWrapper");
  const entryPoint = await EntryPointWrapper.deploy();

  const deployTx = entryPoint.deploymentTransaction();
  await entryPoint.waitForDeployment();

  const address = await entryPoint.getAddress();
  const receipt = deployTx ? await deployTx.wait() : undefined;

  console.log("EntryPoint deployed at:", address);
  if (receipt) {
    console.log("Tx hash:", receipt.hash);
    console.log("Block number:", receipt.blockNumber);
  }

  const deployments = loadDeployments();

  if (!deployments[network]) {
    deployments[network] = {};
  }

  deployments[network].EntryPoint = {
    address,
    deployer: deployer.address,
    txHash: receipt ? receipt.hash : "",
    blockNumber: receipt ? receipt.blockNumber : null,
  };

  saveDeployments(deployments);

  console.log(`deployments.json updated for network "${network}" (EntryPoint).`);
  console.log("\nNext: Set ENTRYPOINT_ADDRESS=" + address + " in .env");
  console.log("Then redeploy BaselinePaymaster and BaselineAccount with: npm run deploy:baseline:sepolia && npm run deploy:account:sepolia");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
