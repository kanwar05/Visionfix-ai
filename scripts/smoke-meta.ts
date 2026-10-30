import { loadMetaConfig, testMetaApiConnection } from '@visionfix/core';

async function runMetaSmokeTest(): Promise<void> {
  console.log('========================================================');
  console.log('   VisionFix AI — Meta Model API Smoke Test (Phase 0)  ');
  console.log('========================================================\n');

  const configResult = loadMetaConfig();

  if (!configResult.isConfigured || !configResult.config) {
    console.log('Status: BLOCKED');
    console.log(`Reason: ${configResult.reason}\n`);
    console.log('Instructions to unblock live verification:');
    console.log('  1. Create a local .env file by copying the template:');
    console.log('       Copy-Item .env.example .env');
    console.log('  2. In .env, set META_API_KEY to your valid Meta API bearer token.');
    console.log('     Optionally customize META_BASE_URL (default: https://api.meta.ai/v1)');
    console.log('     and META_MODEL (default: muse-spark-1.3).');
    console.log('  3. Re-run: npm run test:smoke:meta\n');
    console.log('⚠️  SECURITY REMINDER:');
    console.log('   - Never paste your API key or secrets into chat or logs.');
    console.log('   - .env is ignored by Git and must remain local to your machine.\n');
    console.log('========================================================');
    console.log('   Meta API Smoke Test Result: BLOCKED (Missing Config) ');
    console.log('========================================================');
    process.exitCode = 2;
    return;
  }

  console.log('Configuration detected:');
  console.log(`  Base URL:  ${configResult.maskedInfo?.baseUrl}`);
  console.log(`  Model ID:  ${configResult.maskedInfo?.model}`);
  console.log(`  Key:       ${configResult.maskedInfo?.keyMasked}`);
  console.log('\nSending minimal verification request to Meta API (15s timeout)...');

  const testResult = await testMetaApiConnection(configResult.config, {
    timeoutMs: 15000,
    prompt: 'Respond with the single word: OK',
  });

  if (testResult.success && testResult.responseText.length > 0) {
    console.log('\n✓ Request succeeded!');
    console.log(`  HTTP Status: ${testResult.status}`);
    console.log(`  Latency:     ${testResult.durationMs}ms`);
    console.log(`  Model ID:    ${testResult.model}`);
    console.log(`  Response:    "${testResult.responseText}"`);
    console.log('\n========================================================');
    console.log('   Meta API Smoke Test Result: PASSED                   ');
    console.log('========================================================');
  } else {
    console.error('\n❌ Request failed!');
    console.error(`  Error Type:  ${testResult.errorType}`);
    if (testResult.statusCode) {
      console.error(`  HTTP Status: ${testResult.statusCode}`);
    }
    console.error(`  Message:     ${testResult.message}`);
    if (testResult.details) {
      console.error(`  Details:     ${testResult.details}`);
    }
    if (testResult.durationMs) {
      console.error(`  Duration:    ${testResult.durationMs}ms`);
    }
    console.error('\n========================================================');
    console.error('   Meta API Smoke Test Result: FAILED                   ');
    console.error('========================================================');
    process.exitCode = 1;
  }
}

runMetaSmokeTest();
