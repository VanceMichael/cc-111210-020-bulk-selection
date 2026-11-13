import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { openBrowser } from './browser.mjs';
import {
  ScopeDriftError,
  ScopeStore,
  buildManifest,
  executeConfirmed,
  findRowAcrossPages,
  previewScope,
  reconcile,
  retryFailed,
  waitForPersist,
} from './tags.mjs';

function section(title) {
  console.log(`\n========== ${title} ==========`);
}

function printRun(run) {
  console.log(`执行单 ${run.runId}（清单 ${run.scopeId}） 汇总：`, JSON.stringify(run.summary));
  for (const row of run.results) {
    const reason = row.reason ? `，原因：${row.reason}` : (row.state === 'skipped' ? `，原因：${row.detail ?? ''}` : '');
    console.log(`  - ${row.key} ${row.name}：${row.state}${reason}`);
  }
}

const directory = await mkdtemp(join(tmpdir(), 'bulk-tags-demo-'));
const fixture = await startFixture();
const store = new ScopeStore(directory);
let failure = false;

try {
  // 场景一：按筛选全选后人工排除一家，确认固定清单
  section('场景一：全选当前筛选结果并人工排除 M-A，生成可核对的操作范围预览');
  const preview = await previewScope(fixture.url, { exclusions: ['M-A'] });
  console.log('筛选条件：', preview.filter);
  console.log('结果版本 generation：', preview.generation);
  console.log('可选总数：', preview.totalSelectable);
  console.log('固定清单（已排除 M-A）：', preview.scopeKeys.join('、'));
  console.log('人工排除项：', preview.excludedKeys.join('、'));
  console.log('不可选/权限受限行：');
  for (const row of preview.blocked) console.log(`  - ${row.key}：${row.reason}`);

  const manifest = buildManifest(preview);
  await store.saveManifest(manifest);
  console.log('已确认并留存清单：', manifest.scopeId);

  // 场景二：确认后新单位进入筛选，旧“全选”授权不能悄悄扩大
  section('场景二：确认后新单位 M-E 进入筛选，固定清单拒绝自动扩大');
  {
    const session = await openBrowser(fixture.url);
    try {
      await session.page.locator('#grow').click();
      await waitForPersist(session.page);
      console.log('新单位 M-E 已进入，结果版本变为：', await session.page.locator('[data-filter]').getAttribute('data-generation'));
    } finally {
      await session.close();
    }
    try {
      await executeConfirmed(fixture.url, manifest, store, { runId: 'run-blocked-drift' });
      failure = true;
      console.log('错误：范围扩大时执行未被拦截');
    } catch (error) {
      if (error instanceof ScopeDriftError) {
        console.log('已拦截执行：', error.message);
        console.log('漂移明细：', JSON.stringify(error.detail));
      } else throw error;
    }
    console.log('处理方式：重新预览并确认新清单（演示中确认包含 M-E 的新固定清单）');
    const previewTwo = await previewScope(fixture.url, { exclusions: ['M-A'] });
    const manifestTwo = buildManifest(previewTwo, { label: '包含新单位的第二批操作' });
    await store.saveManifest(manifestTwo);
    console.log('新清单范围：', manifestTwo.scopeKeys.join('、'), '版本：', manifestTwo.generation);

    // 回到最初确认的清单语义：演示“选择固定清单”而非动态集合，重新确认不含 M-E 的清单
    const previewFixed = await previewScope(fixture.url, { exclusions: ['M-A', 'M-E'] });
    const manifestFixed = buildManifest(previewFixed, { label: '固定清单（不含新进入单位）' });
    await store.saveManifest(manifestFixed);
    console.log('选择固定清单后确认范围：', manifestFixed.scopeKeys.join('、'), '，M-E 作为排除项：', manifestFixed.excludedKeys.join('、'));

    // 场景三：执行，逐单位区分成功/未变/失败
    section('场景三：按固定清单执行，页面逐单位返回成功、未变与失败');
    const run = await executeConfirmed(fixture.url, manifestFixed, store, { runId: 'run-first' });
    printRun(run);
    console.log('说明：M-B 被门户暂时锁定而失败；M-D 原本已有标签，记为未变；M-E 不在固定清单内，未被操作。');

    // 场景四：只重试仍在范围内的失败项
    section('场景四：重试只针对仍在已确认范围内的失败项 M-B');
    const retried = await retryFailed(fixture.url, manifestFixed, store, run);
    printRun(retried);
    if (retried.retryKeys) console.log('本轮实际重试：', retried.retryKeys.join('、'));

    // 场景五：人工撤销与取消资质后，重启浏览器核对，不强行加回
    section('场景五：人工撤销 M-A 范围外不动；对清单内单位做人工变更后重启核对');
    {
      const session = await openBrowser(fixture.url);
      try {
        // M-D 在清单内且带标签：先翻页定位，再人工撤销标签
        await findRowAcrossPages(session.page, 'M-D');
        const revoke = session.page.locator('[data-human-revoke="M-D"]');
        if (await revoke.count()) {
          await revoke.click();
          await waitForPersist(session.page);
          console.log('人工撤销了 M-D 的服务标签');
        }
        // M-B 在清单内：人工取消资质（先翻页定位）
        await findRowAcrossPages(session.page, 'M-B');
        await session.page.locator('[data-human-eligibility="M-B"]').click();
        await waitForPersist(session.page);
        console.log('人工取消了 M-B 的参展资质');
      } finally {
        await session.close();
      }
    }
    const restarted = await reconcile(fixture.url, manifestFixed);
    console.log('核对时间：', restarted.reconciledAt);
    console.log(`确认版本 ${restarted.confirmedGeneration}，当前版本 ${restarted.currentGeneration}`);
    for (const finding of restarted.findings) {
      console.log(`  - ${finding.key} ${finding.name}：${finding.conclusion}（${finding.detail}）`);
    }
    console.log('核对为只读操作：未点击添加标签，人工撤销的 M-D 不会被自动加回，失去资质的 M-B 保留门户现状。');
  }
} catch (error) {
  failure = true;
  console.error('演示失败：', error);
} finally {
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
  if (failure) process.exit(1);
}
