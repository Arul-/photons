import { Photon } from '@portel/photon-core';

/**
 * Group Scheduler — dynamic scheduled tasks for WhatsApp groups.
 *
 * Each task runs a prompt against a group context on a cron schedule.
 * When a task fires, it emits { type: 'task:fire' } — the agent runner
 * (e.g. nanoclaw's container-runner) handles execution.
 *
 * Uses this.schedule for runtime-managed cron execution and
 * this.memory to persist task definitions.
 *
 * @version 1.0.0
 * @icon ⏰
 * @tags scheduler, whatsapp, cron, nanoclaw, groups
 * @stateful
 * @ui dashboard ./ui/dashboard.html
 */
export default class GroupScheduler extends Photon {
  private tasks: Record<string, ScheduledTask> = {};

  async onInitialize(): Promise<void> {
    const saved = await this.memory.get<Record<string, ScheduledTask>>('tasks');
    if (saved) {
      this.tasks = saved;
      // Re-register active tasks with the schedule provider on startup
      for (const task of Object.values(this.tasks)) {
        if (task.status === 'active') {
          await this._registerSchedule(task).catch(() => {});
        }
      }
    }
  }

  /**
   * Group Scheduler Dashboard — view and manage scheduled tasks.
   *
   * @title Group Scheduler
   * @ui dashboard
   * @readOnly
   * @closedWorld
   */
  async main(): Promise<ScheduledTask[]> {
    return Object.values(this.tasks);
  }

  /**
   * Create a new scheduled task for a group.
   * @param groupFolder Filesystem folder name for the group {@example "dev-team"}
   * @param chatJid WhatsApp JID of the chat {@example "123@g.us"}
   * @param prompt The prompt to run when the task fires {@example "Summarise today's activity"}
   * @param cron Cron expression or shorthand (e.g. '@daily', '0 9 * * 1-5') {@example "0 9 * * *"}
   * @param contextMode Whether to run with full group context or isolated {@example "group"}
   * @param name Optional name for the task
   */
  async schedule(params: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    cron: string;
    contextMode?: 'group' | 'isolated';
    name?: string;
  }): Promise<ScheduledTask> {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task: ScheduledTask = {
      id,
      name: params.name || `${params.groupFolder}:${params.cron}`,
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      prompt: params.prompt,
      cron: params.cron,
      contextMode: params.contextMode ?? 'group',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
    };

    this.tasks[id] = task;
    await this._persist();
    await this._registerSchedule(task);

    this.emit({ type: 'task:created', task });
    return task;
  }

  /**
   * Cancel and remove a scheduled task.
   * @param taskId Task ID to cancel
   */
  async unschedule(params: { taskId: string }): Promise<{ removed: boolean }> {
    const task = this.tasks[params.taskId];
    if (!task) return { removed: false };

    await this.schedule.cancelByName(task.id).catch(() => {});
    delete this.tasks[params.taskId];
    await this._persist();

    this.emit({ type: 'task:removed', taskId: params.taskId });
    return { removed: true };
  }

  /**
   * Pause a task without removing it.
   * @param taskId Task ID to pause
   */
  async pause(params: { taskId: string }): Promise<ScheduledTask> {
    const task = this._getOrThrow(params.taskId);
    await this.schedule.cancelByName(task.id).catch(() => {});
    task.status = 'paused';
    await this._persist();
    this.emit({ type: 'task:paused', task });
    return task;
  }

  /**
   * Resume a paused task.
   * @param taskId Task ID to resume
   */
  async resume(params: { taskId: string }): Promise<ScheduledTask> {
    const task = this._getOrThrow(params.taskId);
    task.status = 'active';
    await this._registerSchedule(task);
    await this._persist();
    this.emit({ type: 'task:resumed', task });
    return task;
  }

  /**
   * List all scheduled tasks, optionally filtered by group folder.
   * @readOnly
   * @param groupFolder Optional filter by group folder
   */
  async tasks(params: { groupFolder?: string } = {}): Promise<ScheduledTask[]> {
    const all = Object.values(this.tasks);
    return params.groupFolder
      ? all.filter((t) => t.groupFolder === params.groupFolder)
      : all;
  }

  /**
   * Manually trigger a task immediately, outside its normal schedule.
   * @param taskId Task ID to fire now
   */
  async run(params: { taskId: string }): Promise<{ fired: boolean }> {
    const task = this._getOrThrow(params.taskId);
    await this._fireTask(task);
    return { fired: true };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async _registerSchedule(task: ScheduledTask): Promise<void> {
    // Use task.id as the schedule name so we can cancel by name later
    const existing = await this.schedule.has(task.id);
    if (existing) return;

    await this.schedule.create({
      name: task.id,
      schedule: task.cron,
      method: '_onScheduleFire',
      params: { taskId: task.id },
    });
  }

  /** Called by the schedule provider when a task's cron fires */
  async _onScheduleFire(params: { taskId: string }): Promise<void> {
    const task = this.tasks[params.taskId];
    if (!task || task.status !== 'active') return;
    await this._fireTask(task);
  }

  private async _fireTask(task: ScheduledTask): Promise<void> {
    task.lastRunAt = new Date().toISOString();
    task.runCount++;
    await this._persist();

    this.emit({
      type: 'task:fire',
      taskId: task.id,
      groupFolder: task.groupFolder,
      chatJid: task.chatJid,
      prompt: task.prompt,
      contextMode: task.contextMode,
      firedAt: task.lastRunAt,
    });
  }

  private _getOrThrow(taskId: string): ScheduledTask {
    const task = this.tasks[taskId];
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private async _persist(): Promise<void> {
    await this.memory.set('tasks', this.tasks);
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface ScheduledTask {
  id: string;
  name: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  cron: string;
  contextMode: 'group' | 'isolated';
  status: 'active' | 'paused';
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
}
