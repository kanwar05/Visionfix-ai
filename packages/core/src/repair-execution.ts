import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { filterSecrets } from './privacy.js';
import { RepairExecutionError, requireRepairWorkspace } from './repair-workspace.js';
import type { ExecutionCommand } from './repair-schema.js';
export { RepairExecutionError } from './repair-workspace.js';

const LOG_BYTES = 64 * 1024;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Only operational OS paths are inherited. Model/API/npm/Node option credentials are not. */
export function repairEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'pathext']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toLowerCase()) && value) environment[name] = value;
  return { ...environment, NODE_ENV: 'production', CI: '1', NO_COLOR: '1' };
}

// This fixed supervisor assigns the reviewed command to a Windows Job Object
// before its first instruction executes. Closing the supervisor/job handle kills
// the entire run-owned descendant tree, including descendants whose parent exits.
const WINDOWS_SUPERVISOR = String.raw`param([Parameter(Mandatory=$true)][string]$SpecPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VisionFixProcess {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string Reserved, Desktop, Title; public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPointer,Input,Output,Error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
  public static int Run(string executable,string command,string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new InvalidOperationException("Could not create run-owned job.");
    ProcessInfo process = new ProcessInfo();
    try {
      ExtendedLimit limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000;
      int size=Marshal.SizeOf(typeof(ExtendedLimit)); IntPtr buffer=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits,buffer,false); if(!SetInformationJobObject(job,9,buffer,(uint)size)) throw new InvalidOperationException("Could not configure run-owned job."); }
      finally { Marshal.FreeHGlobal(buffer); }
      Startup startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(typeof(Startup)); startup.Flags=0x100;
      startup.Input=GetStdHandle(-10); startup.Output=GetStdHandle(-11); startup.Error=GetStdHandle(-12);
      if(!CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out process)) throw new InvalidOperationException("Reviewed executable could not start.");
      if(!AssignProcessToJobObject(job,process.Process)) { TerminateProcess(process.Process,125); throw new InvalidOperationException("Could not isolate the run-owned process tree."); }
      if(ResumeThread(process.Thread)==0xffffffff) { TerminateProcess(process.Process,125); throw new InvalidOperationException("Could not start the reviewed process."); }
      WaitForSingleObject(process.Process,0xffffffff); uint code;
      if(!GetExitCodeProcess(process.Process,out code)) return 125;
      return unchecked((int)code);
    } finally {
      if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread);
      if(process.Process!=IntPtr.Zero) CloseHandle(process.Process);
      CloseHandle(job);
    }
  }
}
'@
try {
  $spec = [System.IO.File]::ReadAllText($SpecPath) | ConvertFrom-Json
  exit ([VisionFixProcess]::Run([string]$spec.executable,[string]$spec.commandLine,[string]$spec.cwd))
} catch { [Console]::Error.WriteLine('Run-owned process supervisor failed.'); exit 125 }
`;

function quoteWindows(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function validateCommand(command: ExecutionCommand): void {
  if (!path.isAbsolute(command.executable) || /[\x00-\x1f]/.test(command.executable)
    || !Array.isArray(command.args) || command.args.length > 32
    || command.args.some((argument) => typeof argument !== 'string' || argument.length > 2048 || /[\x00-\x1f]/.test(argument))
    || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 120_000
    || /^(?:cmd|powershell|pwsh|sh|bash|zsh|csh)(?:\.exe)?$/i.test(path.basename(command.executable))
    || /\.(?:cmd|bat|ps1|sh)$/i.test(command.executable)) {
    throw new RepairExecutionError('UNSUPPORTED_COMMAND', 'Execution requires a reviewed native executable and bounded argument array, without a shell.');
  }
}

interface OwnedProcess {
  child: ChildProcess; pid: number; logPath: string;
  completed: Promise<{ exitCode: number | null; spawnFailed: boolean }>;
  stop: () => Promise<void>;
  saveLog: () => Promise<void>;
}

async function startOwned(workspace: string, command: ExecutionCommand, logDirectory: string, label: string): Promise<OwnedProcess> {
  validateCommand(command);
  await requireRepairWorkspace(workspace);
  if (process.platform === 'win32' && workspace.length > 180) throw new RepairExecutionError('UNSUPPORTED_WORKSPACE_PATH', 'Execution requires the short working copy created by VisionFix; long evidence directories are supported separately.');
  const executable = await realpath(command.executable).catch(() => { throw new RepairExecutionError('EXECUTABLE_UNAVAILABLE', 'The reviewed executable is unavailable.'); });
  if (!(await stat(executable)).isFile()) throw new RepairExecutionError('EXECUTABLE_UNAVAILABLE', 'The reviewed executable is not a regular file.');
  await mkdir(logDirectory, { recursive: true });
  const logRoot = await realpath(logDirectory);
  if (inside(workspace, logRoot)) throw new RepairExecutionError('UNSAFE_LOG_PATH', 'Execution logs must be outside the working project.');
  const logPath = path.join(logRoot, `${label}-${randomUUID()}.log`);
  const environment = repairEnvironment();
  let executablePath = executable; let args = command.args;
  let helperDirectory: string | undefined; let helperParent: string | undefined;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new RepairExecutionError('SUPERVISOR_UNAVAILABLE', 'Windows system directory is unavailable for process-tree supervision.');
    // Windows PowerShell's -File and .NET Framework path handling can reject
    // nested artifact paths over MAX_PATH. Keep only this run-owned helper short.
    helperParent = await realpath(os.tmpdir());
    helperDirectory = await mkdtemp(path.join(helperParent, 'visionfix-exec-'));
    const supervisor = path.join(helperDirectory, 'supervisor.ps1');
    const spec = path.join(helperDirectory, 'process.json');
    await writeFile(supervisor, WINDOWS_SUPERVISOR, { flag: 'wx', mode: 0o600 });
    await writeFile(spec, JSON.stringify({ executable, commandLine: [executable, ...args].map(quoteWindows).join(' '), cwd: workspace }), { flag: 'wx', mode: 0o600 });
    executablePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, '-SpecPath', spec];
  }
  // The static Windows supervisor itself starts from its short helper directory;
  // only the reviewed project executable receives the isolated project's cwd.
  const child = spawn(executablePath, args, { cwd: helperDirectory ?? workspace, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let raw = ''; let truncated = false; let stopped: Promise<void> | undefined;
  const append = (chunk: Buffer) => {
    const remaining = LOG_BYTES - Buffer.byteLength(raw);
    if (remaining > 0) raw += chunk.subarray(0, remaining).toString('utf8');
    if (chunk.length > remaining) truncated = true;
  };
  child.stdout?.on('data', append); child.stderr?.on('data', append);
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  const completed = new Promise<{ exitCode: number | null; spawnFailed: boolean }>((resolve) => {
    child.once('close', (exitCode) => resolve({ exitCode, spawnFailed }));
  });
  const emergencyStop = () => {
    if (!child.pid) return;
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  };
  process.once('exit', emergencyStop);
  const saveLog = async () => {
    // Sanitize only after collecting chunks, so credentials split across chunks are filtered together.
    const sanitized = filterSecrets(raw).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    await writeFile(logPath, sanitized + (truncated ? '\n[LOG TRUNCATED]\n' : ''), { mode: 0o600 });
  };
  const removeHelper = async () => {
    if (!helperDirectory || !helperParent) return;
    const canonical = await realpath(helperDirectory);
    const expectedParent = await realpath(helperParent);
    if (path.dirname(canonical).toLowerCase() !== expectedParent.toLowerCase()
      || !path.basename(canonical).startsWith('visionfix-exec-')) {
      throw new RepairExecutionError('PROCESS_CLEANUP_FAILED', 'Refusing cleanup outside the run-owned short process helper.');
    }
    await rm(canonical, { recursive: true, force: false });
    helperDirectory = undefined;
  };
  const stop = () => stopped ??= (async () => {
    emergencyStop();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([completed.then(() => true), new Promise<false>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 5000); })]);
      if (!closed) throw new RepairExecutionError('PROCESS_CLEANUP_FAILED', 'A run-owned process did not confirm termination within the cleanup budget.');
      await removeHelper();
    } finally { if (cleanupTimer) clearTimeout(cleanupTimer); process.removeListener('exit', emergencyStop); await saveLog(); }
  })();
  if (process.platform !== 'win32') child.once('exit', emergencyStop);
  completed.then(() => { process.removeListener('exit', emergencyStop); }).catch(() => undefined);
  return { child, pid: child.pid ?? 0, logPath, completed, stop, saveLog };
}

export async function runRepairBuild(options: { workspace: string; command: ExecutionCommand; logDirectory: string }): Promise<{
  success: boolean; exitCode: number | null; timedOut: boolean; logPath: string; durationMs: number;
}> {
  const started = Date.now();
  const workspace = await requireRepairWorkspace(options.workspace);
  const process = await startOwned(workspace, options.command, options.logDirectory, 'build');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), options.command.timeoutMs); });
  try {
    const result = await Promise.race([process.completed, deadline]);
    if (result === 'timeout') {
      await process.stop();
      return { success: false, exitCode: null, timedOut: true, logPath: process.logPath, durationMs: Date.now() - started };
    }
    // The Windows supervisor closes its job after the root command exits; POSIX groups are stopped too.
    await process.stop();
    return { success: result.exitCode === 0 && !result.spawnFailed, exitCode: result.exitCode, timedOut: false, logPath: process.logPath, durationMs: Date.now() - started };
  } finally { if (timer) clearTimeout(timer); }
}

export async function checkRepairPort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RepairExecutionError('INVALID_PORT', 'A reviewed loopback port from 1024 to 65535 is required.');
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new RepairExecutionError('PORT_OCCUPIED', 'The requested loopback port is occupied or unavailable. No existing server was used.')));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve()));
  });
}

export async function startRepairServer(options: { workspace: string; command: ExecutionCommand; port: number; logDirectory: string }): Promise<{
  url: string; pid: number; logPath: string; stop: () => Promise<void>;
}> {
  const workspace = await requireRepairWorkspace(options.workspace);
  validateCommand(options.command);
  if (path.resolve(options.command.executable) !== path.resolve(process.execPath)
    || options.command.args[0]?.replace(/\\/g, '/') !== 'node_modules/vite/bin/vite.js'
    || options.command.args[1] !== 'preview'
    || options.command.args.some((argument) => /^--?(?:host|port|strictPort)(?:=|$)/i.test(argument))) {
    throw new RepairExecutionError('UNSUPPORTED_SERVER', 'The MVP server requires the reviewed Node executable and node_modules/vite/bin/vite.js preview arguments; host, port and strictPort are controlled by VisionFix.');
  }
  await checkRepairPort(options.port);
  const output = await realpath(path.join(workspace, 'dist')).catch(() => { throw new RepairExecutionError('BUILD_OUTPUT_MISSING', 'The isolated Vite build must produce a regular dist directory before preview.'); });
  if (!inside(workspace, output) || !(await stat(output)).isDirectory()) throw new RepairExecutionError('UNSAFE_BUILD_OUTPUT', 'Build output must remain inside the run-owned workspace.');
  const nonce = randomUUID(); const readinessName = `visionfix-ready-${nonce}.txt`;
  await writeFile(path.join(output, readinessName), nonce, { flag: 'wx', mode: 0o600 });
  const command = { ...options.command, args: [...options.command.args, '--host', '127.0.0.1', '--port', String(options.port), '--strictPort'] };
  const owned = await startOwned(workspace, command, options.logDirectory, 'server');
  const url = `http://127.0.0.1:${options.port}/`;
  const deadline = Date.now() + Math.min(options.command.timeoutMs, 30_000);
  let exited = false; owned.completed.then(() => { exited = true; }).catch(() => { exited = true; });
  try {
    while (Date.now() < deadline && !exited) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(750, Math.max(1, deadline - Date.now())));
      try {
        const response = await fetch(new URL(readinessName, url), { signal: controller.signal, redirect: 'error' });
        let body = '';
        if (response.ok && response.body && Number(response.headers.get('content-length') ?? '0') <= 128) {
          const reader = response.body.getReader(); let length = 0; const pieces: Uint8Array[] = [];
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              length += next.value.length; if (length > 128) break; pieces.push(next.value);
            }
            if (length <= 128) body = Buffer.concat(pieces).toString('utf8');
          } finally { await reader.cancel().catch(() => undefined); }
        } else { await response.body?.cancel().catch(() => undefined); }
        if (body === nonce && !exited) { await owned.saveLog(); return { url, pid: owned.pid, logPath: owned.logPath, stop: owned.stop }; }
      } catch { /* Not ready; bounded retry. */ }
      finally { clearTimeout(timer); }
      await delay(75);
    }
    throw new RepairExecutionError('SERVER_NOT_READY', 'The run-owned preview did not prove readiness on its separate loopback URL.');
  } catch (error) { await owned.stop(); throw error; }
}
