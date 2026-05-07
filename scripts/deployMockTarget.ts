import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

type DeploymentInfo = {
  address: string;
  deployer: string;
  txHash: string;
  blockNumber: number | null;
};

type DeploymentsFile = {
  [network: string]: {
    EntryPoint?: { address: string; blockNumber: number | null };
    BaselinePaymaster?: DeploymentInfo;
    BaselineAccount?: DeploymentInfo;
    SecuredPaymaster?: DeploymentInfo;
    MockTarget?: DeploymentInfo;
  };
};

const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");

function loadDeployments(): DeploymentsFile {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) return {} as DeploymentsFile;
  const raw = fs.readFileSync(DEPLOYMENTS_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {} as DeploymentsFile;
  }
}

function saveDeployments(data: DeploymentsFile) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
}

async function main() {
  const deployments = loadDeployments();
  const network = hre.network.name;

  console.log(`Deploying MockTarget to network: ${network}`);
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const MockTarget = await hre.ethers.getContractFactory("MockTarget");
  const mockTarget = await MockTarget.deploy();

  const deployTx = mockTarget.deploymentTransaction();
  await mockTarget.waitForDeployment();

  const address = await mockTarget.getAddress();
  const receipt = deployTx ? await deployTx.wait() : undefined;

  console.log("MockTarget deployed at:", address);
  if (receipt) {
    console.log("Tx hash:", receipt.hash);
    console.log("Block number:", receipt.blockNumber);
  }

  if (!deployments[network]) deployments[network] = {};

  deployments[network].MockTarget = {
    address,
    deployer: deployer.address,
    txHash: receipt ? receipt.hash : "",
    blockNumber: receipt ? receipt.blockNumber : null,
  };

  saveDeployments(deployments);
  console.log(`deployments.json updated for network "${network}" (MockTarget).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

