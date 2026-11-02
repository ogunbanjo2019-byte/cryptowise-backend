# CryptoWise API · backend MVP foundation

Node.js 22 + Express API for Render, Firebase Authentication token verification, Firebase Admin SDK, and Firestore. The backend is intentionally fail-closed. It is an MVP foundation and must not be represented as a live, audited crypto exchange.

## Implemented in this stage

- Firebase ID-token verification with revoked-token checks. Customer passwords remain with Firebase Authentication; this API never handles raw passwords.
- Separate staff authorization using Firebase custom claims (`admin: true` plus `role`). Admin claims are assigned only by a private CLI script.
- Express security headers, strict configured CORS origins, request-size limit, rate limit, health endpoint, and generic error responses.
- Firestore rules deny all direct client reads and writes. Server routes perform authorization because the Firebase Admin SDK bypasses Firestore Security Rules.
- ETH/USDT balances use integer atomic-unit strings (wei for ETH and 6-decimal atomic units for ERC-20 USDT); no floating-point balance math.
- User deposit/withdrawal request endpoints and admin review endpoints. The legacy two-review deposit path is now fail-closed: review and credit requests return `503` until independent chain verification is implemented. A withdrawal reserves available ledger balance and requires multiple staff steps, but this API does not sign or broadcast transactions.
- Append-only individual ledger entries and administrative audit records.
- No wallet private key, seed phrase, password, or Firebase service credential is present in source code.

## Deposit operations work added in this source update

- Customer deposit page supports ETH and USDT selections, fetches instructions from the backend, and lists only the signed-in customer's own submitted requests. No active receiving address is currently published; transaction-hash submission remains hidden while deposits are paused. The screenshot shared during this work is labelled for ETH into Bybit and has not been reused as a USDT instruction.
- Admin deposit-operations endpoint and page show the current request window, stale/manual-review counts, and explicit readiness blockers. Access remains staff-role protected.
- A hard fail-closed readiness module keeps customer deposit intake, independent chain verification, and automatic crediting disabled. Manual review and credit endpoints return `503` until chain verification is implemented; `LIVE_FUNDS_ENABLED=true` alone cannot enable them. Withdrawal intake and manual-send administration also remain blocked by a separate hard-coded custody-readiness check.

This is operational visibility and UI plumbing only. It does not provide a chain monitor, real reconciliation, alerts, or backups.

## Explicitly not implemented / not approved for live-fund use

- A blockchain indexer/RPC confirmation service. Submitted deposit hashes are not independently verified by this API. Admin review must not be treated as chain verification.
- A signing/custody service or automatic withdrawal. The API never signs or broadcasts a transaction.
- A production exchange matching engine, market data, liquidity, execution integrity, fee model, circuit breakers, surveillance, or settlement rules. `TRADING_ENABLED` is a reserved feature flag; there is no order-matching endpoint in this release.
- KYC/AML provider integration, screening, disputes, customer support, privacy retention, and legally approved policies.
- Production load, penetration, threat-model, smart-contract, accounting, operational recovery, and independent security reviews.

`LIVE_FUNDS_ENABLED=false` and `TRADING_ENABLED=false` are the defaults. Keep them false. The hard-coded deposit readiness controls are also false; turning on the environment flag alone cannot activate deposits, credits, withdrawal intake, or manual-send administration. The mainnet configuration check is not a substitute for an audit or readiness review. Do not enable live funds merely to make the website appear functional.

## Local setup

1. Use Node.js 22 or newer and create a Firebase project with Authentication (Email/Password or another chosen provider) and Firestore enabled.
2. In this standalone backend project folder, run `npm ci`.
3. Copy `.env.example` to `.env`. Set your Firebase project ID, a service-account JSON secret, and exact allowed frontend origins. Never commit `.env` or service-account JSON.
4. Run `npm start`. Health check: `GET http://localhost:10000/health`.
5. Set Firebase Authentication authorized domains to the actual frontend domain. Firebase Auth clients obtain an ID token and send `Authorization: Bearer <ID_TOKEN>` to this API.
6. Set admin roles from a private shell only after verifying the staff UID: `ADMIN_UID=... ADMIN_ROLE=owner node scripts/set-admin.js`. Claims take effect after the user refreshes the ID token. Do not run this from a public endpoint.
7. Deploy Firestore rules from the repository root with the Firebase CLI after selecting the correct Firebase project: `firebase use <project-id>` then `firebase deploy --only firestore:rules`.

The service account JSON belongs only in Render's secret environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`; never share it in chat, place it in the frontend, or add it to Git. Grant the service account only the access this backend needs. Do not enable broad client Firestore permissions.

Before changes are committed, run `npm test`, `npm run check`, and `npm audit --omit=dev --audit-level=high`. The included unit tests cover atomic amount conversion and Ethereum public identifier validation; they are not a substitute for integration, penetration, or accounting tests. The current rate limiter stores counters in process memory; use a shared store before scaling to multiple Render instances.

## Render

The root `render.yaml` creates a Web Service from this standalone backend repository, binds to Render's `PORT`, and uses `/health`. Import the repository as a Blueprint, review every setting, and add environment secrets in Render. Set `CORS_ORIGINS` to the exact deployed website origin(s), without `*`. A free/sleeping service is not an appropriate production environment for an exchange or fund-handling API; select an always-on plan only after reviewing cost, region, data handling, and availability needs.

Do not add production receiving addresses or switch `LIVE_FUNDS_ENABLED` on yet. The addresses will need a confirmed chain/network, monitoring, reconciliation, approval controls, recovery procedures, and independent operational review.

## Authentication and API outline

Customer routes (`/v1`): `GET /me`, `GET /wallet`, `GET /deposit-instructions`, `POST /deposit-requests`, `POST /withdrawal-requests`, `GET /notifications`, and `PATCH /notifications/:id/read`.

Staff routes (`/v1/admin`): overview, user list, deposit queue and two-person review/credit workflow, withdrawal queue and two-person approval/manual completion, and audit logs. Access is denied unless Firebase ID-token custom claims authorize the staff role.

All request examples must use HTTPS in production. Use integer atomic amounts and the exact chain. Never accept a balance, customer UID, approval state, KYC status, or permission from an untrusted browser as authoritative.

## Deployment blocker: exchange licensing and operations

An exchange that takes orders, holds assets, or transfers customer assets is a regulated financial operation in many markets. SEC Nigeria's rules cover platforms facilitating trading/exchange/transfer and lay out VASP, exchange, custody, asset-protection, and settlement obligations. Obtain Nigerian and each target-market legal/compliance advice before serving customers. The SEC's 2026 ARIP announcement states approval-in-principle is conditional and is not a final licence. This code does not determine legal eligibility.
