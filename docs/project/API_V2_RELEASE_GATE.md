# API v2 Release Gate

Use this checklist before deploying API v2 changes or removing legacy API v1 surface area.

## Local Gate

1. Run Rust/API compile checks:

```bash
npm run api-v2:check
```

2. Run whitespace and build checks:

```bash
git diff --check
npm run build
```

3. Run guarded read verification after Node and Rust are running locally:

```bash
npm run api-v2:verify:local:read:guarded
```

4. Run full local verification with Mongo fixtures:

```bash
MONGO_URI="mongodb://user:pass@localhost:27017/POBB" MONGO_DB=POBB npm run api-v2:verify:local:full
```

## GitHub Gate

1. Confirm `API v2 build check` is green on the target commit.
2. Confirm `API v2 runtime smoke` is green on the target commit.
3. Run manual `API v2 mutation smoke` before release-sized changes or route/security refactors.
4. Download smoke evidence artifacts if a release audit needs proof of checks.

## Staging Gate

Run staging checks only after staging secrets and disposable smoke accounts are configured.

```bash
npm run staging:check
npm run staging:smoke
```

Mutation/provider/staging dry-run checks remain opt-in and require explicit approval, especially for transaction-create flows.

## API v1 Removal Gate

Do not remove `/v1` until all conditions are true:

1. Deprecation headers have shipped for the agreed observation window.
2. `npm run api-v1:usage-report -- <node-log-path>` shows zero external `/v1` usage, or every remaining caller has an approved migration plan.
3. `npm run api-v1:removal-readiness` has been reviewed and successor `/api/v2` paths are documented.
4. Rollback plan exists for restoring v1 routes if an external consumer is missed.

Recommended observation window: at least 30 days for production traffic unless the service owner explicitly approves a shorter window.
