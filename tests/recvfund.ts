import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
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
/** Terms in force when merchant 1 registers. */
const FEE_BPS_A = 50; // 0.5%
/** Terms set later; merchant 1 must keep FEE_BPS_A. */
const FEE_BPS_B = 120; // 1.2%

/** 32-byte identifier from a label; the server would use its own ids. */
function id32(label: string): number[] {
  return Array.from(createHash("sha256").update(label).digest());
}

function expectedFee(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

type TestMerchant = {
  id: number[];
  pda: PublicKey;
  admin: Keypair;
  sweeper: Keypair;
  settlement: Keypair;
};

describe("recvfund", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.recvfund as Program<Recvfund>;
  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  const collectorA = Keypair.generate();
  const collectorB = Keypair.generate();
  const outsider = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  function newMerchant(label: string): TestMerchant {
    const id = id32(label);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), Buffer.from(id)],
      program.programId
    );
    return {
      id,
      pda,
      admin: Keypair.generate(),
      sweeper: Keypair.generate(),
      settlement: Keypair.generate(),
    };
  }

  /** Registered under FEE_BPS_A / collectorA. */
  const m1 = newMerchant("merchant-1");
  /** Registered after the terms change to FEE_BPS_B / collectorB. */
  const m2 = newMerchant("merchant-2");
  /** Registered while the vendor rate is 0. */
  const m3 = newMerchant("merchant-zero-fee");

  let mint: PublicKey;

  const depositPda = (m: TestMerchant, customerRef: number[]) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), m.pda.toBuffer(), Buffer.from(customerRef)],
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

  async function lamports(address: PublicKey): Promise<bigint> {
    return BigInt(await connection.getBalance(address));
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

  const authorityOnly = (signer: PublicKey = authority.publicKey) => ({
    authority: signer,
    config: configPda,
  });

  const registerAccounts = (m: TestMerchant, admin = m.admin.publicKey) => ({
    admin,
    config: configPda,
    merchant: m.pda,
    systemProgram: SystemProgram.programId,
  });

  function register(m: TestMerchant) {
    return program.methods
      .registerMerchant(m.id, m.settlement.publicKey, m.sweeper.publicKey)
      .accountsStrict(registerAccounts(m))
      .signers([m.admin])
      .rpc();
  }

  const sweepTokenAccounts = (
    m: TestMerchant,
    customerRef: number[],
    signer: PublicKey,
    feeCollector: PublicKey
  ) => ({
    signer,
    merchant: m.pda,
    depositAuthority: depositPda(m, customerRef),
    mint,
    depositTokenAccount: ata(depositPda(m, customerRef)),
    settlementWallet: m.settlement.publicKey,
    settlementTokenAccount: ata(m.settlement.publicKey),
    feeCollector,
    feeCollectorTokenAccount: ata(feeCollector),
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const sweepSolAccounts = (
    m: TestMerchant,
    customerRef: number[],
    signer: PublicKey,
    feeCollector: PublicKey
  ) => ({
    signer,
    merchant: m.pda,
    depositAuthority: depositPda(m, customerRef),
    settlementWallet: m.settlement.publicKey,
    feeCollector,
    systemProgram: SystemProgram.programId,
  });

  function sweepToken(
    m: TestMerchant,
    customerRef: number[],
    feeCollector: PublicKey,
    signer: Keypair = m.sweeper
  ) {
    return program.methods
      .sweepToken(customerRef)
      .accountsStrict(
        sweepTokenAccounts(m, customerRef, signer.publicKey, feeCollector)
      )
      .signers([signer])
      .rpc();
  }

  function sweepSol(
    m: TestMerchant,
    customerRef: number[],
    feeCollector: PublicKey,
    signer: Keypair = m.sweeper
  ) {
    return program.methods
      .sweepSol(customerRef)
      .accountsStrict(
        sweepSolAccounts(m, customerRef, signer.publicKey, feeCollector)
      )
      .signers([signer])
      .rpc();
  }

  /**
   * A customer token deposit. The deposit PDA is off-curve, so its ATA is
   * created with allowOwnerOffCurve; an existing ATA is reused.
   */
  async function depositTokens(
    m: TestMerchant,
    customerRef: number[],
    amount: bigint
  ): Promise<PublicKey> {
    const account = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      depositPda(m, customerRef),
      true
    );
    await mintTo(
      connection,
      authority,
      mint,
      account.address,
      authority,
      amount
    );
    return account.address;
  }

  async function depositSol(
    m: TestMerchant,
    customerRef: number[],
    amount: bigint
  ) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: depositPda(m, customerRef),
        lamports: amount,
      })
    );
    await provider.sendAndConfirm(tx, [authority]);
  }

  before(async () => {
    const keys = [collectorA, collectorB, outsider];
    for (const m of [m1, m2, m3]) keys.push(m.admin, m.sweeper, m.settlement);
    await Promise.all(keys.map((k) => airdrop(k.publicKey)));
    mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    // An existing token account owned by someone else, used to try to redirect funds.
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
          .initializeConfig(collectorA.publicKey, MAX_FEE_BPS + 1)
          .accountsStrict({
            ...authorityOnly(),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "FeeTooHigh"
      );
    });

    it("rejects initialization with the default pubkey as fee collector", async () => {
      await expectFailure(
        program.methods
          .initializeConfig(PublicKey.default, FEE_BPS_A)
          .accountsStrict({
            ...authorityOnly(),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "InvalidFeeCollector"
      );
    });

    it("initializes with the signer as authority and emits FeeTermsUpdated", async () => {
      const sig = await program.methods
        .initializeConfig(collectorA.publicKey, FEE_BPS_A)
        .accountsStrict({
          ...authorityOnly(),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.authority.equals(authority.publicKey)).to.be.true;
      expect(cfg.feeCollector.equals(collectorA.publicKey)).to.be.true;
      expect(cfg.feeBps).to.equal(FEE_BPS_A);

      const [ev] = await eventsOf(sig, "feeTermsUpdated");
      expect(ev, "FeeTermsUpdated event").to.not.be.undefined;
      expect(ev.data.feeCollector.equals(collectorA.publicKey)).to.be.true;
      expect(ev.data.feeBps).to.equal(FEE_BPS_A);
    });

    it("rejects a second initialization", async () => {
      await expectFailure(
        program.methods
          .initializeConfig(outsider.publicKey, 0)
          .accountsStrict({
            ...authorityOnly(),
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "already in use"
      );
    });

    it("validates set_fee_terms: cap, default collector, and the cap itself is accepted", async () => {
      await expectFailure(
        program.methods
          .setFeeTerms(collectorA.publicKey, MAX_FEE_BPS + 1)
          .accountsStrict(authorityOnly())
          .rpc(),
        "FeeTooHigh"
      );
      await expectFailure(
        program.methods
          .setFeeTerms(PublicKey.default, FEE_BPS_A)
          .accountsStrict(authorityOnly())
          .rpc(),
        "InvalidFeeCollector"
      );
      const sig = await program.methods
        .setFeeTerms(collectorB.publicKey, MAX_FEE_BPS)
        .accountsStrict(authorityOnly())
        .rpc();
      let cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.feeBps).to.equal(MAX_FEE_BPS);
      expect(cfg.feeCollector.equals(collectorB.publicKey)).to.be.true;
      const [ev] = await eventsOf(sig, "feeTermsUpdated");
      expect(ev.data.feeCollector.equals(collectorB.publicKey)).to.be.true;
      expect(ev.data.feeBps).to.equal(MAX_FEE_BPS);

      // Restore the terms merchant 1 registers under.
      await program.methods
        .setFeeTerms(collectorA.publicKey, FEE_BPS_A)
        .accountsStrict(authorityOnly())
        .rpc();
      cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.feeBps).to.equal(FEE_BPS_A);
      expect(cfg.feeCollector.equals(collectorA.publicKey)).to.be.true;
    });

    it("rejects authority-only instructions from any other signer", async () => {
      await expectFailure(
        program.methods
          .setFeeTerms(outsider.publicKey, 0)
          .accountsStrict(authorityOnly(outsider.publicKey))
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
      await expectFailure(
        program.methods
          .transferAuthority(outsider.publicKey)
          .accountsStrict(authorityOnly(outsider.publicKey))
          .signers([outsider])
          .rpc(),
        "Unauthorized"
      );
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.authority.equals(authority.publicKey)).to.be.true;
      expect(cfg.feeCollector.equals(collectorA.publicKey)).to.be.true;
    });

    it("transfers authority and the old key loses access", async () => {
      const newAuthority = Keypair.generate();
      await airdrop(newAuthority.publicKey, 1);
      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict(authorityOnly())
        .rpc();
      await expectFailure(
        program.methods
          .setFeeTerms(collectorA.publicKey, 0)
          .accountsStrict(authorityOnly())
          .rpc(),
        "Unauthorized"
      );
      await program.methods
        .transferAuthority(authority.publicKey)
        .accountsStrict(authorityOnly(newAuthority.publicKey))
        .signers([newAuthority])
        .rpc();
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.authority.equals(authority.publicKey)).to.be.true;
    });
  });

  describe("register_merchant", () => {
    it("rejects the default pubkey as settlement wallet or sweeper", async () => {
      await expectFailure(
        program.methods
          .registerMerchant(m1.id, PublicKey.default, m1.sweeper.publicKey)
          .accountsStrict(registerAccounts(m1))
          .signers([m1.admin])
          .rpc(),
        "InvalidSettlementWallet"
      );
      await expectFailure(
        program.methods
          .registerMerchant(m1.id, m1.settlement.publicKey, PublicKey.default)
          .accountsStrict(registerAccounts(m1))
          .signers([m1.admin])
          .rpc(),
        "InvalidSweeper"
      );
      expect(await connection.getAccountInfo(m1.pda)).to.be.null;
    });

    it("registers in one instruction with sweeper and a snapshot of the fee terms", async () => {
      const sig = await register(m1);
      const m = await program.account.merchant.fetch(m1.pda);
      expect(m.merchantId).to.deep.equal(m1.id);
      expect(m.admin.equals(m1.admin.publicKey)).to.be.true;
      expect(m.sweeper.equals(m1.sweeper.publicKey)).to.be.true;
      expect(m.settlementWallet.equals(m1.settlement.publicKey)).to.be.true;
      expect(m.isActive).to.be.true;
      expect(m.feeCollector.equals(collectorA.publicKey)).to.be.true;
      expect(m.feeBps).to.equal(FEE_BPS_A);

      const [ev] = await eventsOf(sig, "merchantRegistered");
      expect(ev, "MerchantRegistered event").to.not.be.undefined;
      expect(ev.data.merchantId).to.deep.equal(m1.id);
      expect(ev.data.admin.equals(m1.admin.publicKey)).to.be.true;
      expect(ev.data.settlementWallet.equals(m1.settlement.publicKey)).to.be
        .true;
      expect(ev.data.sweeper.equals(m1.sweeper.publicKey)).to.be.true;
      expect(ev.data.feeCollector.equals(collectorA.publicKey)).to.be.true;
      expect(ev.data.feeBps).to.equal(FEE_BPS_A);
    });

    it("rejects a second registration under the same id", async () => {
      await expectFailure(
        program.methods
          .registerMerchant(m1.id, outsider.publicKey, outsider.publicKey)
          .accountsStrict(registerAccounts(m1, outsider.publicKey))
          .signers([outsider])
          .rpc(),
        "already in use"
      );
    });
  });

  describe("merchant admin setters", () => {
    it("reject the vendor authority and strangers", async () => {
      for (const who of [outsider, authority]) {
        const asWho = { admin: who.publicKey, merchant: m1.pda };
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
      const m = await program.account.merchant.fetch(m1.pda);
      expect(m.settlementWallet.equals(m1.settlement.publicKey)).to.be.true;
      expect(m.sweeper.equals(m1.sweeper.publicKey)).to.be.true;
      expect(m.isActive).to.be.true;
    });

    it("let the admin change the settlement wallet, sweeper and active flag", async () => {
      const asAdmin = { admin: m1.admin.publicKey, merchant: m1.pda };
      const tmp = Keypair.generate().publicKey;

      await program.methods
        .setSettlementWallet(tmp)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      expect(
        (await program.account.merchant.fetch(m1.pda)).settlementWallet.equals(
          tmp
        )
      ).to.be.true;
      await expectFailure(
        program.methods
          .setSettlementWallet(PublicKey.default)
          .accountsStrict(asAdmin)
          .signers([m1.admin])
          .rpc(),
        "InvalidSettlementWallet"
      );

      await program.methods
        .setSweeper(tmp)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      expect((await program.account.merchant.fetch(m1.pda)).sweeper.equals(tmp))
        .to.be.true;

      await program.methods
        .setMerchantActive(false)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      expect((await program.account.merchant.fetch(m1.pda)).isActive).to.be
        .false;

      // Restore, and confirm the fee terms were not touched by any setter.
      await program.methods
        .setSettlementWallet(m1.settlement.publicKey)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      await program.methods
        .setSweeper(m1.sweeper.publicKey)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      await program.methods
        .setMerchantActive(true)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      const m = await program.account.merchant.fetch(m1.pda);
      expect(m.settlementWallet.equals(m1.settlement.publicKey)).to.be.true;
      expect(m.sweeper.equals(m1.sweeper.publicKey)).to.be.true;
      expect(m.isActive).to.be.true;
      expect(m.feeCollector.equals(collectorA.publicKey)).to.be.true;
      expect(m.feeBps).to.equal(FEE_BPS_A);
    });
  });

  describe("sweep_token", () => {
    const customerRef = id32("customer-1");
    const deposited = 500_000n;

    before(async () => {
      await depositTokens(m1, customerRef, deposited);
    });

    it("rejects a sweep from a stranger or from the vendor authority", async () => {
      await expectFailure(
        sweepToken(m1, customerRef, collectorA.publicKey, outsider),
        "Unauthorized"
      );
      await expectFailure(
        sweepToken(m1, customerRef, collectorA.publicKey, authority),
        "Unauthorized"
      );
      expect(await tokenBalance(ata(depositPda(m1, customerRef)))).to.equal(
        deposited
      );
    });

    it("rejects a sweep that names a different settlement token account", async () => {
      const accounts = sweepTokenAccounts(
        m1,
        customerRef,
        m1.sweeper.publicKey,
        collectorA.publicKey
      );
      accounts.settlementTokenAccount = ata(outsider.publicKey);
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(accounts)
          .signers([m1.sweeper])
          .rpc(),
        "ConstraintTokenOwner"
      );
      // Swapping the wallet too, so that the token account is a valid ATA of
      // the named wallet: the `address` pin on the wallet rejects it.
      accounts.settlementWallet = outsider.publicKey;
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(accounts)
          .signers([m1.sweeper])
          .rpc(),
        "ConstraintAddress"
      );
    });

    it("rejects a sweep with a fee collector other than the merchant's", async () => {
      // A different collector together with its own ATA: the `address` check fails.
      await expectFailure(
        sweepToken(m1, customerRef, outsider.publicKey),
        "ConstraintAddress"
      );
      // The merchant's collector but someone else's token account.
      const accounts = sweepTokenAccounts(
        m1,
        customerRef,
        m1.sweeper.publicKey,
        collectorA.publicKey
      );
      accounts.feeCollectorTokenAccount = ata(outsider.publicKey);
      await expectFailure(
        program.methods
          .sweepToken(customerRef)
          .accountsStrict(accounts)
          .signers([m1.sweeper])
          .rpc(),
        "ConstraintTokenOwner"
      );
      expect(await tokenBalance(ata(depositPda(m1, customerRef)))).to.equal(
        deposited
      );
    });

    it("moves the whole balance with the exact split, closes the deposit ATA and emits DepositSwept", async () => {
      const depositAta = ata(depositPda(m1, customerRef));
      const fee = expectedFee(deposited, FEE_BPS_A);
      expect(fee).to.equal(2_500n);
      const before = {
        settlement: await tokenBalance(ata(m1.settlement.publicKey)),
        collector: await tokenBalance(ata(collectorA.publicKey)),
        sweeperLamports: await lamports(m1.sweeper.publicKey),
        rent: BigInt((await connection.getAccountInfo(depositAta))!.lamports),
        destinationAtas: await Promise.all(
          [m1.settlement.publicKey, collectorA.publicKey].map((o) =>
            connection.getAccountInfo(ata(o))
          )
        ),
      };
      expect(before.destinationAtas.every((a) => a === null)).to.be.true;

      const sig = await sweepToken(m1, customerRef, collectorA.publicKey);

      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before.settlement + deposited - fee
      );
      expect(await tokenBalance(ata(collectorA.publicKey))).to.equal(
        before.collector + fee
      );
      expect(await connection.getAccountInfo(depositAta), "deposit ATA closed")
        .to.be.null;
      // The sweeper paid rent for the two destination ATAs it created and got
      // back the rent of the closed deposit ATA (all ATAs have the same size).
      // The provider wallet pays the transaction fee.
      expect(await lamports(m1.sweeper.publicKey)).to.equal(
        before.sweeperLamports - before.rent
      );

      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev, "DepositSwept event").to.not.be.undefined;
      expect(ev.data.merchantId).to.deep.equal(m1.id);
      expect(ev.data.customerRef).to.deep.equal(customerRef);
      expect(ev.data.mint.equals(mint)).to.be.true;
      expect(ev.data.amount.toString()).to.equal(deposited.toString());
      expect(ev.data.fee.toString()).to.equal(fee.toString());
    });

    it("recreates the ATA for a later deposit, sums repeated deposits, and returns the rent to the sweeper", async () => {
      const depositAta = ata(depositPda(m1, customerRef));
      const first = 100_000n;
      const second = 200_001n;
      const recreated = await depositTokens(m1, customerRef, first);
      expect(recreated.equals(depositAta), "same ATA address").to.be.true;
      await depositTokens(m1, customerRef, second);
      const total = first + second;
      expect(await tokenBalance(depositAta)).to.equal(total);

      const fee = expectedFee(total, FEE_BPS_A);
      expect(fee).to.equal(1_500n); // 300_001 * 50 / 10_000 = 1500.005, rounded down
      const before = {
        settlement: await tokenBalance(ata(m1.settlement.publicKey)),
        collector: await tokenBalance(ata(collectorA.publicKey)),
        sweeperLamports: await lamports(m1.sweeper.publicKey),
        rent: BigInt((await connection.getAccountInfo(depositAta))!.lamports),
      };
      const sig = await sweepToken(m1, customerRef, collectorA.publicKey);
      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before.settlement + total - fee
      );
      expect(await tokenBalance(ata(collectorA.publicKey))).to.equal(
        before.collector + fee
      );
      expect(await connection.getAccountInfo(depositAta)).to.be.null;
      // Destination ATAs exist now, so the sweeper only receives the rent back.
      expect(await lamports(m1.sweeper.publicKey)).to.equal(
        before.sweeperLamports + before.rent
      );
      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.amount.toString()).to.equal(total.toString());
      expect(ev.data.fee.toString()).to.equal(fee.toString());
    });

    it("rounds a fee below one unit down to zero and skips the fee transfer", async () => {
      const ref = id32("customer-small");
      const amount = 199n; // 199 * 50 / 10_000 = 0.995
      await depositTokens(m1, ref, amount);
      const before = {
        settlement: await tokenBalance(ata(m1.settlement.publicKey)),
        collector: await tokenBalance(ata(collectorA.publicKey)),
      };
      const sig = await sweepToken(m1, ref, collectorA.publicKey);
      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before.settlement + amount
      );
      expect(await tokenBalance(ata(collectorA.publicKey))).to.equal(
        before.collector
      );
      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.fee.toString()).to.equal("0");
    });

    it("rejects sweeping an empty deposit", async () => {
      const emptyRef = id32("customer-empty");
      await depositTokens(m1, emptyRef, 0n);
      await expectFailure(
        sweepToken(m1, emptyRef, collectorA.publicKey),
        "NothingToSweep"
      );
    });

    it("lets the admin sweep as well as the sweeper", async () => {
      const ref = id32("customer-2");
      await depositTokens(m1, ref, 10_000n);
      const before = await tokenBalance(ata(m1.settlement.publicKey));
      await sweepToken(m1, ref, collectorA.publicKey, m1.admin);
      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before + 9_950n
      );
    });

    it("still sweeps while the merchant is inactive", async () => {
      const asAdmin = { admin: m1.admin.publicKey, merchant: m1.pda };
      await program.methods
        .setMerchantActive(false)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      const ref = id32("customer-inactive");
      await depositTokens(m1, ref, 40_000n);
      const before = await tokenBalance(ata(m1.settlement.publicKey));
      await sweepToken(m1, ref, collectorA.publicKey);
      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before + 40_000n - expectedFee(40_000n, FEE_BPS_A)
      );
      await program.methods
        .setMerchantActive(true)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
    });
  });

  describe("sweep_sol", () => {
    const customerRef = id32("customer-sol");
    const deposited = BigInt(LAMPORTS_PER_SOL);

    before(async () => {
      await depositSol(m1, customerRef, deposited);
      expect(await lamports(depositPda(m1, customerRef))).to.equal(deposited);
    });

    it("rejects a sweep from a stranger or from the vendor authority", async () => {
      await expectFailure(
        sweepSol(m1, customerRef, collectorA.publicKey, outsider),
        "Unauthorized"
      );
      await expectFailure(
        sweepSol(m1, customerRef, collectorA.publicKey, authority),
        "Unauthorized"
      );
    });

    it("rejects a destination other than the registered settlement wallet", async () => {
      const accounts = sweepSolAccounts(
        m1,
        customerRef,
        m1.sweeper.publicKey,
        collectorA.publicKey
      );
      accounts.settlementWallet = outsider.publicKey;
      await expectFailure(
        program.methods
          .sweepSol(customerRef)
          .accountsStrict(accounts)
          .signers([m1.sweeper])
          .rpc(),
        "ConstraintAddress"
      );
    });

    it("rejects a fee collector other than the merchant's", async () => {
      await expectFailure(
        sweepSol(m1, customerRef, outsider.publicKey),
        "ConstraintAddress"
      );
      expect(await lamports(depositPda(m1, customerRef))).to.equal(deposited);
    });

    it("moves every lamport with the exact split", async () => {
      const fee = expectedFee(deposited, FEE_BPS_A);
      const before = {
        settlement: await lamports(m1.settlement.publicKey),
        collector: await lamports(collectorA.publicKey),
      };
      const sig = await sweepSol(m1, customerRef, collectorA.publicKey);

      expect(await lamports(depositPda(m1, customerRef))).to.equal(0n);
      expect(await lamports(m1.settlement.publicKey)).to.equal(
        before.settlement + deposited - fee
      );
      expect(await lamports(collectorA.publicKey)).to.equal(
        before.collector + fee
      );

      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.merchantId).to.deep.equal(m1.id);
      expect(ev.data.customerRef).to.deep.equal(customerRef);
      expect(ev.data.mint.equals(PublicKey.default)).to.be.true;
      expect(ev.data.amount.toString()).to.equal(deposited.toString());
      expect(ev.data.fee.toString()).to.equal(fee.toString());
    });

    it("rejects sweeping an empty deposit", async () => {
      await expectFailure(
        sweepSol(m1, customerRef, collectorA.publicKey),
        "NothingToSweep"
      );
    });

    it("sums repeated deposits to one address and rounds the fee down", async () => {
      const first = BigInt(LAMPORTS_PER_SOL);
      const second = 199n;
      await depositSol(m1, customerRef, first);
      await depositSol(m1, customerRef, second);
      const total = first + second;
      const fee = expectedFee(total, FEE_BPS_A);
      expect(fee).to.equal(5_000_000n); // 1_000_000_199 * 50 / 10_000 = 5_000_000.995
      const before = {
        settlement: await lamports(m1.settlement.publicKey),
        collector: await lamports(collectorA.publicKey),
      };
      const sig = await sweepSol(m1, customerRef, collectorA.publicKey);
      expect(await lamports(depositPda(m1, customerRef))).to.equal(0n);
      expect(await lamports(m1.settlement.publicKey)).to.equal(
        before.settlement + total - fee
      );
      expect(await lamports(collectorA.publicKey)).to.equal(
        before.collector + fee
      );
      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.amount.toString()).to.equal(total.toString());
    });

    it("still sweeps while the merchant is inactive, signed by the admin", async () => {
      const asAdmin = { admin: m1.admin.publicKey, merchant: m1.pda };
      await program.methods
        .setMerchantActive(false)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
      const ref = id32("customer-sol-inactive");
      const amount = BigInt(LAMPORTS_PER_SOL / 2);
      await depositSol(m1, ref, amount);
      const before = await lamports(m1.settlement.publicKey);
      await sweepSol(m1, ref, collectorA.publicKey, m1.admin);
      expect(await lamports(m1.settlement.publicKey)).to.equal(
        before + amount - expectedFee(amount, FEE_BPS_A)
      );
      await program.methods
        .setMerchantActive(true)
        .accountsStrict(asAdmin)
        .signers([m1.admin])
        .rpc();
    });
  });

  describe("fee terms are fixed per merchant", () => {
    const tokenRef = id32("customer-after-change");
    const solRef = id32("customer-sol-after-change");

    it("set_fee_terms changes the config but not an already registered merchant", async () => {
      const merchantBefore = await program.account.merchant.fetch(m1.pda);
      await program.methods
        .setFeeTerms(collectorB.publicKey, FEE_BPS_B)
        .accountsStrict(authorityOnly())
        .rpc();
      const cfg = await program.account.globalConfig.fetch(configPda);
      expect(cfg.feeCollector.equals(collectorB.publicKey)).to.be.true;
      expect(cfg.feeBps).to.equal(FEE_BPS_B);

      const merchantAfter = await program.account.merchant.fetch(m1.pda);
      expect(merchantAfter.feeCollector.equals(collectorA.publicKey)).to.be
        .true;
      expect(merchantAfter.feeBps).to.equal(FEE_BPS_A);
      expect(merchantAfter).to.deep.equal(merchantBefore);
    });

    it("sweeps for the earlier merchant still use its registered terms", async () => {
      const amount = 1_000_000n;
      await depositTokens(m1, tokenRef, amount);
      await depositSol(m1, solRef, BigInt(LAMPORTS_PER_SOL));

      // The vendor's current collector is not this merchant's collector.
      await expectFailure(
        sweepToken(m1, tokenRef, collectorB.publicKey),
        "ConstraintAddress"
      );
      await expectFailure(
        sweepSol(m1, solRef, collectorB.publicKey),
        "ConstraintAddress"
      );

      const before = {
        settlement: await tokenBalance(ata(m1.settlement.publicKey)),
        collectorA: await tokenBalance(ata(collectorA.publicKey)),
        collectorBLamports: await lamports(collectorB.publicKey),
        collectorALamports: await lamports(collectorA.publicKey),
      };
      const sig = await sweepToken(m1, tokenRef, collectorA.publicKey);
      const fee = expectedFee(amount, FEE_BPS_A);
      expect(fee).to.equal(5_000n);
      expect(await tokenBalance(ata(m1.settlement.publicKey))).to.equal(
        before.settlement + amount - fee
      );
      expect(await tokenBalance(ata(collectorA.publicKey))).to.equal(
        before.collectorA + fee
      );
      expect(await tokenBalance(ata(collectorB.publicKey))).to.equal(0n);
      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.fee.toString()).to.equal(fee.toString());

      await sweepSol(m1, solRef, collectorA.publicKey);
      expect(await lamports(collectorA.publicKey)).to.equal(
        before.collectorALamports +
          expectedFee(BigInt(LAMPORTS_PER_SOL), FEE_BPS_A)
      );
      expect(await lamports(collectorB.publicKey)).to.equal(
        before.collectorBLamports
      );
    });

    it("a merchant registered after the change gets the new terms", async () => {
      const sig = await register(m2);
      const m = await program.account.merchant.fetch(m2.pda);
      expect(m.feeCollector.equals(collectorB.publicKey)).to.be.true;
      expect(m.feeBps).to.equal(FEE_BPS_B);
      const [ev] = await eventsOf(sig, "merchantRegistered");
      expect(ev.data.feeCollector.equals(collectorB.publicKey)).to.be.true;
      expect(ev.data.feeBps).to.equal(FEE_BPS_B);

      const amount = 1_000_000n;
      await depositTokens(m2, tokenRef, amount);
      await expectFailure(
        sweepToken(m2, tokenRef, collectorA.publicKey),
        "ConstraintAddress"
      );
      await sweepToken(m2, tokenRef, collectorB.publicKey);
      const fee = expectedFee(amount, FEE_BPS_B);
      expect(fee).to.equal(12_000n);
      expect(await tokenBalance(ata(m2.settlement.publicKey))).to.equal(
        amount - fee
      );
      expect(await tokenBalance(ata(collectorB.publicKey))).to.equal(fee);

      await depositSol(m2, solRef, BigInt(LAMPORTS_PER_SOL));
      const before = await lamports(collectorB.publicKey);
      await sweepSol(m2, solRef, collectorB.publicKey);
      expect(await lamports(collectorB.publicKey)).to.equal(
        before + expectedFee(BigInt(LAMPORTS_PER_SOL), FEE_BPS_B)
      );
    });

    it("a merchant registered at a zero rate pays no fee on token or SOL sweeps", async () => {
      await program.methods
        .setFeeTerms(collectorB.publicKey, 0)
        .accountsStrict(authorityOnly())
        .rpc();
      await register(m3);
      const m = await program.account.merchant.fetch(m3.pda);
      expect(m.feeBps).to.equal(0);
      expect(m.feeCollector.equals(collectorB.publicKey)).to.be.true;

      const amount = 123_456_789n;
      await depositTokens(m3, tokenRef, amount);
      const collectorTokens = await tokenBalance(ata(collectorB.publicKey));
      const sig = await sweepToken(m3, tokenRef, collectorB.publicKey);
      expect(await tokenBalance(ata(m3.settlement.publicKey))).to.equal(amount);
      expect(await tokenBalance(ata(collectorB.publicKey))).to.equal(
        collectorTokens
      );
      const [ev] = await eventsOf(sig, "depositSwept");
      expect(ev.data.fee.toString()).to.equal("0");

      const lamportsIn = BigInt(LAMPORTS_PER_SOL);
      await depositSol(m3, solRef, lamportsIn);
      const before = {
        settlement: await lamports(m3.settlement.publicKey),
        collector: await lamports(collectorB.publicKey),
      };
      await sweepSol(m3, solRef, collectorB.publicKey);
      expect(await lamports(m3.settlement.publicKey)).to.equal(
        before.settlement + lamportsIn
      );
      expect(await lamports(collectorB.publicKey)).to.equal(before.collector);
    });
  });

  describe("no vendor path to merchant funds", () => {
    const idl = program.idl as any;

    it("the instruction set has no checkout path", () => {
      expect(idl.instructions.map((ix: any) => ix.name).sort()).to.deep.equal([
        "initializeConfig",
        "registerMerchant",
        "setFeeTerms",
        "setMerchantActive",
        "setSettlementWallet",
        "setSweeper",
        "sweepSol",
        "sweepToken",
        "transferAuthority",
      ]);
    });

    it("authority-gated instructions touch no merchant, token account or deposit address", () => {
      const authorityIxs = idl.instructions.filter((ix: any) =>
        ix.accounts.some((a: any) => a.name === "authority")
      );
      expect(authorityIxs.map((ix: any) => ix.name).sort()).to.deep.equal([
        "initializeConfig",
        "setFeeTerms",
        "transferAuthority",
      ]);
      for (const ix of authorityIxs) {
        const names = ix.accounts.map((a: any) => a.name);
        for (const forbidden of [
          "merchant",
          "tokenProgram",
          "settlementWallet",
          "depositAuthority",
        ]) {
          expect(names, `${ix.name} accounts`).to.not.include(forbidden);
        }
      }
    });

    it("sweeps do not read the vendor config", () => {
      for (const name of ["sweepToken", "sweepSol"]) {
        const ix = idl.instructions.find((i: any) => i.name === name);
        expect(ix.accounts.map((a: any) => a.name)).to.not.include("config");
      }
    });
  });
});
