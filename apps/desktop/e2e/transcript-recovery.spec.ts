/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { Page } from '@playwright/test';
import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { awaitSendReady, COMPOSER_INPUT, expect, test } from './fixtures';

async function send(page: Page, prompt: string): Promise<void> {
  await page.locator(COMPOSER_INPUT).fill(prompt);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
}

async function expectCompleted(page: Page, prompts: string[]): Promise<void> {
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(prompts.length, {
    timeout: 20_000,
  });
  await expectPrompts(page, prompts);
  for (const prompt of prompts) {
    await expect(page.getByRole('log').getByText(`Fake backend received: ${prompt}`, {
      exact: false,
    })).toHaveCount(1);
  }
}

async function expectPrompts(page: Page, prompts: string[]): Promise<void> {
  const messages = page.getByLabel('你发送的消息');
  await expect(messages).toHaveCount(prompts.length);
  for (const [index, prompt] of prompts.entries()) {
    await expect(messages.nth(index).getByText(prompt, { exact: true })).toHaveCount(1);
  }
}

test('completed transcript keeps exact order and cardinality across renderer reloads', async ({
  window: page,
}) => {
  const prompts = ['transcript first completed turn', 'transcript second completed turn'];
  await send(page, prompts[0]!);
  await expectCompleted(page, prompts.slice(0, 1));
  await send(page, prompts[1]!);
  await expectCompleted(page, prompts);
  for (let reload = 0; reload < 2; reload += 1) {
    await page.reload();
    await expectCompleted(page, prompts);
  }
});

test('live transcript survives renderer replacement and settles without duplicate output', async ({
  window: page,
}) => {
  await send(page, FAKE_HOLD_OPEN_PROMPT);
  const output = 'Fake backend waiting for the test to stop the Turn.';
  await expect(page.locator('.maka-bubble-streaming')).toContainText(output);
  await page.reload();
  await expect(page.locator('.maka-bubble-streaming')).toContainText(output);
  await expect(page.getByLabel('你发送的消息')).toHaveCount(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.getByRole('log').getByText(output, { exact: false })).toHaveCount(1);
});

test('an explicitly stopped turn remains terminal after reload and accepts a fresh turn', async ({
  window: page,
}) => {
  await send(page, FAKE_HOLD_OPEN_PROMPT);
  await expect(page.locator('.maka-bubble-streaming')).toContainText('Fake backend waiting');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await send(page, 'fresh turn after explicit stop');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(2);
  await expectPrompts(page, [
    FAKE_HOLD_OPEN_PROMPT,
    'fresh turn after explicit stop',
  ]);
  await expect(page.getByRole('log').getByText('Fake backend received: fresh turn after explicit stop', {
    exact: false,
  })).toHaveCount(1);
});

test('completed transcript reopens from the same isolated storage after Desktop restart', async ({
  restartableWindow,
}) => {
  const prompts = ['durable transcript before desktop restart'];
  await send(restartableWindow.page, prompts[0]!);
  await expectCompleted(restartableWindow.page, prompts);
  const page = await restartableWindow.restart();
  await expectCompleted(page, prompts);
  await send(page, 'durable transcript after desktop restart');
  await expectCompleted(page, [...prompts, 'durable transcript after desktop restart']);
});
