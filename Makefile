.PHONY: dev-verify-setup dev-verify-up dev-verify-seed dev-verify-test dev-verify-reset dev-verify-down dev-verify-purge dev-verify-status

dev-verify-setup:
	npm run dev-verify -- setup

dev-verify-up:
	npm run dev-verify -- up

dev-verify-seed:
	npm run dev-verify -- seed

dev-verify-test:
	npm run dev-verify -- test

dev-verify-reset:
	npm run dev-verify -- reset

dev-verify-down:
	npm run dev-verify -- down

dev-verify-purge:
	npm run dev-verify -- purge

dev-verify-status:
	npm run dev-verify -- status
