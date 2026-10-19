/**
 * child-process.ts — Run bridge modules in real child processes.
 *
 * Cross-process guarantees (the config lock, the single router lock) cannot be shown inside one
 * process. These helpers transpile the TypeScript sources of the modules under test into a temp
 * directory as ES modules and start plain Node processes against them, with the home directory
 * pointed at a temp directory so nothing touches the real one.
 */

import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Transpile `src/<relativePath>.ts` for each entry into `<outDir>/<relativePath>.js`.
 * Only modules whose runtime imports are among `relativePaths` (or Node built-ins) can run there.
 */
export function buildChildModules(outDir: string, relativePaths: string[]): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const relativePath of relativePaths) {
    const source = readFileSync(join(SRC_ROOT, `${relativePath}.ts`), 'utf-8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    });
    const target = join(outDir, `${relativePath}.js`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
}

export interface RunningChild {
  /** Settles when the process exits. */
  result: Promise<ChildResult>;
  /** Resolves once the process has printed `text`. */
  waitForOutput(text: string): Promise<void>;
}

/** Start `node <script> ...args` with `home` as the user's home directory. */
export function startChild(script: string, args: string[], home: string): RunningChild {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const listeners: Array<() => void> = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const listener of [...listeners]) listener();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<ChildResult>((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
  return {
    result,
    waitForOutput(text) {
      return new Promise((resolveOutput) => {
        const check = () => {
          if (!stdout.includes(text)) return;
          listeners.splice(listeners.indexOf(check), 1);
          resolveOutput();
        };
        listeners.push(check);
        check();
      });
    },
  };
}

export function runChild(script: string, args: string[], home: string): Promise<ChildResult> {
  return startChild(script, args, home).result;
}
