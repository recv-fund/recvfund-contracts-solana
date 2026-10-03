/*
 * One-time vendor setup after deploying the program: creates the Config PDA
 * with the fee collector and the fee rate. The signing keypair becomes the
 * fee authority (it can later call set_fee_terms and transfer_authority).
 *
 * These fee terms are copied into each merchant when it registers. Changing
 * them later with set_fee_terms affects only merchants registered after the
 * change.
 *
 * Environment:
 *   RPC_URL            cluster RPC endpoint
 *   AUTHORITY_KEYPAIR  path to the signing keypair file (becomes authority)
 *   FEE_COLLECTOR      base58 address that receives fees
 *   FEE_BPS            sweep fee in basis points, integer 0 to 200
 *
 * Usage: node scripts/init-config.cjs   (after `anchor build` has written
 * target/idl/recvfund.json). Prints the config account afterwards. If the
 * config already exists it only prints it.
 */
const fs = require('node:fs');
const path = require('node:path');
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'target', 'idl', 'recvfund.json'), 'utf8'),
  );
  const secret = JSON.parse(fs.readFileSync(need('AUTHORITY_KEYPAIR'), 'utf8'));
  const authority = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(need('RPC_URL'), 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), {
    commitment: 'confirmed',
  });
  const program = new anchor.Program(idl, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);

  const existing = await connection.getAccountInfo(configPda);
  if (!existing) {
    const feeCollector = new PublicKey(need('FEE_COLLECTOR'));
    const feeBps = Number(need('FEE_BPS'));
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 200) {
      throw new Error('FEE_BPS must be an integer from 0 to 200');
    }
    const signature = await program.methods
      .initializeConfig(feeCollector, feeBps)
      .accountsStrict({
        authority: authority.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('initialize_config signature', signature);
  } else {
    console.log('config already exists; not initializing');
  }

  const config = await program.account.globalConfig.fetch(configPda);
  const view = {};
  for (const [key, value] of Object.entries(config)) {
    view[key] = value && typeof value.toBase58 === 'function' ? value.toBase58() : String(value);
  }
  console.log('program', program.programId.toBase58());
  console.log('config  ', configPda.toBase58());
  console.log(JSON.stringify(view, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
