# Contributing

Thanks for helping. Bug reports, fixes and documentation are welcome; for a larger feature, open an issue first so the
shape can be agreed before you write it.

## Set up

Node `^22.23.5 || ^24.22.3 || >=26.13.1` and pnpm (the version is pinned in `package.json` as `packageManager`).

```sh
pnpm install
```

## Before you open a pull request

```sh
pnpm vitest run test/<file>   # the tests for the code you touched
make preflight                # lint, typecheck, test, build: the same gate CI runs
```

- **Tests.** Behaviour that would break silently (a guard, a digest, an access check) needs a test that fails when the
  production call site is reverted. The mutation table is in the header of `test/lane.int.spec.ts`; add your line to it.
  Docs and mechanical changes need none.
- **TypeScript stays on 6.x** in `devDependencies`: `@payloadcms/plugin-mcp` transpiles its tool schemas with it, and 7.x
  leaves every create/update tool without its field arguments.
- **Style.** Biome formats and lints (`pnpm lint:fix`). Edit files in their existing style.
- **Commits.** [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:`).
  release-please builds the changelog and the version from them.

## Reporting problems

Bugs and feature requests go to GitHub issues. A security problem does not: follow [SECURITY.md](SECURITY.md).

By contributing you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md), and that your contribution is licensed
under [Apache-2.0](LICENSE).
