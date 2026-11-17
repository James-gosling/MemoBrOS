# ADR 0001 — Hybrid, encrypted storage for ARVI / MemoBrOS

- **Status:** Accepted for MVP architecture — implementation pending security review and local acceptance.
- **Accepted by the owner on 2026-11-17, for the architecture only:** private GitHub for approved code and
  documentation; Google Drive as the intended encrypted backup destination; restic plus rclone as the preferred
  implementation; Ubuntu as the local execution environment and operational source of truth; an optional
  independent disaster-recovery copy, **provider undecided** (neither Backblaze B2 nor Cloudflare R2 is chosen).
- **Not authorised by this acceptance:** production uploads; real Google Drive OAuth configuration; deleting or
  moving local files; automated retention; backup scheduling; cloud billing; merging pull requests; production
  deployment. Nothing here is deployed.
- **Date:** 2026-11-17.
- **Context document:** `arvi-hybrid-storage-v0.7.md`. **Procedure:** `storage-runbook.md`.

## Context

ARVI keeps its private runtime data (settings, memory, routines, and soon task records) only on one Ubuntu laptop
whose disk is nearly full. The code lives on GitHub. The owner has Google Drive. The goals are durability and
recoverability of the private data without a second live copy of everything, without new infrastructure to run,
and at the lowest possible cost; and less pressure on the local disk.

Two findings shaped the decision:

1. The private data worth protecting is small (megabytes). The disk is filled by things that can be re-created:
   dependencies (about 0.5 GB per worktree), build outputs (about 0.46 GB per build), package caches and speech
   models. Those do not belong in any cloud tier.
2. restic with rclone performs client-side authenticated encryption, deduplication, snapshots and verification,
   and reaches Google Drive and S3-compatible storage with the same repository format. A proof of concept on
   synthetic data passed 12 backup and restore scenarios with the real tools.

## Decision

1. **GitHub (private repository) is the source of truth for approved code, documents, contracts, templates and
   their history, and for nothing else.** No runtime data, no secrets, no backup archives, no models. Git LFS is
   not adopted: there is no versioned binary asset that needs it today.
2. **The laptop's profile folder is the truth for private runtime data.** All task state is written there first
   and never waits for a network.
3. **Google Drive holds encrypted, versioned backups of that data**, made with restic through rclone, one way,
   as snapshots. Drive is never mounted as a working folder and never holds worktrees, `node_modules`, a live
   database or an agent's working directory.
4. **One encryption layer: restic's.** No rclone crypt in the MVP.
5. **A third provider is optional and small:** a second restic repository, with its own password and its own
   credentials, holding only the critical sets. It is added when the owner wants protection against losing the
   Google account, not before.
6. **No synchronisation, no consensus, no always-on service.** Backups run when asked (later: on a schedule),
   and a restore is an explicit act into an empty folder.
7. **Durability is claimed only after a read-back** (`check --read-data` plus a restore whose file hashes match).
8. **Local space is freed only from reconstructable caches, or from data with a verified backup and the owner's
   approval per category.** Never automatically, never the owner's own files.

## Roles compared

| | GitHub | Google Drive | Independent object storage | Local disk |
| --- | --- | --- | --- | --- |
| Role | Source of truth for code and documents | Primary encrypted archive | Independent recovery copy (optional) | Operational truth; caches |
| Holds | Source, history, ADRs, contracts, CI | restic repository: settings, memory, routines, task records, approved extras | A second restic repository: critical sets only | Profile, worktrees, runtime, models in use |
| Must never hold | Secrets, runtime data, archives, models, caches | Anything unencrypted from the profile; working folders | The same | A second copy of the backups |
| Encryption | None needed if nothing private is committed | restic, client side | restic, client side, different password | Disk encryption is the owner's (unverified) |
| Failure it covers | Loss of the laptop's code | Loss of the laptop's private data | Loss of the Google account, or a damaged Drive repository | — |
| Failure it does not cover | Unpushed commits | Loss of both the laptop and every key | The same | Everything |

## Third-provider comparison

Figures were taken on 2026-11-17 from search results limited to each vendor's own domain; the pages themselves
could not be opened from the session that wrote this. **Confirm every figure on the live page before relying on
it.** "Unverified" means no official statement was found.

| | Backblaze B2 | Cloudflare R2 |
| --- | --- | --- |
| Storage price | $6.95 per TB per month, pay as you go (pricing page) | $0.015 per GB-month Standard; $0.01 Infrequent Access (R2 pricing) |
| Free allowance | "First 10 GB free" appears in a Backblaze blog post; **not confirmed as current** | 10 GB-month, 1 million Class A and 10 million Class B operations per month; Standard class only |
| Operation costs | Not found in the results; **unverified** | Class A $4.50 per million, Class B $0.36 per million (Standard); billed in whole millions |
| Egress | Free up to 3× the stored amount, then $0.01 per GB | Free |
| Minimums | Pricing page says no minimum file size or storage duration fees | Infrequent Access has a retrieval fee ($0.01 per GB); minimum duration **unverified** |
| S3 compatibility | Yes. restic's documentation recommends B2's S3-compatible API over the native B2 backend | Yes (S3 API) |
| restic / rclone | Both | Both (as S3) |
| Client-side encryption | restic, unchanged | restic, unchanged |
| Lifecycle note | restic's documentation: B2 keeps old file versions as hidden files by default; set the lifecycle rule "keep only the last version" | **Unverified** |
| Upload-only credentials (ransomware defence) | **Unverified**; to check before choosing | **Unverified**; to check before choosing |
| Payment method required to start | **Unverified** | **Unverified** |
| Region and jurisdiction choice | **Unverified** | **Unverified** |
| Lock-in | Low: a restic repository can be copied to another backend with `restic copy` or `rclone` | Low, same reason |

For the size in question (critical sets of well under 1 GB, a few uploads a day), both cost cents per month or
nothing; the price is not what decides. What decides: whether the owner already has an account with one of them,
whether an upload-only key exists (to be checked), and where the data should physically be. **No recommendation
between the two is made until those three are answered.** Other providers were not evaluated: nothing in the
evidence gathered supports adding one.

Google account storage, for sizing: Google's help states that each account includes 15 GB shared across Gmail,
Drive and Photos. The backup repository counts against it; how much of it the owner has free is unknown.

GitHub, for completeness: GitHub's documentation states that files over 100 MiB are blocked without Git LFS, and
lists 10 GiB of LFS storage and of monthly bandwidth for GitHub Free. Not used by this decision.

## Consequences

- Recovery of private data becomes possible after loss of the laptop, with one condition the owner must accept:
  **the recovery key is theirs to keep, and losing it is final.**
- The laptop's disk pressure is addressed by removing reconstructable data, not by this storage design.
- One new dependency on the laptop: restic and rclone, as packages. No service runs permanently.
- Until a sandbox or an upload-only credential exists, a compromised process running as the user could delete the
  Drive repository. The optional third copy is the mitigation.
- Each device is its own island of sets. A future multi-device ARVI needs a new decision.

## Alternatives rejected

- **Drive as a mounted working folder or a synchronised profile.** Conflicts, partial writes, a live database on
  a network file system, and the provider becoming part of every state transition.
- **Private GitHub repository for runtime data or archives.** Not encrypted, history is permanent, wrong tool.
- **Two full live copies on two clouds, kept in step.** Cost and complexity without a matching risk.
- **rclone crypt under restic.** A second key to lose; no added protection.
- **A custom encrypted format or protocol.** restic exists, is documented and is widely used.
- **A VPS or an always-on backup agent.** Running cost and one more thing to secure.
