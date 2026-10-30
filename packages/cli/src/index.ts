import { APPLICATION_NAME, APPLICATION_VERSION, CURRENT_PHASE } from '@visionfix/core';

export function runCli(args: string[] = process.argv.slice(2)): void {
  const isVersion = args.includes('--version') || args.includes('-v') || args.length === 0;
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`${APPLICATION_NAME} v${APPLICATION_VERSION}`);
    console.log(`Status: ${CURRENT_PHASE}\n`);
    console.log('Usage:');
    console.log('  visionfix [options]\n');
    console.log('Options:');
    console.log('  -v, --version  Print application name and version');
    console.log('  -h, --help     Print this help message');
    return;
  }

  if (isVersion) {
    console.log(`${APPLICATION_NAME} v${APPLICATION_VERSION} (${CURRENT_PHASE})`);
    return;
  }

  console.log(`Unknown option(s): ${args.join(' ')}`);
  console.log('Run "visionfix --help" for available options.');
  process.exitCode = 1;
}

if (import.meta.url.startsWith('file:') && process.argv[1]?.endsWith('index.js')) {
  runCli();
}
