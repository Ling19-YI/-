const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const CRED_FILE = path.join(__dirname, 'credentials_gd.json');
const LOGIN_HTML = path.join(__dirname, 'login-gd.html');
const LOGIN_URL = 'https://gdypt.rf.hangzhou.gov.cn:9443/hzgd-web/#/video-study';

let USERNAME = '';
let PASSWORD = '';

let totalWatched = 0;

// ===== 凭证 =====
function loadCredentials() {
  if (!fs.existsSync(CRED_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
  } catch { return null; }
}

function saveCredentials(creds) {
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), 'utf-8');
}

// 打开可视化登录窗口
async function loginWithUI() {
  console.log('[登录] 打开登录窗口...');

  const browser = await chromium.launch({
    headless: false,
    ignoreHTTPSErrors: true,
    args: ['--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
  });

  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 400, height: 520 } });
  const page = await ctx.newPage();

  await page.goto(`file:///${LOGIN_HTML.replace(/\\/g, '/')}`);
  await page.waitForLoadState('domcontentloaded');

  let resolved = false;
  let creds = null;

  const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('登录窗口超时(60s)')), 60000));
  const submitPromise = new Promise((resolve) => {
    page.on('message', (msg) => {
      if (msg?.type === 'credentials_ready' && !resolved) {
        resolved = true;
        resolve({ username: msg.username, password: msg.password });
      }
    });
  });

  try {
    creds = await Promise.race([submitPromise, timeoutPromise]);
  } catch (e) {
    console.log(`[登录] ${e.message}，尝试读取已保存凭证...`);
    try {
      const raw = await page.evaluate(() => localStorage.getItem('gd_credentials'));
      if (raw) creds = JSON.parse(raw);
    } catch {}
  }

  if (!creds?.username || !creds?.password) {
    throw new Error('未获取到有效凭证');
  }

  saveCredentials(creds);
  await browser.close();
  return creds;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function login(page) {
  const btn = page.locator('.btn-login-ANMzVQ');
  if (await btn.count() > 0) {
    await btn.click({ force: true });
    await sleep(2000);
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button.ant-btn-primary').click({ force: true });
    await sleep(3000);
    const body = await page.locator('body').textContent();
    if (body.includes('胡智杰')) {
      console.log('[登录] 登录成功');
    } else {
      console.log('[登录] 登录可能失败，继续尝试...');
    }
  } else {
    console.log('[登录] 已登录状态');
  }
}

async function getCardInfo(page) {
  const items = page.locator('.unit-video-zUBDJE');
  const count = await items.count();
  const result = [];
  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).textContent()).trim();
    const learned = text.startsWith('已学习');
    const match = text.match(/^已学习(.+?)\d+人已学习/);
    const match2 = text.match(/^(.+?)\d+人已学习/);
    const title = learned ? (match ? match[1].trim() : '') : (match2 ? match2[1].trim() : text.substring(0, 40));
    result.push({ index: i, title, text, learned });
  }
  return result;
}

async function clickAndCheck(page, index) {
  const items = page.locator('.unit-video-zUBDJE');
  await items.nth(index).click({ force: true });
  await sleep(2000);

  try {
    await page.waitForSelector('.ant-modal-title', { timeout: 8000 });
    await page.waitForSelector('video', { timeout: 8000 });
  } catch {
    return null;
  }

  await sleep(500);
  const title = (await page.locator('.ant-modal-title').textContent()).trim();

  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.duration > 0 && !isNaN(v.duration);
  }, { timeout: 15000 }).catch(() => {});

  const duration = await page.locator('video').evaluate(el => el.duration).catch(() => 0);
  return { title, duration: Math.round(duration) };
}

async function closeModal(page) {
  try {
    await page.locator('button.ant-modal-close').click({ force: true });
    await sleep(800);
  } catch {}
}

async function playVideo(page, info) {
  console.log(`\n▶ ${info.title}  (${info.duration}秒 ≈ ${Math.round(info.duration / 60)}分)`);

  await page.waitForSelector('video', { timeout: 5000 }).catch(() => {});

  const bigPlayBtn = page.locator('.anticon-play-circle');
  if (await bigPlayBtn.count() > 0) {
    await bigPlayBtn.first().click({ force: true });
    await sleep(1000);
  }

  const smallPlayBtn = page.locator('.btn-player-QJnYBQ');
  if (await smallPlayBtn.count() > 0) {
    console.log('  点击小播放按钮');
    await smallPlayBtn.first().click({ force: true });
    await sleep(2000);
  } else {
    console.log('  未找到小播放按钮，尝试直接播放');
  }

  const video = page.locator('video');

  await video.evaluate(el => { el.playbackRate = 1; el.play(); });
  const startTime = Date.now();

  while (true) {
    await sleep(15000);
    const ended = await video.evaluate(el => el.ended).catch(() => true);
    if (ended) break;
    const cur = await video.evaluate(el => Math.round(el.currentTime)).catch(() => 0);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  进度 ${cur}/${info.duration}秒 | 已等待 ${elapsed}秒`);
  }

  console.log(`  ✓ 完成`);
  totalWatched++;
  await closeModal(page);
}

async function main() {
  console.log('=== 国防视频学习助手 ===');
  console.log('自动播放全部未看视频（不限时长）\n');

  // 0. 获取凭证
  let creds = loadCredentials();
  if (!creds) {
    creds = await loginWithUI();
  } else {
    console.log(`[登录] 使用已保存账号: ${creds.username}`);
  }
  USERNAME = creds.username;
  PASSWORD = creds.password;

  const browser = await chromium.launch({
    headless: false,
    ignoreHTTPSErrors: true,
    args: ['--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
  });

  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  console.log('[启动] 打开页面...');
  await page.goto(LOGIN_URL, { timeout: 30000 }).catch(e => console.log('[警告]', e.message.substring(0, 80)));
  await sleep(4000);

  await login(page);

  let maxPage = 1;
  try {
    const pItems = page.locator('.ant-pagination-item:not(.ant-pagination-item-link)');
    const pCount = await pItems.count();
    for (let i = 0; i < pCount; i++) {
      const n = parseInt(await pItems.nth(i).textContent());
      if (n > maxPage) maxPage = n;
    }
  } catch {}
  console.log(`[分页] 共 ${maxPage} 页\n`);

  for (let p = 1; p <= maxPage; p++) {
    console.log(`--- 第 ${p}/${maxPage} 页 ---`);

    const cards = await getCardInfo(page);
    const unwatched = cards.filter(c => !c.learned);
    console.log(`  未看: ${unwatched.length} 个`);

    for (const card of unwatched) {
      console.log(`\n[检查] ${card.title.substring(0, 50)}`);

      const info = await clickAndCheck(page, card.index);
      if (!info) {
        console.log(`  [跳过] 无法打开`);
        continue;
      }

      await playVideo(page, info);
    }

    if (p < maxPage) {
      const nextBtn = page.locator(`li.ant-pagination-item-${p + 1}`);
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click({ force: true });
        await sleep(2000);
      } else {
        console.log('[翻页] 找不到下一页按钮，结束');
        break;
      }
    }
  }

  console.log('\n========================================');
  console.log(`全部完成! 共播放 ${totalWatched} 个视频`);
  console.log('========================================');
  await sleep(3000);
  await browser.close();
}

main().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});