import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openBrowser } from './browser.mjs';

export const 结果状态 = Object.freeze({
  成功: 'accepted',
  未变: 'unchanged',
  失败: 'failed',
});

/** 筛选结果在确认后发生变化，固定清单不再等于当前筛选结果 */
export class ScopeDriftError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ScopeDriftError';
    this.detail = detail;
  }
}

function fail(message) {
  throw new Error(message);
}

async function readFilter(page) {
  const locator = page.locator('[data-filter]').first();
  const condition = await locator.getAttribute('data-filter');
  const generation = Number(await locator.getAttribute('data-generation'));
  const total = Number(await locator.getAttribute('data-total'));
  return { condition, generation, total };
}

async function readVisibleRows(page) {
  return page.locator('[data-company]').evaluateAll(elements => elements.map(element => ({
    key: element.getAttribute('data-key'),
    name: element.querySelector('[data-name]')?.textContent?.trim() ?? element.textContent.trim(),
    eligible: element.getAttribute('data-eligible') === 'true',
    tagged: element.getAttribute('data-tag') === 'true',
    selectable: element.querySelector('input[data-check]')?.disabled !== true,
  })));
}

/** 逐页枚举全部单位，不依赖页号；返回值按业务键排序 */
async function enumerateAllRows(page) {
  const byKey = new Map();
  let emptyStreak = 0;
  for (let step = 0; step < 100; step += 1) {
    const rows = await readVisibleRows(page);
    let newOnPage = 0;
    for (const row of rows) {
      if (!byKey.has(row.key)) {
        byKey.set(row.key, row);
        newOnPage += 1;
      }
    }
    emptyStreak = newOnPage === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) break;
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#app')?.dataset.ready === 'true');
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 翻页定位某单位所在页，返回该行的最新状态 */
async function locateRow(page, key, rowsPerRound = 10) {
  for (let step = 0; step <= rowsPerRound; step += 1) {
    const row = page.locator(`[data-company][data-key="${key}"]`);
    if (await row.count()) {
      const element = row.first();
      return {
        key,
        name: await element.locator('[data-name]').textContent(),
        eligible: (await element.getAttribute('data-eligible')) === 'true',
        tagged: (await element.getAttribute('data-tag')) === 'true',
        selectable: (await element.locator('input[data-check]').isDisabled()) === false,
      };
    }
    await page.locator('#next').click();
    await page.waitForFunction(() => document.querySelector('#app')?.dataset.ready === 'true');
  }
  fail(`单位 ${key} 在结果页中找不到`);
}

async function waitForSaved(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.dataset.saved === 'true', { timeout: 5000 });
}

/** 供外部在人工点击后等待门户自身保存结束 */
export async function waitForPersist(page) {
  await waitForSaved(page);
}

/** 翻页定位某单位所在页并读取最新状态（供测试与演示跨页核对） */
export async function findRowAcrossPages(page, key) {
  return locateRow(page, key);
}

async function readReceipts(page, expectedKeys) {
  const text = await page.locator('#status').textContent();
  let receipts;
  try {
    receipts = JSON.parse(text);
  } catch {
    fail(`门户未返回逐单位回执：${text}`);
  }
  if (!Array.isArray(receipts)) fail('门户回执格式不正确');
  const got = receipts.map(item => item.key).sort();
  const want = [...expectedKeys].sort();
  if (got.length !== want.length || got.some((key, index) => key !== want[index])) {
    fail(`门户回执与已确认清单不一致：期望 ${want.join('、')}，实际 ${got.join('、')}`);
  }
  return receipts;
}

/**
 * 在页面正常路径中读取筛选条件、结果版本、可选总数与人工排除项，生成固定清单预览。
 * 会真实点击“按筛选全选”并逐项取消排除，不读取页面内部变量。
 */
export async function previewScope(base, { exclusions = [] } = {}) {
  const session = await openBrowser(base);
  try {
    const { page } = session;
    await page.locator('#all').click();
    await waitForSaved(page);
    const filter = await readFilter(page);
    const rows = await enumerateAllRows(page);

    const blocked = rows.filter(row => !row.eligible).map(row => ({
      key: row.key, name: row.name,
      reason: row.selectable ? '当前不满足筛选条件' : '权限受限：复选框被禁用，不允许选择',
    }));

    const eligibleKeys = rows.filter(row => row.eligible).map(row => row.key);
    const uniqueExclusions = [...new Set(exclusions)];
    for (const key of uniqueExclusions) {
      const row = rows.find(item => item.key === key);
      if (!row) fail(`排除项 ${key} 不在当前筛选结果中，无法确认`);
      if (!row.eligible) fail(`排除项 ${key}（${row.name}）本就不可选，原因：权限受限或不符合筛选条件`);
    }
    for (const key of uniqueExclusions) {
      await locateRow(page, key);
      await page.locator(`[data-check="${key}"]`).uncheck();
      await waitForSaved(page);
    }

    const declared = await page.locator('[data-selection]').getAttribute('data-excluded');
    const declaredSet = declared ? declared.split(',').filter(Boolean).sort() : [];
    if (JSON.stringify(declaredSet) !== JSON.stringify([...uniqueExclusions].sort())) {
      fail(`门户登记的排除项与请求不一致：${declaredSet.join('、') || '（空）'}`);
    }
    const selectionMode = await page.locator('[data-selection]').getAttribute('data-selection');
    if (selectionMode !== 'dynamic-all') fail('门户未处于“按筛选全选”语义，无法生成预览');

    const scopeKeys = eligibleKeys.filter(key => !uniqueExclusions.includes(key)).sort();
    const filterNow = await readFilter(page);
    if (filterNow.generation !== filter.generation || filterNow.total !== filter.total) {
      throw new ScopeDriftError('读取预览期间筛选结果发生变动，请重新预览', { before: filter, after: filterNow });
    }

    return {
      filter: filter.condition,
      generation: filter.generation,
      totalSelectable: filter.total,
      scopeKeys,
      excludedKeys: [...uniqueExclusions].sort(),
      blocked,
      rows,
    };
  } finally {
    await session.close();
  }
}

export function buildManifest(preview, { label = '服务标签批量操作' } = {}) {
  if (!preview.scopeKeys.length) fail('操作范围为空，没有可确认的单位');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([preview.filter, preview.generation, preview.scopeKeys, preview.excludedKeys]))
    .digest('hex')
    .slice(0, 12);
  return {
    scopeId: `scope-${preview.generation}-${fingerprint}`,
    label,
    confirmedAt: new Date().toISOString(),
    filter: preview.filter,
    generation: preview.generation,
    totalSelectable: preview.totalSelectable,
    scopeKeys: [...preview.scopeKeys].sort(),
    excludedKeys: [...preview.excludedKeys].sort(),
    blocked: preview.blocked,
  };
}

/**
 * 比较固定清单与当前筛选结果，返回漂移明细（只读，不抛错）。
 * 只有“出现新的可选单位”才构成范围扩大；单位消失或失去资质不扩大范围，按跳过处理。
 */
export async function detectDrift(page, manifest) {
  const filter = await readFilter(page);
  const rows = await enumerateAllRows(page);
  const eligibleNow = rows.filter(row => row.eligible).map(row => row.key).sort();
  const scope = [...manifest.scopeKeys].sort();
  const added = eligibleNow.filter(key => !scope.includes(key) && !manifest.excludedKeys.includes(key));
  const missing = scope.filter(key => !rows.some(row => row.key === key));
  const becameIneligible = scope.filter(key => {
    const row = rows.find(item => item.key === key);
    return row && !row.eligible;
  });
  return {
    confirmedGeneration: manifest.generation,
    currentGeneration: filter.generation,
    added,
    missing,
    becameIneligible,
    changed: filter.generation !== manifest.generation,
  };
}

/** 出现确认时不在清单内的新可选单位即拒绝继续 */
function guardAgainstAdded(detail) {
  if (detail.added.length) {
    throw new ScopeDriftError(
      `筛选结果在确认后新增了可选单位 ${detail.added.join('、')}，固定清单已不是当前全部结果；请选择固定清单重新确认，或重新预览`,
      detail,
    );
  }
}

/** 按固定清单在界面上重建选择（按筛选全选后恢复人工排除项） */
async function rebuildSelection(page, manifest) {
  await page.goto(page.url());
  await page.waitForFunction(() => document.querySelector('#app')?.dataset.ready === 'true');
  guardAgainstAdded(await detectDrift(page, manifest));
  await page.locator('#all').click();
  for (const key of manifest.excludedKeys) {
    await locateRow(page, key);
    await page.locator(`[data-check="${key}"]`).uncheck();
    await waitForSaved(page);
  }
  const rows = await enumerateAllRows(page);
  const currentlyEligible = new Set(rows.filter(row => row.eligible).map(row => row.key));
  // 清单内失去资质的单位会自动掉出勾选集合，按跳过处理；其余清单成员必须全部在选
  const expectedCohort = manifest.scopeKeys.filter(key => currentlyEligible.has(key)).sort();
  const cohortKeys = rows
    .filter(row => row.eligible && !manifest.excludedKeys.includes(row.key))
    .map(row => row.key).sort();
  if (JSON.stringify(cohortKeys) !== JSON.stringify(expectedCohort)) {
    fail('重建选择后的勾选集合与已确认清单不一致，已中止操作');
  }
}

/**
 * 对已确认清单执行一次完整批量操作，逐单位记录成功/未变/失败。
 */
export async function executeConfirmed(base, manifest, store, { runId = randomUUID() } = {}) {
  const session = await openBrowser(base);
  try {
    const { page } = session;
    await rebuildSelection(page, manifest);

    const skips = [];
    for (const key of manifest.scopeKeys) {
      const row = await locateRow(page, key);
      if (!row.eligible) {
        skips.push({ key, name: row.name, state: 'skipped', reason: '单位已不符合筛选条件，不进行操作' });
      }
    }
    const operatingKeys = manifest.scopeKeys.filter(key => !skips.some(skip => skip.key === key));
    if (!operatingKeys.length) fail('已确认清单内已没有仍符合条件的单位');

    await page.locator('#apply').click();
    await waitForSaved(page);
    const receipts = await readReceipts(page, operatingKeys);
    const nameByKey = new Map((await enumerateAllRows(page)).map(row => [row.key, row.name]));

    const results = [
      ...receipts.map(receipt => ({
        key: receipt.key,
        name: nameByKey.get(receipt.key) ?? receipt.key,
        state: receipt.state,
        reason: receipt.reason ?? null,
      })),
      ...skips,
    ].sort((a, b) => a.key.localeCompare(b.key));

    const run = {
      runId,
      scopeId: manifest.scopeId,
      executedAt: new Date().toISOString(),
      scopeKeys: [...manifest.scopeKeys].sort(),
      results,
      summary: summarize(results),
    };
    await store.saveRun(run);
    return run;
  } finally {
    await session.close();
  }
}

function summarize(results) {
  return results.reduce((acc, row) => {
    acc[row.state] = (acc[row.state] ?? 0) + 1;
    return acc;
  }, {});
}

/**
 * 仅重试仍在已确认范围内、且仍符合条件的失败项；成功/未变结果原样保留。
 * 人工撤销标签不会被强行加回。
 */
export async function retryFailed(base, manifest, store, run) {
  const failedKeys = run.results.filter(row => row.state === 结果状态.失败).map(row => row.key);
  if (!failedKeys.length) return run;

  const session = await openBrowser(base);
  try {
    const { page } = session;
    const drift = await detectDrift(page, manifest);
    guardAgainstAdded(drift);
    const candidates = [];
    const skips = [];
    for (const key of failedKeys) {
      const row = await locateRow(page, key);
      if (!manifest.scopeKeys.includes(key)) {
        skips.push({ key, name: row.name, state: 'skipped', reason: '已不在确认范围内，不重试' });
      } else if (!row.eligible) {
        skips.push({ key, name: row.name, state: 'skipped', reason: '单位不再符合筛选条件，不重试' });
      } else {
        candidates.push(key);
      }
    }
    if (!candidates.length) {
      const results = run.results.map(row => {
        const skip = skips.find(item => item.key === row.key);
        return skip ?? row;
      }).sort((a, b) => a.key.localeCompare(b.key));
      const updated = {
        ...run,
        retriedAt: new Date().toISOString(),
        retrySkips: skips,
        drift,
        results,
        summary: summarize(results),
      };
      await store.saveRun(updated);
      return updated;
    }

    // 刷新回到显式空选，再只勾选本轮失败项；成功/未变单位本轮完全不触碰
    await page.goto(page.url());
    await page.waitForFunction(() => document.querySelector('#app')?.dataset.ready === 'true');
    const selectionMode = await page.locator('[data-selection]').getAttribute('data-selection');
    if (selectionMode !== 'explicit') fail('刷新后门户未回到显式选择模式，已中止');
    for (const key of candidates) {
      await locateRow(page, key);
      await page.locator(`[data-check="${key}"]`).check();
      await waitForSaved(page);
    }

    await page.locator('#apply').click();
    await waitForSaved(page);
    const receipts = await readReceipts(page, candidates);
    const latestByName = new Map((await enumerateAllRows(page)).map(row => [row.key, row.name]));
    const retryByKey = new Map(receipts.map(receipt => [receipt.key, receipt]));

    const results = run.results.map(row => {
      const receipt = retryByKey.get(row.key);
      if (!receipt) return row;
      return { key: row.key, name: latestByName.get(row.key) ?? row.name, state: receipt.state, reason: receipt.reason ?? null };
    });
    for (const skip of skips) {
      const index = results.findIndex(row => row.key === skip.key);
      if (index >= 0) results[index] = skip;
    }
    results.sort((a, b) => a.key.localeCompare(b.key));

    const updated = {
      ...run,
      retriedAt: new Date().toISOString(),
      retryKeys: candidates,
      retrySkips: skips,
      drift,
      results,
      summary: summarize(results),
    };
    await store.saveRun(updated);
    return updated;
  } finally {
    await session.close();
  }
}

/**
 * 重启后只读核对：对照固定清单与门户当前状态给出逐单位结论，不做任何写入。
 */
export async function reconcile(base, manifest) {
  const session = await openBrowser(base);
  try {
    const { page } = session;
    const filter = await readFilter(page);
    const rows = await enumerateAllRows(page);
    const byKey = new Map(rows.map(row => [row.key, row]));
    const findings = [];

    for (const key of manifest.scopeKeys) {
      const row = byKey.get(key);
      if (!row) {
        findings.push({ key, name: key, conclusion: 'missing', detail: '单位已从门户结果中消失，未做任何操作' });
      } else if (!row.eligible) {
        findings.push({ key, name: row.name, conclusion: row.tagged ? 'tagged-ineligible' : 'ineligible', detail: '单位已不符合筛选条件，保留门户现状，不加回也不摘除标签' });
      } else if (row.tagged) {
        findings.push({ key, name: row.name, conclusion: 'tagged', detail: '当前带服务标签' });
      } else {
        findings.push({ key, name: row.name, conclusion: 'untagged', detail: '当前不带标签；若为人工撤销则尊重撤销，不自动加回' });
      }
    }
    for (const key of manifest.excludedKeys) {
      const row = byKey.get(key);
      findings.push({ key, name: row?.name ?? key, conclusion: 'excluded', detail: '确认时被人工排除，从未纳入操作范围' });
    }
    for (const row of rows.filter(item => !manifest.scopeKeys.includes(item.key) && !manifest.excludedKeys.includes(item.key))) {
      findings.push({ key: row.key, name: row.name, conclusion: 'outside-scope', detail: '不在已确认清单内（确认后进入筛选的新单位），未做任何操作' });
    }

    return {
      scopeId: manifest.scopeId,
      reconciledAt: new Date().toISOString(),
      confirmedGeneration: manifest.generation,
      currentGeneration: filter.generation,
      findings: findings.sort((a, b) => a.key.localeCompare(b.key)),
    };
  } finally {
    await session.close();
  }
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 固定清单与执行记录的本地留存；写入为原子操作，读取时校验摘要 */
export class ScopeStore {
  constructor(directory) {
    this.directory = directory;
  }
  async #write(path, value) {
    await mkdir(this.directory, { recursive: true });
    const record = { digest: digestOf(value), value };
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
    await rename(temporary, path);
    return record;
  }
  async #read(path) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (digestOf(record.value) !== record.digest) throw new Error('留存记录校验失败');
    return record.value;
  }
  async saveManifest(manifest) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(manifest.scopeId)) throw new Error('清单标识无效');
    await this.#write(join(this.directory, `${manifest.scopeId}.manifest.json`), manifest);
    return manifest;
  }
  async readManifest(scopeId) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(scopeId)) throw new Error('清单标识无效');
    return this.#read(join(this.directory, `${scopeId}.manifest.json`));
  }
  async saveRun(run) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(run.runId)) throw new Error('执行标识无效');
    await this.#write(join(this.directory, `${run.runId}.run.json`), run);
    return run;
  }
  async readRun(runId) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(runId)) throw new Error('执行标识无效');
    return this.#read(join(this.directory, `${runId}.run.json`));
  }
}
