# ADR-001 — SportsDash host isolation
Status: Proposed
Candidate: separate NestJS service with dedicated DB/schema, credentials, port, deploy config, backup and observability even when sharing SportsDash compute. Infrastructure survey must confirm available CPU/RAM, database, reverse proxy, backups and network access. Never reuse SportsDash app tables or secrets. Separate release paths and scoped credentials.
