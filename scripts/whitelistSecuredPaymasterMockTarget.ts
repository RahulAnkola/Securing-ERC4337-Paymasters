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
    EntryPoint?: { address: string };
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
  const netDeployments = (deployments as any)[network];

  if (!netDeployments) throw new Error(`No deployments found for network "${network}"`);

  const securedPaymasterAddress: string | undefined = netDeployments.SecuredPaymaster?.address;
  const mockTargetAddress: string | undefined = netDeployments.MockTarget?.address;

  if (!securedPaymasterAddress || !mockTargetAddress) {
    throw new Error(
      "SecuredPaymaster or MockTarget missing in deployments.json. Run deployMockTarget.ts and deploySecuredPaymaster.ts first."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Whitelisting MockTarget:", mockTargetAddress);
  console.log("In SecuredPaymaster:", securedPaymasterAddress);

  const securedPaymaster = await hre.ethers.getContractAt(
    "SecuredPaymaster",
    securedPaymasterAddress
  );

  const tx = await securedPaymaster.setAllowedTarget(mockTargetAddress, true);
  console.log("setAllowedTarget tx:", tx.hash);
  await tx.wait();

  // Optional: record tx hash/block for convenience (not required for correctness)
  saveDeployments(deployments);
  console.log("Whitelist updated.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

