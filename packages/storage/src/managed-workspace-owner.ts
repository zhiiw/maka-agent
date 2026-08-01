import {
  createGitWorkspaceService,
  type CreateManagedWorkspaceFromSourceInput,
  GitWorkspaceServiceError,
  type GitWorkspaceService,
  type GitWorkspaceServiceFailpoint,
  type ManagedWorkspaceBinding,
  type VerifiedGitRuntimeInput,
} from './git-workspace-service.js';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  runWithStorageRootLease,
  type InteractiveRootOwner,
} from './root-authority.js';

export type ManagedWorkspaceOwnerErrorCode =
  | 'managed_workspace_owner_conflict'
  | 'managed_workspace_owner_unavailable'
  | 'managed_workspace_owner_closing'
  | 'managed_workspace_quarantined';

export class ManagedWorkspaceOwnerError extends Error {
  constructor(
    readonly code: ManagedWorkspaceOwnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagedWorkspaceOwnerError';
  }
}

export interface OpenManagedWorkspaceOwnerInput {
  readonly rootOwner: InteractiveRootOwner;
  readonly gitRuntime: VerifiedGitRuntimeInput;
  readonly failpoint?: (point: GitWorkspaceServiceFailpoint) => void | Promise<void>;
}

export interface ManagedWorkspaceOwner {
  readonly state: 'ready' | 'closing' | 'closed';
  createManagedWorkspaceFromSource(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBinding>;
  openManagedWorkspaceFromBinding(
    binding: ManagedWorkspaceBinding,
  ): Promise<ManagedWorkspaceBinding>;
  close(): Promise<void>;
}

const owners = new WeakMap<InteractiveRootOwner, object>();

export async function openManagedWorkspaceOwner(
  input: OpenManagedWorkspaceOwnerInput,
): Promise<ManagedWorkspaceOwner> {
  const rootOwner = authenticateInteractiveRootOwner(input.rootOwner);
  await assertInteractiveRootOwner(rootOwner);
  if (owners.has(rootOwner)) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_conflict',
      'This storage root owner already has a managed workspace owner',
    );
  }

  const claim = {};
  owners.set(rootOwner, claim);
  try {
    const service = createGitWorkspaceService({
      storageRoot: rootOwner.capability.canonicalPath,
      gitRuntime: input.gitRuntime,
      ...(input.failpoint ? { failpoint: input.failpoint } : {}),
    });
    await runWithStorageRootLease(rootOwner.lease, 'interactive', 'write', () =>
      service.assertAvailable(),
    );
    // The root owner may begin closing while capability initialization is in
    // flight. Revalidate after the lease-bound operation so a stale lifecycle
    // owner is never published as ready.
    await assertInteractiveRootOwner(rootOwner);
    const owner = new ManagedWorkspaceOwnerImpl(rootOwner, service);
    owners.set(rootOwner, owner);
    return owner;
  } catch (error) {
    if (owners.get(rootOwner) === claim) owners.delete(rootOwner);
    if (error instanceof ManagedWorkspaceOwnerError) throw error;
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Unable to initialize the managed workspace owner',
      { cause: error },
    );
  }
}

class ManagedWorkspaceOwnerImpl implements ManagedWorkspaceOwner {
  #state: 'ready' | 'closing' | 'closed' = 'ready';
  #activeOperations = 0;
  readonly #drainWaiters = new Set<() => void>();
  #closeTask: Promise<void> | undefined;

  constructor(
    private readonly rootOwner: InteractiveRootOwner,
    private readonly service: GitWorkspaceService,
  ) {}

  get state(): 'ready' | 'closing' | 'closed' {
    return this.#state;
  }

  async createManagedWorkspaceFromSource(
    input: CreateManagedWorkspaceFromSourceInput,
  ): Promise<ManagedWorkspaceBinding> {
    return this.#run(async () =>
      this.#requireReady(await this.service.createManagedWorkspaceFromSource(input)),
    );
  }

  async openManagedWorkspaceFromBinding(
    binding: ManagedWorkspaceBinding,
  ): Promise<ManagedWorkspaceBinding> {
    return this.#run(async () => {
      try {
        return await this.#requireReady(
          await this.service.openManagedWorkspaceFromBinding(binding),
        );
      } catch (error) {
        if (
          !(error instanceof GitWorkspaceServiceError) ||
          error.code !== 'managed_workspace_drifted'
        ) {
          throw error;
        }
        const quarantine = await this.service.quarantineManagedWorkspace(
          binding,
          'external_workspace_drift',
        );
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_quarantined',
          `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
          { cause: error },
        );
      }
    });
  }

  close(): Promise<void> {
    this.#closeTask ??= (async () => {
      this.#state = 'closing';
      await this.#waitForDrain();
      this.#state = 'closed';
    })();
    return this.#closeTask;
  }

  #assertReady(): void {
    if (this.#state !== 'ready') {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_owner_closing',
        'Managed workspace owner is closing or closed',
      );
    }
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertReady();
    this.#activeOperations += 1;
    try {
      return await runWithStorageRootLease(this.rootOwner.lease, 'interactive', 'write', operation);
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters.clear();
      }
    }
  }

  #waitForDrain(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  async #requireReady(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBinding> {
    const inspection = await this.service.inspectManagedWorkspace(binding);
    if (inspection.state === 'ready') return binding;
    const quarantine = await this.service.quarantineManagedWorkspace(
      binding,
      'external_workspace_drift',
    );
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_quarantined',
      `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
    );
  }
}
