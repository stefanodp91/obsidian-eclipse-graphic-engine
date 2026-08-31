# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting from the repository Security tab. Do not disclose a
vulnerability, credential, personal identifier, or private configuration in a public issue,
discussion, pull request, commit, or sample.

## Credentials and application configuration

This repository must contain no credentials or consumer configuration. Firebase project files,
service accounts, signing material, environment files, project identifiers, event taxonomies, and
user data belong to the consuming application and its protected CI environment.

Run `npm run check:sensitive` before every push. If a real credential is ever committed, revoke and
rotate it immediately; deleting a file or rewriting Git history does not invalidate the credential.
