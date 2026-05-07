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
    EntryPoint?: { address: string; deployer?: string; txHash?: string; blockNumber?: number | null };
    BaselinePaymaster?: DeploymentInfo;
    BaselineAccount?: DeploymentInfo;
    SecuredPaymaster?: DeploymentInfo;
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
    throw new Error(
      "EntryPoint not found. Run deploy:entrypoint:sepolia first or set ENTRYPOINT_ADDRESS in .env"
    );
  }

  console.log(`Deploying SecuredPaymaster to network: ${network}`);
  console.log("Using EntryPoint:", entryPointAddress);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const SecuredPaymaster = await hre.ethers.getContractFactory("SecuredPaymaster");
  const paymaster = await SecuredPaymaster.deploy(entryPointAddress);

  const deployTx = paymaster.deploymentTransaction();
  await paymaster.waitForDeployment();

  const address = await paymaster.getAddress();
  const receipt = deployTx ? await deployTx.wait() : undefined;

  console.log("SecuredPaymaster deployed at:", address);
  if (receipt) {
    console.log("Tx hash:", receipt.hash);
    console.log("Block number:", receipt.blockNumber);
  }

  if (!deployments[network]) {
    deployments[network] = {};
  }

  (deployments[network] as any).SecuredPaymaster = {
    address,
    deployer: deployer.address,
    txHash: receipt ? receipt.hash : "",
    blockNumber: receipt ? receipt.blockNumber : null,
  };

  saveDeployments(deployments);

  console.log(`deployments.json updated for network "${network}" (SecuredPaymaster).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
