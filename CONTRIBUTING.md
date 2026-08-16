# Contributing

Thanks for helping improve Durant Media Server Bot. This is a maintainer-led project; submitting a
change does not guarantee that it will be accepted or merged.

## Before starting

1. Search the issue tracker for existing work. Open an issue before a substantial feature,
   architecture change, migration, or security-sensitive behavior change.
2. Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md), never in a
   public issue or pull request.
3. Read [AGENTS.md](AGENTS.md) for the repository workflow and [CLAUDE.md](CLAUDE.md) for the
   architecture, commands, validation gates, and security invariants.
4. Keep one change focused on one issue or numbered issue packet. Preserve unrelated worktree
   changes.

## Development expectations

- Use Node.js 24 and CommonJS (`require` / `module.exports`).
- Match the existing JavaScript style: two-space indentation, semicolons, and descriptive
  camelCase names.
- Keep reusable services independent of Discord and pass dependencies explicitly.
- Add focused tests for behavior changes. Do not weaken authentication, authorization, rate
  limits, path checks, destructive-action guards, migration guarantees, scheduler overlap guards,
  or audit logging to make a test pass.
- Never commit secrets, tokens, credentials, private hostnames, personal data, production database
  contents, or unredacted operational evidence.
- Update README, `.env.example`, deployment guidance, and focused documentation when configuration
  or operator behavior changes.

Run the narrowest relevant test while iterating, then finish with:

```bash
npm test
npm run lint
```

Pull requests should explain the behavior changed, the files affected, the checks run, any skipped
verification, and remaining deployment or operator steps. Keep the diff cohesive and avoid
unrelated formatting or cleanup.

## License

The project is licensed under the [MIT License](LICENSE). Unless explicitly stated otherwise, any
contribution intentionally submitted for inclusion in this repository is provided under that same
license without additional terms or conditions.
