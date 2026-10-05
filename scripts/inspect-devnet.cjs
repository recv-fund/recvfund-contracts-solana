/* Read-only release preparation. No wallet, signer or transaction is loaded. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const {Connection, PublicKey} = require('@solana/web3.js');
const PROGRAM = new PublicKey('FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
(async () => {
  const connection = new Connection('https://api.devnet.solana.com', 'finalized');
  const program = await connection.getAccountInfo(PROGRAM);
  if (!program?.executable || !program.owner.equals(LOADER) || program.data.readUInt32LE(0) !== 2) {
    throw new Error('Unexpected program/loader account');
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const expected = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
  if (!programData.equals(expected)) throw new Error('Unexpected ProgramData address');
  const data = await connection.getAccountInfo(programData);
  if (!data?.owner.equals(LOADER) || data.data.readUInt32LE(0) !== 3) throw new Error('Invalid ProgramData');
  const body = data.data.subarray(45);
  const manifestPath = process.argv[2];
  const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const candidate = manifest?.files['recvfund.so'];
  const matches = candidate ? body.length >= candidate.byteLength &&
    crypto.createHash('sha256').update(body.subarray(0, candidate.byteLength)).digest('hex') === candidate.sha256 &&
    body.subarray(candidate.byteLength).every(byte => byte === 0) : false;
  const output = {
    cluster: 'devnet', programId: PROGRAM.toBase58(), programData: programData.toBase58(),
    observedAt: new Date().toISOString(), lastDeploySlot: data.data.readBigUInt64LE(4).toString(),
    upgradeAuthority: data.data[12] ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null,
    programDataBytes: body.length, candidateMatchesDeployed: matches,
    candidateSourceCommit: manifest?.source.commit ?? null,
    releaseStatus: matches ? 'binary-match-only; funded acceptance and authority review required' : 'candidate-not-deployed',
  };
  fs.mkdirSync('security/artifacts', {recursive:true});
  fs.writeFileSync('security/artifacts/devnet-inspection.json', JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
})().catch(error => { console.error(error.message); process.exit(1); });
