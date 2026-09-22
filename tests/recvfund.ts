import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { createHash } from "crypto";
import { Recvfund } from "../target/types/recvfund";

const MAX_FEE_BPS = 200;
const FEE_BPS_CHECKOUT = 100; // 1%
const FEE_BPS_SWEEP = 50; // 0.5%

/** 32-byte identifier from a label; the server would use its own ids. */
function id32(label: string): number[] {
  return Array.from(createHash("sha256").update(label).digest());
}

describe("recvfund", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.recvfund as Program<Recvfund>;
  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  const feeCollector = Keypair.generate();
  const merchantAdmin = Keypair.generate();
  const sweeper = Keypair.generate();
  const settlementWallet = Keypair.generate();
  const payer = Keypair.generate();
  const outsider = Keypair.generate();

  const merchantId = id32("merchant-1");
  let mint: PublicKey;
  let payerAta: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [merchantPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merchant"), Buffer.from(merchantId)],
    program.programId
  );
  const invoicePda = (invoiceId: number[]) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchantPda.toBuffer(), Buffer.from(invoiceId)],
      program.programId
    )[0];
  const depositPda = (customerRef: number[]) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("deposit"),
        merchantPda.toBuffer(),
        Buffer.from(customerRef),
      ],
      program.programId
    )[0];
  const ata = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true);

  async function airdrop(pk: PublicKey, sol = 10) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function tokenBalance(address: PublicKey): Promise<bigint> {
    const info = await connection.getAccountInfo(address);
    if (!info) return 0n;
    return (await getAccount(connection, address)).amount;
  }

  /** Asserts that `p` rejects with the named Anchor error, or a raw message. */
  async function expectFailure(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (err: any) {
      const anchorCode = err?.error?.errorCode?.code;
      if (anchorCode !== undefined) {
        expect(anchorCode).to.equal(code);
        return;
      }
      expect(String(err), `expected error containing "${code}"`).to.include(
        code
      );
      return;
    }
    assert.fail(`expected failure with ${code}`);
  }

  /** `name` is camelCased: the program client converts IDL names, events included. */
  async function eventsOf(sig: string, name: string) {
    await connection.confirmTransaction(sig, "confirmed");
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);
    return [...parser.parseLogs(tx!.meta!.logMessages!)].filter(
      (e) => e.name === name
    );
  }

  const payAccounts = (invoiceId: number[], from: Keypair = payer) => ({
    payer: from.publicKey,
    config: configPda,
    merchant: merchantPda,
    invoice: invoicePda(invoiceId),
    mint,
    payerTokenAccount: ata(from.publicKey),
    settlementWallet: settlementWallet.publicKey,
    settlementTokenAccount: ata(settlementWallet.publicKey),
    feeCollector: feeCollector.publicKey,
    feeCollectorTokenAccount: ata(feeCollector.publicKey),
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const sweepTokenAccounts = (customerRef: number[], signer: PublicKey) => ({
    signer,
    config: configPda,
    merchant: merchantPda,
    depositAuthority: depositPda(customerRef),
    mint,
    depositTokenAccount: ata(depositPda(customerRef)),
    settlementWallet: settlementWallet.publicKey,
    settlementTokenAccount: ata(settlementWallet.publicKey),
    feeCollector: feeCollector.publicKey,
    feeCollectorTokenAccount: ata(feeCollector.publicKey),
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const sweepSolAccounts = (customerRef: number[], signer: PublicKey) => ({
    signer,
    config: configPda,
    merchant: merchantPda,
    depositAuthority: depositPda(customerRef),
    settlementWallet: settlementWallet.publicKey,
    feeCollector: feeCollector.publicKey,
    systemProgram: SystemProgram.programId,
  });

  before(async () => {
    await Promise.all(
      [
        feeCollector,
        merchantAdmin,
        sweeper,
        settlementWallet,
        payer,
        outsider,
      ].map((k) => airdrop(k.publicKey))
    );
    mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    payerAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
      )
    ).address;
    await mintTo(connection, authority, mint, payerAta, authority, 100_000_000);
    // An existing token account owned by someone else, used to try to redirect settlements.
    await getOrCreateAssociatedTokenAccount(
      connection,
      outsider,
      mint,
      outsider.publicKey
    );
  });

  describe("config", () => {
    it("rejects initialization with a fee above the cap", async () => {
      await expectFailure(
        program.methods
          .initializeConfig(
            feeCollector.publicKey,
            MAX_FEE_BPS + 1,
            FEE_BPS_SWEEP
          )
          .accountsStrict({
            authority: authority.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "FeeTooHigh"
      );
    });

    it("initializes with the signer as authority", async () => {
      await program.methods
        .initializeConfig(
          feeCollector.publicKey,
          FEE_BPS_CHECKOUT,
          FEE_BPS_SWEEP
        )
        .accountsStrict({
          authority: authority.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.authority.equals(authority.publicKey)).to.be.true;
      expect(cfg.feeCollector.equals(feeCollector.publicKey)).to.be.true;
      expect(cfg.feeBpsCheckout).to.equal(FEE_BPS_CHECKOUT);
      expect(cfg.feeBpsSweep).to.equal(FEE_BPS_SWEEP);
    });

    it("rejects set_fees above the cap and accepts the cap itself", async () => {
      const authorityOnly = {
        authority: authority.publicKey,
        config: configPda,
      };
      await expectFailure(
        program.methods
          .setFees(MAX_FEE_BPS, MAX_FEE_BPS + 1)
          .accountsStrict(authorityOnly)
          .rpc(),
        "FeeTooHigh"
      );
      await expectFailure(
        program.methods
          .setFees(MAX_FEE_BPS + 1, 0)
          .accountsStrict(authorityOnly)
          .rpc(),
        "FeeTooHigh"
      );
      await program.methods
        .setFees(MAX_FEE_BPS, MAX_FEE_BPS)
        .accountsStrict(authorityOnly)
        .rpc();
      let cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.feeBpsCheckout).to.equal(MAX_FEE_BPS);
      expect(cfg.feeBpsSweep).to.equal(MAX_FEE_BPS);
      // Restore the rates the rest of the suite assumes.
      await program.methods
        .setFees(FEE_BPS_CHECKOUT, FEE_BPS_SWEEP)
        .accountsStrict(authorityOnly)
        .rpc();
      cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.feeBpsCheckout).to.equal(FEE_BPS_CHECKOUT);
    });

    it("rejects authority-only setters from any other signer", async () => {
      const asOutsider = { authority: outsider.publicKey, config: configPda };
      await expectFailure(
        program.methods
          .setFees(0, 0)
          .accountsStrict(asOutsider)
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
      await expectFailure(
        program.methods
          .setFeeCollector(outsider.publicKey)
          .accountsStrict(asOutsider)
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
      await expectFailure(
        program.methods
          .transferAuthority(outsider.publicKey)
          .accountsStrict(asOutsider)
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("transfers authority and the old key loses access", async () => {
      const newAuthority = Keypair.generate();
      await airdrop(newAuthority.publicKey, 1);
      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({ authority: authority.publicKey, config: configPda })
        .rpc();
      await expectFailure(
        program.methods
          .setFees(0, 0)
          .accountsStrict({ authority: authority.publicKey, config: configPda })
          .rpc(),
        "Unauthorized"
      );
      await program.methods
        .transferAuthority(authority.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          config: configPda,
        })
        .signers([newAuthority])
        .rpc();
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.authority.equals(authority.publicKey)).to.be.true;
    });

    it("lets the authority change the fee collector", async () => {
      const tmp = Keypair.generate().publicKey;
      const authorityOnly = {
        authority: authority.publicKey,
        config: configPda,
      };
      await program.methods
        .setFeeCollector(tmp)
        .accountsStrict(authorityOnly)
        .rpc();
      expect(
        (
          await program.account.globalConfig.fetch(configPda)
        ).feeCollector.equals(tmp)
      ).to.be.true;
      await program.methods
        .setFeeCollector(feeCollector.publicKey)
        .accountsStrict(authorityOnly)
        .rpc();
    });
  });

  describe("merchant", () => {
    it("registers with the signer as admin and sweeper", async () => {
      await program.methods
        .registerMerchant(merchantId, settlementWallet.publicKey)
        .accountsStrict({
          admin: merchantAdmin.publicKey,
          merchant: merchantPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchantAdmin])
        .rpc();
      const m = await program.account.merchant.fetch(merchantPda);
      expect(m.merchantId).to.deep.equal(merchantId);
      expect(m.admin.equals(merchantAdmin.publicKey)).to.be.true;
      expect(m.sweeper.equals(merchantAdmin.publicKey)).to.be.true;
      expect(m.settlementWallet.equals(settlementWallet.publicKey)).to.be.true;
      expect(m.isActive).to.be.true;
    });

    it("rejects a second registration under the same id", async () => {
      await expectFailure(
        program.methods
          .registerMerchant(merchantId, outsider.publicKey)
          .accountsStrict({
            admin: outsider.publicKey,
            merchant: merchantPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([outsider])
          .rpc(),
        "already in use"
      );
    });

    it("rejects admin-only setters from the vendor authority and from strangers", async () => {
      for (const who of [outsider, authority]) {
        const asWho = { admin: who.publicKey, merchant: merchantPda };
        await expectFailure(
          program.methods
            .setSettlementWallet(who.publicKey)
            .accountsStrict(asWho)
            .signers([who])
            .rpc(),
          "Unauthorized"
        );
        await expectFailure(
          program.methods
            .setSweeper(who.publicKey)
            .accountsStrict(asWho)
            .signers([who])
            .rpc(),
          "Unauthorized"
        );
        await expectFailure(
          program.methods
            .setMerchantActive(false)
            .accountsStrict(asWho)
            .signers([who])
            .rpc(),
          "Unauthorized"
        );
      }
      const m = await program.account.merchant.fetch(merchantPda);
      expect(m.settlementWallet.equals(settlementWallet.publicKey)).to.be.true;
    });

    it("lets the admin change the settlement wallet", async () => {
      const asAdmin = { admin: merchantAdmin.publicKey, merchant: merchantPda };
      const tmp = Keypair.generate().publicKey;
      await program.methods
        .setSettlementWallet(tmp)
        .accountsStrict(asAdmin)
        .signers([merchantAdmin])
        .rpc();
      expect(
        (
          await program.account.merchant.fetch(merchantPda)
        ).settlementWallet.equals(tmp)
      ).to.be.true;
      await expectFailure(
        program.methods
          .setSettlementWallet(PublicKey.default)
          .accountsStrict(asAdmin)
          .signers([merchantAdmin])
          .rpc(),
        "InvalidSettlementWallet"
      );
      await program.methods
        .setSettlementWallet(settlementWallet.publicKey)
        .accountsStrict(asAdmin)
        .signers([merchantAdmin])
        .rpc();
    });

    it("lets the admin delegate sweeping", async () => {
      await program.methods
        .setSweeper(sweeper.publicKey)
        .accountsStrict({
          admin: merchantAdmin.publicKey,
          merchant: merchantPda,
        })
        .signers([merchantAdmin])
        .rpc();
      expect(
        (await program.account.merchant.fetch(merchantPda)).sweeper.equals(
          sweeper.publicKey
        )
      ).to.be.true;
    });
  });

  describe("pay", () => {
    const invoiceId = id32("invoice-1");
    const amount = 1_000_000n;
    const expectedFee = (amount * BigInt(FEE_BPS_CHECKOUT)) / 10_000n;

    it("splits the amount exactly, writes a receipt and emits PaymentReceived", async () => {
      const before = {
        payer: await tokenBalance(payerAta),
        settlement: await tokenBalance(ata(settlementWallet.publicKey)),
        collector: await tokenBalance(ata(feeCollector.publicKey)),
      };

      const sig = await program.methods
        .pay(invoiceId, new BN(amount.toString()))
        .accountsStrict(payAccounts(invoiceId))
        .signers([payer])
        .rpc();

      expect(await tokenBalance(payerAta)).to.equal(before.payer - amount);
      expect(await tokenBalance(ata(settlementWallet.publicKey))).to.equal(
        before.settlement + amount - expectedFee
      );
      expect(await tokenBalance(ata(feeCollector.publicKey))).to.equal(
        before.collector + expectedFee
      );
      expect(expectedFee).to.equal(10_000n);

      const inv = await program.account.invoice.fetch(invoicePda(invoiceId));
      expect(inv.merchant.equals(merchantPda)).to.be.true;
      expect(inv.invoiceId).to.deep.equal(invoiceId);
      expect(inv.mint.equals(mint)).to.be.true;
      expect(inv.payer.equals(payer.publicKey)).to.be.true;
      expect(inv.amount.toString()).to.equal(amount.toString());
      expect(inv.fee.toString()).to.equal(expectedFee.toString());
      expect(inv.paidAt.toNumber()).to.be.greaterThan(0);

      const [ev] = await eventsOf(sig, "paymentReceived");
      expect(ev, "PaymentReceived event").to.not.be.undefined;
      expect(ev.data.merchantId).to.deep.equal(merchantId);
      expect(ev.data.invoiceId).to.deep.equal(invoiceId);
      expect(ev.data.mint.equals(mint)).to.be.true;
      expect(ev.data.amount.toString()).to.equal(amount.toString());
      expect(ev.data.fee.toString()).to.equal(expectedFee.toString());
      expect(ev.data.payer.equals(payer.publicKey)).to.be.true;
    });

    it("rejects paying the same invoice twice", async () => {
      await expectFailure(
        program.methods
          .pay(invoiceId, new BN(1))
          .accountsStrict(payAccounts(invoiceId))
          .signers([payer])
          .rpc(),
        "already in use"
      );
    });

    it("rejects a zero amount", async () => {
      const other = id32("invoice-zero");
      await expectFailure(
        program.methods
          .pay(other, new BN(0))
          .accountsStrict(payAccounts(other))
          .signers([payer])
          .rpc(),
        "ZeroAmount"
      );
    });

    it("rejects payments to an inactive merchant", async () => {
      const asAdmin = { admin: merchantAdmin.publicKey, merchant: merchantPda };
      await program.methods
        .setMerchantActive(false)
        .accountsStrict(asAdmin)
        .signers([merchantAdmin])
        .rpc();
      const other = id32("invoice-inactive");
      await expectFailure(
        program.methods
          .pay(other, new BN(1000))
          .accountsStrict(payAccounts(other))
          .signers([payer])
          .rpc(),
        "MerchantInactive"
      );
      await program.methods
        .setMerchantActive(true)
        .accountsStrict(asAdmin)
        .signers([merchantAdmin])
        .rpc();
    });

    it("rejects a settlement token account that is not the registered wallet's ATA", async () => {
      const other = id32("invoice-wrong-dest");
      const accounts = payAccounts(other);
      accounts.settlementTokenAccount = ata(outsider.publicKey);
      await expectFailure(
        program.methods
          .pay(other, new BN(1000))
          .accountsStrict(accounts)
          .signers([payer])
          .rpc(),
        "ConstraintTokenOwner"
      );
      accounts.settlementTokenAccount = ata(settlementWallet.publicKey);
      accounts.feeCollectorTokenAccount = ata(outsider.publicKey);
      await expectFailure(
        program.methods
          .pay(other, new BN(1000))
          .accountsStrict(accounts)
          .signers([payer])
          .rpc(),
        "ConstraintTokenOwner"
      );
    });
  });

  describe("sweep_token", () => {
    const customerRef = id32("customer-1");
    const deposited = 500_000n;
    const expectedFee = (deposited * BigInt(FEE_BPS_SWEEP)) / 10_000n;

    before(async () => {
      // The deposit PDA is off-curve, so its ATA has to be created explicitly.
      const depositAta = await createAssociatedTokenAccount(
        connection,
        authority,
        mint,
        depositPda(customerRef),
        undefined,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        true
      );
      await mintTo(
        connection,
        authority,
        mint,
        depositAta,
        authority,
        Number(deposited)
      );
    });

    it("rejects a sweep from a stranger", async () => {
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(sweepTokenAccounts(customerRef, outsider.publicKey))
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
    });

    it("rejects a sweep from the vendor authority", async () => {
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(sweepTokenAccounts(customerRef, authority.publicKey))
          .rpc(),
        "Unauthorized"
      );
      expect(await tokenBalance(ata(depositPda(customerRef)))).to.equal(
        deposited
      );
    });

    it("rejects a sweep that names a different settlement token account", async () => {
      const accounts = sweepTokenAccounts(customerRef, sweeper.publicKey);
      accounts.settlementTokenAccount = ata(outsider.publicKey);
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(accounts)
          .signers([sweeper])
          .rpc(),
        "ConstraintTokenOwner"
      );
      // Swapping the wallet too: Anchor checks the init_if_needed ATA owner before the
      // `address` constraint, so this surfaces as the owner mismatch (sweep_sol covers
      // ConstraintAddress directly). Either way the transaction fails.
      accounts.settlementTokenAccount = ata(settlementWallet.publicKey);
      accounts.settlementWallet = outsider.publicKey;
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(accounts)
          .signers([sweeper])
          .rpc(),
        "ConstraintTokenOwner"
      );
    });

    it("moves the whole balance with the exact split and closes the deposit ATA", async () => {
      const depositAta = ata(depositPda(customerRef));
      const before = {
        settlement: await tokenBalance(ata(settlementWallet.publicKey)),
        collector: await tokenBalance(ata(feeCollector.publicKey)),
        sweeperLamports: await connection.getBalance(sweeper.publicKey),
        rent: (await connection.getAccountInfo(depositAta))!.lamports,
      };

      const sig = await program.methods
        .sweepToken(customerRef)
        .accountsStrict(sweepTokenAccounts(customerRef, sweeper.publicKey))
        .signers([sweeper])
        .rpc();

      expect(expectedFee).to.equal(2_500n);
      expect(await tokenBalance(ata(settlementWallet.publicKey))).to.equal(
        before.settlement + deposited - expectedFee
      );
      expect(await tokenBalance(ata(feeCollector.publicKey))).to.equal(
        before.collector + expectedFee
      );
      expect(await connection.getAccountInfo(depositAta), "deposit ATA closed")
        .to.be.null;
      // The provider wallet pays the tx fee, so the sweeper's balance changes only by the rent.
      expect(await connection.getBalance(sweeper.publicKey)).to.equal(
        before.sweeperLamports + before.rent
      );

      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev, "DepositSwept event").to.not.be.undefined;
      expect(ev.data.merchantId).to.deep.equal(merchantId);
      expect(ev.data.customerRef).to.deep.equal(customerRef);
      expect(ev.data.mint.equals(mint)).to.be.true;
      expect(ev.data.amount.toString()).to.equal(deposited.toString());
      expect(ev.data.fee.toString()).to.equal(expectedFee.toString());
    });

    it("rejects sweeping an empty deposit", async () => {
      const emptyRef = id32("customer-empty");
      await createAssociatedTokenAccount(
        connection,
        authority,
        mint,
        depositPda(emptyRef),
        undefined,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        true
      );
      await expectFailure(
        program.methods
          .sweepToken(emptyRef)
          .accountsStrict(sweepTokenAccounts(emptyRef, sweeper.publicKey))
          .signers([sweeper])
          .rpc(),
        "NothingToSweep"
      );
    });

    it("lets the admin sweep as well as the delegated sweeper", async () => {
      const ref = id32("customer-2");
      const depositAta = await createAssociatedTokenAccount(
        connection,
        authority,
        mint,
        depositPda(ref),
        undefined,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        true
      );
      await mintTo(connection, authority, mint, depositAta, authority, 10_000);
      const before = await tokenBalance(ata(settlementWallet.publicKey));
      await program.methods
        .sweepToken(ref)
        .accountsStrict(sweepTokenAccounts(ref, merchantAdmin.publicKey))
        .signers([merchantAdmin])
        .rpc();
      expect(await tokenBalance(ata(settlementWallet.publicKey))).to.equal(
        before + 9_950n
      );
    });
  });

  describe("sweep_sol", () => {
    const customerRef = id32("customer-sol");
    const deposited = BigInt(LAMPORTS_PER_SOL);
    const expectedFee = (deposited * BigInt(FEE_BPS_SWEEP)) / 10_000n;

    before(async () => {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: depositPda(customerRef),
          lamports: Number(deposited),
        })
      );
      await provider.sendAndConfirm(tx, [authority]);
      expect(await connection.getBalance(depositPda(customerRef))).to.equal(
        Number(deposited)
      );
    });

    it("rejects a sweep from the vendor authority", async () => {
      await expectFailure(
        program.methods
          .sweepSol(customerRef)
          .accountsStrict(sweepSolAccounts(customerRef, authority.publicKey))
          .rpc(),
        "Unauthorized"
      );
    });

    it("rejects a sweep whose destination is not the registered settlement wallet", async () => {
      const accounts = sweepSolAccounts(customerRef, sweeper.publicKey);
      accounts.settlementWallet = outsider.publicKey;
      await expectFailure(
        program.methods
          .sweepSol(customerRef)
          .accountsStrict(accounts)
          .signers([sweeper])
          .rpc(),
        "ConstraintAddress"
      );
      accounts.settlementWallet = settlementWallet.publicKey;
      accounts.feeCollector = outsider.publicKey;
      await expectFailure(
        program.methods
          .sweepSol(customerRef)
          .accountsStrict(accounts)
          .signers([sweeper])
          .rpc(),
        "ConstraintAddress"
      );
    });

    it("moves every lamport with the exact split", async () => {
      const before = {
        settlement: await connection.getBalance(settlementWallet.publicKey),
        collector: await connection.getBalance(feeCollector.publicKey),
      };
      const sig = await program.methods
        .sweepSol(customerRef)
        .accountsStrict(sweepSolAccounts(customerRef, sweeper.publicKey))
        .signers([sweeper])
        .rpc();

      expect(await connection.getBalance(depositPda(customerRef))).to.equal(0);
      expect(
        BigInt(await connection.getBalance(settlementWallet.publicKey))
      ).to.equal(BigInt(before.settlement) + deposited - expectedFee);
      expect(
        BigInt(await connection.getBalance(feeCollector.publicKey))
      ).to.equal(BigInt(before.collector) + expectedFee);

      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.mint.equals(PublicKey.default)).to.be.true;
      expect(ev.data.amount.toString()).to.equal(deposited.toString());
      expect(ev.data.fee.toString()).to.equal(expectedFee.toString());
    });

    it("rejects sweeping an empty deposit", async () => {
      await expectFailure(
        program.methods
          .sweepSol(customerRef)
          .accountsStrict(sweepSolAccounts(customerRef, sweeper.publicKey))
          .signers([sweeper])
          .rpc(),
        "NothingToSweep"
      );
    });
  });

  describe("no vendor path to merchant funds", () => {
    it("the IDL exposes no instruction that both requires the authority and touches token accounts", () => {
      const idl = program.idl as any;
      const authorityIxs = idl.instructions.filter((ix: any) =>
        ix.accounts.some((a: any) => a.name === "authority")
      );
      expect(authorityIxs.map((ix: any) => ix.name).sort()).to.deep.equal([
        "initializeConfig",
        "setFeeCollector",
        "setFees",
        "transferAuthority",
      ]);
      for (const ix of authorityIxs) {
        const names = ix.accounts.map((a: any) => a.name);
        expect(names).to.not.include("tokenProgram");
        expect(names).to.not.include("settlementWallet");
        expect(names).to.not.include("depositAuthority");
      }
    });
  });
});
