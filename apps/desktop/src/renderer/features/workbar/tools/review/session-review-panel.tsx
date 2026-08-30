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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { redactSecrets as displayRedactSecrets } from '@maka/core/display-redaction';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type GitReviewReadResult } from '@maka/core/git-review';
import type {
  ManagedWorkspacePublishResult,
  ManagedWorkspaceHistoricalRestoreResult,
  ManagedWorkspaceHistoryResult,
  ManagedWorkspaceHistoryUndoResult,
  ManagedWorkspaceRestoreResult,
  ManagedWorkspaceRebaselineResult,
} from '@maka/runtime-host/protocol';
import { DiffCodePreview, useUiLocale } from '@maka/ui';
import { ICON_SIZE, GitBranch } from '@maka/ui/icons';
import { getDesktopConversationCopy } from '../../../../locales/conversation-copy';
import { useWorkbarServices } from '../../services-context.js';

const REVIEW_FILE_PAGE_SIZE = 20;
const REVIEW_DIFF_LINE_CAP = 500;
const REVIEW_SKELETON_ROWS = [0, 1, 2, 3] as const;

function boundedDiff(diff: string) {
  const lines = displayRedactSecrets(diff).split('\n');
  if (lines.length <= REVIEW_DIFF_LINE_CAP) {
    return { body: lines.join('\n'), hiddenLines: 0 };
  }
  return {
    body: lines.slice(0, REVIEW_DIFF_LINE_CAP).join('\n'),
    hiddenLines: lines.length - REVIEW_DIFF_LINE_CAP,
  };
}

export function SessionReviewPanel(props: {
  sessionId: string;
  active: boolean;
}) {
  const { review } = useWorkbarServices();
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).reviewPanel;
  const [gitResult, setGitResult] = useState<GitReviewReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [visibleFileCount, setVisibleFileCount] = useState(REVIEW_FILE_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<ManagedWorkspacePublishResult | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restored, setRestored] = useState<ManagedWorkspaceRestoreResult | null>(null);
  const [history, setHistory] = useState<ManagedWorkspaceHistoryResult | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRestoringVersion, setHistoryRestoringVersion] = useState<string | null>(null);
  const [historyRestoreError, setHistoryRestoreError] = useState<string | null>(null);
  const [historicalRestore, setHistoricalRestore] =
    useState<ManagedWorkspaceHistoricalRestoreResult | null>(null);
  const [historyUndoingVersion, setHistoryUndoingVersion] = useState<string | null>(null);
  const [historyUndoError, setHistoryUndoError] = useState<string | null>(null);
  const [historyUndo, setHistoryUndo] = useState<ManagedWorkspaceHistoryUndoResult | null>(null);
  const [rebaselining, setRebaselining] = useState(false);
  const [rebaselineError, setRebaselineError] = useState<string | null>(null);
  const [rebaselined, setRebaselined] = useState<ManagedWorkspaceRebaselineResult | null>(null);
  const revisionRef = useRef(0);
  const publishIdRef = useRef<string | null>(null);
  const restoreIdRef = useRef<string | null>(null);
  const historyRestoreIdsRef = useRef(new Map<string, string>());
  const historyUndoIdsRef = useRef(new Map<string, string>());
  const rebaselineIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextGit = await review.read({
        sessionId: props.sessionId,
        source: 'branch',
      });
      if (revision !== revisionRef.current) return;
      setGitResult(nextGit);
      if (nextGit.ok && nextGit.snapshot.repositoryRoot.startsWith('maka-managed://')) {
        try {
          const nextHistory = await review.history({ sessionId: props.sessionId, limit: 50 });
          if (revision !== revisionRef.current) return;
          setHistory(nextHistory);
          setHistoryError(null);
        } catch (nextError) {
          if (revision !== revisionRef.current) return;
          setHistory(null);
          setHistoryError(
            locale === 'zh'
              ? generalizedErrorMessageChinese(nextError, copy.historyLoadFailed)
              : generalizedErrorMessage(nextError, copy.historyLoadFailed),
          );
        }
      } else {
        setHistory(null);
        setHistoryError(null);
      }
    } catch (nextError) {
      if (revision === revisionRef.current) {
        setError(
          locale === 'zh'
            ? generalizedErrorMessageChinese(nextError, copy.loadFailed)
            : generalizedErrorMessage(nextError, copy.loadFailed),
        );
      }
    } finally {
      if (revision === revisionRef.current) setLoading(false);
    }
  }, [copy.historyLoadFailed, copy.loadFailed, locale, props.sessionId, review]);

  useEffect(() => {
    if (!props.active) return;
    let timer: number | undefined;
    const unsubscribe = review.subscribeSessionEvents(
      props.sessionId,
      (event) => {
        if (event.type !== 'tool_result' && event.type !== 'complete') return;
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => void load(), 250);
      },
    );
    const refreshAfterExternalChange = () => {
      if (document.visibilityState === 'hidden') return;
      void load();
    };
    window.addEventListener('focus', refreshAfterExternalChange);
    document.addEventListener('visibilitychange', refreshAfterExternalChange);
    void load();
    return () => {
      revisionRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshAfterExternalChange);
      document.removeEventListener('visibilitychange', refreshAfterExternalChange);
      unsubscribe();
    };
  }, [load, props.active, props.sessionId, review]);

  const gitSnapshot = gitResult?.ok ? gitResult.snapshot : null;
  const gitFiles = gitSnapshot?.files ?? [];
  const visibleGitFiles = gitFiles.slice(0, visibleFileCount);
  const remainingGitFiles = Math.max(0, gitFiles.length - visibleGitFiles.length);
  const stats = {
    files: gitFiles.length,
    additions: gitSnapshot?.additions ?? 0,
    deletions: gitSnapshot?.deletions ?? 0,
  };
  const sourceError =
    gitResult?.ok !== false
      ? null
      : gitResult.reason === 'not_git_repository'
        ? copy.notGitRepository
        : gitResult.reason === 'workspace_unavailable'
          ? copy.workspaceUnavailable
          : gitResult.reason === 'unborn_repository'
            ? copy.unbornRepository
            : gitResult.reason === 'invalid_base_branch'
              ? copy.invalidBaseBranch
              : copy.gitFailed;
  const empty = !loading && !error && !sourceError && gitFiles.length === 0;
  useEffect(() => {
    setVisibleFileCount(REVIEW_FILE_PAGE_SIZE);
    setPublished(null);
    setPublishError(null);
    setRestored(null);
    setRestoreError(null);
    publishIdRef.current = null;
    restoreIdRef.current = null;
    setHistoricalRestore(null);
    setHistoryRestoreError(null);
    historyRestoreIdsRef.current.clear();
    setHistoryUndo(null);
    setHistoryUndoError(null);
    historyUndoIdsRef.current.clear();
  }, [gitSnapshot?.revision]);

  const publishSnapshot = useCallback(async () => {
    if (!gitSnapshot || publishing || published) return;
    const publishId = publishIdRef.current ?? `desktop-${crypto.randomUUID()}`;
    publishIdRef.current = publishId;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await review.publish({
        sessionId: props.sessionId,
        publishId,
      });
      setPublished(result);
    } catch (nextError) {
      setPublishError(
        locale === 'zh'
          ? generalizedErrorMessageChinese(nextError, copy.publishFailed)
          : generalizedErrorMessage(nextError, copy.publishFailed),
      );
    } finally {
      setPublishing(false);
    }
  }, [copy.publishFailed, gitSnapshot, locale, props.sessionId, published, publishing, review]);

  const restoreSnapshot = useCallback(async () => {
    if (!gitSnapshot || restoring || restored) return;
    const restoreId = restoreIdRef.current ?? `desktop-${crypto.randomUUID()}`;
    restoreIdRef.current = restoreId;
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await review.restore({
        sessionId: props.sessionId,
        restoreId,
      });
      setRestored(result);
    } catch (nextError) {
      setRestoreError(
        locale === 'zh'
          ? generalizedErrorMessageChinese(nextError, copy.restoreFailed)
          : generalizedErrorMessage(nextError, copy.restoreFailed),
      );
    } finally {
      setRestoring(false);
    }
  }, [copy.restoreFailed, gitSnapshot, locale, props.sessionId, restored, restoring, review]);

  const restoreHistoricalVersion = useCallback(
    async (workspaceVersionId: string) => {
      if (historyRestoringVersion !== null) return;
      const restoreId =
        historyRestoreIdsRef.current.get(workspaceVersionId) ?? `desktop-${crypto.randomUUID()}`;
      historyRestoreIdsRef.current.set(workspaceVersionId, restoreId);
      setHistoryRestoringVersion(workspaceVersionId);
      setHistoryRestoreError(null);
      try {
        setHistoricalRestore(
          await review.restoreVersion({
            sessionId: props.sessionId,
            workspaceVersionId,
            restoreId,
          }),
        );
      } catch (nextError) {
        setHistoryRestoreError(
          locale === 'zh'
            ? generalizedErrorMessageChinese(nextError, copy.historyRestoreFailed)
            : generalizedErrorMessage(nextError, copy.historyRestoreFailed),
        );
      } finally {
        setHistoryRestoringVersion(null);
      }
    },
    [copy.historyRestoreFailed, historyRestoringVersion, locale, props.sessionId, review],
  );

  const undoHistoricalVersion = useCallback(
    async (workspaceVersionId: string) => {
      if (historyUndoingVersion !== null) return;
      const restoreId =
        historyUndoIdsRef.current.get(workspaceVersionId) ?? `desktop-${crypto.randomUUID()}`;
      historyUndoIdsRef.current.set(workspaceVersionId, restoreId);
      setHistoryUndoingVersion(workspaceVersionId);
      setHistoryUndoError(null);
      try {
        const result = await review.undoVersion({
          sessionId: props.sessionId,
          workspaceVersionId,
          restoreId,
        });
        setHistoryUndo(result);
        await load();
      } catch (nextError) {
        setHistoryUndoError(
          locale === 'zh'
            ? generalizedErrorMessageChinese(nextError, copy.historyUndoFailed)
            : generalizedErrorMessage(nextError, copy.historyUndoFailed),
        );
      } finally {
        setHistoryUndoingVersion(null);
      }
    },
    [copy.historyUndoFailed, historyUndoingVersion, load, locale, props.sessionId, review],
  );

  const rebaselineWorkspace = useCallback(async () => {
    if (rebaselining) return;
    const rebaselineId = rebaselineIdRef.current ?? `desktop-${crypto.randomUUID()}`;
    rebaselineIdRef.current = rebaselineId;
    setRebaselining(true);
    setRebaselineError(null);
    try {
      const result = await review.rebaseline({ sessionId: props.sessionId, rebaselineId });
      setRebaselined(result);
      await load();
    } catch (nextError) {
      setRebaselineError(
        locale === 'zh'
          ? generalizedErrorMessageChinese(nextError, copy.rebaselineFailed)
          : generalizedErrorMessage(nextError, copy.rebaselineFailed),
      );
    } finally {
      setRebaselining(false);
    }
  }, [copy.rebaselineFailed, load, locale, props.sessionId, rebaselining, review]);

  return (
    <Section
      variant="transparent"
      padding={4}
      className="maka-session-review-panel"
      role="region"
      aria-label={copy.ariaLabel}
      aria-busy={loading || undefined}
    >
      <VStack gap={3} align="stretch" width="100%">
        {loading && gitResult === null ? (
          <VStack
            gap={2}
            align="stretch"
            aria-hidden="true"
          >
            <Skeleton width="42%" height={16} radius="rounded" index={0} />
            <div className="maka-session-review-loading-list">
              {REVIEW_SKELETON_ROWS.map((index) => (
                <Skeleton key={index} width="100%" height={36} radius={0} index={index + 1} />
              ))}
            </div>
          </VStack>
        ) : null}
        {gitSnapshot && gitFiles.length > 0 ? (
          <VStack gap={1} align="start" className="maka-session-review-summary">
            <Text type="label">{copy.changedFiles(stats.files)}</Text>
            <HStack gap={3} align="center">
              <Text
                type="supporting"
                hasTabularNumbers
                className="maka-session-review-additions"
              >
                {copy.addedLines(stats.additions)}
              </Text>
              <Text
                type="supporting"
                hasTabularNumbers
                className="maka-session-review-deletions"
              >
                {copy.deletedLines(stats.deletions)}
              </Text>
            </HStack>
          </VStack>
        ) : null}
        {gitSnapshot ? (
          <HStack gap={2} align="center" justify="end">
            <Button
              variant="ghost"
              size="sm"
              label={rebaselining ? copy.rebaselining : copy.rebaseline}
              isLoading={rebaselining}
              isDisabled={rebaselining}
              onClick={() => void rebaselineWorkspace()}
            />
            <Button
              variant="ghost"
              size="sm"
              label={restoring ? copy.restoring : restored ? copy.restored : copy.restore}
              isLoading={restoring}
              isDisabled={restoring || restored !== null}
              onClick={() => void restoreSnapshot()}
            />
            <Button
              variant="secondary"
              size="sm"
              label={publishing ? copy.publishing : published ? copy.published : copy.publish}
              isLoading={publishing}
              isDisabled={publishing || published !== null}
              onClick={() => void publishSnapshot()}
            />
          </HStack>
        ) : null}
        {published ? (
          <Banner status="success" title={copy.publishedDetail(published.publishedRef)} />
        ) : null}
        {restored ? (
          <Banner
            status="success"
            title={copy.restoredDetail(
              restored.destinationPath,
              restored.filesMaterialized,
              restored.bytesMaterialized,
            )}
          />
        ) : null}
        {restoreError ? (
          <Banner
            status="error"
            title={restoreError}
            endContent={
              <Button
                variant="ghost"
                size="sm"
                label={copy.retryRestore}
                isLoading={restoring}
                onClick={() => void restoreSnapshot()}
              />
            }
          />
        ) : null}
        {historyError ? <Banner status="error" title={historyError} /> : null}
        {historicalRestore ? (
          <Banner
            status="success"
            title={copy.historyRestoredDetail(
              historicalRestore.destinationPath,
              historicalRestore.filesMaterialized,
            )}
          />
        ) : null}
        {historyRestoreError ? <Banner status="error" title={historyRestoreError} /> : null}
        {historyUndo ? <Banner status="success" title={copy.historyUndone} /> : null}
        {historyUndoError ? <Banner status="error" title={historyUndoError} /> : null}
        {rebaselined ? <Banner status="success" title={copy.rebaselined} /> : null}
        {rebaselineError ? <Banner status="error" title={rebaselineError} /> : null}
        {publishError ? (
          <Banner
            status="error"
            title={publishError}
            endContent={
              <Button
                variant="ghost"
                size="sm"
                label={copy.retryPublish}
                isLoading={publishing}
                onClick={() => void publishSnapshot()}
              />
            }
          />
        ) : null}
        {error ? (
          <Banner
            status="error"
            title={error}
            endContent={
              <HStack gap={1} align="center">
                <Button
                  variant="ghost"
                  size="sm"
                  label={rebaselining ? copy.rebaselining : copy.rebaseline}
                  isLoading={rebaselining}
                  onClick={() => void rebaselineWorkspace()}
                />
                <Button variant="ghost" size="sm" label={copy.retry} onClick={() => void load()} />
              </HStack>
            }
          />
        ) : null}
        {/* A source that cannot be read is a failure, not an absence — it takes
            the same Banner the load error above does, not an EmptyState. */}
        {sourceError ? (
          <Banner
            status="error"
            title={sourceError}
            endContent={
              <Button
                variant="ghost"
                size="sm"
                label={copy.retry}
                isLoading={loading}
                onClick={() => void load()}
              />
            }
          />
        ) : null}
        {gitSnapshot?.truncated ? (
          <Banner status="info" title={copy.truncated} />
        ) : null}
        {empty ? (
          /* Panel empty (DESIGN.md §10 tier 2): the whole panel is empty, so it
             carries icon and description, not the compact form. */
          (<EmptyState
            icon={<GitBranch size={ICON_SIZE.empty} aria-hidden />}
            title={copy.empty}
            description={copy.emptyHelp}
          />)
        ) : null}
        {gitFiles.length > 0 ? (
          <div className="maka-session-review-list">
            <CollapsibleGroup
              key={gitSnapshot?.revision}
              type="single"
              hasDividers
              density="compact"
              role="list"
              aria-label={copy.changedFiles(gitFiles.length)}
            >
              {visibleGitFiles.map((file) => {
                const preview = boundedDiff(file.diff);
                return (
                  <Collapsible
                    key={`${gitSnapshot?.revision}:${file.path}`}
                    value={file.path}
                    className="maka-session-review-file"
                    role="listitem"
                    trigger={
                      <HStack
                        as="span"
                        gap={2}
                        align="center"
                        justify="between"
                        width="100%"
                        className="maka-session-review-file-trigger"
                      >
                        <Text
                          type="code"
                          maxLines={1}
                          className="maka-session-review-file-path"
                        >
                          {file.path}
                        </Text>
                        <HStack
                          as="span"
                          gap={2}
                          align="center"
                          className="maka-session-review-file-stats"
                        >
                          {file.additions > 0 ? (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="maka-session-review-additions"
                            >
                              {copy.added(file.additions)}
                            </Text>
                          ) : null}
                          {file.deletions > 0 ? (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="maka-session-review-deletions"
                            >
                              {copy.deleted(file.deletions)}
                            </Text>
                          ) : null}
                        </HStack>
                      </HStack>
                    }
                  >
                    <DiffCodePreview
                      diff={preview.body}
                      paths={[file.path]}
                      className="maka-session-review-diff"
                    />
                    {preview.hiddenLines > 0 ? (
                      <Text type="supporting" color="secondary" display="block">
                        {copy.hiddenLines(preview.hiddenLines)}
                      </Text>
                    ) : null}
                  </Collapsible>
                );
              })}
            </CollapsibleGroup>
            {remainingGitFiles > 0 ? (
              <div className="maka-session-review-more">
                <Button
                  variant="ghost"
                  size="sm"
                  label={copy.showMore(remainingGitFiles)}
                  onClick={() =>
                    setVisibleFileCount((current) =>
                      Math.min(gitFiles.length, current + REVIEW_FILE_PAGE_SIZE),
                    )
                  }
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {history ? (
          <VStack gap={2} align="stretch" className="maka-session-review-history">
            <Text type="label">{copy.historyTitle}</Text>
            {history.versions.map((version) => {
              const isHead = version.workspaceVersionId === history.headWorkspaceVersionId;
              const isRestoring = historyRestoringVersion === version.workspaceVersionId;
              const isUndoing = historyUndoingVersion === version.workspaceVersionId;
              return (
                <HStack
                  key={version.workspaceVersionId}
                  gap={2}
                  align="center"
                  justify="between"
                  width="100%"
                >
                  <VStack gap={0} align="start">
                    <Text type="supporting">
                      {isHead
                        ? copy.historyCurrent
                        : version.kind === 'baseline'
                          ? copy.historyBaseline
                          : copy.historyMutation(version.changedFileCount)}
                    </Text>
                    <Text type="supporting" color="secondary">
                      {new Date(version.committedAt).toLocaleString(
                        locale === 'zh' ? 'zh-CN' : 'en-US',
                      )}
                    </Text>
                  </VStack>
                  {!isHead ? (
                    <HStack gap={1} align="center">
                      <Button
                        variant="ghost"
                        size="sm"
                        label={isRestoring ? copy.restoring : copy.historyRestore}
                        isLoading={isRestoring}
                        isDisabled={historyRestoringVersion !== null || historyUndoingVersion !== null}
                        onClick={() => void restoreHistoricalVersion(version.workspaceVersionId)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        label={isUndoing ? copy.historyUndoing : copy.historyUndo}
                        isLoading={isUndoing}
                        isDisabled={historyRestoringVersion !== null || historyUndoingVersion !== null}
                        onClick={() => void undoHistoricalVersion(version.workspaceVersionId)}
                      />
                    </HStack>
                  ) : null}
                </HStack>
              );
            })}
            {history.hasMore ? (
              <Text type="supporting" color="secondary">
                {copy.historyTruncated}
              </Text>
            ) : null}
          </VStack>
        ) : null}
      </VStack>
    </Section>
  );
}
