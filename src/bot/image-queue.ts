import { ImageTask } from '../types';
import { getSettings } from '../utils/config';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

export class ImageQueue extends EventEmitter {
  private queue: ImageTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chatId: number;

  constructor(chatId: number) {
    super();
    this.chatId = chatId;
  }

  public addTask(task: ImageTask) {
    this.queue.push(task);
    this.resetTimer();
    logger.info(`Task added to queue for chat ${this.chatId}. Queue length: ${this.queue.length}`);
  }

  public getQueue() {
    return this.queue;
  }

  public clearQueue() {
    this.queue = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`Queue cleared for chat ${this.chatId}`);
  }

  private resetTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const timeoutMs = getSettings().idle_timeout_seconds * 1000;
    this.timer = setTimeout(() => {
      this.triggerProcessing();
    }, timeoutMs);
  }

  private triggerProcessing() {
    if (this.queue.length > 0) {
      logger.info(`Idle timeout reached for chat ${this.chatId}. Triggering processing.`);
      const tasksToProcess = [...this.queue];
      this.queue = [];
      this.emit('process', tasksToProcess);
    }
  }
}
