// Integration test: sign-in code limits hold under PARALLEL requests.
//   MONGODB_DB=maavuli_it_orch pnpm run it scripts/it/orch-otp.ts
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { issueOtp, RateLimitError, verifyOtp, VerifyError } from '@/lib/auth';

if (!process.env.MONGODB_DB?.startsWith('maavuli_it_')) {
  console.log('refusing to run: MONGODB_DB must be an isolated maavuli_it_* database');
  process.exit(1);
}
let passed = 0;
let failed = 0;
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
const db = await getDb();
const rnd = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

// ---- 10 parallel issues for one mobile → at most 3 live codes ----
const m1 = rnd();
const issued = await Promise.allSettled(Array.from({ length: 10 }, () => issueOtp(m1)));
const okCount = issued.filter(r => r.status === 'fulfilled').length;
const limited = issued.filter(r => r.status === 'rejected' && r.reason instanceof RateLimitError).length;
t('parallel issue: at most 3 codes minted', okCount <= 3 && okCount >= 1, { okCount });
t('parallel issue: the rest are rate-limited', okCount + limited === 10, { okCount, limited });
t('parallel issue: at most 3 OTP rows exist', (await col.otps(db).countDocuments({ mobile: m1 })) <= 3);

// ---- per-IP limit across different mobiles ----
const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ipOk = 0;
let ipLimited = 0;
for (let i = 0; i < 22; i++) {
  try {
    await issueOtp(rnd(), { ip });
    ipOk++;
  } catch (e) {
    if (e instanceof RateLimitError) ipLimited++;
  }
}
t('per-IP limit: 20 allowed', ipOk === 20, { ipOk });
t('per-IP limit: the rest refused', ipLimited === 2, { ipLimited });

// ---- attempts: 5 wrong guesses kill the code, even the right one fails after ----
const m2 = rnd();
const r = await issueOtp(m2);
const code = r.devCode;
if (!code) {
  console.log('NOT VERIFIED: attempts case needs a devCode (non-production, non-owner mobile)');
} else {
  const wrong = code === '000000' ? '111111' : '000000';
  const guesses = await Promise.allSettled(Array.from({ length: 12 }, () => verifyOtp(m2, wrong)));
  t('parallel wrong guesses all rejected', guesses.every(g => g.status === 'rejected' && g.reason instanceof VerifyError));
  const doc = await col.otps(db).findOne({ mobile: m2 });
  t('code is dead after 5 attempts (deleted)', doc === null, doc);
  let rightRejected = false;
  try {
    await verifyOtp(m2, code);
  } catch (e) {
    rightRejected = e instanceof VerifyError;
  }
  t('the right code no longer works', rightRejected);
}

await col.otps(db).deleteMany({ $or: [{ mobile: m1 }, { mobile: m2 }, { ip }] });
console.log(`orch-otp: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
