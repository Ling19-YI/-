/**
 * 刷课平台启动器
 * 同时支持：超星学习通、杭州干部学习
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname2 = dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║              🎓 刷课平台选择                              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log('   [1] 超星学习通         （进阶英语读写等课程）');
console.log('   [2] 杭州干部学习平台   （国防教育视频）\n');

console.log('   请输入编号，按回车:');

rl.on('line', (input) => {
  rl.close();
  const choice = input.trim();

  if (choice === '1') {
    console.log('\n→ 启动 超星学习通...\n');
    const child = spawn('npx', ['ts-node', 'index.ts'], {
      cwd: __dirname2,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => process.exit(code));
  } else if (choice === '2') {
    console.log('\n→ 启动 杭州干部学习...\n');
    const child = spawn('node', ['gd_video_auto.js'], {
      cwd: __dirname2,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => process.exit(code));
  } else {
    console.log('无效编号');
    process.exit(1);
  }
});