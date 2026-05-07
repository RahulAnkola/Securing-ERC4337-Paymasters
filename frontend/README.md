# Paymaster Dashboard

Simple UI to view deployed contract addresses (from `deployments.json`) and their balances.

## Setup

From project root:

```bash
npm run dashboard:install
```

Ensure `.env` in the project root has an RPC URL for the network you use (e.g. `SEPOLIA_RPC_URL`). The backend reads this to fetch balances.

## Run (dev)

1. Start the backend (serves API and reads `deployments.json`):

   ```bash
   npm run dashboard:backend
   ```

2. In another terminal, start the frontend (Vite dev server with proxy to backend):

   ```bash
   npm run dashboard:frontend
   ```

3. Open http://localhost:3000

## Run (production)

```bash
npm run dashboard:build
npm run dashboard:backend
```

Then open http://localhost:3001 (backend serves the built frontend and the API).

## API

- `GET /api/deployments` — returns full `deployments.json`.
- `GET /api/balances?network=sepolia` — returns contract addresses, ETH balances, and paymaster deposit in EntryPoint for the given network. Requires `SEPOLIA_RPC_URL` (or `<NETWORK>_RPC_URL`) in `.env`.
