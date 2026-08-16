# Security policy

## Supported versions

This project does not yet publish versioned releases. Security fixes target the current `main`
branch and the current `latest` container image. Earlier commits and commit-addressed images do not
receive backported fixes.

## Report a vulnerability privately

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Use GitHub's private
[Report a vulnerability](https://github.com/DurantTL/overseerr-dm-bot/security/advisories/new)
form. Private vulnerability reporting is enabled for this repository and delivers the report to
the repository maintainers without disclosing it publicly.

Include enough information to reproduce and assess the issue:

- the affected route, command, component, or configuration;
- the expected and observed behavior;
- reproduction steps or a minimal proof of concept;
- the likely impact and any known prerequisites; and
- a suggested remediation, if you have one.

Never include real passwords, API keys, session cookies, tokens, private hostnames, personal data,
or production database contents. Use synthetic or redacted evidence.

Maintainers will triage the report, request additional details if needed, and coordinate remediation
and disclosure through the private advisory. Response and resolution times depend on severity and
maintainer availability; this project does not promise a service-level agreement or bug bounty.

For vulnerabilities in Plex, Seerr, Discord, GitHub, or another dependency or external service,
report directly to that project's security channel unless the problem is caused by this
repository's integration code or default configuration.
