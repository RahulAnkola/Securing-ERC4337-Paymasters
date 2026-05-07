import express from "express";
import cors from "cors";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { JsonRpcProvider, Contract, id, formatEther, parseEther, AbiCoder } from "ethers";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env"), quiet: true });

const app = express();
app.use(cors());

const frontendDist = join(__dirname, "..", "frontend", "dist");
const projectRoot = join(__dirname, "..");
app.use("/api", express.json());
app.use(express.static(frontendDist));

const deploymentsPath = join(projectRoot, "deployments.json");
const historyDir = join(__dirname, "data");
const historyPath = join(historyDir, "userop-history.json");
const csvPath = join(historyDir, "userop-results.csv");

function getDeployments() {
  const raw = readFileSync(deploymentsPath, "utf8");
  return JSON.parse(raw);
}

function getFingerprint(net) {
  const names = ["EntryPoint", "BaselinePaymaster", "SecuredPaymaster", "BaselineAccount", "MockTarget"];
  const addrs = names
    .filter((n) => net[n]?.address)
    .map((n) => net[n].address.toLowerCase())
    .sort();
  return addrs.join("|");
}

app.post("/api/send-userop-whitelist", async (req, res) => {
  const network = req.body?.network || req.query.network;
  const reject = req.body?.reject === true || req.query.reject === "1";
  if (!network) {
    return res.status(400).json({ error: "Missing network (body or query)" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({
      error: "Set SEPOLIA_RPC_URL in .env.",
    });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const entryPoint = new Contract(
      net.EntryPoint?.address,
      ENTRYPOINT_ABI,
      provider
    );

    const paymasterAddress = net.SecuredPaymaster?.address;
    if (!paymasterAddress) {
      return res
        .status(400)
        .json({ error: "SecuredPaymaster not in deployments" });
    }

    const child = spawn(
      "npx",
      [
        "hardhat",
        "run",
        "scripts/sendUserOpWithSecuredPaymasterWhitelist.ts",
        "--network",
        network,
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, REJECT_WHITELIST: reject ? "1" : "0" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(s);
    });

    child.on("error", (err) => {
      res.status(500).json({ error: err.message });
    });

    child.on("close", async () => {
      const match =
        stdout.match(/(?:handleOps tx hash|Txn hash):\s*(0x[a-fA-F0-9]{64})/) ||
        stderr.match(/(?:handleOps tx hash|Txn hash):\s*(0x[a-fA-F0-9]{64})/);
      const txHash = match ? match[1] : null;
      if (!txHash) {
        const errMsg =
          stderr.trim() || stdout.trim() || `Script exited with code ${child.exitCode}`;
        return res.status(500).json({ error: errMsg.slice(0, 500) });
      }

      try {
        let gasUsedEth = "0.000000";
        let gasCostEth = null;
        let actualGasCostEth = "0.000000";
        let status = null;

        try {
          const receipt = await getReceiptWithRetry(provider, txHash);
          if (receipt) {
            status = Number(receipt.status) === 1 ? "Success" : "Revert";
            const effectiveGasPrice =
              receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
            const gasCostWei = receipt.gasUsed * effectiveGasPrice;
            gasCostEth = formatEthFromWei(gasCostWei);

            const sponsorDrainFromEvent = extractSponsorDrainWeiFromReceipt(
              entryPoint,
              receipt,
              paymasterAddress,
            );
            actualGasCostEth = formatEthFromWei(sponsorDrainFromEvent);
            const sponsorDrainWei = sponsorDrainFromEvent;
            gasUsedEth = formatEthFromWei(sponsorDrainWei);
          }
        } catch {
          // ignore receipt timing issues
        }

        const currentFingerprint = getFingerprint(net);
        const data = readHistory();
        if (
          !data[network] ||
          data[network].fingerprint !== currentFingerprint
        ) {
          data[network] = { fingerprint: currentFingerprint, txns: [] };
        }

        data[network].txns.unshift({
          kind: "secured",
          caseId: reject ? "non-whitelist" : "valid",
          txHash,
          gasUsedEth,
          gasCostEth,
          actualGasCostEth,
          status,
          userQuotaOk: true,
          dappQuotaOk: true,
          timestamp: Math.floor(Date.now() / 1000),
        });
        writeHistory(data);
        appendCsvResultRow({
          type: "secured",
          caseId: reject ? "non-whitelist" : "valid",
          txHash,
          sponsorDrainEth: actualGasCostEth,
          txnCostEth: gasCostEth,
          success: status,
          userQuota: true,
          dappQuota: true,
        });

        res.json({ kind: "secured", txHash, gasUsedEth, gasCostEth, actualGasCostEth, status });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getUserOpKindConfig(net, kind) {
  if (kind === "secured") {
    return {
      kind: "secured",
      paymasterAddress: net.SecuredPaymaster?.address,
      scriptPath: "scripts/sendUserOpWithSecuredPaymaster.ts",
      missingPaymasterError: "SecuredPaymaster not in deployments",
    };
  }
  return {
    kind: "baseline",
    paymasterAddress: net.BaselinePaymaster?.address,
    scriptPath: "scripts/sendUserOpWithBaselinePaymaster.ts",
    missingPaymasterError: "BaselinePaymaster not in deployments",
  };
}

function readHistory() {
  try {
    if (existsSync(historyPath)) {
      return JSON.parse(readFileSync(historyPath, "utf8"));
    }
  } catch (e) {
    // ignore
  }
  return {};
}

function writeHistory(data) {
  if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
  writeFileSync(historyPath, JSON.stringify(data, null, 2), "utf8");
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, "\"\"")}"`;
  return s;
}

function csvTxHashCell(txHash) {
  const s = txHash == null ? "" : String(txHash);
  // Prefix zero-width space so spreadsheet tools keep it as text
  // without showing formula wrappers like ="0x...".
  return csvCell(`\u200B${s}`);
}

function csvEthCell(value) {
  const n = Number(value ?? 0);
  const fixed = Number.isFinite(n) ? n.toFixed(6) : String(value ?? "0.000000");
  // Force text to avoid spreadsheet auto-rounding tiny values to 0.
  return csvCell(`\u200B${fixed}`);
}

function ensureCsvHeader() {
  if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
  if (!existsSync(csvPath)) {
    appendFileSync(
      csvPath,
      "type,case,txn_hash,sponsor_drain_eth,txn_cost_eth,result,user_quota,dapp_quota\n",
      "utf8",
    );
  }
}

function detectFailedCondition(stdout, stderr, status, opts = {}) {
  if (status !== "Revert") return "";
  if (opts.overCap) return "overcap";
  if (opts.rejectWhitelist) return "whitelist";

  const combined = `${stdout || ""}\n${stderr || ""}`;
  if (/daily quota exceeded/i.test(combined)) return "quota limit";
  if (/target not allowed|whitelist/i.test(combined)) return "whitelist";
  if (/over[\s-]?cap|exceeds cap|OVER_CAP/i.test(combined)) return "overcap";
  return "";
}

function appendCsvResultRow(row) {
  ensureCsvHeader();
  const line = [
    csvCell(row.type),
    csvCell(row.caseId ?? ""),
    csvTxHashCell(row.txHash),
    csvEthCell(row.sponsorDrainEth ?? "0.000000"),
    csvEthCell(row.txnCostEth ?? "0.000000"),
    csvCell(row.success ?? ""),
    csvCell(String(row.userQuota ?? true)),
    csvCell(String(row.dappQuota ?? true)),
  ].join(",") + "\n";
  appendFileSync(csvPath, line, "utf8");
}

async function decodeRevertReasonFromTx(provider, txHash, blockNumber) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to || !tx.data || !blockNumber || blockNumber <= 0) return "";
    await provider.call(
      {
        to: tx.to,
        data: tx.data,
        from: tx.from,
        gasLimit: tx.gasLimit,
      },
      blockNumber - 1,
    );
    return "";
  } catch (e) {
    const data = e?.data;
    if (!data || typeof data !== "string") return "";
    const idx = data.indexOf("08c379a0");
    if (idx < 0) return "";
    try {
      const payload = "0x" + data.slice(idx + 8);
      const decoded = AbiCoder.defaultAbiCoder().decode(["string"], payload);
      return String(decoded[0] || "");
    } catch {
      return "";
    }
  }
}

function parseMatrixOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let current = null;

  for (const line of lines) {
    const m1 = line.match(/^\[(baseline|secured)\]\s+case=([^\s]+)\s+target=([^\s]+)\s+overcap=(yes|no)$/i);
    if (m1) {
      if (current) rows.push(current);
      current = {
        type: m1[1].toLowerCase(),
        caseId: m1[2],
        target: m1[3],
        overCap: m1[4].toLowerCase() === "yes",
        virtualUserId: "",
        userQuota: true,
        dappQuota: true,
      };
      continue;
    }
    if (!current) continue;

    const uq = line.match(/^User quota check:\s*(true|false)$/i);
    if (uq) {
      current.userQuota = uq[1].toLowerCase() === "true";
      continue;
    }
    const dq = line.match(/^dapp quota check:\s*(true|false)$/i);
    if (dq) {
      current.dappQuota = dq[1].toLowerCase() === "true";
      continue;
    }
    const vu = line.match(/^Virtual user id:\s*(0x[a-fA-F0-9]{64})$/i);
    if (vu) {
      current.virtualUserId = vu[1];
      continue;
    }
    const m7 = line.match(
      /^result=(success|revert)\s+txn hash=(0x[a-fA-F0-9]{64}|)\s+user_quota=(true|false)\s+dapp_quota=(true|false)$/i,
    );
    if (m7) {
      current.result = m7[1].toLowerCase() === "success" ? "Success" : "Revert";
      current.txHash = m7[2] || "";
      current.userQuota = m7[3].toLowerCase() === "true";
      current.dappQuota = m7[4].toLowerCase() === "true";
      rows.push(current);
      current = null;
    }
  }

  if (current) rows.push(current);
  return rows;
}

const ENTRYPOINT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
];

const SECURE_PAYMASTER_ABI = [
  "function allowedTargets(address) view returns (bool)",
  "event AllowedTargetUpdated(address indexed target, bool allowed)",
];

const SECURED_QUOTA_ABI = [
  "function userDailyQuota(bytes32) view returns (uint48 dayIndex, uint256 spentWei)",
  "function userDailyLimitWei() view returns (uint256)",
  "function dappDailyLimitWei() view returns (uint256)",
  "function dappDayIndex() view returns (uint48)",
  "function dappSpentWei() view returns (uint256)",
];

function virtualUserPool() {
  return Array.from({ length: 10 }, (_, i) => ({
    label: `SIM_USER_${i + 1}`,
    virtualUserId: id(`SIM_USER_${i + 1}`),
  }));
}

function formatEthFromWei(wei) {
  return (Number(wei) / 1e18).toFixed(6);
}

async function getReceiptWithRetry(provider, txHash) {
  let receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    await new Promise((r) => setTimeout(r, 2000));
    receipt = await provider.getTransactionReceipt(txHash);
  }
  return receipt;
}

function extractSponsorDrainWeiFromReceipt(entryPoint, receipt, paymasterAddress) {
  if (!receipt) return 0n;
  const paymasterLc = String(paymasterAddress).toLowerCase();
  let totalActualGasCost = 0n;
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== String(entryPoint.target).toLowerCase()) continue;
    try {
      const parsed = entryPoint.interface.parseLog(log);
      if (!parsed || parsed.name !== "UserOperationEvent") continue;
      const logPaymaster = String(parsed.args.paymaster ?? "").toLowerCase();
      if (logPaymaster !== paymasterLc) continue;
      totalActualGasCost += BigInt(parsed.args.actualGasCost.toString());
    } catch {
      // ignore unrelated logs
    }
  }
  return totalActualGasCost;
}

app.get("/api/daily-quotas", async (req, res) => {
  const network = req.query.network;
  if (!network) {
    return res.status(400).json({ error: "Missing query: network" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({ error: "Set SEPOLIA_RPC_URL in .env." });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const paymasterAddress = net.SecuredPaymaster?.address;
    if (!paymasterAddress) {
      return res.status(400).json({ error: "SecuredPaymaster not in deployments" });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const paymaster = new Contract(paymasterAddress, SECURED_QUOTA_ABI, provider);

    const block = await provider.getBlock("latest");
    const currentDay = Number(BigInt(block.timestamp) / 86400n);

    const [userDailyLimitWei, dappDailyLimitWei, dappDayIndex, dappSpentWei] =
      await Promise.all([
        paymaster.userDailyLimitWei(),
        paymaster.dappDailyLimitWei(),
        paymaster.dappDayIndex(),
        paymaster.dappSpentWei(),
      ]);

    const userLimit = BigInt(userDailyLimitWei.toString());
    const dappLimit = BigInt(dappDailyLimitWei.toString());
    const dappDay = Number(dappDayIndex);
    const effectiveDappSpent =
      dappDay === currentDay ? BigInt(dappSpentWei.toString()) : 0n;
    const dappRemaining = dappLimit > effectiveDappSpent ? dappLimit - effectiveDappSpent : 0n;

    const users = await Promise.all(
      virtualUserPool().map(async ({ label, virtualUserId }) => {
        const q = await paymaster.userDailyQuota(virtualUserId);
        const uDay = Number(q.dayIndex);
        const spent =
          uDay === currentDay ? BigInt(q.spentWei.toString()) : 0n;
        const remaining = userLimit > spent ? userLimit - spent : 0n;
        return {
          label,
          virtualUserId,
          dayIndex: uDay,
          spentWei: spent.toString(),
          spentEth: formatEther(spent),
          remainingWei: remaining.toString(),
          remainingEth: formatEther(remaining),
          baselineSpentWei: "0",
          baselineSpentEth: "0.0",
          isCurrentDay: uDay === currentDay,
        };
      }),
    );

    // Baseline doesn't enforce quota, but we can still attribute spend by virtual user
    // from matrix/history rows and show it in this popup.
    const history = readHistory();
    const currentFingerprint = getFingerprint(net);
    const historyEntry = history?.[network];
    const networkRows =
      historyEntry && historyEntry.fingerprint === currentFingerprint
        ? (historyEntry.txns ?? [])
        : [];
    const baselineByUser = new Map();
    for (const row of networkRows) {
      if (row?.kind !== "baseline") continue;
      const resolvedVirtualUserId =
        row?.virtualUserId ??
        (row?.caseId ? matrixVirtualUserId(row.caseId) : null);
      if (!resolvedVirtualUserId) continue;
      const ts = Number(row?.timestamp ?? 0);
      const rowDay = Math.floor(ts / 86400);
      if (rowDay !== currentDay) continue;
      const amountEth =
        row?.userDrainEth ??
        row?.actualGasCostEth ??
        row?.gasUsedEth ??
        "0";
      let wei = 0n;
      try {
        wei = parseEther(String(amountEth));
      } catch {
        wei = 0n;
      }
      const k = String(resolvedVirtualUserId).toLowerCase();
      baselineByUser.set(k, (baselineByUser.get(k) ?? 0n) + wei);
    }
    for (const u of users) {
      const spent = baselineByUser.get(String(u.virtualUserId).toLowerCase()) ?? 0n;
      u.baselineSpentWei = spent.toString();
      u.baselineSpentEth = formatEther(spent);
    }

    return res.json({
      network,
      currentDay,
      blockTimestamp: Number(block.timestamp),
      userDailyLimitWei: userLimit.toString(),
      userDailyLimitEth: formatEther(userLimit),
      dappDailyLimitWei: dappLimit.toString(),
      dappDailyLimitEth: formatEther(dappLimit),
      dapp: {
        dayIndex: dappDay,
        spentWei: effectiveDappSpent.toString(),
        spentEth: formatEther(effectiveDappSpent),
        remainingWei: dappRemaining.toString(),
        remainingEth: formatEther(dappRemaining),
        isCurrentDay: dappDay === currentDay,
      },
      users,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/deployments", (_req, res) => {
  try {
    const deployments = getDeployments();
    res.json(deployments);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/whitelist", async (req, res) => {
  const network = req.query.network;
  if (!network) return res.status(400).json({ error: "Missing query: network" });

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({ error: "Set SEPOLIA_RPC_URL in .env." });
  }

  // Simple in-memory cache to avoid repeated log scans.
  // Keyed only by network + refreshed frequently.
  if (!globalThis.__whitelistCache) {
    globalThis.__whitelistCache = {};
  }
  const cache = globalThis.__whitelistCache;
  const cacheKey = String(network);
  const nowMs = Date.now();
  const cached = cache[cacheKey];
  if (cached && nowMs - cached.t < 60_000) {
    return res.json(cached.v);
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) return res.status(404).json({ error: `Unknown network: ${network}` });

    const paymasterAddress = net.SecuredPaymaster?.address;
    if (!paymasterAddress) {
      return res.status(400).json({ error: "SecuredPaymaster not in deployments" });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const paymaster = new Contract(paymasterAddress, SECURE_PAYMASTER_ABI, provider);

    const latestBlock = await provider.getBlockNumber();
    // Alchemy free tier typically limits eth_getLogs to ~10 blocks per request.
    // We therefore query in small chunks and only within a reasonable lookback.
    // Default kept small to avoid Alchemy free-tier rate limits.
    // You can override using: ?lookbackBlocks=...
    const lookbackBlocks = req.query.lookbackBlocks
      ? Number(req.query.lookbackBlocks)
      : 300;
    const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

    const filter = paymaster.filters.AllowedTargetUpdated();
    const lastAllowedByTarget = new Map();
    const addedTargetsSet = new Set();

    const chunkSize = 10; // <= 10-block range limitation
    const maxChunks = 30; // safety cap against repeated RPC log scans
    let chunks = 0;
    for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, latestBlock);
      const logs = await paymaster.queryFilter(filter, start, end);
      // logs are returned in ascending block order for each chunk
      for (const log of logs) {
        const { target, allowed } = log.args || {};
        if (!target) continue;
        const t = String(target).toLowerCase();
        const a = Boolean(allowed);
        lastAllowedByTarget.set(t, a);
        if (a) addedTargetsSet.add(t);
      }
      chunks += 1;
      if (chunks >= maxChunks) break;
    }

    // Derive:
    // - addedTargets: any address ever set with allowed=true
    // - currentlyAllowedTargets: last known allowed state
    const currentlyAllowedTargets = Array.from(lastAllowedByTarget.entries())
      .filter(([, allowed]) => allowed)
      .map(([t]) => t);
    const addedTargets = Array.from(addedTargetsSet);

    const out = {
      network,
      fromBlock,
      latestBlock,
      addedTargets,
      currentlyAllowedTargets,
    };

    cache[cacheKey] = { t: nowMs, v: out };
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/balances", async (req, res) => {
  const network = req.query.network;
  if (!network) {
    return res.status(400).json({ error: "Missing query: network" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({
      error: "Set SEPOLIA_RPC_URL in .env.",
    });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const provider = new JsonRpcProvider(rpcUrl);

    const contractNames = Object.keys(net).filter(
      (k) => net[k] && typeof net[k].address === "string",
    );

    const contracts = await Promise.all(
      contractNames.map(async (name) => {
        const address = net[name].address;
        const balance = await provider.getBalance(address);
        return {
          name,
          address,
          balanceWei: balance.toString(),
          balanceEth: (Number(balance) / 1e18).toFixed(6),
        };
      }),
    );

    const entryPointInfo = net.EntryPoint;
    const baselinePaymasterInfo = net.BaselinePaymaster;
    const securedPaymasterInfo = net.SecuredPaymaster;
    let baselinePaymasterDepositWei = "0";
    let baselinePaymasterDepositEth = "0";
    let securedPaymasterDepositWei = "0";
    let securedPaymasterDepositEth = "0";

    if (entryPointInfo?.address) {
      const entryPoint = new Contract(
        entryPointInfo.address,
        ENTRYPOINT_ABI,
        provider,
      );
      if (baselinePaymasterInfo?.address) {
        const baselineDeposit = await entryPoint.balanceOf(baselinePaymasterInfo.address);
        baselinePaymasterDepositWei = baselineDeposit.toString();
        baselinePaymasterDepositEth = (Number(baselineDeposit) / 1e18).toFixed(6);
      }
      if (securedPaymasterInfo?.address) {
        const securedDeposit = await entryPoint.balanceOf(securedPaymasterInfo.address);
        securedPaymasterDepositWei = securedDeposit.toString();
        securedPaymasterDepositEth = (Number(securedDeposit) / 1e18).toFixed(6);
      }
    }

    res.json({
      network,
      contracts,
      baselinePaymasterDepositWei,
      baselinePaymasterDepositEth,
      securedPaymasterDepositWei,
      securedPaymasterDepositEth,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/userop-history", (req, res) => {
  const network = req.query.network;
  if (!network) {
    return res.status(400).json({ error: "Missing query: network" });
  }
  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.json({ network, txns: [] });
    }
    const currentFingerprint = getFingerprint(net);
    const data = readHistory();
    const entry = data[network];
    if (!entry || entry.fingerprint !== currentFingerprint) {
      return res.json({ network, txns: [] });
    }
    res.json({ network, txns: entry.txns || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/send-userop", async (req, res) => {
  const network = req.body?.network || req.query.network;
  const requestedKind = req.body?.kind || req.query.kind || "baseline";
  const kind = requestedKind === "secured" ? "secured" : "baseline";
  const overCap = req.body?.overCap === true || req.query.overCap === "1";
  if (!network) {
    return res.status(400).json({ error: "Missing network (body or query)" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({
      error: "Set SEPOLIA_RPC_URL in .env.",
    });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const entryPoint = new Contract(
      net.EntryPoint?.address,
      ENTRYPOINT_ABI,
      provider,
    );
    const config = getUserOpKindConfig(net, kind);
    const paymasterAddress = config.paymasterAddress;
    if (!paymasterAddress) {
      return res.status(400).json({ error: config.missingPaymasterError });
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        "npx",
        [
          "hardhat",
          "run",
          config.scriptPath,
          "--network",
          network,
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, OVER_CAP: overCap ? "1" : "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        const s = chunk.toString();
        stdout += s;
        process.stdout.write(s);
      });
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderr += s;
        process.stderr.write(s);
      });
      child.on("close", async (code) => {
        const match =
          stdout.match(/(?:handleOps tx hash|Txn hash):\s*(0x[a-fA-F0-9]{64})/) ||
          stderr.match(/(?:handleOps tx hash|Txn hash):\s*(0x[a-fA-F0-9]{64})/);
        const txHash = match ? match[1] : null;
        if (!txHash) {
          const expectedOverCapRevert = stdout.includes(
            "OVER_CAP check behaved as expected (reverted).",
          );
          if (overCap && expectedOverCapRevert) {
            const currentFingerprint = getFingerprint(net);
            const data = readHistory();
            if (
              !data[network] ||
              data[network].fingerprint !== currentFingerprint
            ) {
              data[network] = { fingerprint: currentFingerprint, txns: [] };
            }
            data[network].txns.unshift({
              kind,
              caseId: "overcap",
              txHash: "OVER_CAP_REVERT",
              gasUsedEth: "0.000000",
              gasCostEth: "0.000000",
              actualGasCostEth: "0.000000",
              status: "Revert",
              userQuotaOk: true,
              dappQuotaOk: true,
              timestamp: Math.floor(Date.now() / 1000),
            });
            writeHistory(data);
            return resolve(
              res.json({
                kind,
                txHash: "OVER_CAP_REVERT",
                gasUsedEth: "0.000000",
                gasCostEth: "0.000000",
                actualGasCostEth: "0.000000",
                status: "Revert",
              }),
            );
          }
          const errMsg =
            stderr.trim() || stdout.trim() || `Script exited with code ${code}`;
          return resolve(res.status(500).json({ error: errMsg.slice(0, 500) }));
        }
        try {
          let gasUsedEth = "0.000000";
          let gasCostEth = null;
          let actualGasCostEth = "0.000000";
          let status = null;
          let rawReceipt = null;
          try {
            const receipt = await getReceiptWithRetry(provider, txHash);
            if (receipt) {
              const statusCode = Number(receipt.status);
              status = statusCode === 1 ? "Success" : "Revert";
              const effectiveGasPrice =
                receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
              const gasCostWei = receipt.gasUsed * effectiveGasPrice;
              gasCostEth = formatEthFromWei(gasCostWei);

              const sponsorDrainFromEvent = extractSponsorDrainWeiFromReceipt(
                entryPoint,
                receipt,
                paymasterAddress,
              );
              actualGasCostEth = formatEthFromWei(sponsorDrainFromEvent);
              const sponsorDrainWei = sponsorDrainFromEvent;
              gasUsedEth = formatEthFromWei(sponsorDrainWei);

              const logs = (receipt.logs ?? []).map((l) => ({
                transactionHash: l.transactionHash,
                blockNumber: l.blockNumber,
                address: l.address,
                topics: l.topics,
                data: l.data,
                logIndex: l.index,
                transactionIndex: l.transactionIndex,
              }));

              rawReceipt = {
                transactionHash: receipt.hash,
                gasUsed: receipt.gasUsed.toString(),
                effectiveGasPrice: effectiveGasPrice.toString(),
                status: statusCode,
                logs,
                blockNumber: receipt.blockNumber,
              };

            }
          } catch (e) {
            // ignore receipt timing/indexing issues for API response
          }

          const currentFingerprint = getFingerprint(net);
          const data = readHistory();
          if (
            !data[network] ||
            data[network].fingerprint !== currentFingerprint
          ) {
            data[network] = { fingerprint: currentFingerprint, txns: [] };
          }
          data[network].txns.unshift({
            kind,
            caseId: overCap ? "overcap" : "valid",
            txHash,
            gasUsedEth,
            gasCostEth,
            actualGasCostEth,
            status,
            userQuotaOk: true,
            dappQuotaOk: true,
            timestamp: Math.floor(Date.now() / 1000),
          });
          writeHistory(data);
          appendCsvResultRow({
            type: kind,
            caseId: overCap ? "overcap" : "valid",
            txHash,
            sponsorDrainEth: actualGasCostEth,
            txnCostEth: gasCostEth,
            success: status,
            userQuota: true,
            dappQuota: true,
          });

          resolve(
            res.json({ kind, txHash, gasUsedEth, gasCostEth, actualGasCostEth, status, receipt: rawReceipt })
          );
        } catch (e) {
          resolve(res.status(500).json({ error: e.message }));
        }
      });
      child.on("error", (err) => {
        resolve(res.status(500).json({ error: err.message }));
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/run-matrix", async (req, res) => {
  const network = req.body?.network || req.query.network;
  if (!network) {
    return res.status(400).json({ error: "Missing network (body or query)" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({ error: "Set SEPOLIA_RPC_URL in .env." });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const entryPoint = new Contract(net.EntryPoint?.address, ENTRYPOINT_ABI, provider);

    return new Promise((resolve) => {
      const child = spawn(
        "npx",
        ["hardhat", "run", "scripts/runScenarioMatrix_80_10_10.ts", "--network", network],
        {
          cwd: projectRoot,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        const s = chunk.toString();
        stdout += s;
        process.stdout.write(s);
      });
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderr += s;
        process.stderr.write(s);
      });

      child.on("close", async () => {
        try {
          const rows = parseMatrixOutput(stdout);
          const currentFingerprint = getFingerprint(net);
          const data = readHistory();
          if (!data[network] || data[network].fingerprint !== currentFingerprint) {
            data[network] = { fingerprint: currentFingerprint, txns: [] };
          }

          for (const row of rows) {
            let gasCostEth = "0.000000";
            let actualGasCostEth = "0.000000";
            let status = row.result ?? "Revert";
            let userQuotaOk = !!row.userQuota;
            let dappQuotaOk = !!row.dappQuota;

            if (row.txHash) {
              const receipt = await getReceiptWithRetry(provider, row.txHash);
              if (receipt) {
                status = Number(receipt.status) === 1 ? "Success" : "Revert";
                const effectiveGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
                gasCostEth = formatEthFromWei(receipt.gasUsed * effectiveGasPrice);

                const paymasterAddress =
                  row.type === "secured" ? net.SecuredPaymaster?.address : net.BaselinePaymaster?.address;
                const sponsorDrainFromEvent = extractSponsorDrainWeiFromReceipt(
                  entryPoint,
                  receipt,
                  paymasterAddress,
                );
                actualGasCostEth = formatEthFromWei(sponsorDrainFromEvent);

                if (status === "Revert") {
                  const reason = await decodeRevertReasonFromTx(provider, row.txHash, receipt.blockNumber);
                  if (/user daily quota exceeded/i.test(reason)) userQuotaOk = false;
                  if (/dapp daily quota exceeded/i.test(reason)) dappQuotaOk = false;
                }
              }
            }

            data[network].txns.unshift({
              kind: row.type === "secured" ? "secured" : "baseline",
              caseId: row.caseId,
              virtualUserId: row.virtualUserId || null,
              txHash: row.txHash,
              gasUsedEth: actualGasCostEth,
              gasCostEth,
              actualGasCostEth,
              userDrainEth: actualGasCostEth,
              status,
              userQuotaOk,
              dappQuotaOk,
              timestamp: Math.floor(Date.now() / 1000),
            });

            appendCsvResultRow({
              type: row.type,
              caseId: row.caseId,
              txHash: row.txHash,
              sponsorDrainEth: actualGasCostEth,
              txnCostEth: gasCostEth,
              success: status,
              userQuota: userQuotaOk,
              dappQuota: dappQuotaOk,
            });
          }

          writeHistory(data);
          return resolve(res.json({ network, count: rows.length, matrixType: "80_10_10" }));
        } catch (e) {
          return resolve(res.status(500).json({ error: e.message || String(e), stdout, stderr }));
        }
      });

      child.on("error", (err) => {
        resolve(res.status(500).json({ error: err.message }));
      });
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/run-matrix-100", async (req, res) => {
  const network = req.body?.network || req.query.network;
  if (!network) {
    return res.status(400).json({ error: "Missing network (body or query)" });
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({ error: "Set SEPOLIA_RPC_URL in .env." });
  }

  try {
    const deployments = getDeployments();
    const net = deployments[network];
    if (!net) {
      return res.status(404).json({ error: `Unknown network: ${network}` });
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const entryPoint = new Contract(net.EntryPoint?.address, ENTRYPOINT_ABI, provider);

    return new Promise((resolve) => {
      const child = spawn(
        "npx",
        ["hardhat", "run", "scripts/runScenarioMatrix_100.ts", "--network", network],
        {
          cwd: projectRoot,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        const s = chunk.toString();
        stdout += s;
        process.stdout.write(s);
      });
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderr += s;
        process.stderr.write(s);
      });

      child.on("close", async () => {
        try {
          const rows = parseMatrixOutput(stdout);
          const currentFingerprint = getFingerprint(net);
          const data = readHistory();
          if (!data[network] || data[network].fingerprint !== currentFingerprint) {
            data[network] = { fingerprint: currentFingerprint, txns: [] };
          }

          for (const row of rows) {
            let gasCostEth = "0.000000";
            let actualGasCostEth = "0.000000";
            let status = row.result ?? "Revert";
            let userQuotaOk = !!row.userQuota;
            let dappQuotaOk = !!row.dappQuota;

            if (row.txHash) {
              const receipt = await getReceiptWithRetry(provider, row.txHash);
              if (receipt) {
                status = Number(receipt.status) === 1 ? "Success" : "Revert";
                const effectiveGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
                gasCostEth = formatEthFromWei(receipt.gasUsed * effectiveGasPrice);

                const paymasterAddress =
                  row.type === "secured" ? net.SecuredPaymaster?.address : net.BaselinePaymaster?.address;
                const sponsorDrainFromEvent = extractSponsorDrainWeiFromReceipt(
                  entryPoint,
                  receipt,
                  paymasterAddress,
                );
                actualGasCostEth = formatEthFromWei(sponsorDrainFromEvent);

                if (status === "Revert") {
                  const reason = await decodeRevertReasonFromTx(provider, row.txHash, receipt.blockNumber);
                  if (/user daily quota exceeded/i.test(reason)) userQuotaOk = false;
                  if (/dapp daily quota exceeded/i.test(reason)) dappQuotaOk = false;
                }
              }
            }

            data[network].txns.unshift({
              kind: row.type === "secured" ? "secured" : "baseline",
              caseId: row.caseId,
              virtualUserId: row.virtualUserId || null,
              txHash: row.txHash,
              gasUsedEth: actualGasCostEth,
              gasCostEth,
              actualGasCostEth,
              userDrainEth: actualGasCostEth,
              status,
              userQuotaOk,
              dappQuotaOk,
              timestamp: Math.floor(Date.now() / 1000),
            });

            appendCsvResultRow({
              type: row.type,
              caseId: row.caseId,
              txHash: row.txHash,
              sponsorDrainEth: actualGasCostEth,
              txnCostEth: gasCostEth,
              success: status,
              userQuota: userQuotaOk,
              dappQuota: dappQuotaOk,
            });
          }

          writeHistory(data);
          return resolve(res.json({ network, count: rows.length }));
        } catch (e) {
          return resolve(res.status(500).json({ error: e.message || String(e), stdout, stderr }));
        }
      });

      child.on("error", (err) => {
        resolve(res.status(500).json({ error: err.message }));
      });
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  const index = join(frontendDist, "index.html");
  if (existsSync(index)) res.sendFile(index);
  else next();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(
    `Server: http://localhost:${PORT} (API: /api/*, static: frontend/dist)`,
  );
});
