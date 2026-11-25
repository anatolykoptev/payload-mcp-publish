.PHONY: preflight lint typecheck test build
PNPM ?= pnpm

# The full gate. CI runs this; locally run only the scoped tests (`pnpm test -- <file>`).
preflight: lint typecheck test build

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

test:
	$(PNPM) test

build:
	$(PNPM) build

