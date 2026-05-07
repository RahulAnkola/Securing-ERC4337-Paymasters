import { useEffect, useState } from "react";

type Deployments = Record<string, Record<string, { address: string }>>;

type ContractBalance = {
  name: string;
  address: string;
  balanceWei: string;
  balanceEth: string;
};

type BalancesResponse = {
  network: string;
  contracts: ContractBalance[];
  baselinePaymasterDepositWei?: string;
  baselinePaymasterDepositEth?: string;
  securedPaymasterDepositWei?: string;
  securedPaymasterDepositEth?: string;
  // Backward compatibility with older backend response.
  paymasterDepositWei?: string;
  paymasterDepositEth?: string;
};

type UserOpTxn = {
  kind?: "baseline" | "secured";
  caseId?: string | null;
  txHash: string;
  gasUsedEth: string;
  gasCostEth?: string | null;
  actualGasCostEth?: string | null;
  status?: string | null;
  userQuotaOk?: boolean | null;
  dappQuotaOk?: boolean | null;
  timestamp: number;
};

type WhitelistResponse = {
  network?: string;
  addedTargets?: string[];
  currentlyAllowedTargets?: string[];
  error?: string;
};

type DailyQuotaUserRow = {
  label: string;
  virtualUserId: string;
  dayIndex: number;
  spentWei: string;
  spentEth: string;
  remainingWei: string;
  remainingEth: string;
  baselineSpentWei?: string;
  baselineSpentEth?: string;
  isCurrentDay: boolean;
};

type DailyQuotasResponse = {
  network?: string;
  currentDay?: number;
  blockTimestamp?: number;
  userDailyLimitEth?: string;
  dappDailyLimitEth?: string;
  dapp?: {
    dayIndex: number;
    spentEth: string;
    remainingEth: string;
    isCurrentDay: boolean;
  };
  users?: DailyQuotaUserRow[];
  error?: string;
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={copy}
      title="Copy address"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function shortAddress(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** ETH string from API → at most 6 decimals, no trailing zeros (e.g. 0.2 not 0.200000) */
function formatEth6(ethStr: string | undefined | null): string {
  if (ethStr == null || ethStr === "") return "—";
  const n = Number(ethStr);
  if (!Number.isFinite(n)) return ethStr;
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function formatEthTableCell(ethStr: string | undefined | null, opts?: { zeroAsPlain?: boolean }): string {
  if (ethStr == null || ethStr === "") return "—";
  const n = Number(ethStr);
  if (Number.isFinite(n) && n === 0 && opts?.zeroAsPlain) return "0 ETH";
  return `${ethStr} ETH`;
}

export default function App() {
  const [deployments, setDeployments] = useState<Deployments | null>(null);
  const [network, setNetwork] = useState<string>("");
  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [txHistory, setTxHistory] = useState<UserOpTxn[]>([]);
  const [sendingKind, setSendingKind] = useState<
    | "baseline"
    | "secured"
    | "secured-overcap"
    | "whitelist-allowed"
    | "whitelist-rejected"
    | "matrix"
    | "matrix-100"
    | null
  >(null);
  const [lastResult, setLastResult] = useState<{ txHash: string; gasUsedEth: string } | null>(null);

  const [whitelistModalOpen, setWhitelistModalOpen] = useState(false);
  const [whitelistLoading, setWhitelistLoading] = useState(false);
  const [whitelistError, setWhitelistError] = useState<string | null>(null);
  const [whitelistTargets, setWhitelistTargets] = useState<string[]>([]);

  const [quotaModalOpen, setQuotaModalOpen] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [quotaData, setQuotaData] = useState<DailyQuotasResponse | null>(null);

  const fetchBalances = (net: string) => {
    setError(null);
    return fetch(`/api/balances?network=${encodeURIComponent(net)}`)
      .then((r) => {
        if (!r.ok) return r.json().then((body) => Promise.reject(new Error(body.error || r.statusText)));
        return r.json();
      })
      .then(setBalances)
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    fetch("/api/deployments")
      .then((r) => r.json())
      .then((data) => {
        setDeployments(data);
        const networks = Object.keys(data);
        if (networks.length && !network) setNetwork(networks[0]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const fetchHistory = (net: string) => {
    return fetch(`/api/userop-history?network=${encodeURIComponent(net)}`)
      .then((r) => r.json())
      .then((data) => setTxHistory(data.txns || []))
      .catch(() => setTxHistory([]));
  };

  const doSend = async (endpoint: string, body: any) => {
    if (!network) return;
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: { error?: string; txHash?: string; gasUsedEth?: string };
    try {
      data = text.startsWith("{") ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!r.ok) {
      if (data?.error) throw new Error(data.error);
      throw new Error(
        "Backend unavailable or error. Is the backend running on port 3001?"
      );
    }
    if (data.txHash != null && data.gasUsedEth != null) {
      setLastResult({ txHash: data.txHash, gasUsedEth: data.gasUsedEth });
    }
    setTimeout(() => setLastResult(null), 8000);
    await fetchBalances(network);
    await fetchHistory(network);
  };

  useEffect(() => {
    if (!network) return;
    fetchBalances(network);
    fetchHistory(network);
  }, [network]);

  const fetchDailyQuotas = async (net: string) => {
    setQuotaLoading(true);
    setQuotaError(null);
    try {
      const r = await fetch(`/api/daily-quotas?network=${encodeURIComponent(net)}`);
      const text = await r.text();
      let data: DailyQuotasResponse = {};
      try {
        data = text.startsWith("{") ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!r.ok) throw new Error(data.error || "Failed to load daily quotas");
      setQuotaData(data);
      setQuotaModalOpen(true);
    } catch (e) {
      setQuotaError(e instanceof Error ? e.message : "Failed to load daily quotas");
      setQuotaData(null);
      setQuotaModalOpen(true);
    } finally {
      setQuotaLoading(false);
    }
  };

  const fetchWhitelist = async (net: string) => {
    setWhitelistLoading(true);
    setWhitelistError(null);
    try {
      const r = await fetch(`/api/whitelist?network=${encodeURIComponent(net)}`);
      const text = await r.text();
      let data: WhitelistResponse = {};
      try {
        data = text.startsWith("{") ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!r.ok) throw new Error(data.error || "Failed to load whitelist");
      // User request: show ALL addresses added to whitelist.
      const addrs = data.addedTargets || [];
      setWhitelistTargets(addrs);
      setWhitelistModalOpen(true);
    } catch (e) {
      setWhitelistError(e instanceof Error ? e.message : "Failed to load whitelist");
    } finally {
      setWhitelistLoading(false);
    }
  };

  if (loading || !deployments) {
    return <div className="loading">Loading deployments…</div>;
  }

  const networks = Object.keys(deployments);

  return (
    <>
      <header className="page-header">
        <h1>ERC-4337 Paymaster Dashboard</h1>
        {networks.length > 0 && (
          <div className="page-header-actions">
            <button
              type="button"
              className="quota-btn"
              onClick={() => {
                if (!network) return;
                fetchDailyQuotas(network);
              }}
              disabled={quotaLoading || sendingKind !== null}
              title="Secured paymaster daily limits (10 simulated users + dApp)"
            >
              {quotaLoading ? "Loading…" : "Daily quotas"}
            </button>
          </div>
        )}
      </header>

      {networks.length > 0 && (
        <div className="top-bar top-bar-grid">
          <div className="top-row">
            <div className="network-select">
              <label htmlFor="network">Network</label>
              <select
                id="network"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
              >
                {networks.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="refresh-btn"
              onClick={() => {
                if (!network) return;
                setRefreshing(true);
                fetchBalances(network).finally(() => setRefreshing(false));
              }}
              disabled={refreshing}
              title="Refresh balances"
            >
              {refreshing ? "…" : "Refresh"}
            </button>
            <button
              type="button"
              className="send-userop-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("baseline");
                try {
                  await doSend("/api/send-userop", { network, kind: "baseline" });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Run sendUserOpWithBaselinePaymaster script"
            >
              {sendingKind === "baseline" ? "Sending…" : "Send Baseline UserOp"}
            </button>
          </div>

          <div className="top-row">
            <div className="row-label">Over-cap testing</div>
            <button
              type="button"
              className="send-userop-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("secured");
                try {
                  await doSend("/api/send-userop", { network, kind: "secured" });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Run secured within gas caps (expected success)"
            >
              {sendingKind === "secured" ? "Sending…" : "Secured Success"}
            </button>
            <button
              type="button"
              className="send-userop-btn send-userop-revert-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("secured-overcap");
                try {
                  await doSend("/api/send-userop", {
                    network,
                    kind: "secured",
                    overCap: true,
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Run secured over-cap test (expected revert)"
            >
              {sendingKind === "secured-overcap" ? "Testing…" : "Over-Cap Revert"}
            </button>
          </div>

          <div className="top-row">
            <div className="row-label">Whitelist testing</div>
            <button
              type="button"
              className="send-userop-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("whitelist-allowed");
                try {
                  await doSend("/api/send-userop-whitelist", {
                    network,
                    reject: false,
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Whitelist Allowed (expected success)"
            >
              {sendingKind === "whitelist-allowed" ? "Testing…" : "Whitelist Allowed"}
            </button>
            <button
              type="button"
              className="send-userop-btn send-userop-revert-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("whitelist-rejected");
                try {
                  await doSend("/api/send-userop-whitelist", {
                    network,
                    reject: true,
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Whitelist Rejected (expected revert)"
            >
              {sendingKind === "whitelist-rejected" ? "Testing…" : "Whitelist Rejected"}
            </button>
            <button
              type="button"
              className="view-whitelist-btn"
              onClick={() => {
                if (!network) return;
                fetchWhitelist(network);
              }}
              disabled={whitelistLoading || sendingKind !== null}
              title="View currently allowed whitelist targets"
            >
              {whitelistLoading ? "Loading…" : "View Whitelist"}
            </button>
            <button
              type="button"
              className="send-userop-btn send-userop-secured-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("matrix");
                try {
                  await doSend("/api/run-matrix", { network });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Matrix run failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Run 80/10/10 matrix (secured then baseline)"
            >
              {sendingKind === "matrix" ? "Running…" : "Run Matrix 80/10/10"}
            </button>
            <button
              type="button"
              className="send-userop-btn send-userop-secured-btn"
              onClick={async () => {
                if (!network) return;
                setError(null);
                setSendingKind("matrix-100");
                try {
                  await doSend("/api/run-matrix-100", { network });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Matrix run failed");
                } finally {
                  setSendingKind(null);
                }
              }}
              disabled={sendingKind !== null}
              title="Run 100 valid txns matrix (secured then baseline)"
            >
              {sendingKind === "matrix-100" ? "Running…" : "Run Matrix 100 Valid"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {lastResult && (
        <div className="success-msg">
          UserOp sent.{" "}
          <a href={explorerTxUrl(network, lastResult.txHash)} target="_blank" rel="noopener noreferrer" className="tx-link">
            View tx
          </a>
          {" "}— Gas: {lastResult.gasUsedEth} ETH (also in table below)
        </div>
      )}

      {quotaModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setQuotaModalOpen(false);
            setQuotaError(null);
            setQuotaData(null);
          }}
        >
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Secured paymaster — daily quotas</div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => {
                  setQuotaModalOpen(false);
                  setQuotaError(null);
                  setQuotaData(null);
                }}
              >
                Close
              </button>
            </div>
            {quotaError && <div className="modal-error">{quotaError}</div>}
            <div className="modal-body">
              {quotaData && !quotaError && (
                <>
                  <div className="quota-meta">
                    Network: <strong>{quotaData.network}</strong>
                    {quotaData.currentDay != null && (
                      <>
                        {" "}
                        · Day index: <strong>{quotaData.currentDay}</strong>
                      </>
                    )}
                    {quotaData.userDailyLimitEth != null && (
                      <>
                        {" "}
                        · Per-user limit: <strong>{formatEth6(quotaData.userDailyLimitEth)} ETH</strong>
                      </>
                    )}
                  </div>
                  {quotaData.dapp && (
                    <div className="quota-dapp-card">
                      <div className="quota-dapp-title">dApp aggregate</div>
                      <div className="quota-dapp-row">
                        <div>
                          <span>Daily limit </span>
                          <strong>{formatEth6(quotaData.dappDailyLimitEth)} ETH</strong>
                        </div>
                        <div>
                          <span>Spent (today) </span>
                          <strong>{formatEth6(quotaData.dapp.spentEth)} ETH</strong>
                        </div>
                        <div>
                          <span>Remaining </span>
                          <strong>{formatEth6(quotaData.dapp.remainingEth)} ETH</strong>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="quota-table-wrap">
                    <table className="quota-table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Virtual ID</th>
                          <th>Baseline spending</th>
                          <th>Spent (today)</th>
                          <th>Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(quotaData.users ?? []).map((u) => (
                          <tr key={u.virtualUserId}>
                            <td>{u.label}</td>
                            <td className="mono" title={u.virtualUserId}>
                              {shortAddress(u.virtualUserId)}
                            </td>
                            <td>{formatEth6(u.baselineSpentEth ?? "0")} ETH</td>
                            <td>{formatEth6(u.spentEth)} ETH</td>
                            <td>{formatEth6(u.remainingEth)} ETH</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {whitelistModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setWhitelistModalOpen(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title">Whitelist Targets</div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setWhitelistModalOpen(false)}
              >
                Close
              </button>
            </div>
            {whitelistError && <div className="modal-error">{whitelistError}</div>}
            <div className="modal-body">
              {whitelistTargets.length === 0 ? (
                <div className="tx-empty">No currently allowed targets found.</div>
              ) : (
                <div className="whitelist-list">
                  {whitelistTargets.map((a) => (
                    <div key={a} className="whitelist-item">
                      <span className="whitelist-addr">{a}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="section-title">Contracts</div>
      <div className="card-row">
        {balances?.contracts.map((c) => (
          <div key={c.name} className="card">
            <div className="card-name">{c.name}</div>
            <div className="card-address">
              <span title={c.address}>{shortAddress(c.address)}</span>
              <CopyButton value={c.address} />
            </div>
            <div className="card-balance">{c.balanceEth} ETH</div>
          </div>
        ))}
      </div>

      <div className="section-title">Paymaster deposit in EntryPoint</div>
      <div className="deposit-row">
        <div className="deposit-box">
          <div className="deposit-label">BaselinePaymaster deposit</div>
          <div className="deposit-value baseline-deposit-value">
            {balances
              ? `${balances.baselinePaymasterDepositEth ?? balances.paymasterDepositEth ?? "0.000000"} ETH`
              : "—"}
          </div>
        </div>
        <div className="deposit-box">
          <div className="deposit-label">SecuredPaymaster deposit</div>
          <div className="deposit-value secured-deposit-value">
            {balances ? `${balances.securedPaymasterDepositEth ?? "0.000000"} ETH` : "—"}
          </div>
        </div>
      </div>

      <div className="section-title">UserOp history</div>
      <p className="history-note">Resets when contracts are redeployed. Sponsor drain = deposit before − deposit after.</p>
      <div className="table-wrap">
        <table className="tx-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Case</th>
              <th>Txn</th>
              <th>Sponsor Drain (ETH)</th>
              <th>Txn Cost (ETH)</th>
              <th>Result</th>
              <th>User Quota</th>
              <th>dApp Quota</th>
            </tr>
          </thead>
          <tbody>
            {txHistory.length === 0 ? (
              <tr>
                <td colSpan={8} className="tx-empty">No UserOps yet</td>
              </tr>
            ) : (
              txHistory.map((row, idx) => (
                <tr key={`${row.txHash || "nohash"}-${row.timestamp}-${idx}`}>
                  <td>
                    <span className={row.kind === "secured" ? "kind-secured" : "kind-baseline"}>
                      {row.kind === "secured" ? "Secured" : "Baseline"}
                    </span>
                  </td>
                  <td>{row.caseId ?? "—"}</td>
                  <td>
                    {typeof row.txHash === "string" && row.txHash.startsWith("0x") ? (
                      <a
                        href={explorerTxUrl(network, row.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tx-link"
                      >
                        {shortAddress(row.txHash)}
                      </a>
                    ) : (
                      <span className="tx-muted">{row.txHash ?? "—"}</span>
                    )}
                  </td>
                  <td>{formatEthTableCell(row.actualGasCostEth, { zeroAsPlain: true })}</td>
                  <td>{row.gasCostEth != null ? `${row.gasCostEth} ETH` : "—"}</td>
                  <td>
                    {row.status != null ? (
                      <span className={row.status === "Success" ? "status-success" : "status-revert"}>
                        {row.status}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{row.userQuotaOk == null ? "—" : row.userQuotaOk ? "true" : "false"}</td>
                  <td>{row.dappQuotaOk == null ? "—" : row.dappQuotaOk ? "true" : "false"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function explorerTxUrl(network: string, txHash: string): string {
  const base: Record<string, string> = {
    sepolia: "https://sepolia.etherscan.io",
    mainnet: "https://etherscan.io",
  };
  const host = base[network] || `https://${network}.etherscan.io`;
  return `${host}/tx/${txHash}`;
}
