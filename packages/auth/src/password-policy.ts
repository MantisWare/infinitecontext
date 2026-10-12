export const MAX_AUTH_PASSWORD_LENGTH = 256;

export function assertPasswordLength(password: string): void {
    if (password.length < 8) {
        throw new Error('weak_password');
    }
    if (password.length > MAX_AUTH_PASSWORD_LENGTH) {
        throw new Error('weak_password');
    }
}
