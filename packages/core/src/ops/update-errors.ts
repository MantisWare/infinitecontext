export { appendErrorCode as updateErrorCode } from './append-errors';

export const UPDATE_RETRY_ATTEMPTS = 8;

export function isConcurrentUpdateMessage(message: string): boolean {
    return (
        message.includes('Concurrent update') ||
        message.includes('retry') ||
        message.includes('serialize')
    );
}
