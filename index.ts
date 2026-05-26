/**
 * 超星学习通刷课框架
 *
 * 功能：
 * 1. 可视化登录（账号保存在 credentials.json）
 * 2. 自动检测所有课程，交互式选择
 * 3. 每课程独立进度文件（data/{courseId}.json），中断后可继续
 * 4. 支持指定起始章节
 * 5. AI 答题：整页文本 → DeepSeek → Playwright 自动点击提交
 */

import { chromium } from 'playwright';
import type { Page } from 'playwright';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename);

const CONFIG = {
  LOGIN_URL: 'https://i.mooc.chaoxing.com/space/index?ws=1&t=1779594450165',
  USERNAME: '',
  PASSWORD: '',
  VIDEO_SPEED: 2,
  DEFAULT_COURSE: null,  // null = 每次交互式选择课程
  DATA_DIR: path.join(__dirname2, 'data'),
  CREDENTIALS_FILE: path.join(__dirname2, 'credentials.json'),
  LOGIN_HTML: path.join(__dirname2, 'login-ui.html'),
  DEEPSEEK_API_KEY: '',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ===== 凭证管理 =====
interface Credentials { username: string; password: string; }

function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CONFIG.CREDENTIALS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG.CREDENTIALS_FILE, 'utf-8')); }
  catch { return null; }
}

function saveCredentials(creds: Credentials) {
  fs.writeFileSync(CONFIG.CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf-8');
}

// 打开可视化登录窗口
async function loginWithUI(): Promise<Credentials> {
  console.log('    → 打开登录窗口...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const ctx = await browser.newContext({ viewport: { width: 400, height: 580 } });
  const page = await ctx.newPage();

  await page.goto(`file:///${CONFIG.LOGIN_HTML.replace(/\\/g, '/')}`);
  await page.waitForLoadState('domcontentloaded');
  console.log('    → 请在浏览器中填写账号密码，点击登录...');

  let creds: Credentials | null = null;
  const startTime = Date.now();

  while (Date.now() - startTime < 120000) {
    await sleep(1000);
    const raw = await page.evaluate(() => {
      try { return localStorage.getItem('mooc_credentials'); } catch { return null; }
    }).catch(() => null);
    if (raw) {
      try {
        creds = JSON.parse(raw);
        if (creds?.username && creds?.password) { console.log(`    → 检测到: ${creds.username}`); break; }
      } catch {}
    }
  }

  await browser.close();
  if (!creds?.username || !creds?.password) throw new Error('未获取到有效凭证');
  saveCredentials(creds);
  console.log(`    ✓ 账号已保存: ${creds.username}`);
  return creds;
}

// ===== 工具 =====
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ===== 进度管理 =====
interface CourseProgress {
  courseId: string; courseName: string;
  completedChapters: string[]; lastChapter: string; updatedAt: number;
}

function getProgressPath(courseId: string): string {
  ensureDir(CONFIG.DATA_DIR);
  return `${CONFIG.DATA_DIR}/${courseId}.json`;
}

function loadProgress(courseId: string): CourseProgress | null {
  const p = getProgressPath(courseId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function saveProgress(progress: CourseProgress) {
  progress.updatedAt = Date.now();
  fs.writeFileSync(getProgressPath(progress.courseId), JSON.stringify(progress, null, 2), 'utf-8');
}

function markChapterDone(progress: CourseProgress, onclick: string) {
  if (!progress.completedChapters.includes(onclick)) progress.completedChapters.push(onclick);
  progress.lastChapter = onclick;
  saveProgress(progress);
}

// ===== 登录 =====
async function login(page: Page): Promise<boolean> {
  console.log('\n[1/4] 登录中...');
  await page.goto(CONFIG.LOGIN_URL, { timeout: 30000 });
  await sleep(3000);
  await page.locator('#phone').fill(CONFIG.USERNAME);
  await page.locator('#pwd').fill(CONFIG.PASSWORD);
  await page.locator('.btn-big-blue').click();
  await sleep(5000);
  if (!page.url().includes('passport2')) { console.log('    ✓ 登录成功'); return true; }
  console.log('    ✗ 登录失败'); return false;
}

// ===== 课程列表 =====
interface Course { index: number; name: string; url: string; courseId: string; }

async function getCourses(page: Page): Promise<Course[]> {
  console.log('\n[2/4] 获取课程列表...');
  await page.goto('https://mooc1-1.chaoxing.com/visit/interaction?s=775da1a566dbca1933653ce05b2b43a3', { timeout: 30000 });
  await sleep(3000);
  const frame = page.frames()[0];
  const courses = await frame.$$eval('a[href*="courseid"]', (els: any[]) => {
    const seen = new Set<string>();
    return els.map(el => {
      const name = el.innerText?.trim() || '';
      const href = el.href;
      const match = href.match(/courseid=(\d+)/);
      const courseId = match ? match[1] : '';
      if (!name || seen.has(href)) return null;
      seen.add(href); return { name, href, courseId };
    }).filter(Boolean);
  });
  const result: Course[] = courses.map((c: any, i: number) => ({ index: i + 1, name: c.name, url: c.href, courseId: c.courseId }));
  console.log(`    ✓ 找到 ${result.length} 门课程`); return result;
}

// ===== 交互式选课 =====
async function selectCourseInteractive(courses: Course[]): Promise<Course> {
  if (CONFIG.DEFAULT_COURSE) {
    const s = courses.find(c => c.index === CONFIG.DEFAULT_COURSE) || courses[0];
    console.log(`   ✓ 已自动选择: [${s.index}] ${s.name}\n`); return s;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║              🎓 选择要刷的课程                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  courses.forEach(c => console.log(`   [${c.index.toString().padStart(2)}] ${c.name}`));
  console.log('\n   请输入课程编号，按回车确认:');
  return new Promise(resolve => {
    rl.on('line', (input: string) => {
      const num = parseInt(input.trim());
      const selected = courses.find(c => c.index === num);
      if (selected) { rl.close(); console.log(`\n   ✓ 已选择: ${selected.name}\n`); resolve(selected); }
      else console.log('   无效编号，请重新输入:');
    });
  });
}

// ===== 章节列表 =====
interface Chapter { name: string; onclick: string; isCompleted: boolean; }

async function getChapters(page: Page): Promise<Chapter[]> {
  const frame = page.frames()[1]; if (!frame) return [];
  return frame.$$eval('[class*="chapter_item"]', (els: any[]) =>
    els.map(el => ({
      name: el.innerText?.trim().substring(0, 60) || '',
      onclick: el.getAttribute('onclick') || '',
      isCompleted: el.innerText?.includes('已完成') || el.className.includes('completed') || el.className.includes('finished') || el.className.includes('done'),
    }))
  );
}

async function clickChapter(page: Page, chapter: Chapter) {
  const frame = page.frames()[1]; if (!frame) return;
  const el = await frame.$(`[onclick="${chapter.onclick}"]`);
  if (el) { await el.click({ force: true }); await sleep(3000); }
}

// ===== 播放视频 =====
async function waitForVideo(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const v = await frame.$('video');
      if (v) {
        await v.evaluate((vv: HTMLVideoElement, sp: number) => { vv.playbackRate = sp; if (vv.paused) vv.play(); }, CONFIG.VIDEO_SPEED);
        await sleep(2000);
        const s = await v.evaluate((vv: HTMLVideoElement) => ({ d: Math.round(vv.duration), c: Math.round(vv.currentTime), sp: vv.playbackRate }));
        if (s.d > 0) { console.log(`    ✓ 视频: ${s.d}s, ${s.sp}x`); return true; }
      }
    } catch {}
  }
  return false;
}

type VideoResult = 'completed' | 'no_video' | 'stuck' | 'unexpected';

async function waitForVideoEnd(page: Page): Promise<VideoResult> {
  let lastTime = 0, stuckCount = 0, iteration = 0, lastUrl = page.url();
  while (true) {
    iteration++;
    console.log(`    [检查${iteration}]`);
    const frames = page.frames();
    const currentUrl = page.url();
    if (currentUrl !== lastUrl) { console.log(`    ⚠ 跳转: ${currentUrl.substring(0, 60)}`); lastUrl = currentUrl; }
    let videoFound = false, videoStillPlaying = false;
    for (const frame of frames) {
      try {
        const v = await frame.$('video');
        if (v) {
          videoFound = true;
          await v.evaluate((vv: HTMLVideoElement) => { if (vv.paused) vv.play(); vv.playbackRate = 2; });
          const s = await v.evaluate((vv: HTMLVideoElement) => ({ ct: vv.currentTime, d: vv.duration, ended: vv.ended, paused: vv.paused }));
          console.log(`    ${Math.round(s.ct)}/${Math.round(s.d)}s, paused=${s.paused}`);
          if (s.ended || s.ct >= s.d - 5) { console.log('    ✓ 完成'); return 'completed'; }
          if (s.ct < lastTime) {
            console.log(`    ↺ 回退 ${lastTime}s→${Math.round(s.ct)}s`);
            stuckCount++;
            if (stuckCount >= 2) { console.log('    ✓ 完成（回退）'); return 'completed'; }
            await sleep(5000); continue;
          }
          if (s.ct > lastTime && !s.paused) { lastTime = s.ct; stuckCount = 0; videoStillPlaying = true; }
          else { stuckCount++; if (stuckCount >= 3) { console.log(`    ⚠ 卡住`); return 'stuck'; } }
          await sleep(10000); break;
        }
      } catch {}
    }
    if (!videoFound) { console.log('    ⚠ 视频消失'); return 'unexpected'; }
    if (!videoStillPlaying && videoFound) { console.log('    等待视频加载...'); await sleep(5000); }
  }
}

// ===== 返回课程 =====
async function goBackToCourse(page: Page) {
  const back = await page.$('text=返回课程');
  if (back) { await back.click({ force: true }); await sleep(2000); }
  const tab = await page.$('text=章节');
  if (tab) { await tab.click({ force: true }); await sleep(2000); }
}

// ===== 答题模块：全量文本 → DeepSeek AI → Playwright 点击 =====

function getQuizFrame(page: Page) {
  return page.frameLocator('#iframe').frameLocator('iframe').frameLocator('iframe[name="frame_content"], iframe');
}

async function getQuizPageText(page: Page): Promise<string> {
  return (await getQuizFrame(page).locator('body').textContent({ timeout: 5000 })) || '';
}

async function askDeepSeekForPage(apiKey: string, pageText: string): Promise<any[]> {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是答题助手。分析测验网页文本，选出每题正确答案。返回JSON: [{"question":1,"answer":"A","note":"解释"}]。answer: 单选="A",多选="AB",判断="对"/"错",填空写文字。不确定填"?"。只输出JSON。' },
        { role: 'user', content: `回答以下测验:\n\n${pageText}` },
      ],
      temperature: 0.1, max_tokens: 2000,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}`);
  const raw = (await resp.json() as any).choices?.[0]?.message?.content || '';
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('AI 格式错误: ' + raw.substring(0, 100));
  return JSON.parse(m[0]);
}

async function clickAnswersByLabel(page: Page, answers: any[]) {
  const quiz = getQuizFrame(page); let clicked = 0;
  for (const item of answers) {
    const ans = (item.answer || '').trim().toUpperCase();
    if (!ans || ans === '?' || ans === '？') { console.log(`      Q${item.question}: 跳过`); continue; }
    const qIdx = item.question - 1;
    for (const ch of ans.replace(/[^A-H]/g, '').split('')) {
      let ok = false;
      // 方法1: aria-label nth
      try { const o = quiz.locator(`[aria-label*="${ch} "], [aria-label^="${ch}"]`); if (await o.count() > qIdx) { await o.nth(qIdx).click({ force: true, timeout: 2000 }); ok = true; } } catch {}
      // 方法2: radio 列表容器
      if (!ok) try { const ls = quiz.locator('ul, ol, [role="list"]').filter({ has: quiz.locator('[role="radio"]') }); if (qIdx < await ls.count()) { const r = ls.nth(qIdx).locator('[role="radio"]'); const li = 'ABCDEFGH'.indexOf(ch); if (li >= 0 && li < await r.count()) { await r.nth(li).click({ force: true, timeout: 2000 }); ok = true; } } } catch {}
      // 方法3: 全局 radio 索引
      if (!ok) try { const ar = quiz.locator('[role="radio"], input[type="radio"]'); const idx = qIdx * 4 + 'ABCDEFGH'.indexOf(ch); if (idx >= 0 && idx < await ar.count()) { await ar.nth(idx).click({ force: true, timeout: 2000 }); ok = true; } } catch {}
      // 方法4: 纯文本匹配 (字母 + 空格)
      if (!ok) try { const tx = quiz.getByText(new RegExp(`^${ch}\\s`)); if (await tx.count() > qIdx) { await tx.nth(qIdx).click({ force: true, timeout: 2000 }); ok = true; } } catch {}
      // 方法5: option 角色 (阅读理解)
      if (!ok) try { const op = quiz.getByRole('option'); const oi = 15 + (qIdx - 15) * 4 + 'ABCDEFGH'.indexOf(ch); if (oi >= 15 && oi < await op.count()) { await op.nth(oi).click({ force: true, timeout: 2000 }); ok = true; } } catch {}
      if (ok) { clicked++; console.log(`      Q${item.question} ${ch} ✓`); }
    }
  }
  return clicked;
}

async function isQuizPage(page: Page): Promise<boolean> {
  try { const t = await getQuizPageText(page); return (t.includes('章节测验') || t.includes('待完成')) && (t.includes('单选题') || t.includes('多选题') || t.includes('判断题')); } catch { return false; }
}

async function submitQuiz(page: Page): Promise<boolean> {
  try { await getQuizFrame(page).locator('button:has-text("提交"), a:has-text("提交")').first().click({ timeout: 3000 }); await sleep(2000); const c = page.locator('.layui-layer-btn0, button:has-text("确定")'); if (await c.count() > 0) { await c.first().click({ timeout: 2000 }); await sleep(2000); } console.log('    ✓ 已提交'); return true; } catch { console.log('    ⚠ 提交失败'); return false; }
}

async function handleQuiz(page: Page): Promise<{ answered: number; success: boolean }> {
  console.log('    → 检测到答题页面');
  if (!CONFIG.DEEPSEEK_API_KEY) { console.log('    ⚠ 未配置 API Key，跳过'); return { answered: 0, success: false }; }
  const text = await getQuizPageText(page); console.log(`    → 页面 ${text.length} 字符`);
  let answers: any[]; try { answers = await askDeepSeekForPage(CONFIG.DEEPSEEK_API_KEY, text); } catch (e: any) { console.log(`    ✗ AI: ${e.message}`); return { answered: 0, success: false }; }
  if (!answers?.length) { console.log('    ⚠ AI 无返回'); return { answered: 0, success: false }; }
  console.log(`    → AI 给出 ${answers.length} 题答案`);
  const clicked = await clickAnswersByLabel(page, answers);
  return { answered: clicked, success: await submitQuiz(page) };
}

// ===== 主流程 =====
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🎓 超星学习通刷课                               ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // 0. 获取凭证
  let creds = loadCredentials();
  if (!creds) creds = await loginWithUI();
  else console.log(`\n[0/4] 使用已保存账号: ${creds.username}`);
  CONFIG.USERNAME = creds.username; CONFIG.PASSWORD = creds.password;

  // DeepSeek API Key
  if (!CONFIG.DEEPSEEK_API_KEY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  DeepSeek API Key（留空跳过 AI 答题）                    ║');
    console.log('║  获取: https://platform.deepseek.com/api_keys              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    CONFIG.DEEPSEEK_API_KEY = await new Promise<string>(r => { rl.question('   Key: ', v => { rl.close(); r(v.trim()); }); });
    if (CONFIG.DEEPSEEK_API_KEY) console.log('    ✓ DeepSeek 已配置\n');
    else console.log('    - 跳过 AI 答题\n');
  }

  if (!await login(page)) { await browser.close(); return; }

  const courses = await getCourses(page);
  if (!courses.length) { console.log('    ✗ 未找到课程'); await browser.close(); return; }

  const selected = await selectCourseInteractive(courses);
  const progress = loadProgress(selected.courseId);
  if (progress) console.log(`    ✓ 发现进度: ${progress.completedChapters.length} 个已完成`);

  console.log('\n[4/4] 开始刷课...\n');
  await page.goto(selected.url, { timeout: 30000 }); await sleep(5000);
  const tab = await page.$('text=章节');
  if (tab) { await tab.click({ force: true }); await sleep(5000); }

  const chapters = await getChapters(page);
  console.log(`    ✓ 找到 ${chapters.length} 个任务点\n`);

  let startIdx = 0;
  if (progress?.lastChapter) {
    const idx = chapters.findIndex(c => c.onclick === progress.lastChapter);
    if (idx >= 0) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`   上次做到: ${progress.lastChapter.substring(0, 50)}`);
      console.log('   [0] 从头开始  [1] 从上次继续（默认）');
      const answer = await new Promise<string>(resolve => {
        rl.question('   请输入: ', (v: string) => { rl.close(); resolve(v || '1'); });
      });
      if (answer !== '0') startIdx = idx + 1;
    }
  }
  console.log(`    → 从第 ${startIdx + 1} 节开始\n`);

  let completed = 0, skipped = 0;
  const toDo = chapters.filter(c => c.onclick.includes('toOld') && !progress?.completedChapters.includes(c.onclick));

  for (let i = startIdx; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter.onclick || !chapter.onclick.includes('toOld')) continue;
    if (progress?.completedChapters.includes(chapter.onclick)) {
      console.log(`\n[跳过] ${chapter.name.replace(/\n/g, ' ').trim().substring(0, 50)} - 已完成`); skipped++; continue;
    }
    const idx = completed + 1;
    const name = chapter.name.replace(/\n/g, ' ').trim();
    console.log(`\n[${idx}/${toDo.length}] ${name.substring(0, 50)}`);
    await clickChapter(page, chapter);

    // 先检测答题页面
    const isQuiz = await isQuizPage(page);
    if (isQuiz) {
      const qr = await handleQuiz(page);
      if (qr.success) {
        if (!progress) progress = { courseId: selected.courseId, courseName: selected.name, completedChapters: [], lastChapter: chapter.onclick, updatedAt: Date.now() };
        markChapterDone(progress, chapter.onclick); completed++;
        console.log(`    ✓ 答题完成 (${qr.answered} 题)`);
      } else { console.log(`    ⚠ 答题未完成，跳过`); skipped++; }
      await goBackToCourse(page);
      continue;
    }

    const hasVideo = await waitForVideo(page);
    let result: VideoResult;
    if (hasVideo) result = await waitForVideoEnd(page);
    else { console.log('    - 无视频'); result = 'no_video'; }
    if (result === 'completed') {
      if (!progress) progress = { courseId: selected.courseId, courseName: selected.name, completedChapters: [], lastChapter: chapter.onclick, updatedAt: Date.now() };
      markChapterDone(progress, chapter.onclick); completed++;
    } else { console.log(`    ⚠ 跳过（${result}）`); skipped++; }
    await goBackToCourse(page);
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🎉 刷课完成!                                             ║');
  console.log(`║  已完成: ${completed} 个 | 跳过: ${skipped} 个                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  await browser.close();
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });