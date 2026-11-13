import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { openBrowser } from '../src/browser.mjs';
import {
  ScopeDriftError,
  ScopeStore,
  buildManifest,
  detectDrift,
  executeConfirmed,
  findRowAcrossPages,
  previewScope,
  reconcile,
  retryFailed,
  waitForPersist,
} from '../src/tags.mjs';

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tags-test-'));
  try {
    await run(new ScopeStore(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('预览固定清单：全选后排除，记录筛选条件、版本、总数与不可选原因', async () => {
  const fixture = await startFixture();
  try {
    const preview = await previewScope(fixture.url, { exclusions: ['M-A'] });
    assert.equal(preview.filter, 'eligible');
    assert.equal(preview.generation, 1);
    assert.equal(preview.totalSelectable, 3);
    assert.deepEqual(preview.scopeKeys, ['M-B', 'M-D']);
    assert.deepEqual(preview.excludedKeys, ['M-A']);
    const blocked = preview.blocked.find(row => row.key === 'M-C');
    assert.match(blocked.reason, /禁用|权限/);
    await assert.rejects(previewScope(fixture.url, { exclusions: ['M-C'] }), /不可选/);
    await assert.rejects(previewScope(fixture.url, { exclusions: ['M-X'] }), /不在当前筛选结果/);
  } finally {
    await fixture.close();
  }
});

test('翻页和排序不改变已确认清单，执行逐单位区分成功、未变、失败', async () => {
  const fixture = await startFixture();
  await withStore(async store => {
    const preview = await previewScope(fixture.url, { exclusions: ['M-A'] });
    const manifest = buildManifest(preview);
    await store.saveManifest(manifest);

    // 确认后翻页、排序、刷新都不允许范围悄悄变化
    const session = await openBrowser(fixture.url);
    try {
      await session.page.locator('#next').click();
      await session.page.locator('#sort').click();
    } finally {
      await session.close();
    }

    const run = await executeConfirmed(fixture.url, manifest, store, { runId: 'run-a' });
    assert.deepEqual(run.scopeKeys, ['M-B', 'M-D']);
    const byKey = Object.fromEntries(run.results.map(row => [row.key, row]));
    assert.equal(byKey['M-B'].state, 'failed');
    assert.match(byKey['M-B'].reason, /锁定/);
    assert.equal(byKey['M-D'].state, 'unchanged');
    assert.deepEqual(run.summary, { failed: 1, unchanged: 1 });

    // 留存可重新读取且摘要自校验
    const reloaded = await store.readRun('run-a');
    assert.deepEqual(reloaded.results, run.results);
    const savedManifest = await store.readManifest(manifest.scopeId);
    assert.deepEqual(savedManifest.scopeKeys, manifest.scopeKeys);

    const check = await openBrowser(fixture.url);
    try {
      const rowD = await findRowAcrossPages(check.page, 'M-D');
      assert.equal(rowD.tagged, true);
      // 排除项 M-A 未被操作
      const rowA = await findRowAcrossPages(check.page, 'M-A');
      assert.equal(rowA.tagged, false);
    } finally {
      await check.close();
    }
  });
  await fixture.close();
});

test('确认后新单位进入筛选：执行被漂移拦截，重新确认后才放行', async () => {
  const fixture = await startFixture();
  await withStore(async store => {
    const manifest = buildManifest(await previewScope(fixture.url, { exclusions: ['M-A'] }));
    await store.saveManifest(manifest);

    const session = await openBrowser(fixture.url);
    try {
      await session.page.locator('#grow').click();
    } finally {
      await session.close();
    }

    await assert.rejects(
      executeConfirmed(fixture.url, manifest, store, { runId: 'run-blocked' }),
      error => error instanceof ScopeDriftError && error.detail.added.includes('M-E'),
    );

    const sessionTwo = await openBrowser(fixture.url);
    try {
      const drift = await detectDrift(sessionTwo.page, manifest);
      assert.deepEqual(drift.added, ['M-E']);
      assert.equal(drift.changed, true);
    } finally {
      await sessionTwo.close();
    }

    // 重新预览并确认：选择把新单位作为排除项的固定清单
    const preview = await previewScope(fixture.url, { exclusions: ['M-A', 'M-E'] });
    assert.deepEqual(preview.scopeKeys, ['M-B', 'M-D']);
    const fixed = buildManifest(preview);
    await store.saveManifest(fixed);
    const run = await executeConfirmed(fixture.url, fixed, store, { runId: 'run-after-drift' });
    assert.ok(!run.results.some(row => row.key === 'M-E'));
  });
  await fixture.close();
});

test('重试只处理仍在确认范围内的失败项，成功与未变原样保留', async () => {
  const fixture = await startFixture();
  await withStore(async store => {
    const manifest = buildManifest(await previewScope(fixture.url, { exclusions: ['M-A'] }));
    const run = await executeConfirmed(fixture.url, manifest, store, { runId: 'run-retry' });
    assert.equal(run.results.find(row => row.key === 'M-B').state, 'failed');
    assert.equal(run.results.find(row => row.key === 'M-D').state, 'unchanged');

    const retried = await retryFailed(fixture.url, manifest, store, run);
    assert.deepEqual(retried.retryKeys, ['M-B']);
    // M-B 在门户中始终锁定，仍失败；M-D 的未变结论没有被重试覆盖
    assert.equal(retried.results.find(row => row.key === 'M-B').state, 'failed');
    assert.equal(retried.results.find(row => row.key === 'M-D').state, 'unchanged');
  });
  await fixture.close();
});

test('失败项失去资质后不再重试；重启核对尊重人工撤销且不做写入', async () => {
  const fixture = await startFixture();
  await withStore(async store => {
    const manifest = buildManifest(await previewScope(fixture.url, { exclusions: ['M-A'] }));
    const run = await executeConfirmed(fixture.url, manifest, store, { runId: 'run-human' });

    // 人工：取消 M-B 资质、撤销 M-D 标签（M-D 可能不在当前页，先跨页定位）
    const human = await openBrowser(fixture.url);
    try {
      await human.page.locator('[data-human-eligibility="M-B"]').click();
      await waitForPersist(human.page);
      await findRowAcrossPages(human.page, 'M-D');
      const revoke = human.page.locator('[data-human-revoke="M-D"]');
      if (await revoke.count()) {
        await revoke.click();
        await waitForPersist(human.page);
      }
      await findRowAcrossPages(human.page, 'M-B');
      assert.equal(await human.page.locator('[data-company][data-key="M-B"]').getAttribute('data-eligible'), 'false');
    } finally {
      await human.close();
    }

    const retried = await retryFailed(fixture.url, manifest, store, run);
    const skip = retried.retrySkips.find(row => row.key === 'M-B');
    assert.match(skip.reason, /不再符合筛选条件/);
    assert.equal(retried.results.find(row => row.key === 'M-B').state, 'skipped');

    // 重启后只读核对
    const before = await (await fetch(fixture.url + '/state')).json();
    const report = await reconcile(fixture.url, manifest);
    const after = await (await fetch(fixture.url + '/state')).json();
    assert.deepEqual(after, before);

    const byKey = Object.fromEntries(report.findings.map(row => [row.key, row]));
    assert.equal(byKey['M-D'].conclusion, 'untagged');
    assert.match(byKey['M-D'].detail, /不自动加回/);
    assert.equal(byKey['M-B'].conclusion, 'ineligible');
    assert.equal(byKey['M-A'].conclusion, 'excluded');
  });
  await fixture.close();
});

test('单位在确认后失去资质：执行时跳过并说明，其余单位照常处理', async () => {
  const fixture = await startFixture();
  await withStore(async store => {
    const manifest = buildManifest(await previewScope(fixture.url, { exclusions: [] }));
    assert.deepEqual(manifest.scopeKeys, ['M-A', 'M-B', 'M-D']);

    const human = await openBrowser(fixture.url);
    try {
      await human.page.locator('[data-human-eligibility="M-A"]').click();
      await waitForPersist(human.page);
    } finally {
      await human.close();
    }

    const run = await executeConfirmed(fixture.url, manifest, store, { runId: 'run-skip' });
    const skipped = run.results.find(row => row.key === 'M-A');
    assert.equal(skipped.state, 'skipped');
    assert.match(skipped.reason, /不符合筛选条件/);
    assert.ok(run.results.some(row => row.key === 'M-B' && row.state === 'failed'));
  });
  await fixture.close();
});
