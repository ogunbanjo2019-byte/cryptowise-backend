# CryptoWise deposit production-readiness checklist

## Current state

- The customer UI supports ETH and USDT selections and can display instructions returned by the backend. It also lists only the signed-in user's own deposit requests.
- The admin console has a protected, read-only deposit-operations view with request-window and staleness visibility.
- Customer deposit intake, manual review, ledger credit, withdrawal intake, and manual-send administration are fail-closed in code. `LIVE_FUNDS_ENABLED=true` alone cannot turn them on.
- There is no Ethereum chain monitor, automated reconciliation, alert delivery, or application-reported backup/restore verification. Do not accept public deposits with this release.

## Receiving address verification

- The screenshot provided during this work is explicitly labelled **“Deposit ETH into Bybit”** on Ethereum (ERC-20). It is not a verified USDT deposit instruction and has not been embedded in the source or shown to CryptoWise customers.
- Before accepting USDT, obtain the address from the company's Bybit **USDT → Deposit → Ethereum (ERC-20)** screen and independently confirm the asset/network in the account. Confirm that the account is a company-controlled account permitted for this business use.
- Obtain and verify a separate ETH deposit instruction if ETH is to be supported. Do not assume two assets use the same exchange address, even if the address strings look identical.
- Do not paste private keys, seed phrases, Bybit credentials, or provider API secrets into the repository or frontend. Public addresses belong in reviewed backend configuration, not client-side constants.
- Shared company addresses do not inherently identify the customer who made a transfer. A user-submitted transaction hash can be claimed by another customer. Use unique customer deposit addresses or another independently reviewed attribution mechanism before automatic crediting.

## Chain verification and crediting

- Select and document the exact chain ID and network (Ethereum mainnet chain ID 1 for production), ETH confirmations/finality policy, and the official Ethereum USDT contract. Do not accept same-symbol tokens or another chain's USDT.
- Monitor native ETH transactions and ERC-20 `Transfer` logs for the configured destination(s). Verify canonical transaction receipt success, destination, token contract, asset, positive integer amount, block hash, and confirmation depth.
- Use a stable event identity, e.g. `chainId:transactionHash:logIndex` for token logs and an appropriate unique identifier for native transfers. Enforce uniqueness and perform balance + ledger + event-status writes in one Firestore transaction.
- Handle retries, provider timeouts, duplicate events, gaps, and reorgs. Do not treat a submitted hash or a staff-entered amount as verification. Keep deposits pending until the configured finality rule is met.
- Record detected but unattributed, mismatched, under/overpaid, failed, and reorged transfers as explicit exceptions. Provide a reviewed procedure for resolution; do not silently credit or discard them.
- Add integration tests for duplicate event delivery, competing workers, wrong chain/token/destination, reverted transfers, insufficient confirmations, provider gaps, and a credited event removed by a reorg. Test against a controlled local chain or testnet before mainnet.

## Operations, recovery, and security

- Deploy the monitor as an always-on, supervised worker with independent health/heartbeat reporting, provider failover, alerting, structured logs, and an on-call runbook. The present dashboard does not perform monitoring or reconciliation.
- Reconcile scanned chain events against deposit requests, event records, and immutable ledger entries on a schedule. Alert on monitor lag, stuck requests, missing blocks, mismatches, duplicate attempts, reorgs, and ledger reconciliation differences.
- Configure Firestore backups/export retention and access controls, then perform documented restore drills. The current API cannot report whether backups are configured or restorable.
- Keep withdrawal signing/custody separate from the web/API service. Use an independently reviewed institutional custody or HSM/MPC design; never place wallet signing keys in browser code, Git, or ordinary Render environment variables.
- Complete independent security, accounting, privacy, fraud, and load testing. Obtain legal/compliance advice for Nigeria and every target jurisdiction before accepting customer funds.

## Release gate

Keep `LIVE_FUNDS_ENABLED=false` and leave the hard-coded deposit readiness constants false until the full verification, attribution, operations, custody, compliance, and test evidence above has been reviewed and approved. This checklist is not a legal opinion or security certification.
