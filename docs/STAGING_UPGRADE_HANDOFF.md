# Solana staging upgrade handoff — 2026-10-05

The upgrade authority is on another developer's local machine. The requested
handoff is source on `staging`; CI never signs or upgrades a public program.
The live demo application was updated to 0.1.16, but the Solana program remains
on its previous binary. Deploying a server image does not apply these fixes.

## Reviewed candidate

- Public devnet program: `FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J`.
- Last inspected upgrade authority: `58tYVJZ3DadHLW7aA4gGAWNxS1dEkm6ifseFqZ4LyTcV`.
- Candidate source: `c81a3e29d9abe5334cad01483fcea3b9b56bd88b`.
- Binary: 375008 bytes; SHA-256
  `899bc7ca40f85f8f1ddf6daab799d60c1847cc5b66576b5079ca52f5b96ae3fd`.
- [Prepared archive and evidence](https://github.com/recv-fund/recvfund-contracts-solana/actions/runs/37350046035).
- [Independent security build](https://github.com/recv-fund/recvfund-contracts-solana/actions/runs/37350033503).

Both workflows passed 41 real-validator tests, five Rust unit tests, strict
Clippy, TypeScript, six release-tool regressions and all 260 dependency checks.
Two clean official-container builds and the independent workflow produced
identical binaries. Three reviewed dependency warnings remain documented in
`security/REVIEW-2026-10-05.md`; this is not an independent audit.

The fixes prevent unauthorized first configuration and collector ATA authority
changes from blocking token sweeps. Existing devnet initialization avoids the
first-initializer window; the old collector denial remains until upgrade.

## Developer execution order

1. Fetch `staging`; inspect the review and original candidate manifest. Download
   the prepared artifact from the run above and verify its binary and IDL hashes.
   Documentation-only commits after the candidate do not change its source hash.
2. On the machine holding the key, verify the signer's public address and current
   devnet ProgramData/authority. Load the key from its existing protected path;
   do not commit it, upload it to Actions, or paste it in chat.
3. Read and retain the currently deployed binary, ProgramData, config and merchant
   configuration before any change. Confirm the app's expected program address,
   retained account layouts and the candidate's initializer account changes.
4. Coordinate a testnet maintenance window. Pause affected payment creation and
   workers because the application's current supported provenance intentionally
   rejects an unrecognized program binary. Review the exact deploy/upgrade command
   with the authority operator, cluster, program ID and candidate hash visible.
5. The authority operator upgrades the verified artifact on **devnet only**.
   Do not revoke authority, change collectors/fees, initialize existing config,
   or deploy mainnet as part of this handoff.
6. Dump the deployed program and compare its candidate-length prefix byte for byte;
   require every remaining allocation byte to be zero. Recheck authority and
   config/merchant data, retaining transaction/slot/hash evidence.
7. In `recvfund-server`, promote the verified binary provenance and matching IDL
   together, updating canonical chain/API docs for any changed contract. The
   candidate fixture under `scripts/ci/fixtures/solana/candidate` is only a test
   overlay and must not silently become the production pin.
8. Run full application CI, then install the approved server release. Complete
   funded devnet registration/quote/deposit/confirmation/native+SPL sweep/payout,
   signed webhook and browser checkout acceptance on the installed instance.
   Record actual transaction IDs and destinations; HTTP health alone is insufficient.

Use the existing pinned toolchain and README deployment procedure. Do not guess
an authority path or issue an upgrade from an unrelated wallet. If any binary,
authority or account-layout check differs, stop promotion and investigate.

## Open gates

Authority-holder upgrade, deployed-byte proof, server provenance promotion and
funded devnet end-to-end acceptance are pending. Mainnet deployment requires its
own independent audit, authority/key governance and explicit release decision.
